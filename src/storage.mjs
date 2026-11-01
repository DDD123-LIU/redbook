import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, linkSync, rmSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 3;
const SCHEMA_V2 = 2;
const PREVIOUS_SCHEMA_VERSION = 1;
const APPLICATION_ID = 1380201035;
const ORCHESTRATION_STAGE = 'orchestration:main';
const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8');
const STATE_ENTITIES = Object.freeze({
  batch: ['delivery_batch_id', 'status', new Set(['generation', 'stop_requested', 'updated_at'])],
  recommendation: ['recommendation_id', 'state', new Set(['first_success_at', 'updated_at'])],
  delivery_attempt: ['delivery_attempt_id', 'status', new Set(['dispatched_at', 'returned_at', 'message_id', 'query_evidence_refs_json', 'verification_evidence_refs_json', 'updated_at'])],
  outbox: ['outbox_id', 'state', new Set(['attempt_id', 'updated_at'])],
});

function nowIso() {
  return new Date().toISOString();
}

function shanghaiBusinessDay(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function materialArtifactHash({ bodyRef, bodyHash, orderedImages, coverRef, coverHash }) {
  return sha256(JSON.stringify({
    body: { ref: bodyRef ?? null, hash: bodyHash },
    images: [...orderedImages].sort((a, b) => a.index - b.index)
      .map((image) => ({ index: image.index, ref: image.path ?? null, hash: image.hash })),
    cover: { ref: coverRef ?? null, hash: coverHash ?? null },
  }));
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new TypeError(`${label} must be a SHA256 hex digest`);
  return value.toLowerCase();
}

function tableCount(db) {
  return db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count;
}

function checkDatabase(db, expectedVersion = SCHEMA_VERSION) {
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  if (applicationId !== APPLICATION_ID) throw new Error(`database application id mismatch: expected ${APPLICATION_ID}, got ${applicationId}`);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== expectedVersion) {
    if (version === SCHEMA_V2 && expectedVersion === SCHEMA_VERSION) throw new Error('schema version 2 requires explicit upgrade with upgradeStoreV2ToV3');
    if (version === PREVIOUS_SCHEMA_VERSION && expectedVersion === SCHEMA_VERSION) {
      throw new Error('schema version 1 requires explicit upgrade with upgradeStoreV1');
    }
    throw new Error(`schema version mismatch: expected ${expectedVersion}, got ${version}`);
  }
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') throw new Error(`database integrity check failed: ${integrity}`);
  const foreignKeyError = db.prepare('PRAGMA foreign_key_check').get();
  if (foreignKeyError) throw new Error(`foreign key check failed: ${JSON.stringify(foreignKeyError)}`);
}

