import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { materialHash, openStore, saveContent, saveMaterialVersion } from './storage.mjs';

const PLATFORM = 'xiaohongshu';
const MEMBERSHIPS = new Set(['present', 'confirmed_removed', 'unknown']);
const FETCH_STATES = new Set(['succeeded', 'failed', 'unknown', 'blocked']);
const MEDIA_KINDS = new Set(['image', 'video', 'text', 'unknown']);
const TERMINAL_SLOT_STATES = new Set(['idle', 'stopped']);
const runtimeProcess = typeof process === 'undefined' ? null : process;
const sha256 = (value) => createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value), 'utf8').digest('hex');

export class CollectionStoppedError extends Error {
  constructor(message = 'collection run no longer owns the execution slot') {
    super(message);
    this.name = 'CollectionStoppedError';
  }
}

export function parseBusinessSummary(stdout) {
  const matches = [...String(stdout ?? '').matchAll(/共处理\s*(\d+)\s*个作品[，,]\s*成功\s*(\d+)\s*个[，,]\s*失败\s*(\d+)\s*个[，,]\s*跳过\s*(\d+)/g)];
  if (matches.length !== 1) return null;
  const [, total, succeeded, failed, skipped] = matches[0].map(Number);
  return { total, succeeded, failed, skipped };
}

