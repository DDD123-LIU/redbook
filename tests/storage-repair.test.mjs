// 2026-10-21 Codex：仅隔离合成SQLite，不访问私人数据库或采集资料。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const storage = await import('../src/storage.mjs');
const { openStore, restoreStore, saveContent, saveMaterialVersion, upgradeStoreV1 } = storage;
const root = mkdtempSync(join(tmpdir(), 'redbook-repair-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = () => randomUUID();
const check = async (label, run) => {
  try { await run(); console.log(`PASS ${label}`); }
  catch (error) { console.error(`FAIL ${label}: ${error.stack}`); process.exitCode = 1; }
};
const fresh = name => openStore(join(root, name));
const get = (store, sql, ...values) => store.db.prepare(sql).get(...values);
const count = (store, table) => get(store, `SELECT count(*) AS n FROM ${table}`).n;
function createV1Fixture(path, { active = false, material = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA application_id=1380201035; PRAGMA user_version=1;
    CREATE TABLE content(content_id TEXT PRIMARY KEY);
    CREATE TABLE execution_slot(slot_key TEXT PRIMARY KEY, state TEXT NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0, owner TEXT, run_id TEXT);
    INSERT INTO execution_slot(slot_key,state,stop_requested,owner,run_id) VALUES('main','${active ? 'running' : 'idle'}',0,${active ? "'owner'" : 'NULL'},${active ? "'run'" : 'NULL'});`);
  if (material) {
    db.exec(`CREATE TABLE material_version(
      material_version_id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES content(content_id), body_ref TEXT,
      body_hash TEXT, ordered_images_json TEXT NOT NULL DEFAULT '[]', cover_ref TEXT, cover_hash TEXT,
      media_kind TEXT NOT NULL, published_at TEXT, fetched_at TEXT NOT NULL, material_hash TEXT NOT NULL,
      completeness TEXT NOT NULL, evidence_refs_json TEXT NOT NULL DEFAULT '[]', fetch_status TEXT NOT NULL);
      CREATE UNIQUE INDEX material_success_hash_uq ON material_version(content_id,material_hash) WHERE fetch_status='succeeded';
      INSERT INTO content VALUES('content-1');
      INSERT INTO material_version VALUES('material-1','content-1','private://body-old','${hash('body')}',
        '[{"index":0,"path":"private://image-old","hash":"${hash('image')}"}]',NULL,NULL,
        'image',NULL,'2026-10-21T00:00:00.000Z','${hash('semantic')}','complete','[]','succeeded');`);
  }
  db.close();
}

await check('v2 repair保留原版本并按完整引用清单幂等追加', () => {
  const store = fresh('repair.db');
  const content = saveContent(store, { platform: 'synthetic', content_id: 'source-1' }).entity_id;
  const originalInput = {
    content_id: content, body_ref: 'private://body-old', body_hash: hash('body'), media_kind: 'image', completeness: 'complete',
    ordered_images: [{ index: 0, path: 'private://image-old', hash: hash('image') }], evidence_refs: ['synthetic://original'],
  };
  const original = saveMaterialVersion(store, originalInput);
  const repairInput = {
    ...originalInput, body_ref: 'private://body-repair',
    ordered_images: [{ index: 0, path: 'private://image-repair', hash: hash('image') }],
    repair_of_material_version_id: original.entity_id, evidence_refs: ['synthetic://repair'],
  };
  const repaired = saveMaterialVersion(store, repairInput);
  const replay = saveMaterialVersion(store, { ...repairInput, fetched_at: '2026-10-22T00:00:00.000Z' });
  const same = saveMaterialVersion(store, { ...repairInput, body_hash: originalInput.body_hash.toUpperCase() });
  assert.equal(store.schemaVersion, 3);
  assert.equal(repaired.status, 'succeeded');
  assert.equal(replay.status, 'duplicate');
  assert.equal(same.entity_id, repaired.entity_id);
  assert.equal(count(store, 'material_version'), 2);
  const originalRow = get(store, 'SELECT body_ref,material_hash,repair_of_material_version_id,artifact_hash FROM material_version WHERE material_version_id=?', original.entity_id);
  assert.equal(originalRow.body_ref, 'private://body-old');
  assert.equal(originalRow.repair_of_material_version_id, null);
  assert.equal(originalRow.artifact_hash, null);
  const row = get(store, 'SELECT * FROM material_version WHERE material_version_id=?', repaired.entity_id);
  assert.equal(row.repair_of_material_version_id, original.entity_id);
  assert.match(row.artifact_hash, /^[a-f0-9]{64}$/);
  assert.equal(row.material_hash, get(store, 'SELECT material_hash FROM material_version WHERE material_version_id=?', original.entity_id).material_hash);
  assert.equal(get(store, 'SELECT body_ref FROM material_version WHERE material_version_id=?', original.entity_id).body_ref, 'private://body-old');
  store.close();
});

await check('repair API拒绝跨内容、语义变化、非root和不完整引用', () => {
  const store = fresh('repair-reject.db');
  const firstContent = saveContent(store, { platform: 'synthetic', content_id: 'source-a' }).entity_id;
  const secondContent = saveContent(store, { platform: 'synthetic', content_id: 'source-b' }).entity_id;
  const rootInput = { content_id: firstContent, body: 'same', body_ref: 'private://body', media_kind: 'text', completeness: 'complete' };
  const rootMaterial = saveMaterialVersion(store, rootInput);
  const base = { ...rootInput, repair_of_material_version_id: rootMaterial.entity_id, body_ref: 'private://body-copy' };
  assert.throws(() => saveMaterialVersion(store, { ...base, content_id: secondContent }));
  assert.throws(() => saveMaterialVersion(store, { ...base, body: 'different' }));
  assert.throws(() => saveMaterialVersion(store, { ...base, completeness: 'partial' }));
  assert.throws(() => saveMaterialVersion(store, { ...base, body_ref: null }));
  const child = saveMaterialVersion(store, base);
  assert.throws(() => saveMaterialVersion(store, { ...base, repair_of_material_version_id: child.entity_id, body_ref: 'private://third' }));
  assert.throws(() => store.db.prepare(`INSERT INTO material_version(material_version_id,content_id,body_ref,body_hash,ordered_images_json,media_kind,fetched_at,material_hash,completeness,fetch_status,repair_of_material_version_id,artifact_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(), firstContent, 'private://sql', hash('same'), '[]', 'text', '2026-10-21', get(store, 'SELECT material_hash FROM material_version WHERE material_version_id=?', rootMaterial.entity_id).material_hash, 'complete', 'succeeded', 'missing-root', hash('artifact')));
  assert.throws(() => store.db.prepare(`INSERT INTO material_version(material_version_id,content_id,body_hash,ordered_images_json,media_kind,fetched_at,material_hash,completeness,fetch_status,artifact_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(uuid(), firstContent, hash('ordinary'), '[]', 'text', '2026-10-21', hash('ordinary-semantic'), 'complete', 'succeeded', hash('orphan-artifact')));
  store.close();
});

await check('显式v1升级保留只读源、v1备份和原素材行，并支持v1/v2恢复', async () => {
  const source = join(root, 'source-v1.db'), backupPath = join(root, 'source-backup-v1.db'), destination = join(root, 'upgraded-v2.db');
  createV1Fixture(source);
  const before = readFileSync(source);
  const result = await upgradeStoreV1(source, destination, { backupPath });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(readFileSync(source), before);
  assert.throws(()=>openStore(destination),/explicit upgrade/);
  const legacyV2 = new DatabaseSync(destination,{enableForeignKeyConstraints:true});
  const v2 = {db:legacyV2,schemaVersion:2,backup:path=>backup(legacyV2,path),close:()=>legacyV2.close()};
  assert.equal(v2.schemaVersion, 2);
  assert.equal(get(v2, 'SELECT body_ref FROM material_version WHERE material_version_id=?', 'material-1').body_ref, 'private://body-old');
  assert.equal(get(v2, 'PRAGMA user_version').user_version, 2);
  assert.deepEqual(v2.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => v2.db.prepare(`INSERT INTO material_version(material_version_id,content_id,body_hash,ordered_images_json,media_kind,fetched_at,material_hash,completeness,fetch_status,artifact_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(uuid(), 'content-1', hash('ordinary'), '[]', 'text', '2026-10-21', hash('ordinary-semantic'), 'complete', 'succeeded', hash('orphan-artifact')));
  const v2Backup = join(root, 'backup-v2.db'); await v2.backup(v2Backup); v2.close();
  const v2Restore = join(root, 'restore-v2.db'); await restoreStore(v2Backup, v2Restore,2);
  const restoredV2 = new DatabaseSync(v2Restore); assert.equal(restoredV2.prepare('PRAGMA user_version').get().user_version, 2); restoredV2.close();
  const v1Restore = join(root, 'restore-v1.db'); await restoreStore(backupPath, v1Restore, 1);
  const legacy = new DatabaseSync(v1Restore, { readOnly: true });
  assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(legacy.prepare('SELECT body_ref FROM material_version WHERE material_version_id=?').get('material-1').body_ref, 'private://body-old');
  legacy.close();
});

await check('v1活动槽或迁移失败不会发布目标且不会改源备份', async () => {
  const activeSource = join(root, 'active-v1.db'), activeBackup = join(root, 'active-backup.db'), activeTarget = join(root, 'active-v2.db');
  createV1Fixture(activeSource, { active: true });
  await assert.rejects(() => upgradeStoreV1(activeSource, activeTarget, { backupPath: activeBackup }), /active|slot/i);
  assert.equal(existsSync(activeTarget), false);
  const brokenSource = join(root, 'broken-v1.db'), brokenBackup = join(root, 'broken-backup.db'), brokenTarget = join(root, 'broken-v2.db');
  createV1Fixture(brokenSource, { material: false });
  await assert.rejects(() => upgradeStoreV1(brokenSource, brokenTarget, { backupPath: brokenBackup }));
  assert.equal(existsSync(brokenBackup), true);
  assert.equal(existsSync(brokenTarget), false);
  const backup = new DatabaseSync(brokenBackup, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1); backup.close();
});

await check('openStore拒绝隐式升级v1并保留文件', () => {
  const path = join(root, 'no-auto-upgrade.db'); createV1Fixture(path);
  const before = readFileSync(path);
  assert.throws(() => openStore(path), /explicit|upgrade|migration/i);
  assert.deepEqual(readFileSync(path), before);
});