function migrate(db) {
  // 先取得写锁，再检查版本，避免另一进程提交初始化时读到不一致状态。
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    if (version > SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) {
      if (applicationId !== APPLICATION_ID) throw new Error(`database application id mismatch: expected ${APPLICATION_ID}, got ${applicationId}`);
      db.exec('COMMIT');
      return;
    }
    if (version === PREVIOUS_SCHEMA_VERSION && applicationId === APPLICATION_ID) {
      throw new Error('schema version 1 requires explicit upgrade with upgradeStoreV1');
    }
    if (version === SCHEMA_V2 && applicationId === APPLICATION_ID) throw new Error('schema version 2 requires explicit upgrade with upgradeStoreV2ToV3');
    if (applicationId !== 0) throw new Error(`unrecognized database application id: ${applicationId}`);
    if (version !== 0 || tableCount(db) !== 0) throw new Error('refusing to migrate a non-empty unversioned database');
    db.exec(SCHEMA_SQL);
    const createdAt = nowIso();
    db.prepare(`INSERT INTO strategy_version(strategy_version,rule_diff_json,evidence_refs_json,state,effective_at,created_at)
      VALUES(?, '{}', '[]', 'unconfigured', ?, ?)`).run(randomUUID(), createdAt, createdAt);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function withTransaction(db, callback, state) {
  if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
  if (callback.constructor?.name === 'AsyncFunction') throw new TypeError('SQLite transaction callback must be synchronous');
  const nested = state.depth > 0;
  const savepoint = `store_${++state.savepoint}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  state.depth += 1;
  try {
    const result = callback(db);
    if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
    throw error;
  } finally {
    state.depth -= 1;
  }
}

function openReadonly(path) {
  const db = new DatabaseSync(resolve(path), { readOnly: true, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function backupToNewFile(sourceDb, target, expectedVersion) {
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await backup(sourceDb, temporary);
    const copy = openReadonly(temporary);
    try { checkDatabase(copy, expectedVersion); } finally { copy.close(); }
    linkSync(temporary, target);
    return { status: 'succeeded', entity_id: target, schema_version: expectedVersion, evidence_refs: [`sqlite:${target}:integrity_check=ok`] };
  } finally {
    rmSync(temporary, { force: true });
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

function assertInactiveExecutionSlot(db) {
  if (!hasTable(db, 'execution_slot')) throw new Error('cannot upgrade database with unknown execution slot state');
  const slots = db.prepare('SELECT slot_key,state,stop_requested,owner,run_id FROM execution_slot').all();
  if (slots.length !== 1 || slots[0].slot_key !== 'main' || !['idle', 'stopped'].includes(slots[0].state)
    || slots[0].stop_requested || slots[0].owner !== null || slots[0].run_id !== null) {
    throw new Error('cannot upgrade database while execution slot is active or unknown');
  }
}

function upgradeSchemaV1ToV2(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE material_version ADD COLUMN repair_of_material_version_id TEXT REFERENCES material_version(material_version_id);
      ALTER TABLE material_version ADD COLUMN artifact_hash TEXT;
      DROP INDEX material_success_hash_uq;
      CREATE UNIQUE INDEX material_success_hash_uq ON material_version(content_id,material_hash)
        WHERE fetch_status='succeeded' AND repair_of_material_version_id IS NULL;
      CREATE UNIQUE INDEX material_repair_artifact_uq ON material_version(content_id,material_hash,artifact_hash)
        WHERE fetch_status='succeeded' AND repair_of_material_version_id IS NOT NULL;
      CREATE TRIGGER material_repair_insert_validate BEFORE INSERT ON material_version
      WHEN (NEW.repair_of_material_version_id IS NULL AND NEW.artifact_hash IS NOT NULL)
        OR (NEW.repair_of_material_version_id IS NOT NULL AND (
          NEW.fetch_status<>'succeeded' OR NEW.artifact_hash IS NULL OR length(NEW.artifact_hash)<>64
          OR NEW.artifact_hash GLOB '*[^a-f0-9]*' OR NOT EXISTS (
            SELECT 1 FROM material_version parent
            WHERE parent.material_version_id=NEW.repair_of_material_version_id
              AND parent.content_id=NEW.content_id AND parent.material_hash=NEW.material_hash
              AND parent.media_kind=NEW.media_kind AND parent.completeness=NEW.completeness
              AND parent.fetch_status='succeeded' AND parent.repair_of_material_version_id IS NULL
          )
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid material repair parent or artifact hash'); END;
      PRAGMA user_version = ${SCHEMA_V2};
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function upgradeStoreV1(source, destination, options = {}) {
  if (!source || !destination || !options.backupPath) throw new TypeError('source, destination and backupPath are required');
  const sourcePath = resolve(source);
  const target = resolve(destination);
  const backupPath = resolve(options.backupPath);
  if (sourcePath === target || sourcePath === backupPath || target === backupPath) throw new Error('source, destination and backup paths must differ');
  if (existsSync(target) || existsSync(backupPath)) throw new Error('destination and backup paths must be new files');

  // 源库和v1备份保持只读；只在独立副本验证成功后发布v2目标。
  const sourceDb = openReadonly(sourcePath);
  try {
    checkDatabase(sourceDb, PREVIOUS_SCHEMA_VERSION);
    assertInactiveExecutionSlot(sourceDb);
    await backupToNewFile(sourceDb, backupPath, PREVIOUS_SCHEMA_VERSION);
  } finally {
    sourceDb.close();
  }

  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const backupDb = openReadonly(backupPath);
    try {
      checkDatabase(backupDb, PREVIOUS_SCHEMA_VERSION);
      assertInactiveExecutionSlot(backupDb);
      await backup(backupDb, temporary);
    } finally {
      backupDb.close();
    }

    const upgraded = new DatabaseSync(temporary, { enableForeignKeyConstraints: true });
    try {
      upgraded.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      upgradeSchemaV1ToV2(upgraded);
      checkDatabase(upgraded, SCHEMA_V2);
    } finally {
      upgraded.close();
    }
    const verified = openReadonly(temporary);
    try { checkDatabase(verified, SCHEMA_V2); } finally { verified.close(); }
    linkSync(temporary, target);
    return {
      status: 'succeeded', entity_id: target, schema_version: SCHEMA_V2, backup_id: backupPath,
      evidence_refs: [`sqlite:${target}:integrity_check=ok`, `sqlite:${target}:foreign_key_check=ok`],
    };
  } finally {
    rmSync(temporary, { force: true });
  }
}

// v2源库与备份均不改写；只在独立目标副本中放开同输入的不可变分析尝试。
export async function upgradeStoreV2ToV3(source, destination, { backupPath } = {}) {
  if (!source || !destination || !backupPath) throw new TypeError('source, destination and backupPath are required');
  const sourcePath=resolve(source), target=resolve(destination), backupTarget=resolve(backupPath);
  if(new Set([sourcePath,target,backupTarget]).size!==3||existsSync(target)||existsSync(backupTarget))throw new Error('source, destination and backup paths must differ; targets must be new');
  const original=openReadonly(sourcePath);
  try{checkDatabase(original,SCHEMA_V2);assertInactiveExecutionSlot(original);await backupToNewFile(original,backupTarget,SCHEMA_V2);}finally{original.close();}
  const temporary=resolve(dirname(target),`.${basename(target)}.${randomUUID()}.tmp`);
  try{
    const sourceCopy=openReadonly(backupTarget);try{checkDatabase(sourceCopy,SCHEMA_V2);assertInactiveExecutionSlot(sourceCopy);await backup(sourceCopy,temporary);}finally{sourceCopy.close();}
    const db=new DatabaseSync(temporary,{enableForeignKeyConstraints:true});
    try{db.exec(`BEGIN IMMEDIATE; DROP INDEX analysis_success_input_uq;
      CREATE INDEX analysis_complete_lookup_idx ON analysis(material_version_id,input_hash,prompt_version,created_at DESC,analysis_id) WHERE status='complete';
      PRAGMA user_version=3; COMMIT;`);checkDatabase(db,SCHEMA_VERSION);}finally{db.close();}
    linkSync(temporary,target);
    return {status:'succeeded',entity_id:target,schema_version:SCHEMA_VERSION,backup_id:backupTarget,evidence_refs:[`sqlite:${target}:integrity_check=ok`,`sqlite:${target}:foreign_key_check=ok`]};
  }finally{rmSync(temporary,{force:true});}
}

export function openStore(path, options = {}) {
  if (!path) throw new TypeError('database path is required');
  const resolvedPath = resolve(path);
  const readonly = options.readonly === true;
  const db = new DatabaseSync(resolvedPath, { readOnly: readonly, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    if (!readonly) migrate(db);
    checkDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const state = { depth: 0, savepoint: 0 };
  return {
    db,
    schemaVersion: SCHEMA_VERSION,
    transaction(callback) {
      if (readonly) throw new Error('store is read-only');
      return withTransaction(db, callback, state);
    },
    assertCoordinator(coordination, { now, accountingOnly = false } = {}) {
      const head = db.prepare("SELECT owner,run_id,generation,delivery_batch_id,pending_ids_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1")
        .get(ORCHESTRATION_STAGE);
      if (head) {
        const fullHead = db.prepare("SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1").get(ORCHESTRATION_STAGE);
        let proof;
        let pendingIds;
        try {
          pendingIds = JSON.parse(fullHead.pending_ids_json);
          proof = JSON.parse(fullHead.succeeded_refs_json).find(ref => ref && typeof ref === 'object' && ref.orchestration)?.orchestration;
        } catch { throw new Error('coordinator head proof is invalid'); }
        if (!Array.isArray(pendingIds) || !proof || proof.owner !== fullHead.owner || proof.batchId !== fullHead.delivery_batch_id
          || proof.runId !== fullHead.run_id || proof.batchGeneration !== fullHead.generation
          || typeof proof.active !== 'boolean' || proof.active !== (pendingIds.length > 0)
          || !Number.isSafeInteger(proof.process_id) || proof.process_id < 1
          || typeof proof.process_instance_id !== 'string' || !proof.process_instance_id.trim()
          || typeof proof.process_started_at !== 'string' || Number.isNaN(new Date(proof.process_started_at).getTime())
          || !['admitted', 'executing', 'returned'].includes(proof.invocation_state)
          || !Array.isArray(proof.worker_refs)
          || sha256(JSON.stringify(proof)) !== fullHead.output_hash) throw new Error('coordinator head proof is invalid');
      }
      if (!coordination) {
        if (head && JSON.parse(head.pending_ids_json).length > 0) throw new Error('active coordinator identity is required');
        return;
      }
      const { owner, batchId, runId, batchGeneration } = coordination;
      if (!owner || !batchId || !runId || !Number.isSafeInteger(batchGeneration) || batchGeneration < 1) {
        throw new TypeError('coordinator identity is invalid');
      }
      const batch = db.prepare('SELECT owner,generation,business_day,status,stop_requested,kind FROM batch WHERE delivery_batch_id=?').get(batchId);
      if (!batch || batch.owner !== owner) throw new Error('coordinator batch identity is stale');
      if (accountingOnly) return;
      if (!now || Number.isNaN(new Date(now).getTime())) throw new TypeError('coordinator now must be a valid date');
      const pendingIds = head ? JSON.parse(head.pending_ids_json) : [];
      if (!head || !pendingIds.includes(runId) || head.owner !== owner || head.run_id !== runId ||
          head.generation !== batchGeneration || head.delivery_batch_id !== batchId || batch.generation !== batchGeneration) {
        throw new Error('coordinator identity is stale');
      }
      if (batch.status !== 'running') throw new Error(`coordinator batch status is ${batch.status}`);
      if (batch.stop_requested) throw new Error('coordinator batch stop is requested');
      if (['daily_follow', 'additional_follow', 'explore'].includes(batch.kind) && batch.business_day !== shanghaiBusinessDay(now)) {
        throw new Error('coordinator daily batch business day is closed');
      }
    },
    casSlot(input) {
      if (readonly) throw new Error('store is read-only');
      const required = [
        'owner', 'runId', 'generation', 'stopRequested', 'expectedOwner', 'expectedRunId',
        'expectedGeneration', 'expectedStopRequested', 'expectedState', 'expectedRevision', 'nextState',
      ];
      for (const key of required) if (!(key in input)) throw new TypeError(`casSlot requires ${key}`);
      const updatedAt = input.updatedAt ?? nowIso();
      const result = withTransaction(db, () => {
        if (input.coordination && input.owner !== input.coordination.owner) throw new Error('execution slot owner must match coordinator owner');
        if (input.coordination && input.batchId != null && input.batchId !== input.coordination.batchId) {
          throw new Error('execution slot batch must match coordinator batch');
        }
        if (input.nextState === 'running') this.assertCoordinator(input.coordination, { now: updatedAt });
        return db.prepare(`
        UPDATE execution_slot
        SET owner=?, run_id=?, generation=?, batch_id=?, state=?, stop_requested=?, revision=revision+1, updated_at=?
        WHERE slot_key='main' AND owner IS ? AND run_id IS ? AND generation=? AND stop_requested=? AND state=? AND revision=?
      `).run(
        input.owner, input.runId, input.generation, input.coordination?.batchId ?? input.batchId ?? null, input.nextState,
        input.stopRequested ? 1 : 0, updatedAt,
        input.expectedOwner, input.expectedRunId, input.expectedGeneration,
        input.expectedStopRequested ? 1 : 0, input.expectedState, input.expectedRevision,
        );
      }, state);
      return {
        status: result.changes === 1 ? 'succeeded' : 'rejected',
        entity_id: 'main',
        changes: Number(result.changes),
        evidence_refs: [],
      };
    },
    casState(input) {
      if (readonly) throw new Error('store is read-only');
      const entity = STATE_ENTITIES[input.entity];
      if (!entity) throw new TypeError(`unsupported CAS entity: ${input.entity}`);
      const [idColumn, stateColumn, allowedFields] = entity;
      if (input.entity_id == null || input.expectedState == null || input.expectedRevision == null || input.nextState == null) {
        throw new TypeError('casState requires entity_id, expectedState, expectedRevision and nextState');
      }
      const fields = input.fields ?? {};
      for (const key of Object.keys(fields)) if (!allowedFields.has(key)) throw new TypeError(`unsupported ${input.entity} field: ${key}`);
      const nextFields = { ...fields };
      if (allowedFields.has('updated_at')) nextFields.updated_at = input.updatedAt ?? nowIso();
      const assignments = [`${stateColumn}=?`, 'revision=revision+1', ...Object.keys(nextFields).map((key) => `${key}=?`)];
      const values = [input.nextState, ...Object.values(nextFields), input.entity_id, input.expectedState, input.expectedRevision];
      const result = withTransaction(db, () => db.prepare(`UPDATE ${input.entity} SET ${assignments.join(', ')} WHERE ${idColumn}=? AND ${stateColumn}=? AND revision=?`).run(...values), state);
      return {
        status: result.changes === 1 ? 'succeeded' : 'rejected',
        entity_id: input.entity_id,
        changes: Number(result.changes),
        evidence_refs: input.evidence_refs ?? [],
      };
    },
    casFeedback(input) {
      if (readonly) throw new Error('store is read-only');
      const required = ['owner', 'platform', 'sourceContentId', 'expectedRevision', 'value', 'eventId', 'savedAt'];
      for (const key of required) if (!(key in input)) throw new TypeError(`casFeedback requires ${key}`);
      const result = withTransaction(db, () => db.prepare(`
        UPDATE feedback_current SET value=?, event_id=?, saved_at=?, revision=revision+1
        WHERE owner=? AND platform=? AND source_content_id=? AND revision=?
      `).run(input.value, input.eventId, input.savedAt, input.owner, input.platform, input.sourceContentId, input.expectedRevision), state);
      return {
        status: result.changes === 1 ? 'succeeded' : 'rejected',
        entity_id: input.sourceContentId,
        changes: Number(result.changes),
        evidence_refs: input.evidence_refs ?? [],
      };
    },
    async backup(destination) {
      if (readonly) throw new Error('store is read-only');
      const target = resolve(destination);
      if (target === resolvedPath || existsSync(target)) throw new Error('backup destination must be a new file');
      checkDatabase(db);
      return backupToNewFile(db, target, SCHEMA_VERSION);
    },
    close() { db.close(); },
  };
}

export async function restoreStore(source, destination, expectedSchemaVersion = SCHEMA_VERSION) {
  const sourcePath = resolve(source);
  const target = resolve(destination);
  if (sourcePath === target || existsSync(target)) throw new Error('restore destination must be a new file');
  const sourceDb = openReadonly(sourcePath);
  try {
    checkDatabase(sourceDb, expectedSchemaVersion);
    return await backupToNewFile(sourceDb, target, expectedSchemaVersion);
  } catch (error) {
    throw error;
  } finally {
    sourceDb.close();
  }
}

export function materialHash(input = {}) {
  const bodyHash = input.bodyHash ?? input.body_hash ?? (input.body === undefined ? sha256('') : sha256(Buffer.isBuffer(input.body) ? input.body : String(input.body)));
  const normalizedBodyHash = requireSha256(bodyHash, 'body hash');
  const images = input.orderedImages ?? input.ordered_images ?? [];
  if (!Array.isArray(images)) throw new TypeError('orderedImages must be an array');
  const orderedImages = images.map((image, offset) => {
    const index = typeof image === 'string' ? offset : image?.index;
    const bytesHash = typeof image === 'object' && image?.bytes !== undefined
      ? sha256(Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes)) : null;
    if (bytesHash && image.hash && requireSha256(image.hash, 'image hash') !== bytesHash) throw new Error('image hash does not match image bytes');
    const hash = typeof image === 'string' ? image : image?.hash ?? bytesHash;
    if (!Number.isSafeInteger(index) || !hash) throw new TypeError('each ordered image requires an integer index and a hash or bytes');
    return { index, hash: requireSha256(hash, 'image hash') };
  });
  if (orderedImages.length && ![0, 1].includes(orderedImages[0].index)) throw new TypeError('ordered image indexes must start at 0 or 1');
  for (let i = 1; i < orderedImages.length; i += 1) {
    if (orderedImages[i].index !== orderedImages[i - 1].index + 1) throw new TypeError('ordered image indexes must be unique, increasing and contiguous');
  }
  const coverHash = input.coverHash ?? input.cover_hash ?? null;
  return sha256(JSON.stringify({
    bodyHash: normalizedBodyHash,
    orderedImages,
    mediaKind: input.mediaKind ?? input.media_kind ?? 'unknown',
    coverHash: coverHash === null ? null : requireSha256(coverHash, 'cover hash'),
  }));
}

export function saveContent(store, input) {
  const { platform, content_id: sourceContentId } = input;
  if (!platform || !sourceContentId) throw new TypeError('platform and content_id are required');
  if (input.source_state && !['available', 'unavailable', 'unknown', 'removed', 'source_deleted', 'temporarily_unavailable', 'access_blocked'].includes(input.source_state)) {
    throw new TypeError(`invalid source_state: ${input.source_state}`);
  }
  const contentId = randomUUID();
  const at = input.last_observed_at ?? nowIso();
  const inserted = store.db.prepare(`INSERT INTO content(content_id,platform,source_content_id,source_url_ref,author_id,author_name,source_state,last_observed_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,source_content_id) DO NOTHING`).run(
    contentId, platform, sourceContentId, input.source_url_ref ?? null, input.author_id ?? null,
    input.author_name ?? null, input.source_state ?? 'unknown', at, input.created_at ?? nowIso(),
  );
  const saved = store.db.prepare('SELECT content_id FROM content WHERE platform=? AND source_content_id=?').get(platform, sourceContentId);
  return { status: inserted.changes === 1 ? 'succeeded' : 'duplicate', entity_id: saved.content_id, evidence_refs: [] };
}

export function saveMaterialVersion(store, input) {
  const orderedImages = input.ordered_images ?? [];
  const fetchStatus = input.fetch_status ?? 'succeeded';
  const repairOf = input.repair_of_material_version_id ?? null;
  if (input.artifact_hash != null && !repairOf) throw new TypeError('artifact_hash is storage-generated and only valid for repairs');
  if (repairOf && fetchStatus !== 'succeeded') throw new TypeError('a material repair must be succeeded');
  if (fetchStatus === 'succeeded' && input.body === undefined && input.body_hash == null) {
    throw new TypeError('a successful material requires body bytes or an explicit body_hash');
  }
  if (fetchStatus === 'succeeded' && input.body_hash === '') throw new TypeError('a successful material cannot have an empty body_hash');
  const bodyHash = input.body_hash ?? (input.body === undefined ? sha256('') : sha256(Buffer.isBuffer(input.body) ? input.body : String(input.body)));
  const normalizedBodyHash = requireSha256(bodyHash, 'body hash');
  if (input.body !== undefined && input.body_hash && requireSha256(input.body_hash, 'body hash') !== sha256(Buffer.isBuffer(input.body) ? input.body : String(input.body))) {
    throw new Error('body_hash does not match body bytes');
  }
  const calculatedHash = materialHash({ bodyHash, orderedImages, mediaKind: input.media_kind, coverHash: input.cover_hash });
  if (input.material_hash && input.material_hash !== calculatedHash) throw new Error('material_hash does not match stored content hashes');
  const normalizedImages = orderedImages.map((image, index) => typeof image === 'string'
    ? { index, hash: requireSha256(image, 'image hash') }
    : { index: image.index, path: image.path ?? null, hash: requireSha256(image.hash ?? (image.bytes === undefined ? null : sha256(Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes))), 'image hash') });
  const mediaKind = input.media_kind ?? 'unknown';
  const completeness = input.completeness ?? (fetchStatus === 'succeeded' ? 'complete' : 'failed');
  const bodyRef = input.body_ref ?? null;
  const coverRef = input.cover_ref ?? null;
  const coverHash = input.cover_hash == null ? null : requireSha256(input.cover_hash, 'cover hash');
  const artifactHash = repairOf ? materialArtifactHash({
    bodyRef, bodyHash: normalizedBodyHash, orderedImages: normalizedImages, coverRef, coverHash,
  }) : null;
  if (input.artifact_hash != null && requireSha256(input.artifact_hash, 'artifact_hash') !== artifactHash) {
    throw new Error('artifact_hash does not match stored artifact references');
  }
  if (repairOf && (typeof bodyRef !== 'string' || !bodyRef || normalizedImages.some((image) => typeof image.path !== 'string' || !image.path)
    || (coverHash !== null && (typeof coverRef !== 'string' || !coverRef)))) {
    throw new TypeError('a material repair requires a reference for the body and every image or cover hash');
  }
  const id = input.material_version_id ?? randomUUID();
  return store.transaction(() => {
    const content = store.db.prepare('SELECT content_id FROM content WHERE content_id=?').get(input.content_id);
    if (!content) throw new Error(`content not found: ${input.content_id}`);
    if (repairOf) {
      const parent = store.db.prepare(`SELECT material_version_id FROM material_version
        WHERE material_version_id=? AND content_id=? AND material_hash=? AND media_kind=? AND completeness=?
          AND fetch_status='succeeded' AND repair_of_material_version_id IS NULL`).get(
        repairOf, input.content_id, calculatedHash, mediaKind, completeness,
      );
      if (!parent) throw new Error('material repair must reference a matching succeeded root version');
    }
    if (fetchStatus === 'succeeded' && !repairOf) {
      const existing = store.db.prepare("SELECT material_version_id FROM material_version WHERE content_id=? AND material_hash=? AND fetch_status='succeeded' AND repair_of_material_version_id IS NULL").get(input.content_id, calculatedHash);
      if (existing) return { status: 'duplicate', entity_id: existing.material_version_id, evidence_refs: [] };
    }
    if (fetchStatus === 'succeeded' && repairOf) {
      const existing = store.db.prepare(`SELECT material_version_id FROM material_version
        WHERE content_id=? AND material_hash=? AND artifact_hash=? AND fetch_status='succeeded'
          AND repair_of_material_version_id IS NOT NULL`).get(input.content_id, calculatedHash, artifactHash);
      if (existing) return { status: 'duplicate', entity_id: existing.material_version_id, evidence_refs: [] };
    }
    const inserted = store.db.prepare(`INSERT INTO material_version(material_version_id,content_id,body_ref,body_hash,ordered_images_json,cover_ref,cover_hash,media_kind,published_at,fetched_at,material_hash,completeness,evidence_refs_json,fetch_status,repair_of_material_version_id,artifact_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.content_id, bodyRef, bodyHash, JSON.stringify(normalizedImages),
      coverRef, coverHash, mediaKind, input.published_at ?? null, input.fetched_at ?? nowIso(), calculatedHash,
      completeness, JSON.stringify(input.evidence_refs ?? []), fetchStatus, repairOf, artifactHash,
    );
    return {
      status: inserted.changes === 1 ? fetchStatus : 'duplicate',
      entity_id: id,
      evidence_refs: input.evidence_refs ?? [],
    };
  });
}