export function runXhsCli({ executable, settingsPath, url, cwd, indexes, timeoutMs = 600_000, killGraceMs = 3_000, onSpawn = async () => {} }) {
  if (!executable || !settingsPath || !url || !cwd) throw new TypeError('executable, settingsPath, url and cwd are required');
  return new Promise((resolvePromise, reject) => {
    const args = ['--settings', settingsPath, '--url', url];
    if (Array.isArray(indexes) && indexes.length) args.push('--index', indexes.join(' '));
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let spawnProof = Promise.resolve();
    const appendTail = (current, chunk) => (current + chunk).slice(-1_000_000);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    let killTimer;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once('spawn', () => {
      spawnProof = Promise.resolve(onSpawn({ pid: child.pid ?? null, started_at: new Date().toISOString(), executable }))
        .catch(error => { spawnError = error; child.kill('SIGTERM'); });
    });
    child.once('error', (error) => {
      clearTimeout(timeout); clearTimeout(killTimer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once('close', async (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      await spawnProof;
      if (settled) return;
      settled = true;
      if (spawnError) reject(new Error(`collection child spawn proof could not be saved: ${spawnError.message}`));
      else resolvePromise({ exitCode, signal, timedOut, stdout, stderr, child_pid: child.pid ?? null });
    });
  });
}

export function createCollector({ store, root, owner, coordination = null, cli, settingsPath, executable, decodeImage = decodeImageWithSystemDrawing,
  afterReceipt = async () => {}, onWorkerSpawned = async () => {}, now = () => new Date().toISOString(), uuid = randomUUID }) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('a writable TASK-007 store is required');
  if (!root) throw new TypeError('private collection root is required');
  if (!owner) throw new TypeError('collection owner is required');
  coordination = coordination ? Object.freeze({ ...coordination }) : null;
  if (coordination && coordination.owner !== owner) throw new Error('collection coordinator owner mismatch');
  const privateRoot = resolve(root);
  const cliExecutable = cli?.executable ?? executable;
  const configuredSettings = cli?.settingsPath ?? settingsPath;
  const invokeCli = typeof cli === 'function'
    ? cli
    : (input) => runXhsCli({ executable: cliExecutable, settingsPath: input.settingsPath, url: input.url, cwd: input.cwd,
      indexes: input.indexes, timeoutMs: input.timeoutMs, onSpawn: input.onSpawn });
  let activeToken = null;

  function assertCoordinator(batchId = coordination?.batchId) {
    if (coordination && coordination.batchId !== batchId) throw new Error('collection coordinator batch mismatch');
    store.assertCoordinator(coordination, { now: new Date(now()).toISOString() });
  }

  async function preflight() {
    if (typeof cli === 'function') return { status: 'ready' };
    if (!cliExecutable || !configuredSettings) return { status: 'blocked', reason: 'collection_cli_configuration_missing' };
    try { await access(resolve(cliExecutable)); } catch { return { status: 'blocked', reason: 'collection_cli_executable_unavailable' }; }
    try { await access(resolve(configuredSettings)); } catch { return { status: 'blocked', reason: 'collection_cli_settings_unavailable' }; }
    return { status: 'ready' };
  }

  function slot() {
    return store.db.prepare("SELECT owner,run_id,generation,state,stop_requested,revision FROM execution_slot WHERE slot_key='main'").get();
  }

  function assertCurrent(token = activeToken) {
    assertCoordinator();
    if (!token) throw new CollectionStoppedError('collection run token is required');
    const current = slot();
    if (current.owner !== token.owner || current.run_id !== token.runId || current.generation !== token.generation || current.stop_requested !== 0 || current.state !== 'running') {
      throw new CollectionStoppedError();
    }
    return current;
  }

  function tokenFor(input) {
    const token = input ?? activeToken;
    assertCurrent(token);
    return token;
  }

  function casSlot(current, next, batchId = coordination?.batchId) {
    return store.casSlot({
      owner: next.owner,
      runId: next.runId,
      generation: next.generation,
      batchId: next.state === 'running' ? batchId : null,
      coordination: next.state === 'running' ? coordination : undefined,
      stopRequested: next.stopRequested,
      expectedOwner: current.owner,
      expectedRunId: current.run_id,
      expectedGeneration: current.generation,
      expectedStopRequested: Boolean(current.stop_requested),
      expectedState: current.state,
      expectedRevision: current.revision,
      nextState: next.state,
      updatedAt: now(),
    });
  }

  async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${uuid()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
  }

  async function readJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function hashFile(path) {
    const hash = createHash('sha256');
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolvePromise);
    });
    return hash.digest('hex');
  }

  function urlHash(url) { return sha256(String(url)); }
  function normalizeText(value) { return String(value ?? '').replace(/^\uFEFF/, '').replace(/\s+/gu, ''); }

  function validateUrl(sourceId, input) {
    if (typeof input !== 'string' || !input) throw new TypeError('complete_source_url is required');
    let parsed;
    try { parsed = new URL(input); } catch { throw new TypeError('complete_source_url must be a valid URL'); }
    if (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(parsed.hostname.toLowerCase())) throw new TypeError('source URL host is not supported');
    const pathId = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})$/i)?.[1]
      ?? parsed.pathname.match(/\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})$/i)?.[1];
    if (!pathId || pathId.toLowerCase() !== String(sourceId).toLowerCase() || !/^[a-f\d]{24}$/i.test(String(sourceId))) throw new TypeError('source URL does not match source content ID');
    return parsed.href;
  }

  async function prepareAttemptSettings(settingsSource, attemptDir, workDir, { disableImageDownload = false } = {}) {
    if (!settingsSource) throw new TypeError('existing XHS CLI settings path is required');
    const settings = JSON.parse(await readFile(settingsSource, 'utf8'));
    settings.work_path = workDir;
    if (disableImageDownload) settings.image_download = false;
    const attemptSettings = join(attemptDir, 'settings.json');
    await writeFile(attemptSettings, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
    return attemptSettings;
  }

  function sourceScope(input) {
    if (!input.source_page) throw new TypeError('source_page is required for live collection');
    const parsed = new URL(input.source_page);
    if (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(parsed.hostname.toLowerCase())) throw new TypeError('source_page host is not supported');
    return sha256(JSON.stringify({ origin: parsed.origin.toLowerCase(), pathname: parsed.pathname, sub_tab: input.sub_tab ?? null }));
  }

  function privatePath(...parts) { return resolve(privateRoot, ...parts); }

  async function persistRun(token, fields) {
    const base = join(privateRoot, 'runs', token.runId);
    await mkdir(base, { recursive: true });
    const path = join(base, 'run.json');
    const previous = await readJson(path);
    await atomicJson(path, { ...previous, owner: token.owner, run_id: token.runId, generation: token.generation, process_id: runtimeProcess?.pid ?? null, process_started_at: previous?.process_started_at ?? (runtimeProcess ? new Date(Date.now() - runtimeProcess.uptime() * 1000).toISOString() : null), updated_at: now(), ...fields });
  }

  function currentToken(token) { return tokenFor(token); }

  async function claim() {
    assertCoordinator();
    if (activeToken) throw new CollectionStoppedError('this collector already owns an active run');
    const current = slot();
    if (!TERMINAL_SLOT_STATES.has(current.state) || current.owner !== null || current.run_id !== null || current.stop_requested !== 0) {
      throw new CollectionStoppedError(`execution slot is ${current.state}; explicit recovery is required`);
    }
    const token = { owner, runId: uuid(), generation: current.generation + 1 };
    const result = casSlot(current, { ...token, stopRequested: false, state: 'running' });
    if (result.status !== 'succeeded') throw new CollectionStoppedError('execution slot claim was rejected');
    activeToken = token;
    try {
      await persistRun(token, { state: 'running' });
    } catch (error) {
      await release(token);
      throw error;
    }
    return token;
  }

  function requestStop(token = activeToken) {
    const current = assertCurrent(token);
    const result = casSlot(current, { ...token, stopRequested: true, state: 'stopping' });
    if (result.status !== 'succeeded') throw new CollectionStoppedError('stop request lost the execution slot');
    return { status: 'stopping', generation: token.generation };
  }

  async function release(token = activeToken, state = 'stopped') {
    if (!token) return { status: 'idle' };
    const current = slot();
    if (current.owner !== token.owner || current.run_id !== token.runId || current.generation !== token.generation) return { status: 'rejected' };
    const result = casSlot(current, { owner: null, runId: null, generation: current.generation, stopRequested: false, state });
    if (result.status === 'succeeded' && activeToken?.runId === token.runId) activeToken = null;
    return { status: result.status };
  }

  async function recover({ confirmedStoppedRunId, evidenceRef } = {}) {
    if (!confirmedStoppedRunId || !evidenceRef) throw new TypeError('confirmedStoppedRunId and evidenceRef are required');
    const current = slot();
    if (!current.run_id || current.run_id !== confirmedStoppedRunId || !['running', 'stopping', 'recovery_required'].includes(current.state)) {
      throw new CollectionStoppedError('the confirmed run does not match the active slot');
    }
    const record = await readJson(join(privateRoot, 'runs', current.run_id, 'run.json'));
    const recordedPid = record?.process_id;
    if (!Number.isInteger(recordedPid) || record?.run_id !== confirmedStoppedRunId) throw new CollectionStoppedError('the old process identity is unavailable');
    try {
      if (!runtimeProcess?.kill) throw new CollectionStoppedError('OS process identity is unavailable in this runtime');
      runtimeProcess.kill(recordedPid, 0);
      throw new CollectionStoppedError('the old process is still present; recovery is unsafe');
    } catch (error) {
      if (error instanceof CollectionStoppedError) throw error;
      if (error.code !== 'ESRCH') throw new CollectionStoppedError('the old process state is unknown');
    }
    const result = casSlot(current, { owner: null, runId: null, generation: current.generation, stopRequested: false, state: 'stopped' });
    if (result.status !== 'succeeded') throw new CollectionStoppedError('recovery compare-and-swap was rejected');
    await atomicJson(join(privateRoot, 'runs', confirmedStoppedRunId, 'recovery.json'), { run_id: confirmedStoppedRunId, evidence_ref: evidenceRef, process_id: recordedPid, recovered_at: now() });
    return claim();
  }

  async function recordDiscovery(batchId, input) {
    const token = currentToken(input.token);
    if (!batchId || !Array.isArray(input.observations)) throw new TypeError('batchId and observations are required');
    const sourceKind = input.source_kind ?? 'live_page';
    if (sourceKind !== 'live_page') throw new TypeError('only live_page observations can enter TASK-008');
    const scopeHash = sourceScope(input);
    const existingBatch = store.db.prepare('SELECT coverage_json FROM collection_batch WHERE collection_batch_id=?').get(batchId);
    if (existingBatch) {
      const priorCoverage = JSON.parse(existingBatch.coverage_json);
      if (priorCoverage.source_kind !== 'live_page' || priorCoverage.source_scope_hash !== scopeHash) throw new Error('collection batch source scope changed');
    }
    const observedAt = input.observed_at ?? now();
    const readId = uuid();
    const rawObservations = input.observations.map((observation) => {
      const sourceId = String(observation.content_id ?? '');
      if (!sourceId) throw new TypeError('observation content_id is required');
      if (!MEMBERSHIPS.has(observation.membership ?? 'present')) throw new TypeError('invalid observation membership');
      return {
        ...observation,
        content_id: sourceId,
        complete_source_url: validateUrl(sourceId, observation.complete_source_url),
        membership: observation.membership ?? 'present',
        evidence_ref: null,
        observed_at: observation.observed_at ?? observedAt,
      };
    });
    const rawPath = join(privateRoot, 'runs', token.runId, 'observations', `${readId}.json`);
    await atomicJson(rawPath, { batch_id: batchId, read_id: readId, source_page: input.source_page ?? null, anchor_id: input.anchor_id ?? null, observations: rawObservations });
    const rawRef = resolve(rawPath);
    assertCurrent(token);

    const coverage = input.coverage ?? { state: 'unknown', stop_reason: 'coverage_not_provided' };
    const observationIds = [];
      store.transaction(() => {
      assertCurrent(token);
      const firstAt = rawObservations.reduce((min, item) => item.observed_at < min ? item.observed_at : min, observedAt);
      const lastAt = rawObservations.reduce((max, item) => item.observed_at > max ? item.observed_at : max, observedAt);
      const coverageRecord = {
        state: coverage.state ?? 'unknown',
        stop_reason: coverage.stop_reason ?? null,
        scope: coverage.scope ?? 'local_observation',
        visible_count: Number.isInteger(coverage.visible_count) ? coverage.visible_count : rawObservations.length,
        source_kind: sourceKind,
        read_method: input.read_method ?? 'edge_dom',
        source_scope_hash: scopeHash,
        source_page_ref: rawRef,
        anchor_id: input.anchor_id ?? null,
        total_count: Number.isInteger(input.total_count) ? input.total_count : null,
        total_known: input.total_known === true,
      };
      store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_count,total_known,evidence_refs_json,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(collection_batch_id) DO UPDATE SET observed_until=excluded.observed_until, coverage_json=excluded.coverage_json,
        total_count=excluded.total_count,total_known=excluded.total_known,evidence_refs_json=excluded.evidence_refs_json`).run(
        batchId, firstAt, lastAt, JSON.stringify(coverageRecord),
        Number.isInteger(input.total_count) ? input.total_count : null, input.total_known ? 1 : 0,
        JSON.stringify([rawRef]), now(),
      );
      for (const observation of rawObservations) {
        const saved = saveContent(store, {
          platform: PLATFORM,
          content_id: observation.content_id,
          source_url_ref: rawRef,
          source_state: observation.source_state ?? 'unknown',
          author_id: observation.author_id ?? null,
          author_name: observation.author_name ?? null,
          last_observed_at: observation.observed_at,
        });
        const insert = store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref,collected_at,coverage_ref)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(collection_batch_id,content_id,observed_at) DO NOTHING`).run(
          uuid(), batchId, saved.entity_id, observation.observed_at, observation.membership,
          rawRef, observation.collected_at ?? null, rawRef,
        );
        if (insert.changes === 1) observationIds.push(saved.entity_id);
      }
      const observedIds = store.db.prepare('SELECT DISTINCT c.source_content_id FROM collection_observation o JOIN content c USING(content_id) WHERE o.collection_batch_id=? ORDER BY c.source_content_id').all(batchId).map((row) => row.source_content_id);
      const pendingIds = observedIds;
      const cpId = uuid();
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
        VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(
        cpId, token.owner, token.runId, token.generation, `collection:${batchId}:${readId}`,
        JSON.stringify(pendingIds), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]),
        sha256(JSON.stringify({ batchId, readId, sourceIds: rawObservations.map((item) => item.content_id) })),
        sha256(JSON.stringify(observedIds)), 0, now(),
      );
    });
    assertCurrent(token);
    const cumulative = store.db.prepare('SELECT DISTINCT c.source_content_id FROM collection_observation o JOIN content c USING(content_id) WHERE o.collection_batch_id=? ORDER BY c.source_content_id').all(batchId).map((row) => row.source_content_id);
    const cachedRows = [];
    for (const sourceId of cumulative) {
      const cached = await existingMaterial(sourceId);
      if (cached?.status === 'duplicate') cachedRows.push({ sourceId, materialVersionId: cached.material_version_id });
    }
    const pendingIds = cumulative.filter((sourceId) => !cachedRows.some((item) => item.sourceId === sourceId));
    if (cachedRows.length) {
      assertCurrent(token);
      store.transaction(() => {
        assertCurrent(token);
        const latest = store.db.prepare('SELECT pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,output_hash FROM checkpoint WHERE owner=? AND run_id=? AND stage LIKE ? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(token.owner, token.runId, `collection:${batchId}:%`);
        if (!latest) return;
        const succeeded = JSON.parse(latest.succeeded_refs_json);
        for (const item of cachedRows) succeeded.push(`material_version:${item.materialVersionId}`);
        const pending = JSON.parse(latest.pending_ids_json).filter((id) => pendingIds.includes(id));
        const output = { pending, succeeded, failed: JSON.parse(latest.failed_refs_json), unknown: JSON.parse(latest.unknown_refs_json) };
        store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
          VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(uuid(), token.owner, token.runId, token.generation,
          `collection:${batchId}:cache:${readId}`, JSON.stringify(pending), JSON.stringify(succeeded), JSON.stringify(output.failed), JSON.stringify(output.unknown),
          latest.output_hash, sha256(JSON.stringify(output)), 0, now());
      });
    }
    const nextCheckpoint = store.db.prepare('SELECT checkpoint_id,stage,output_hash,committed_at FROM checkpoint WHERE owner=? AND run_id=? AND stage LIKE ? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(token.owner, token.runId, `collection:${batchId}:%`);
    await persistRun(token, { state: 'running', collection_batch_id: batchId, last_read_id: readId, observed_ids: cumulative, next_checkpoint: nextCheckpoint?.checkpoint_id ?? null });
    return { status: coverage.state ?? 'unknown', entity_id: batchId, evidence_refs: [rawRef, ...(nextCheckpoint ? [`checkpoint:${nextCheckpoint.checkpoint_id}`] : [])], observations: rawObservations.map(({ complete_source_url, ...item }) => item), observed_ids: cumulative, newly_observed_ids: observationIds, cumulative_unique: cumulative.length, pending_ids: pendingIds, coverage, next_checkpoint: nextCheckpoint, state: coverage.state ?? 'unknown' };
  }

  async function listFiles(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('CLI output cannot contain symbolic links');
      if (entry.isDirectory()) files.push(...await listFiles(path));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  }

  async function inspectCliDatabase(outputDir, sourceContentId) {
    const dbPath = (await listFiles(outputDir)).find((path) => /^ExploreData\.db$/i.test(path.split(sep).at(-1) ?? ''));
    if (!dbPath) return { ok: false, reason: 'cli_database_missing' };
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='explore_data'").get();
      if (!table) return { ok: false, reason: 'cli_table_missing' };
      const row = db.prepare('SELECT "作品ID","作品类型","作品标题","作品描述","作品标签","发布时间","采集时间","作者昵称","作者ID","作品链接","下载地址" FROM explore_data WHERE "作品ID"=?').get(String(sourceContentId));
      if (!row) return { ok: false, reason: 'source_id_missing' };
      const count = db.prepare('SELECT COUNT(*) AS count FROM explore_data WHERE "作品ID"=?').get(String(sourceContentId)).count;
      const rowUrl = new URL(String(row['作品链接']));
      const rowId = rowUrl.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})$/i)?.[1]
        ?? rowUrl.pathname.match(/\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})$/i)?.[1];
      if (count !== 1 || rowId?.toLowerCase() !== String(sourceContentId).toLowerCase()) return { ok: false, reason: 'source_id_mismatch' };
      const downloadUrls = String(row['下载地址'] ?? '').match(/https?:\/\//g) ?? [];
      const mediaKind = /视频/.test(String(row['作品类型'] ?? '')) ? 'video' : downloadUrls.length > 0 ? 'image' : 'text';
      return {
        ok: true,
        path: dbPath,
        mediaKind,
        expectedImageCount: mediaKind === 'image' ? downloadUrls.length : 0,
        sourceCollectionTime: row['采集时间'] == null ? null : String(row['采集时间']),
        body: String(row['作品描述'] ?? ''),
        stableBody: {
          title: String(row['作品标题'] ?? ''),
          description: String(row['作品描述'] ?? ''),
          tags: String(row['作品标签'] ?? ''),
          published_at: String(row['发布时间'] ?? ''),
          author_name: String(row['作者昵称'] ?? ''),
          author_id: String(row['作者ID'] ?? ''),
        },
      };
    } catch {
      return { ok: false, reason: 'cli_database_invalid' };
    } finally {
      db?.close();
    }
  }

  function numberedImages(paths) {
    return paths.filter((path) => ['.jpeg', '.jpg', '.png', '.webp'].includes(extname(path).toLowerCase()))
      .sort((left, right) => {
        const leftNumber = Number(left.match(/_(\d+)\.(?:jpe?g|png|webp)$/i)?.[1] ?? 0);
        const rightNumber = Number(right.match(/_(\d+)\.(?:jpe?g|png|webp)$/i)?.[1] ?? 0);
        return leftNumber - rightNumber || left.localeCompare(right);
      });
  }

  async function validateArtifacts(attemptDir, receipt, verifyDecode = true) {
    if (!receipt || !Array.isArray(receipt.files) || !receipt.material) return false;
    const intent = await readJson(join(attemptDir, 'intent.json'));
    if (!intent || intent.attempt_id !== receipt.attempt_id || intent.source_content_id !== receipt.source_content_id || intent.complete_source_url_hash !== receipt.complete_source_url_hash || sha256(intent.complete_source_url) !== receipt.complete_source_url_hash) return false;
    if (receipt.status !== 'succeeded' || receipt.business?.total !== 1 || receipt.business?.succeeded !== 1 || receipt.business?.failed !== 0 || receipt.business?.skipped !== 0) return false;
    if (!receipt.source_evidence?.database_valid || !receipt.source_evidence.description_matches || !receipt.source_evidence.image_order_valid) return false;
    if (receipt.material.media_kind === 'image' && receipt.material.images.length !== receipt.source_evidence.expected_image_count) return false;
    if (!receipt.material.body_path) return false;
    if (receipt.artifact_hash !== sha256(JSON.stringify({ business: receipt.business, exitCode: receipt.exit_code, files: receipt.files, material: receipt.material, sourceEvidence: receipt.source_evidence }))) return false;
    for (const file of receipt.files) {
      const path = resolve(attemptDir, file.path);
      if (!path.startsWith(`${resolve(attemptDir)}${sep}`)) return false;
      let info;
      try { info = await stat(path); } catch { return false; }
      if (!info.isFile() || info.size !== file.size || await hashFile(path) !== file.sha256) return false;
    }
    const bodyPath = resolve(attemptDir, receipt.material.body_path);
    if (await hashFile(bodyPath) !== receipt.material.body_hash) return false;
    for (const image of receipt.material.images) {
      const path = resolve(attemptDir, image.path);
      if (await hashFile(path) !== image.hash) return false;
      if (verifyDecode) await decodeImage(path);
    }
    return true;
  }

  function addCheckpointOutcome(token, batchId, sourceContentId, attemptId, status, receiptRef = privatePath('attempts', attemptId, 'receipt.json')) {
    if (!batchId) return;
    const prior = store.db.prepare('SELECT pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,output_hash FROM checkpoint WHERE owner=? AND run_id=? AND stage LIKE ? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(token.owner, token.runId, `collection:${batchId}:%`);
    if (!prior) return;
    const pending = JSON.parse(prior.pending_ids_json).filter((id) => id !== String(sourceContentId));
    const succeeded = JSON.parse(prior.succeeded_refs_json);
    const failed = JSON.parse(prior.failed_refs_json);
    const unknown = JSON.parse(prior.unknown_refs_json);
    if (status === 'succeeded') succeeded.push(receiptRef);
    else if (status === 'unknown') unknown.push(receiptRef);
    else failed.push(receiptRef);
    const output = { pending, succeeded, failed, unknown };
    store.transaction(() => store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
      VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(
      uuid(), token.owner, token.runId, token.generation, `collection:${batchId}:material:${attemptId}`,
      JSON.stringify(pending), JSON.stringify(succeeded), JSON.stringify(failed), JSON.stringify(unknown),
      prior.output_hash, sha256(JSON.stringify(output)), 0, now(),
    ));
  }

  async function saveNonSuccess(receipt, attemptDir, token, receiptPath = privatePath('attempts', receipt.attempt_id, 'receipt.json')) {
    if (token) assertCurrent(token);
    const content = store.db.prepare('SELECT content_id FROM content WHERE platform=? AND source_content_id=?').get(PLATFORM, receipt.source_content_id);
    if (!content || !receipt.material) return;
    const images = receipt.material.images.filter((image) => image.hash).map((image, index) => ({ index, path: resolve(attemptDir, image.path), hash: image.hash }));
    const bodyPath = receipt.material.body_path ? resolve(attemptDir, receipt.material.body_path) : null;
    store.transaction(() => {
      saveMaterialVersion(store, {
        content_id: content.content_id,
        body_ref: bodyPath ? resolve(bodyPath) : null,
        body_hash: receipt.material.body_hash ?? sha256(''),
        ordered_images: images,
        media_kind: MEDIA_KINDS.has(receipt.material.media_kind) ? receipt.material.media_kind : 'unknown',
        fetched_at: receipt.completed_at,
        completeness: receipt.material.completeness ?? (receipt.status === 'failed' ? 'partial' : 'unknown'),
        fetch_status: receipt.status === 'source_deleted' ? 'failed'
          : FETCH_STATES.has(receipt.status) ? receipt.status : 'unknown',
        evidence_refs: [receiptPath],
      });
      if (receipt.status === 'blocked') store.db.prepare("UPDATE content SET source_state='access_blocked',last_observed_at=? WHERE content_id=?").run(now(), content.content_id);
      if (receipt.status === 'source_deleted' && receipt.source_deleted_evidence_ref) {
        store.db.prepare("UPDATE content SET source_state='source_deleted',last_observed_at=? WHERE content_id=?").run(now(), content.content_id);
      }
      addCheckpointOutcome(token, receipt.batch_id, receipt.source_content_id, receipt.attempt_id, receipt.status, receiptPath);
    });
  }

  async function saveReceipt(receipt, attemptDir, token, receiptPath = privatePath('attempts', receipt.attempt_id, 'receipt.json')) {
    if (!await validateArtifacts(attemptDir, receipt)) throw new Error('receipt artifacts failed hash or image validation');
    const content = store.db.prepare('SELECT content_id FROM content WHERE platform=? AND source_content_id=?').get(PLATFORM, receipt.source_content_id);
    if (!content) throw new Error('receipt source content is not in the collection store');
    const orderedImages = receipt.material.images.map((image, index) => ({ index, path: resolve(attemptDir, image.path), hash: image.hash }));
    const materialFingerprint = materialHash({ body_hash: receipt.material.body_hash, ordered_images: orderedImages, media_kind: receipt.material.media_kind, cover_hash: receipt.material.cover_hash ?? null });
    const duplicateCandidates = receipt.material.repair_of_material_version_id
      ? store.db.prepare(`SELECT * FROM material_version WHERE content_id=? AND material_hash=? AND repair_of_material_version_id=? AND fetch_status='succeeded'`).all(content.content_id, materialFingerprint, receipt.material.repair_of_material_version_id)
      : store.db.prepare(`SELECT * FROM material_version WHERE content_id=? AND material_hash=? AND repair_of_material_version_id IS NULL AND fetch_status='succeeded'`).all(content.content_id, materialFingerprint);
    const duplicate = duplicateCandidates.find((row) => row.body_ref === resolve(attemptDir, receipt.material.body_path)
      && row.cover_ref === (receipt.material.cover_ref ? resolve(attemptDir, receipt.material.cover_ref) : null)
      && JSON.stringify(JSON.parse(row.ordered_images_json)) === JSON.stringify(orderedImages));
    const exactDuplicateValid = duplicate ? await validateMaterialVersionRow(duplicate) : false;
    let hasValidDuplicate = exactDuplicateValid;
    for (const candidate of duplicateCandidates) {
      if (hasValidDuplicate) break;
      hasValidDuplicate = await validateMaterialVersionRow(candidate);
    }
    if (duplicate && !exactDuplicateValid || duplicateCandidates.length && !hasValidDuplicate && !receipt.material.repair_of_material_version_id) {
      throw new Error('duplicate material references failed integrity validation');
    }
    if (token) assertCurrent(token);
    const result = store.transaction(() => {
      const savedMaterial = saveMaterialVersion(store, {
        content_id: content.content_id,
        body_ref: resolve(attemptDir, receipt.material.body_path),
        body_hash: receipt.material.body_hash,
        ordered_images: orderedImages,
        cover_ref: receipt.material.cover_ref ? resolve(attemptDir, receipt.material.cover_ref) : null,
        cover_hash: receipt.material.cover_hash ?? null,
        media_kind: receipt.material.media_kind,
        repair_of_material_version_id: receipt.material.repair_of_material_version_id ?? null,
        fetched_at: receipt.completed_at,
        completeness: receipt.material.completeness,
        fetch_status: receipt.status,
        evidence_refs: [receiptPath],
      });
      store.db.prepare("UPDATE content SET source_state='available',last_observed_at=? WHERE content_id=?").run(receipt.completed_at, content.content_id);
      addCheckpointOutcome(token, receipt.batch_id, receipt.source_content_id, receipt.attempt_id, 'succeeded', receiptPath);
      return savedMaterial;
    });
    return { status: result.status, material_version_id: result.entity_id, completeness: receipt.material.completeness, attempt_id: receipt.attempt_id };
  }

  async function existingMaterial(sourceContentId) {
    const rows = store.db.prepare("SELECT * FROM material_version WHERE content_id=(SELECT content_id FROM content WHERE platform=? AND source_content_id=?) AND fetch_status='succeeded' ORDER BY fetched_at DESC, rowid DESC").all(PLATFORM, sourceContentId);
    for (const row of rows) {
      const integrity = await inspectMaterialVersionRow(row);
      if (integrity.valid) return { status: 'duplicate', material_version_id: row.material_version_id, completeness: row.completeness, source_not_rechecked: true };
      if (!integrity.readable) return { status: 'unrepairable', material_version_id: row.material_version_id, reason: 'stored_material_manifest_invalid' };
      return {
        status: 'repair', row, rootVersionId: row.repair_of_material_version_id ?? row.material_version_id,
        validImages: integrity.validImages, missingIndexes: integrity.missingIndexes, imageCount: integrity.images.length,
        bodyInvalid: !integrity.bodyValid, coverInvalid: !integrity.coverValid, coverValid: integrity.coverValid,
      };
    }
    return null;
  }

  async function inspectMaterialVersionRow(row) {
    let images;
    try { images = JSON.parse(row.ordered_images_json); if (!Array.isArray(images)) return { readable: false }; }
    catch { return { readable: false }; }
    const bodyPath = row.body_ref ? resolve(row.body_ref) : '';
    let bodyValid = false;
    try { bodyValid = Boolean(row.body_ref && bodyPath.startsWith(`${privateRoot}${sep}`) && await hashFile(bodyPath) === row.body_hash); } catch { /* 缺失或损坏的正文可走独立repair。 */ }
    const validImages = [];
    const missingIndexes = [];
    for (const [position, image] of images.entries()) {
      const imagePath = image.path ? resolve(image.path) : '';
      try {
        if (!image.path || !imagePath.startsWith(`${privateRoot}${sep}`) || await hashFile(imagePath) !== image.hash) throw new Error('image hash mismatch');
        await decodeImage(imagePath);
        validImages.push({ ...image, path: imagePath });
      } catch { missingIndexes.push(position + 1); }
    }
    let coverValid = row.cover_hash == null;
    if (row.cover_hash != null) {
      const coverPath = row.cover_ref ? resolve(row.cover_ref) : '';
      try {
        coverValid = Boolean(row.cover_ref && coverPath.startsWith(`${privateRoot}${sep}`) && await hashFile(coverPath) === row.cover_hash);
        if (coverValid) await decodeImage(coverPath);
      } catch { coverValid = false; }
    }
    return { readable: true, valid: bodyValid && missingIndexes.length === 0 && coverValid, bodyValid, coverValid, images, validImages, missingIndexes };
  }

  async function validateMaterialVersionRow(row) {
    return (await inspectMaterialVersionRow(row)).valid === true;
  }

  async function reuseValidImages(outputDir, repair, sourceContentId) {
    if (!repair) return { reused: false, changed: false };
    const evidence = await inspectCliDatabase(outputDir, sourceContentId);
    if (!evidence.ok || evidence.mediaKind !== 'image' || evidence.expectedImageCount !== repair.imageCount) return { reused: false, changed: true };
    const stableBody = `${JSON.stringify(evidence.stableBody)}\n`;
    if (sha256(stableBody) !== repair.row.body_hash) return { reused: false, changed: true };
    for (const image of repair.validImages) {
      const extension = extname(image.path).toLowerCase() || '.jpeg';
      const target = join(outputDir, `cached_${image.index + 1}${extension}`);
      try {
        await stat(target);
        if (await hashFile(target) !== image.hash) return { reused: false, changed: true };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const duplicateDownloads = numberedImages(await listFiles(outputDir)).filter((path) => Number(path.match(/_(\d+)\.(?:jpe?g|png|webp)$/i)?.[1]) === image.index + 1);
        for (const duplicate of duplicateDownloads) await rename(duplicate, `${duplicate}.redundant`);
        await copyFile(image.path, target);
      }
    }
    return { reused: true, changed: false };
  }

  async function prepareReceipt(attempt, attemptDir, outputDir, cliResult, sourceObservation) {
    const business = cliResult.business ?? parseBusinessSummary(cliResult.stdout);
    const outputFiles = await listFiles(outputDir);
    const sourceEvidence = await inspectCliDatabase(outputDir, attempt.source_content_id);
    const bodyFiles = outputFiles.filter((path) => extname(path).toLowerCase() === '.txt');
    const images = numberedImages(outputFiles);
    const imagePaths = images.map((path) => relative(attemptDir, path));
    const downloadedBodyPath = bodyFiles.length === 1 ? bodyFiles[0] : null;
    const bodyPath = sourceEvidence.ok ? join(attemptDir, 'material', 'body.json') : null;
    const sourceKind = sourceObservation?.media_kind ?? sourceEvidence.mediaKind ?? 'unknown';
    const authBlocked = cliResult.blocked === true || /captcha|login required|please log ?in|sign in to continue|登录后查看|请先登录|请登录|登录页面|登录状态|验证码|扫码登录/i.test(`${cliResult.stdout ?? ''}\n${cliResult.stderr ?? ''}`);
    let descriptionMatches = false;
    if (downloadedBodyPath && sourceEvidence.ok) {
      const body = (await readFile(downloadedBodyPath, 'utf8')).replace(/^\uFEFF/, '');
      const normalizedBody = normalizeText(body);
      const normalizedDescription = normalizeText(sourceEvidence.body);
      descriptionMatches = !normalizedDescription || normalizedBody.includes(normalizedDescription);
    }
    if (bodyPath && sourceEvidence.ok) {
      await mkdir(dirname(bodyPath), { recursive: true });
      const canonicalBody = `${JSON.stringify(sourceEvidence.stableBody)}\n`;
      try {
        const priorBody = await readFile(bodyPath, 'utf8');
        if (priorBody !== canonicalBody) descriptionMatches = false;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeFile(bodyPath, canonicalBody, { flag: 'wx' });
      }
    }
    const orderedFileIndexes = images.map((path) => Number(path.match(/_(\d+)\.(?:jpe?g|png|webp)$/i)?.[1]));
    const imageOrderValid = orderedFileIndexes.every((index, position) => index === position + 1);
    let status = 'unknown';
    let completeness = 'unknown';
    if (cliResult.reliableSourceDeleted === true && cliResult.sourceDeletedEvidenceRef) { status = 'source_deleted'; completeness = 'unknown'; }
    else if (authBlocked) { status = 'blocked'; completeness = 'failed'; }
    else if (cliResult.exitCode !== 0 || cliResult.signal) { status = 'unknown'; completeness = 'unknown'; }
    else if (business?.total === 1 && business.succeeded === 1 && business.failed === 0 && business.skipped === 0 && sourceEvidence.ok && bodyPath && descriptionMatches && imageOrderValid && (sourceKind !== 'image' || images.length === sourceEvidence.expectedImageCount)) {
      status = 'succeeded';
      completeness = sourceKind === 'video' ? 'video_unread' : 'complete';
    } else if (business && (business.failed > 0 || business.skipped > 0)) { status = 'failed'; completeness = 'partial'; }
    const databasePath = sourceEvidence.path;
    const markdownPaths = outputFiles.filter((path) => extname(path).toLowerCase() === '.md');
    const cliEvidencePath = join(attemptDir, 'cli-output.json');
    const included = status === 'succeeded' ? [bodyPath, downloadedBodyPath, ...images, ...markdownPaths, databasePath, cliEvidencePath] : [...outputFiles.filter((path) => ['.txt', '.md', '.jpeg', '.jpg', '.png', '.webp'].includes(extname(path).toLowerCase())), cliEvidencePath];
    const fileRecords = [];
    for (const path of included.filter(Boolean)) {
      fileRecords.push({ path: relative(attemptDir, path), size: (await stat(path)).size, sha256: await hashFile(path) });
    }
    let material = { completeness, media_kind: sourceKind, body_path: bodyPath ? relative(attemptDir, bodyPath) : null, body_hash: bodyPath ? await hashFile(bodyPath) : sha256(''), images: imagePaths.map((path, index) => ({ path, hash: fileRecords.find((file) => file.path === path)?.sha256, index })) };
    if (status === 'succeeded') {
      if (!bodyPath || !sourceEvidence.ok || fileRecords.length !== 3 + images.length + markdownPaths.length + 1) { status = 'unknown'; completeness = 'unknown'; material.completeness = completeness; }
      try { for (const image of material.images) await decodeImage(resolve(attemptDir, image.path)); }
      catch { status = 'unknown'; completeness = 'partial'; material.completeness = completeness; }
    }
    const runState = await readJson(join(privateRoot, 'runs', attempt.run_id, 'run.json'));
    const receipt = {
      schema_version: 1,
      attempt_id: attempt.attempt_id,
      run_id: attempt.run_id,
      batch_id: runState?.collection_batch_id ?? null,
      source_content_id: attempt.source_content_id,
      complete_source_url_hash: attempt.complete_source_url_hash,
      business,
      source_evidence: { source_content_id: String(attempt.source_content_id), database_path: databasePath ? resolve(databasePath) : null, database_hash: databasePath ? await hashFile(databasePath) : null, source_collection_time_raw: sourceEvidence.sourceCollectionTime ?? null, source_collection_time_timezone: sourceEvidence.sourceCollectionTime == null ? null : 'Asia/Shanghai', description_matches: descriptionMatches, expected_image_count: sourceEvidence.expectedImageCount ?? null, image_order_valid: imageOrderValid, database_valid: sourceEvidence.ok },
      exit_code: cliResult.exitCode,
      signal: cliResult.signal ?? null,
      status,
      source_deleted_evidence_ref: cliResult.sourceDeletedEvidenceRef ?? null,
      completed_at: cliResult.completed_at ?? attempt.started_at ?? now(),
      verified_at: now(),
      files: fileRecords,
      material,
    };
    const artifactHash = sha256(JSON.stringify({ business, exitCode: receipt.exit_code, files: fileRecords, material, sourceEvidence: receipt.source_evidence }));
    receipt.artifact_hash = artifactHash;
    return receipt;
  }

  async function ensureMaterialInner(sourceContentId, completeSourceUrl, options = {}) {
    const token = currentToken(options.token);
    const url = validateUrl(sourceContentId, completeSourceUrl);
    const prior = store.db.prepare('SELECT content_id,source_state FROM content WHERE platform=? AND source_content_id=?').get(PLATFORM, sourceContentId);
    if (!prior) throw new Error('recordDiscovery must persist the source before material collection');
    if (prior.source_state === 'access_blocked') return { status: 'blocked', reason: 'source_requires_manual_access_recovery' };
    const cached = await existingMaterial(sourceContentId);
    const existing = options.refresh === true && cached?.status === 'duplicate' ? null : cached;
    if (existing?.status === 'duplicate') return existing;
    if (existing?.status === 'unrepairable') return { status: 'unknown', reason: existing.reason, material_version_id: existing.material_version_id };
    const repair = existing?.status === 'repair' ? existing : null;
    const executableState = await preflight();
    if (executableState.status !== 'ready') return { status: 'blocked', reason: executableState.reason };
    const runState = await readJson(join(privateRoot, 'runs', token.runId, 'run.json'));
    const attemptHistory = await attemptsFor(sourceContentId, runState?.collection_batch_id ?? null, token.runId);
    if (attemptHistory.unreceipted) return { status: 'unknown', reason: 'prior_attempt_without_receipt' };
    if (attemptHistory.count >= 2) return { status: 'unknown', reason: 'retry_limit_reached' };
    const attemptId = uuid();
    const attemptDir = join(privateRoot, 'attempts', attemptId);
    const workDir = join(attemptDir, 'work');
    const outputDir = join(workDir, 'Download');
    await mkdir(workDir, { recursive: true });
    const bodyOnlyRepair = Boolean(repair && repair.bodyInvalid && repair.missingIndexes.length === 0 && repair.validImages.length > 0);
    const attemptSettings = configuredSettings ? await prepareAttemptSettings(configuredSettings, attemptDir, workDir, { disableImageDownload: bodyOnlyRepair }) : null;
    const intent = {
      schema_version: 1,
      attempt_id: attemptId,
      source_content_id: String(sourceContentId),
      complete_source_url: url,
      complete_source_url_hash: urlHash(url),
      run_id: token.runId,
      batch_id: runState?.collection_batch_id ?? null,
      generation: token.generation,
      process_id: runtimeProcess?.pid ?? null,
      started_at: now(),
      status: 'intent',
    };
    await writeFile(join(attemptDir, 'intent.json'), `${JSON.stringify(intent, null, 2)}\n`, { flag: 'wx' });
    await persistRun(token, { state: 'running', current_attempt_id: attemptId, source_content_id: String(sourceContentId), url_hash: intent.complete_source_url_hash });
    if (typeof options.onAttempt === 'function') await options.onAttempt({ attemptId, runId: token.runId });
    assertCurrent(token);
    let cliResult;
    const cliStartedAt = now();
    try {
      cliResult = await invokeCli({ url, cwd: cliExecutable ? dirname(resolve(cliExecutable)) : attemptDir, workDir, outputDir, attemptId, sourceContentId: String(sourceContentId), settingsPath: attemptSettings, indexes: options.indexes ?? repair?.missingIndexes, bodyOnlyRepair,
        onSpawn: async info => {
          const processInfo = { ...info, attempt_id: attemptId, run_id: token.runId, stage: 'collection', parent_pid: process.pid };
          const processRef = join(attemptDir, 'process.json');
          await atomicJson(processRef, processInfo);
          await (options.onWorkerSpawned ?? onWorkerSpawned)({ stage: 'collection', attempt_id: attemptId, stage_run_id: token.runId,
            batch_id: runState?.collection_batch_id ?? null, process_ref: processRef, process_hash: await hashFile(processRef),
            process_id: processInfo.pid, parent_pid: process.pid, candidate_id: options.candidateId ?? null });
        } });
    } catch (error) {
      const cliCompletedAt = now();
      const errorCode = typeof error.code === 'string' ? error.code : null;
      await atomicJson(join(attemptDir, 'cli-output.json'), { error_name: error.name, error_code: errorCode, failure_phase: 'spawn', started_at: cliStartedAt, completed_at: cliCompletedAt });
      const receipt = { schema_version: 1, attempt_id: attemptId, run_id: intent.run_id, batch_id: intent.batch_id, source_content_id: String(sourceContentId), complete_source_url_hash: intent.complete_source_url_hash, status: 'unknown', error_name: error.name, error_code: errorCode, failure_phase: 'spawn', completed_at: cliCompletedAt, verified_at: cliCompletedAt, business: null, files: [], material: null };
      await atomicJson(join(attemptDir, 'receipt.json'), receipt);
      await persistRun(token, { state: 'unknown', current_attempt_id: attemptId });
      return { status: 'unknown', attempt_id: attemptId };
    }
    const cliCompletedAt = now();
    if (Number.isInteger(cliResult.child_pid)) options.onWorkerExited?.({ stage: 'collection', attempt_id: attemptId,
      stage_run_id: token.runId, process_id: cliResult.child_pid, exit_code: cliResult.exitCode ?? null, signal: cliResult.signal ?? null,
      timed_out: Boolean(cliResult.timedOut), ended_at: cliCompletedAt });
    cliResult = { ...cliResult, started_at: cliStartedAt, completed_at: cliCompletedAt };
    await atomicJson(join(attemptDir, 'cli-output.json'), {
      exit_code: cliResult.exitCode ?? null,
      signal: cliResult.signal ?? null,
      stdout: String(cliResult.stdout ?? ''),
      stderr: String(cliResult.stderr ?? ''),
      business: cliResult.business ?? null,
      started_at: cliStartedAt,
      completed_at: cliCompletedAt,
    });
    const stillCurrent = (() => { try { assertCurrent(token); return true; } catch { return false; } })();
    const reuse = await reuseValidImages(outputDir, repair, sourceContentId);
    const sourceObservation = await findObservation(sourceContentId, token.runId);
    const receipt = await prepareReceipt(intent, attemptDir, outputDir, cliResult, sourceObservation);
    receipt.source_not_rechecked = reuse.reused;
    if (repair && receipt.status === 'succeeded') {
      receipt.material.repair_of_material_version_id = repair.rootVersionId;
      receipt.artifact_hash = sha256(JSON.stringify({ business: receipt.business, exitCode: receipt.exit_code, files: receipt.files, material: receipt.material, sourceEvidence: receipt.source_evidence }));
    }
    if (reuse.changed) {
      receipt.status = 'unknown';
      receipt.material.completeness = 'partial';
      receipt.artifact_hash = sha256(JSON.stringify({ business: receipt.business, exitCode: receipt.exit_code, files: receipt.files, material: receipt.material, sourceEvidence: receipt.source_evidence }));
    }
    receipt.late_result = !stillCurrent;
    await atomicJson(join(attemptDir, 'receipt.json'), receipt);
    await afterReceipt({ attempt_id: attemptId, receipt_path: privatePath('attempts', attemptId, 'receipt.json') });
    const currentAfterReceipt = (() => { try { assertCurrent(token); return true; } catch { return false; } })();
    if (!stillCurrent || !currentAfterReceipt) {
      await atomicJson(join(attemptDir, 'late-result.json'), { attempt_id: attemptId, run_id: token.runId, generation: token.generation, marked_at: now(), receipt_hash: sha256(JSON.stringify(receipt)) });
      await persistRun(token, { state: 'late_result', current_attempt_id: attemptId });
      return { status: 'unknown', attempt_id: attemptId, late_result: true };
    }
    if (receipt.status === 'source_deleted' && receipt.source_deleted_evidence_ref) {
      await saveNonSuccess(receipt, attemptDir, token);
      await persistRun(token, { state: 'source_deleted', current_attempt_id: attemptId });
      return { status: 'source_deleted', attempt_id: attemptId, evidence_ref: privatePath('attempts', attemptId, 'receipt.json') };
    }
    if (receipt.status !== 'succeeded') {
      await saveNonSuccess(receipt, attemptDir, token);
      await persistRun(token, { state: receipt.status, current_attempt_id: attemptId });
      return { status: receipt.status, attempt_id: attemptId, completeness: receipt.material?.completeness ?? 'unknown', ...(receipt.repair_reason ? { reason: receipt.repair_reason } : {}) };
    }
    if (!await validateArtifacts(attemptDir, receipt)) throw new Error('new receipt failed verification before accounting');
    assertCurrent(token);
    const saved = await saveReceipt(receipt, attemptDir, token);
    await persistRun(token, { state: 'running', completed_attempt_id: attemptId, current_attempt_id: null });
    assertCurrent(token);
    return saved;
  }

  async function ensureMaterial(sourceContentId, completeSourceUrl, options = {}) {
    const result = await ensureMaterialInner(sourceContentId, completeSourceUrl, options);
    const material = result.material_version_id
      ? store.db.prepare('SELECT evidence_refs_json FROM material_version WHERE material_version_id=?').get(result.material_version_id)
      : store.db.prepare(`SELECT m.evidence_refs_json FROM material_version m JOIN content c USING(content_id)
        WHERE c.platform=? AND c.source_content_id=? ORDER BY m.fetched_at DESC,m.rowid DESC LIMIT 1`).get(PLATFORM, String(sourceContentId));
    const evidenceRefs = material ? JSON.parse(material.evidence_refs_json)
      : result.evidence_ref ? [result.evidence_ref]
        : result.attempt_id ? [privatePath('attempts', result.attempt_id, 'receipt.json')]
          : [];
    return { ...result, entity_id: result.material_version_id ?? String(sourceContentId), evidence_refs: evidenceRefs };
  }

  async function findObservation(sourceContentId, runId) {
    const base = join(privateRoot, 'runs', runId, 'observations');
    for (const file of await listFiles(base)) {
      if (!file.endsWith('.json')) continue;
      const record = await readJson(file);
      const observation = record?.observations?.find((item) => item.content_id === String(sourceContentId));
      if (observation) return observation;
    }
    return null;
  }

  async function findAnyObservation(sourceContentId, batchId) {
    const runsDir = join(privateRoot, 'runs');
    let runs = [];
    try { runs = await readdir(runsDir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const run of runs.filter((entry) => entry.isDirectory())) {
      const base = join(runsDir, run.name, 'observations');
      for (const file of await listFiles(base)) {
        if (!file.endsWith('.json')) continue;
        const record = await readJson(file);
        if (record?.batch_id !== batchId) continue;
        const observation = record.observations?.find((item) => item.content_id === String(sourceContentId));
        if (observation) return observation;
      }
    }
    return null;
  }

  async function recheckAttemptInner(attemptId, { token } = {}) {
    const runToken = currentToken(token);
    if (typeof attemptId !== 'string' || !/^[a-f\d-]{36}$/i.test(attemptId)) throw new TypeError('attemptId must be a UUID');
    const attemptDir = join(privateRoot, 'attempts', attemptId);
    const intent = await readJson(join(attemptDir, 'intent.json'));
    const prior = await readJson(join(attemptDir, 'receipt.json'));
    if (!intent || !prior || intent.attempt_id !== attemptId || prior.attempt_id !== attemptId || prior.status === 'succeeded') {
      throw new Error('attempt does not have a recheckable non-success receipt');
    }
    if (sha256(intent.complete_source_url) !== intent.complete_source_url_hash || prior.complete_source_url_hash !== intent.complete_source_url_hash || prior.source_content_id !== intent.source_content_id) {
      throw new Error('attempt receipt does not bind to its original private input');
    }
    const outputDir = join(attemptDir, 'work', 'Download');
    let cliResult = await readJson(join(attemptDir, 'cli-output.json'));
    if (!cliResult || !('exit_code' in cliResult)) {
      cliResult = { exitCode: prior.exit_code, signal: prior.signal, business: prior.business, stdout: '', stderr: '', completed_at: prior.completed_at };
      await atomicJson(join(attemptDir, 'cli-output.json'), { exit_code: cliResult.exitCode ?? null, signal: cliResult.signal ?? null, stdout: '', stderr: '', business: cliResult.business ?? null, started_at: intent.started_at, completed_at: prior.completed_at, recovered_output_record: true });
    } else {
      cliResult = { ...cliResult, exitCode: cliResult.exit_code, business: cliResult.business ?? prior.business };
      cliResult.completed_at ??= prior.completed_at;
    }
    const sourceObservation = await findObservation(intent.source_content_id, intent.run_id);
    const receipt = await prepareReceipt(intent, attemptDir, outputDir, cliResult, sourceObservation);
    receipt.rechecked_at = now();
    receipt.rechecked_from = sha256(JSON.stringify(prior));
    const receiptPath = join(attemptDir, `receipt.rechecked-${uuid()}.json`);
    await atomicJson(receiptPath, receipt);
    assertCurrent(runToken);
    if (receipt.status === 'succeeded') {
      if (!await validateArtifacts(attemptDir, receipt)) throw new Error('rechecked receipt failed artifact verification');
      const result = await saveReceipt(receipt, attemptDir, runToken, receiptPath);
      await persistRun(runToken, { state: 'running', rechecked_attempt_id: attemptId });
      assertCurrent(runToken);
      return { ...result, rechecked: true, receipt_path: resolve(receiptPath) };
    }
    await saveNonSuccess(receipt, attemptDir, runToken, receiptPath);
    return { status: receipt.status, attempt_id: attemptId, rechecked: true, receipt_path: resolve(receiptPath) };
  }

  async function recheckAttempt(attemptId, options = {}) {
    const result = await recheckAttemptInner(attemptId, options);
    const material = result.material_version_id
      ? store.db.prepare('SELECT evidence_refs_json FROM material_version WHERE material_version_id=?').get(result.material_version_id)
      : null;
    const evidenceRefs = material ? JSON.parse(material.evidence_refs_json)
      : result.receipt_path ? [result.receipt_path]
        : result.evidence_ref ? [result.evidence_ref]
          : [];
    return { ...result, entity_id: result.material_version_id ?? result.attempt_id ?? String(attemptId), evidence_refs: evidenceRefs };
  }

  async function commitReceipt(attemptId, { token, sourceContentId, originalRunId } = {}) {
    const runToken = currentToken(token);
    if (typeof attemptId !== 'string' || !/^[a-f\d-]{36}$/i.test(attemptId)) throw new TypeError('attemptId must be a UUID');
    if (!sourceContentId || typeof originalRunId !== 'string' || !originalRunId) throw new TypeError('sourceContentId and originalRunId are required');
    const attemptDir = join(privateRoot, 'attempts', attemptId);
    const intent = await readJson(join(attemptDir, 'intent.json'));
    if (!intent || intent.attempt_id !== attemptId || intent.source_content_id !== String(sourceContentId) || intent.run_id !== originalRunId) {
      throw new Error('attempt identity does not match the requested receipt recovery');
    }
    const entries = await readdir(attemptDir, { withFileTypes: true });
    const receiptPaths = entries.filter((entry) => entry.isFile() && /^receipt(?:\.rechecked-[a-f\d-]+)?\.json$/i.test(entry.name))
      .map((entry) => join(attemptDir, entry.name));
    const receipts = [];
    for (const receiptPath of receiptPaths) {
      const receipt = await readJson(receiptPath);
      if (receipt?.attempt_id === attemptId && receipt.run_id === originalRunId
          && receipt.source_content_id === String(sourceContentId)
          && receipt.complete_source_url_hash === intent.complete_source_url_hash && receipt.status === 'succeeded') {
        receipts.push({ receipt, receiptPath });
      }
    }
    receipts.sort((a, b) => String(b.receipt.verified_at ?? '').localeCompare(String(a.receipt.verified_at ?? '')));
    for (const { receipt, receiptPath } of receipts) {
      if (!await validateArtifacts(attemptDir, receipt)) continue;
      assertCurrent(runToken);
      const result = await saveReceipt(receipt, attemptDir, runToken, receiptPath);
      await persistRun(runToken, { state: 'running', committed_attempt_id: attemptId, source_content_id: String(sourceContentId) });
      assertCurrent(runToken);
      const material = store.db.prepare('SELECT evidence_refs_json FROM material_version WHERE material_version_id=?').get(result.material_version_id);
      return { ...result, attempt_id: attemptId, committed: true, entity_id: result.material_version_id,
        evidence_refs: material ? JSON.parse(material.evidence_refs_json) : [resolve(receiptPath)] };
    }
    return { status: 'unknown', attempt_id: attemptId, entity_id: attemptId, committed: false,
      reason: 'no_valid_success_receipt', evidence_refs: receiptPaths.map((path) => resolve(path)) };
  }

  async function resolvePreDispatchFailure(attemptId, { token, sourceContentId, candidateId, originalRunId, evidenceRef } = {}) {
    const runToken = currentToken(token);
    if (typeof attemptId !== 'string' || !/^[a-f\d-]{36}$/i.test(attemptId)) throw new TypeError('attemptId must be a UUID');
    if (!sourceContentId || !originalRunId || !evidenceRef) throw new TypeError('sourceContentId, originalRunId and evidenceRef are required');
    const attemptDir = join(privateRoot, 'attempts', attemptId);
    const intent = await readJson(join(attemptDir, 'intent.json'));
    const receipt = await readJson(join(attemptDir, 'receipt.json'));
    const cliOutput = await readJson(join(attemptDir, 'cli-output.json'));
    if (!intent || intent.attempt_id !== attemptId || intent.source_content_id !== String(sourceContentId) || intent.run_id !== originalRunId
        || !receipt || receipt.attempt_id !== attemptId || receipt.run_id !== originalRunId || receipt.source_content_id !== String(sourceContentId)
        || receipt.complete_source_url_hash !== intent.complete_source_url_hash || receipt.status !== 'unknown') {
      return { status: 'unknown', attempt_id: attemptId, reason: 'exact_pre_dispatch_enoent_failure_not_proven', evidence_refs: [resolve(join(attemptDir, 'receipt.json'))] };
    }
    if (receipt.failure_phase === 'spawn' && receipt.error_code === 'ENOENT' && cliOutput?.failure_phase === 'spawn' && cliOutput?.error_code === 'ENOENT') {
      assertCurrent(runToken);
      return { status: 'resolved_pre_dispatch_failure', resolution_kind: 'spawn_enoent_observed', attempt_id: attemptId,
        source_content_id: String(sourceContentId), original_run_id: originalRunId, receipt_ref: resolve(join(attemptDir, 'receipt.json')), evidence_ref: String(evidenceRef) };
    }
    let evidence;
    try { evidence = await readJson(resolve(String(evidenceRef).replace(/^file:/, ''))); } catch { evidence = null; }
    const intentRef = join(attemptDir, 'intent.json'), receiptRef = join(attemptDir, 'receipt.json'), cliOutputRef = join(attemptDir, 'cli-output.json');
    const outputFiles = await listFiles(join(attemptDir, 'work', 'Download'));
    const hasCommittedMaterial = store.db.prepare("SELECT 1 FROM material_version WHERE content_id=(SELECT content_id FROM content WHERE platform=? AND source_content_id=?) AND fetch_status='succeeded' LIMIT 1").get(PLATFORM, String(sourceContentId));
    let originalProcessStopped = false;
    if (Number.isInteger(intent.process_id) && runtimeProcess?.kill) {
      try { runtimeProcess.kill(intent.process_id, 0); } catch (error) { originalProcessStopped = error.code === 'ESRCH'; }
    }
    const legacyProofMatches = evidence?.resolution === 'precondition_repaired_no_output' && evidence.raw_errno_unavailable === true
      && evidence.attempt_id === attemptId && evidence.original_run_id === originalRunId && evidence.candidate_id === candidateId
      && evidence.source_content_id === String(sourceContentId) && evidence.slot === 'stopped'
      && evidence.original_process_id === intent.process_id && evidence.original_process_exited === true && originalProcessStopped
      && evidence.no_download_output === true && Array.isArray(evidence.output_files) && evidence.output_files.length === 0
      && typeof evidence.repair_evidence_ref === 'string' && evidence.repair_evidence_ref.length > 0
      && evidence.intent_hash === await hashFile(intentRef) && evidence.receipt_hash === await hashFile(receiptRef)
      && evidence.cli_output_hash === await hashFile(cliOutputRef) && outputFiles.length === 0 && !hasCommittedMaterial;
    if (!legacyProofMatches) return { status: 'unknown', attempt_id: attemptId, reason: 'legacy_failure_requires_exact_hashed_no_output_evidence', evidence_refs: [resolve(receiptRef)] };
    assertCurrent(runToken);
    return { status: 'resolved_pre_dispatch_failure', resolution_kind: 'precondition_repaired_no_output', attempt_id: attemptId, source_content_id: String(sourceContentId),
      original_run_id: originalRunId, receipt_ref: resolve(join(attemptDir, 'receipt.json')), evidence_ref: String(evidenceRef) };
  }

  async function resume(batchId, { token, accessRestoredEvidenceRef } = {}) {
    const temporary = token ? null : await claim();
    const runToken = token ?? temporary;
    try {
      assertCurrent(runToken);
      const runDir = join(privateRoot, 'attempts');
      let entries = [];
      try { entries = await readdir(runDir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const results = [];
      const observationRows = batchId ? store.db.prepare('SELECT DISTINCT c.content_id,c.source_content_id FROM collection_observation o JOIN content c USING(content_id) WHERE o.collection_batch_id=? ORDER BY c.source_content_id').all(batchId) : [];
      if (accessRestoredEvidenceRef) {
        const evidencePath = join(privateRoot, 'runs', runToken.runId, `access-restored-${uuid()}.json`);
        await atomicJson(evidencePath, { batch_id: batchId ?? null, evidence_ref: String(accessRestoredEvidenceRef), recorded_at: now() });
        assertCurrent(runToken);
        store.transaction(() => {
          assertCurrent(runToken);
          for (const row of observationRows) {
            store.db.prepare("UPDATE content SET source_state='unknown' WHERE content_id=? AND source_state='access_blocked'").run(row.content_id);
          }
        });
      }
      const pendingAtStart = observationRows;
      if (batchId && pendingAtStart.length) {
        store.transaction(() => store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
          VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(uuid(), runToken.owner, runToken.runId, runToken.generation,
          `collection:${batchId}:resume:${uuid()}`, JSON.stringify(pendingAtStart.map((row) => row.source_content_id)), '[]', '[]', '[]',
          sha256(JSON.stringify({ batchId, source_ids: pendingAtStart.map((row) => row.source_content_id) })), sha256('pending'), 0, now()));
      }
      for (const entry of entries.filter((item) => item.isDirectory())) {
        assertCurrent(runToken);
        const attemptDir = join(runDir, entry.name);
        let names = [];
        try { names = await readdir(attemptDir); } catch { continue; }
        if (names.includes('late-result.json')) continue;
        for (const name of names.filter((item) => /^receipt(?:\.rechecked-[a-f\d-]+)?\.json$/i.test(item))) {
          const receiptPath = join(attemptDir, name);
          const receipt = await readJson(receiptPath);
          if (!receipt || receipt.status !== 'succeeded' || receipt.late_result || (batchId && receipt.batch_id !== batchId)) continue;
          if (!await validateArtifacts(attemptDir, receipt)) { results.push({ status: 'unknown', attempt_id: receipt.attempt_id, reason: 'receipt_invalid' }); continue; }
          assertCurrent(runToken);
          try { results.push(await saveReceipt(receipt, attemptDir, runToken, receiptPath)); }
          catch { results.push({ status: 'unknown', source_content_id: receipt.source_content_id, attempt_id: receipt.attempt_id, reason: 'receipt_reconcile_failed' }); }
        }
      }
      const outcomeBySource = new Map();
      const processedSources = new Set();
      for (const row of observationRows) {
        assertCurrent(runToken);
        const sourceObservation = await findAnyObservation(row.source_content_id, batchId);
        if (!sourceObservation?.complete_source_url) {
          const missingEvidence = { status: 'unknown', source_content_id: row.source_content_id, entity_id: row.source_content_id, evidence_refs: [], reason: 'source_url_evidence_missing' };
          results.push(missingEvidence);
          outcomeBySource.set(row.source_content_id, 'unknown');
          processedSources.add(row.source_content_id);
          break;
        }
        const outcome = { ...await ensureMaterial(row.source_content_id, sourceObservation.complete_source_url, { token: runToken }), source_content_id: row.source_content_id };
        results.push(outcome);
        outcomeBySource.set(row.source_content_id, outcome.status);
        processedSources.add(row.source_content_id);
        if (outcome.status === 'duplicate') addCheckpointOutcome(runToken, batchId, row.source_content_id, 'cached', 'succeeded', `material_version:${outcome.material_version_id}`);
        if (outcome.status === 'blocked' || outcome.status === 'unknown') break;
      }
      await persistRun(runToken, { state: 'running', resumed_batch_id: batchId ?? null, reconciled_receipts: results.length });
      const stateRows = batchId ? store.db.prepare(`SELECT c.source_content_id,m.fetch_status,m.completeness FROM collection_observation o JOIN content c USING(content_id)
        LEFT JOIN material_version m ON m.content_id=c.content_id AND m.material_version_id=(SELECT material_version_id FROM material_version WHERE content_id=c.content_id ORDER BY fetched_at DESC,rowid DESC LIMIT 1)
        WHERE o.collection_batch_id=? GROUP BY c.source_content_id ORDER BY c.source_content_id`).all(batchId) : [];
      const currentStatuses = [...outcomeBySource.values()];
      const state = currentStatuses.includes('blocked') || stateRows.some((row) => row.fetch_status === 'blocked') ? 'blocked'
        : currentStatuses.includes('unknown') || stateRows.some((row) => row.fetch_status === 'unknown') ? 'unknown'
          : currentStatuses.includes('failed') || currentStatuses.includes('source_deleted') || stateRows.some((row) => row.fetch_status === 'failed') ? 'partial'
            : stateRows.some((row) => row.fetch_status !== 'succeeded') ? 'pending' : 'complete';
      const pendingIds = new Set(stateRows.filter((row) => row.fetch_status !== 'succeeded').map((row) => row.source_content_id));
      for (const [sourceId, outcome] of outcomeBySource) if (['blocked', 'unknown', 'failed', 'source_deleted'].includes(outcome)) pendingIds.add(sourceId);
      for (const row of observationRows) if (!processedSources.has(row.source_content_id)) pendingIds.add(row.source_content_id);
      const nextCheckpoint = store.db.prepare('SELECT checkpoint_id,stage,output_hash,committed_at FROM checkpoint WHERE owner=? AND run_id=? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(runToken.owner, runToken.runId);
      return {
        status: state,
        entity_id: batchId ?? runToken.runId,
        evidence_refs: [...new Set([...(nextCheckpoint ? [`checkpoint:${nextCheckpoint.checkpoint_id}`] : []), ...results.flatMap((item) => item.evidence_refs ?? [])])],
        reconciled: new Set(results.filter((item) => item.status === 'succeeded' || item.status === 'duplicate').map((item) => item.material_version_id).filter(Boolean)).size,
        observed_ids: observationRows.map((row) => row.source_content_id),
        pending_ids: [...pendingIds],
        failed_refs: [],
        unknown_refs: results.filter((item) => item.status === 'unknown').map((item) => item.attempt_id ?? item.source_content_id),
        next_checkpoint: nextCheckpoint ?? null,
        state,
        results,
      };
    } finally {
      if (temporary) await release(temporary);
    }
  }

  async function attemptsFor(sourceContentId, batchId, runId) {
    let entries = [];
    try { entries = await readdir(join(privateRoot, 'attempts'), { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let count = 0;
    let unreceipted = false;
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const dir = join(privateRoot, 'attempts', entry.name);
      const intent = await readJson(join(dir, 'intent.json'));
      if (intent?.source_content_id === String(sourceContentId)) {
        let attemptBatch = intent.batch_id;
        if (!attemptBatch) attemptBatch = (await readJson(join(privateRoot, 'runs', intent.run_id, 'run.json')))?.collection_batch_id;
        if (batchId && attemptBatch !== batchId) continue;
        const receipt = await readJson(join(dir, 'receipt.json'));
        if (!receipt) unreceipted = true;
        else if (intent.run_id === runId) count += 1;
      }
    }
    return { count, unreceipted };
  }

  return { claim, assertCurrent, requestStop, release, recover, recordDiscovery, ensureMaterial, recheckAttempt, commitReceipt, resolvePreDispatchFailure, preflight, resume };
}

export async function runCollectionCommand(argv = runtimeProcess?.argv.slice(2) ?? []) {
  const [command, ...args] = argv;
  if (!['resume', 'recover'].includes(command)) throw new TypeError('command must be resume or recover');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new TypeError('command options must be name-value pairs');
    options[key.slice(2)] = value;
  }
  for (const required of ['root', 'db', 'owner']) if (!options[required]) throw new TypeError(`--${required} is required`);
  if (command === 'recover' && (!options['confirmed-stopped-run-id'] || !options['evidence-ref'])) throw new TypeError('recover requires --confirmed-stopped-run-id and --evidence-ref');
  const store = openStore(options.db);
  const collector = createCollector({
    store,
    root: options.root,
    owner: options.owner,
    cli: { executable: options.executable, settingsPath: options.settings },
  });
  let token;
  try {
    if (options['confirmed-stopped-run-id']) {
      token = await collector.recover({ confirmedStoppedRunId: options['confirmed-stopped-run-id'], evidenceRef: options['evidence-ref'] });
    } else {
      token = await collector.claim();
    }
    const result = command === 'resume'
      ? await collector.resume(options.batch, { token, accessRestoredEvidenceRef: options['access-restored-evidence-ref'] })
      : { status: 'recovered', generation: token.generation };
    return result;
  } finally {
    if (token) await collector.release(token);
    store.close();
  }
}

if (runtimeProcess?.argv?.[1] && import.meta.url === pathToFileURL(resolve(runtimeProcess.argv[1])).href) {
  runCollectionCommand().then((result) => {
    runtimeProcess.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    runtimeProcess.stderr.write(`${error.name}: collection command failed\n`);
    runtimeProcess.exitCode = 1;
  });
}

async function decodeImageWithSystemDrawing(path) {
  const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $p=[Console]::In.ReadToEnd(); $image=[System.Drawing.Image]::FromFile($p); try { if($image.Width -lt 1 -or $image.Height -lt 1){throw 'invalid image dimensions'}; [Console]::Out.WriteLine(($image.Width.ToString()+','+$image.Height.ToString())) } finally { $image.Dispose() }";
  await new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { error += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 && /^\d+,\d+\r?\n?$/.test(output) ? resolvePromise() : reject(new Error(`image decode failed${code === null ? '' : ` (exit ${code})`}${error ? ': System.Drawing rejected the image' : ''}`)));
    child.stdin.end(path, 'utf8');
  });
}
