// 2026-10-21 Codex：合成数据与隔离临时库，不读私人材料，不连接平台。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

const results = [];
const root = mkdtempSync(join(tmpdir(), 'redbook-task007-'));
const storageUrl = new URL('../src/storage.mjs', import.meta.url).href;
const storage = await import(storageUrl);
assert.equal(typeof storage.openStore, 'function', '存储初始化入口必须存在');
const { openStore, restoreStore, materialHash, saveContent, saveMaterialVersion } = storage;
const at = '2026-10-21T04:00:00.000Z';
const uuid = () => randomUUID();
const hash = x => createHash('sha256').update(x).digest('hex');
let serial = 0;
const fresh = () => openStore(join(root, `store-${++serial}.db`));
const one = (s, sql, ...args) => s.db.prepare(sql).get(...args);
const rows = (s, sql, ...args) => s.db.prepare(sql).all(...args);
const run = (s, sql, ...args) => s.db.prepare(sql).run(...args);
const count = (s, table) => one(s, `SELECT count(*) n FROM ${table}`).n;
const slot = (s, input) => s.casSlot({ expectedOwner: null, expectedRunId: null, expectedGeneration: 0, expectedStopRequested: false, expectedRevision: 0, ...input });
function insert(s, table, data) {
  const keys = Object.keys(data);
  return run(s, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...Object.values(data));
}
async function check(name, input, expected, fn) {
  try {
    const actual = await fn();
    results.push({ name, input, expected, actual: actual ?? 'assertions passed', result: 'pass' });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, input, expected, result: 'fail', error: e.message });
    console.error(`FAIL ${name}: ${e.stack}`);
  }
}
function content(s, source = uuid()) {
  saveContent(s, { platform: 'synthetic', content_id: source, source_url_ref: 'private://synthetic/source', source_state: 'unknown', last_observed_at: at });
  return one(s, 'SELECT content_id FROM content WHERE platform=? AND source_content_id=?', 'synthetic', source).content_id;
}
function batch(s, { owner = 'owner', kind = 'daily_follow', command = null, day = '2026-10-21' } = {}) {
  const id = uuid();
  insert(s, 'batch', { delivery_batch_id: id, owner, command_id: command, kind, business_day: day, target: kind === 'daily_follow' ? 20 : 3, created_at: at, status: 'pending' });
  return id;
}
function material(s, cid, changed = 'body') {
  const id = uuid();
  insert(s, 'material_version', { material_version_id: id, content_id: cid, body_ref: 'private://body', body_hash: hash(changed), ordered_images_json: '[]', media_kind: 'text', fetched_at: at, material_hash: hash(changed), completeness: 'complete', fetch_status: 'succeeded' });
  return id;
}
function fixture(s) {
  const cid = content(s), bid = batch(s), mid = material(s, cid);
  const p = uuid(), strategy = uuid(), baseline = uuid(), analysis = uuid(), candidate = uuid(), decision = uuid(), rec = uuid();
  insert(s, 'preference_version', { preference_version: p, created_at: at });
  insert(s, 'strategy_version', { strategy_version: strategy, rule_diff_json: '{}', preference_version: p, effective_at: at, created_at: at });
  insert(s, 'baseline_version', { baseline_version: baseline, material_version_ids_json: JSON.stringify([mid]), coverage_description: 'synthetic partial only', created_at: at });
  insert(s, 'analysis', { analysis_id: analysis, material_version_id: mid, input_hash: hash('actual inputs'), prompt_version: 'test-v1', model_requested: 'synthetic', output_ref: 'private://analysis', completion_evidence: 'synthetic://completed', status: 'complete', created_at: at });
  insert(s, 'candidate', { candidate_id: candidate, content_id: cid, discovery_batch_id: bid, source: 'homefeed', discovered_at: at, source_evidence_ref: 'synthetic://home', eligibility_state: 'eligible' });
  insert(s, 'decision', { decision_id: decision, candidate_id: candidate, analysis_id: analysis, baseline_version: baseline, preference_version: p, strategy_version: strategy, category: 'follow', relevance: 'matched', gain_state: 'gain', result: 'eligible', created_at: at });
  insert(s, 'recommendation', { recommendation_id: rec, content_id: cid, delivery_batch_id: bid, decision_id: decision, category: 'follow', actual_preference_version: p, actual_strategy_version: strategy, state: 'pending', created_at: at });
  return { cid, bid, mid, p, strategy, baseline, analysis, candidate, decision, rec };
}
function attempt(s, rec, state = 'unknown', extra = {}) {
  const id = uuid();
  insert(s, 'delivery_attempt', { delivery_attempt_id: id, recommendation_id: rec, target_ref: 'private://target', payload_hash: hash('payload'), intent_at: at, status: state, created_at: at, ...extra });
  return id;
}

await check('初始化、schema、关闭后重开', 'new isolated DB', 'all entities; schema v2; persisted content', () => {
  const file = join(root, 'reopen.db');
  let s = openStore(file);
  assert.equal(s.schemaVersion, 3);
  assert.equal(one(s, 'PRAGMA foreign_keys').foreign_keys, 1);
  const names = rows(s, "SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name);
  for (const name of ['content','collection_observation','material_version','analysis','preference_version','strategy_version','baseline_version','candidate','decision','batch','recommendation','delivered_content','delivery_attempt','feedback_event','feedback_current','feedback_history','outbox','sample','report_revision','incident','execution_slot','checkpoint']) assert(names.includes(name), name);
  saveContent(s, { platform: 'synthetic', content_id: 'reopen', source_url_ref: 'private://synthetic/source', source_state: 'unknown', last_observed_at: at });
  s.close(); s = openStore(file);
  assert.equal(count(s, 'content'), 1); s.close();
});

await check('原生事务失败全部回滚', 'content insert then throw', 'no persisted half result', () => {
  const s = fresh();
  assert.throws(() => s.transaction(() => {
    saveContent(s, { platform: 'synthetic', content_id: 'rollback', source_url_ref: 'private://synthetic/source', source_state: 'unknown', last_observed_at: at });
    throw Error('injected write failure');
  }), /injected/);
  assert.equal(count(s, 'content'), 0); s.close();
});

await check('内容身份幂等且不按标题猜ID', 'same platform+source ID twice; same ID on another platform', 'two identities total', () => {
  const s = fresh(), id = content(s, 'same');
  assert.equal(content(s, 'same'), id);
  saveContent(s, { platform: 'other', content_id: 'same', source_state: 'unknown', last_observed_at: at });
  assert.equal(count(s, 'content'), 2); s.close();
});

await check('材料指纹忽略token和抓取时间，正文或图片变化区分', 'same body/media with changed fetch metadata', 'same stable hash; actual content changes differ', () => {
  const input = { bodyHash: hash('正文'), orderedImages: [{ index: 1, path: 'private://image-1', hash: hash('image') }], mediaKind: 'image' };
  const stable = materialHash(input);
  assert.equal(stable, materialHash({ ...input, fetchedAt: at, sourceUrl: 'https://example.com/?token=changed' }));
  assert.notEqual(stable, materialHash({ ...input, bodyHash: hash('正文变化') }));
  assert.notEqual(stable, materialHash({ ...input, orderedImages: [{ index: 1, path: 'private://image-1', hash: hash('changed image') }] }));
});

await check('实际FK和状态CHECK拒绝非法及悬空数据', 'orphan material + unknown delivery alias', 'SQLite rejects writes', () => {
  const s = fresh();
  assert.throws(() => material(s, uuid()), /FOREIGN KEY/);
  const f = fixture(s);
  assert.throws(() => attempt(s, f.rec, 'confirmed_success'), /CHECK/);
  assert.throws(() => attempt(s, uuid()), /FOREIGN KEY/);
  assert.equal(rows(s, 'PRAGMA foreign_key_check').length, 0); s.close();
});

await check('日批部分唯一键与命令幂等', 'daily same owner/day; two explicit commands', 'one daily; two additional; duplicate command rejected', () => {
  const s = fresh(); batch(s);
  assert.throws(() => batch(s), /UNIQUE/);
  batch(s, { kind: 'additional_follow', command: 'command-1' });
  batch(s, { kind: 'additional_follow', command: 'command-2' });
  assert.throws(() => batch(s, { kind: 'explore', command: 'command-1' }), /UNIQUE/);
  assert.equal(count(s, 'batch'), 3); s.close();
});

await check('unknown无核实证据不能成功；核实保留状态历史', 'unknown -> succeeded with/without reliable evidence', 'reject missing evidence; retain original unknown and final success', () => {
  const s = fresh(), f = fixture(s), id = attempt(s, f.rec);
  assert.throws(() => run(s, "UPDATE delivery_attempt SET status='succeeded' WHERE delivery_attempt_id=?", id));
  assert.equal(one(s, 'SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?', id).status, 'unknown');
  run(s, "UPDATE delivery_attempt SET status='succeeded',revision=revision+1,message_id=?,verification_evidence_refs_json=?,returned_at=? WHERE delivery_attempt_id=?", 'synthetic-message', '["synthetic://verified"]', at, id);
  const history = rows(s, 'SELECT new_status FROM delivery_attempt_history WHERE delivery_attempt_id=? ORDER BY history_id', id).map(x => x.new_status);
  assert.deepEqual(history, ['unknown', 'succeeded']); s.close();
});

await check('投递意图及状态写入失败同事务回滚', 'intent insert + recommendation state update + injected exception', 'no half intent or changed recommendation', () => {
  const s = fresh(), f = fixture(s);
  assert.throws(() => s.transaction(() => {
    attempt(s, f.rec, 'intent');
    run(s, "UPDATE recommendation SET state='intent',revision=revision+1 WHERE recommendation_id=? AND state='pending'", f.rec);
    throw Error('after intent');
  }), /after intent/);
  assert.equal(count(s, 'delivery_attempt'), 0);
  assert.equal(one(s, 'SELECT state FROM recommendation WHERE recommendation_id=?', f.rec).state, 'pending'); s.close();
});

await check('不可变产物与版本禁止覆盖或删除', 'UPDATE/DELETE previously successful material/version/analysis', 'original references and hashes retained', () => {
  const s = fresh(), f = fixture(s);
  for (const [table, column, id] of [['material_version','material_version_id',f.mid],['analysis','analysis_id',f.analysis],['preference_version','preference_version',f.p],['strategy_version','strategy_version',f.strategy],['decision','decision_id',f.decision]]) {
    assert.throws(() => run(s, `DELETE FROM ${table} WHERE ${column}=?`, id), table);
    assert.throws(() => run(s, `UPDATE ${table} SET ${column}=? WHERE ${column}=?`, uuid(), id), table);
  }
  assert.equal(count(s, 'material_version'), 1); s.close();
});

await check('成功材料复用不覆盖失败记录；内容变化新增历史', 'same hash repeated, changed body, failed attempt', 'successful versions remain; failed result separately traceable', () => {
  const s = fresh(), cid = content(s), id = material(s, cid);
  assert.throws(() => material(s, cid), /UNIQUE/);
  material(s, cid, 'changed body');
  insert(s, 'material_version', { material_version_id: uuid(), content_id: cid, media_kind: 'text', fetched_at: at, material_hash: hash('failed'), completeness: 'failed', fetch_status: 'failed' });
  assert.equal(count(s, 'material_version'), 3);
  assert.equal(one(s, 'SELECT body_ref FROM material_version WHERE material_version_id=?', id).body_ref, 'private://body'); s.close();
});

await check('分析失败后同实际输入可追加成功，不覆盖失败', 'failed then complete with same input/prompt', 'both records remain, one successful reusable result', () => {
  const s = fresh(), cid = content(s), mid = material(s, cid);
  const input = { material_version_id: mid, input_hash: hash('same'), prompt_version: 'v1', model_requested: 'synthetic', created_at: at };
  insert(s, 'analysis', { ...input, analysis_id: uuid(), status: 'failed' });
  insert(s, 'analysis', { ...input, analysis_id: uuid(), status: 'complete', completion_evidence: 'synthetic://complete', output_ref: 'private://output' });
  assert.equal(count(s, 'analysis'), 2); s.close();
});

await check('备份恢复到新路径，实体及关键关联一致', 'consistent SQLite backup then fresh restore', 'integrity_check ok; original and restored facts equal', async () => {
  const file = join(root, 'backup-source.db'), dest = join(root, 'backup.db'), restored = join(root, 'restored.db');
  const s = openStore(file), f = fixture(s);
  await s.backup(dest);
  const r = await restoreStore(dest, restored);
  const copy = r?.db ? r : openStore(restored);
  assert.equal(one(copy, 'PRAGMA integrity_check').integrity_check, 'ok');
  assert.equal(rows(copy, 'PRAGMA foreign_key_check').length, 0);
  assert.equal(one(copy, 'SELECT decision_id FROM recommendation WHERE recommendation_id=?', f.rec).decision_id, f.decision);
  assert.equal(count(copy, 'content'), count(s, 'content')); copy.close(); s.close();
});

await check('备份恢复失败不覆盖原库或已有目标', 'existing target + corrupt backup', 'source bytes and existing destination preserved', async () => {
  const source = join(root, 'preserve.db'), dest = join(root, 'occupied.db'), corrupt = join(root, 'broken.db');
  const s = openStore(source); content(s); s.close();
  writeFileSync(dest, 'do not overwrite'); writeFileSync(corrupt, 'invalid sqlite');
  const before = hash(readFileSync(source));
  await assert.rejects(async () => restoreStore(source, dest));
  await assert.rejects(async () => restoreStore(corrupt, join(root, 'invalid-restore.db')));
  assert.equal(readFileSync(dest, 'utf8'), 'do not overwrite');
  assert.equal(hash(readFileSync(source)), before);
});

await check('未知schema及非产品库拒绝且不改写', 'future schema; unrelated existing database', 'reject version mismatch and retain source', () => {
  const path = join(root, 'future.db'); let s = openStore(path); s.close();
  let raw = new DatabaseSync(path); raw.exec('PRAGMA user_version=999'); raw.close();
  const before = hash(readFileSync(path)); assert.throws(() => openStore(path));
  assert.equal(hash(readFileSync(path)), before);
  const old = join(root, 'legacy.db'); raw = new DatabaseSync(old); raw.exec('CREATE TABLE downloader_cache(id TEXT)'); raw.close();
  const oldHash = hash(readFileSync(old)); assert.throws(() => openStore(old));
  assert.equal(hash(readFileSync(old)), oldHash);
});

await check('局部快照缺失不推断取消，收藏时间缺失保留空值', 'A present in first partial snapshot; only B in next snapshot', 'A remains present; no invented collected_at', () => {
  const s = fresh(), a = content(s, 'A'), b = content(s, 'B'), first = uuid(), next = uuid();
  for (const id of [first,next]) insert(s, 'collection_batch', { collection_batch_id: id, observed_from: at, observed_until: at, coverage_json: '{"scope":"partial","unexplained_gaps":1}', total_known: 0, created_at: at });
  insert(s, 'collection_observation', { collection_observation_id: uuid(), collection_batch_id: first, content_id: a, observed_at: at, membership: 'present', evidence_ref: 'synthetic://first' });
  insert(s, 'collection_observation', { collection_observation_id: uuid(), collection_batch_id: next, content_id: b, observed_at: at, membership: 'present', evidence_ref: 'synthetic://next' });
  const observed = one(s, 'SELECT membership,collected_at FROM collection_observation WHERE content_id=?', a);
  assert.equal(observed.membership, 'present'); assert.equal(observed.collected_at, null);
  assert.equal(count(s, 'collection_observation'), 2);
  assert.throws(() => insert(s, 'collection_observation', { collection_observation_id: uuid(), collection_batch_id: uuid(), content_id: a, observed_at: at, membership: 'unknown', evidence_ref: 'synthetic://orphan' }), /FOREIGN KEY/); s.close();
});

await check('删除、获取失败、取消收藏和视频未读分别保存', 'four independent observed facts', 'states retained without inferring seen or feedback', () => {
  const s = fresh(), deleted = content(s, 'deleted'), unavailable = content(s, 'unavailable'), video = content(s, 'video'), cb = uuid();
  run(s, "UPDATE content SET source_state='source_deleted' WHERE content_id=?", deleted);
  run(s, "UPDATE content SET source_state='temporarily_unavailable' WHERE content_id=?", unavailable);
  insert(s, 'collection_batch', { collection_batch_id: cb, observed_from: at, observed_until: at, coverage_json: '{"scope":"partial"}', total_known: 0, created_at: at });
  insert(s, 'collection_observation', { collection_observation_id: uuid(), collection_batch_id: cb, content_id: deleted, observed_at: at, membership: 'present', evidence_ref: 'synthetic://still-favorite' });
  insert(s, 'collection_observation', { collection_observation_id: uuid(), collection_batch_id: cb, content_id: unavailable, observed_at: at, membership: 'confirmed_removed', evidence_ref: 'synthetic://explicit-removal' });
  insert(s, 'material_version', { material_version_id: uuid(), content_id: video, media_kind: 'video', fetched_at: at, material_hash: hash('video'), cover_ref: 'private://cover', completeness: 'video_unread', fetch_status: 'succeeded' });
  assert.equal(one(s, 'SELECT source_state FROM content WHERE content_id=?', deleted).source_state, 'source_deleted');
  assert.equal(one(s, 'SELECT membership FROM collection_observation WHERE content_id=?', deleted).membership, 'present');
  assert.equal(one(s, 'SELECT completeness FROM material_version WHERE content_id=?', video).completeness, 'video_unread');
  assert.equal(count(s, 'feedback_current'), 0); s.close();
});

function feedbackEvent(s, f, id = uuid(), value = 'like', revision = 1) {
  insert(s, 'feedback_event', { app_ref: 'app', chat_ref: 'chat', event_id: id, recommendation_id: f.rec, content_id: f.cid, value, received_at: at, saved_at: at, revision, parse_state: 'parsed', association_state: 'matched' });
  return id;
}
function feedbackCurrent(s, f, event) {
  const source = one(s, 'SELECT source_content_id FROM content WHERE content_id=?', f.cid).source_content_id;
  insert(s, 'feedback_current', { owner: 'owner', app_ref: 'app', chat_ref: 'chat', platform: 'synthetic', source_content_id: source, content_id: f.cid, recommendation_id: f.rec, value: 'like', revision: 1, event_id: event, saved_at: at });
  return source;
}
function outbox(s, f, revision = 1) {
  const id = uuid();
  insert(s, 'outbox', { outbox_id: id, kind: 'feedback_receipt', object_ref: f.cid, business_revision: revision, state: 'pending', created_at: at, updated_at: at });
  return id;
}

await check('反馈event/current/history/outbox原子保存、重放不重复', 'same event twice then injected outbox save failure', 'one committed vote/history/receipt; failed transaction replayable', () => {
  const s = fresh(), f = fixture(s), event = uuid();
  s.transaction(() => { feedbackEvent(s, f, event); feedbackCurrent(s, f, event); outbox(s, f); });
  assert.equal(count(s, 'feedback_history'), 1);
  assert.throws(() => s.transaction(() => { feedbackEvent(s, f, event); }), /UNIQUE/);
  const failedEvent = uuid();
  assert.throws(() => s.transaction(() => {
    feedbackEvent(s, f, failedEvent, 'dislike', 2);
    run(s, "UPDATE feedback_current SET value='dislike',revision=2,event_id=? WHERE content_id=? AND revision=1", failedEvent, f.cid);
    outbox(s, f); // 相同业务revision导致原生唯一键冲突。
  }), /UNIQUE/);
  assert.equal(count(s, 'feedback_event'), 1); assert.equal(count(s, 'feedback_history'), 1);
  assert.equal(one(s, 'SELECT value FROM feedback_current').value, 'like');
  feedbackEvent(s, f, failedEvent, 'dislike', 2);
  assert.equal(count(s, 'feedback_event'), 2); s.close();
});

await check('反馈保存与回执结果独立；过期反馈revision拒绝', 'save vote, receipt failure, then correction CAS', 'saved vote survives; stale revision changes0; history retained', () => {
  const s = fresh(), f = fixture(s), first = feedbackEvent(s, f), source = feedbackCurrent(s, f, first), box = outbox(s, f);
  assert.equal(s.casState({ entity: 'outbox', entity_id: box, expectedState: 'pending', expectedRevision: 0, nextState: 'failed' }).changes, 1);
  assert.equal(one(s, 'SELECT value FROM feedback_current').value, 'like');
  const second = feedbackEvent(s, f, uuid(), 'seen', 2);
  assert.equal(s.casFeedback({ owner: 'owner', platform: 'synthetic', sourceContentId: source, expectedRevision: 1, value: 'seen', eventId: second, savedAt: at }).changes, 1);
  assert.equal(s.casFeedback({ owner: 'owner', platform: 'synthetic', sourceContentId: source, expectedRevision: 1, value: 'dislike', eventId: first, savedAt: at }).changes, 0);
  assert.equal(one(s, 'SELECT value FROM feedback_current').value, 'seen');
  assert.deepEqual(rows(s, 'SELECT value FROM feedback_history ORDER BY revision').map(x => x.value), ['like','seen']); s.close();
});

await check('版本、样本、报告关联拒绝悬空且保留原修订', 'valid report + correction; orphan baseline and report links', 'valid graph and both immutable reports', () => {
  const s = fresh(), f = fixture(s), sample = uuid(), report = uuid();
  assert.equal(one(s, 'SELECT count(*) n FROM baseline_material WHERE baseline_version=?', f.baseline).n, 1);
  assert.throws(() => insert(s, 'baseline_material', { baseline_version: f.baseline, material_version_id: uuid() }));
  assert.throws(() => run(s,'DELETE FROM baseline_material WHERE baseline_version=?',f.baseline));
  insert(s, 'sample', { sample_id: sample, purpose: 'initial', category: 'follow', strategy_version: f.strategy, created_at: at });
  insert(s, 'sample_member', { sample_id: sample, recommendation_id: f.rec });
  assert.throws(() => insert(s, 'sample_member', { sample_id: sample, recommendation_id: uuid() }), /FOREIGN KEY/);
  insert(s, 'report_revision', { report_revision_id: report, sample_id: sample, event_revision: 1, snapshot_json: '{"state":"pending"}', reason: 'original cutoff', created_at: at });
  insert(s, 'report_revision', { report_revision_id: uuid(), sample_id: sample, parent_report_revision_id: report, event_revision: 2, snapshot_json: '{"state":"revised"}', reason: 'late feedback', created_at: at });
  assert.throws(() => run(s, 'UPDATE report_revision SET reason=? WHERE report_revision_id=?', 'overwrite original', report));
  assert.equal(count(s, 'report_revision'), 2); s.close();
});

await check('非法或不完整输入拒绝且无半记录', 'missing content identity; invalid state; invalid association', 'error and zero invalid rows', () => {
  const s = fresh();
  assert.throws(() => saveContent(s, {}));
  assert.throws(() => saveContent(s, { platform: 'synthetic', content_id: 'invalid', source_state: 'made_up' }));
  assert.equal(count(s, 'content'), 0);
  assert.throws(() => saveMaterialVersion(s, { content_id: uuid() }));
  assert.throws(() => s.transaction(async () => 1), /synchronous/); s.close();
});

await check('状态CAS拒绝旧状态及旧revision', 'one batch pending->running then stale update', 'one transition; second changes0', () => {
  const s = fresh(), id = batch(s);
  const input = { entity: 'batch', entity_id: id, expectedState: 'pending', expectedRevision: 0, nextState: 'running' };
  assert.equal(s.casState(input).changes, 1); assert.equal(s.casState(input).changes, 0);
  assert.equal(s.casState({ ...input, expectedState: 'running', nextState: 'stopped' }).changes, 0); s.close();
});

await check('执行槽owner/代次/停止标志参与CAS，不凭超时抢占', 'claim main; stale owner/generation; stopped recovery', 'one holder; stale claims rejected; recovery_required persisted', () => {
  const s = fresh(), owner = 'worker-a', runId = uuid();
  assert.equal(slot(s,{ owner, runId, generation: 1, stopRequested: false, expectedState: 'idle', nextState: 'running' }).changes, 1);
  assert.equal(slot(s,{ owner: 'worker-b', runId: uuid(), generation: 2, stopRequested: false, expectedState: 'idle', nextState: 'running' }).changes, 0);
  assert.equal(slot(s,{ owner, runId, generation: 1, stopRequested: true, expectedOwner: owner, expectedRunId: runId, expectedGeneration: 1, expectedRevision: 1, expectedState: 'running', nextState: 'recovery_required' }).changes, 1);
  assert.equal(slot(s,{ owner, runId, generation: 1, stopRequested: false, expectedOwner: owner, expectedRunId: runId, expectedGeneration: 1, expectedRevision: 2, expectedState: 'recovery_required', nextState: 'running' }).changes, 0);
  assert.equal(one(s, 'SELECT state FROM execution_slot').state, 'recovery_required'); s.close();
});

await check('提交前进程退出后的SQLite恢复', 'child process exits23 with uncommitted insert', 'committed record stays; interrupted transaction vanishes', () => {
  const file = join(root, 'crash.db'), s = openStore(file); content(s, 'committed'); s.close();
  const code = `import {openStore,saveContent} from ${JSON.stringify(storageUrl)};const s=openStore(process.argv[1]);s.transaction(()=>{saveContent(s,{platform:'synthetic',content_id:'uncommitted'});process.exit(23)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const reopened = openStore(file); assert.equal(count(reopened, 'content'), 1);
  assert.equal(one(reopened, 'SELECT source_content_id FROM content').source_content_id, 'committed'); reopened.close();
});

async function race(file, action) {
  const code = `import {openStore} from ${JSON.stringify(storageUrl)};const s=openStore(process.argv[1]);process.send('ready');process.on('message',()=>{try{${action};process.send({ok:true})}catch(e){process.send({ok:false,error:e.message})}finally{s.close();process.disconnect()}});`;
  const children = [0,1].map(() => spawn(process.execPath, ['--input-type=module','-e',code,file], { stdio: ['ignore','pipe','pipe','ipc'] }));
  const ready = children.map(c => new Promise((resolve, reject) => { c.once('message', resolve); c.once('error', reject); c.once('exit', code => code && reject(Error(`child exited ${code}`))); }));
  await Promise.all(ready);
  const results = children.map(c => new Promise((resolve, reject) => { let result; c.once('message', x => { result=x; }); c.once('error',reject); c.once('exit', code => code===0 ? resolve(result) : reject(Error(`child exit ${code}`))); }));
  children.forEach(c => c.send('go')); return Promise.all(results);
}

await check('独立进程并发日批唯一和执行槽单一持有者', 'two independent Node processes released together', 'one daily row; one successful slot CAS', async () => {
  const file = join(root, 'race.db'), s = openStore(file); s.close();
  const insertSql = "INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status) VALUES(?, 'owner','daily_follow','2026-10-21',20,'2026-10-21T04:00:00.000Z','pending')";
  const dayRace = await race(file, `s.transaction(()=>s.db.prepare(${JSON.stringify(insertSql)}).run(crypto.randomUUID()))`);
  assert.equal(dayRace.filter(x => x.ok).length, 1);
  const slotRace = await race(file, `const r=s.casSlot({owner:crypto.randomUUID(),runId:crypto.randomUUID(),generation:1,stopRequested:false,expectedOwner:null,expectedRunId:null,expectedGeneration:0,expectedStopRequested:false,expectedRevision:0,expectedState:'idle',nextState:'running'});if(r.changes!==1)throw Error('CAS rejected')`);
  assert.equal(slotRace.filter(x => x.ok).length, 1);
  const r = openStore(file); assert.equal(count(r, 'batch'), 1); assert.equal(one(r,'SELECT state FROM execution_slot').state,'running'); r.close();
});

await check('初始化迁移中途失败回滚并可重试', 'isolated copy of schema appended with invalid SQL', 'user_version0 and no half-created tables; real initializer recovers', async () => {
  const dir = mkdtempSync(join(root, 'migration-')), module = join(dir, 'storage.mjs'), schema = join(dir, 'schema.sql'), dbfile = join(dir, 'state.db');
  copyFileSync(new URL('../src/storage.mjs', import.meta.url), module);
  writeFileSync(schema, readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8') + '\nTHIS IS AN INJECTED MIGRATION ERROR;');
  const bad = await import(new URL(`file:///${module.replaceAll('\\','/')}`).href);
  assert.throws(() => bad.openStore(dbfile));
  const raw = new DatabaseSync(dbfile); assert.equal(raw.prepare('PRAGMA user_version').get().user_version,0);
  assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0); raw.close();
  const recovered = openStore(dbfile); assert.equal(recovered.schemaVersion,3); recovered.close();
});

await check('材料保存接口复用、封面变化与伪造摘要拒绝', 'default success twice; video cover changed; mismatched supplied hash', 'duplicate returns original ID; cover change adds version; mismatch rejected', () => {
  const s = fresh(), cid = content(s);
  const input = { content_id: cid, body_ref: 'private://body', body_hash: hash('stable body'), ordered_images: [], media_kind: 'text', completeness: 'complete', evidence_refs: ['synthetic://collected'] };
  const first = saveMaterialVersion(s, input), same = saveMaterialVersion(s, { ...input, fetched_at: '2026-10-22T04:00:00.000Z', source_url: 'https://example.com/?token=new' });
  assert.equal(same.status, 'duplicate'); assert.equal(first.entity_id, same.entity_id);
  const video = { ...input, media_kind: 'video', completeness: 'video_unread', cover_ref: 'private://cover', cover_hash: hash('cover1') };
  const a = saveMaterialVersion(s, video), b = saveMaterialVersion(s, { ...video, cover_hash: hash('cover2') });
  assert.notEqual(a.entity_id,b.entity_id);
  assert.throws(() => saveMaterialVersion(s, { ...input, material_hash: hash('fake') }));
  assert.throws(() => saveMaterialVersion(s, { ...input, ordered_images: [{ index: -1, path: 'private://bad', hash: hash('image') }] }));
  assert.equal(count(s, 'material_version'), 3); s.close();
});

await check('关联一致性拒绝候选/分析串帖与推荐改版本', 'candidate A with analysis B; recommendation category/version differs', 'database rejects unrelated yet individually existing parents', () => {
  const s = fresh(), f = fixture(s), another = content(s), mid = material(s, another), aid = uuid();
  insert(s,'analysis',{analysis_id:aid,material_version_id:mid,input_hash:hash('other'),prompt_version:'v1',model_requested:'synthetic',output_ref:'private://other',completion_evidence:'synthetic://done',status:'complete',created_at:at});
  assert.throws(() => insert(s,'decision',{decision_id:uuid(),candidate_id:f.candidate,analysis_id:aid,baseline_version:f.baseline,preference_version:f.p,strategy_version:f.strategy,category:'follow',relevance:'matched',gain_state:'gain',result:'eligible',created_at:at}));
  const differentBatch=batch(s,{kind:'explore',command:'different'});
  assert.throws(() => insert(s,'recommendation',{recommendation_id:uuid(),content_id:another,delivery_batch_id:differentBatch,decision_id:f.decision,category:'explore',actual_preference_version:f.p,actual_strategy_version:f.strategy,state:'pending',created_at:at})); s.close();
});

await check('同内容unknown阻止另一批的新发送意图', 'old unresolved unknown; second recommendation same content', 'new intent rejected across batch/category', () => {
  const s=fresh(), f=fixture(s); attempt(s,f.rec);
  const bid=batch(s,{kind:'additional_follow',command:'later'}), rec=uuid();
  insert(s,'recommendation',{recommendation_id:rec,content_id:f.cid,delivery_batch_id:bid,decision_id:f.decision,category:'follow',actual_preference_version:f.p,actual_strategy_version:f.strategy,state:'pending',created_at:at});
  assert.throws(()=>attempt(s,rec,'intent')); s.close();
});

await check('成功内容索引拒绝未成功及不符归属，跨类别唯一', 'wrong owner/content + pending recommendation', 'no false success accounting', () => {
  const s=fresh(), f=fixture(s);
  assert.throws(()=>insert(s,'delivered_content',{owner:'other',platform:'wrong',source_content_id:'wrong',recommendation_id:f.rec,first_success_at:at}));
  assert.equal(count(s,'delivered_content'),0); s.close();
});

await check('空JSON及伪造核实证据不能绕过unknown约束', 'invalid evidence, object, empty strings', 'all rejected; original unknown retained', () => {
  const s=fresh(), f=fixture(s), id=attempt(s,f.rec);
  for(const refs of ['{}','[""]','not-json','[]']) assert.throws(()=>run(s,"UPDATE delivery_attempt SET status='succeeded',revision=revision+1,message_id='synthetic-id',verification_evidence_refs_json=? WHERE delivery_attempt_id=?",refs,id));
  assert.equal(one(s,'SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?',id).status,'unknown'); s.close();
});

await check('异步事务回调在执行前拒绝', 'async callback would write after await', 'throw without executing callback or late write', async () => {
  const s=fresh();
  assert.throws(()=>s.transaction(async()=>{await Promise.resolve();content(s,'late-write');}),/synchronous|async/i);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(count(s,'content'),0); s.close();
});

await check('两个独立进程同时初始化新库', 'both processes open previously nonexistent path', 'one valid schema and both opens succeed', async () => {
  const file=join(root,'concurrent-initialize.db');
  const results=await race(file,"if(s.schemaVersion!==3)throw Error('wrong schema')");
  assert.equal(results.filter(x=>x.ok).length,2);
  const s=openStore(file);assert.equal(rows(s,'PRAGMA foreign_key_check').length,0);s.close();
});

await check('无关库相同user_version仍拒绝', 'foreign database has user_version1', 'no accidental adoption and source bytes unchanged', () => {
  const file=join(root,'foreign-v1.db'), raw=new DatabaseSync(file);
  raw.exec('CREATE TABLE unrelated(id TEXT); PRAGMA user_version=1');raw.close();
  const before=hash(readFileSync(file));assert.throws(()=>openStore(file));
  assert.equal(hash(readFileSync(file)),before);
});

await check('跨批次类别成功内容只计一次，重复实发证据仍保留', 'same content successfully sent by follow and explore', 'one delivered identity; two attempts retained', () => {
  const s=fresh(), f=fixture(s), source=one(s,'SELECT source_content_id FROM content WHERE content_id=?',f.cid).source_content_id;
  const proof={message_id:'synthetic-success-1',verification_evidence_refs_json:'["synthetic://receipt-1"]'};
  attempt(s,f.rec,'succeeded',proof);
  s.casState({entity:'recommendation',entity_id:f.rec,expectedState:'pending',expectedRevision:0,nextState:'succeeded',fields:{first_success_at:at}});
  const delivered={owner:'owner',platform:'synthetic',source_content_id:source,recommendation_id:f.rec,first_success_at:at};
  insert(s,'delivered_content',delivered);
  const bid=batch(s,{kind:'explore',command:'explore-repeat'}), decision=uuid(), rec=uuid();
  insert(s,'decision',{decision_id:decision,candidate_id:f.candidate,analysis_id:f.analysis,baseline_version:f.baseline,preference_version:f.p,strategy_version:f.strategy,category:'explore',relevance:'matched',gain_state:'gain',result:'eligible',created_at:at});
  insert(s,'recommendation',{recommendation_id:rec,content_id:f.cid,delivery_batch_id:bid,decision_id:decision,category:'explore',actual_preference_version:f.p,actual_strategy_version:f.strategy,state:'pending',created_at:at});
  attempt(s,rec,'succeeded',{...proof,message_id:'synthetic-success-2'});
  s.casState({entity:'recommendation',entity_id:rec,expectedState:'pending',expectedRevision:0,nextState:'succeeded',fields:{first_success_at:at}});
  assert.throws(()=>insert(s,'delivered_content',{...delivered,recommendation_id:rec}),/UNIQUE/);
  assert.equal(count(s,'delivered_content'),1);assert.equal(count(s,'delivery_attempt'),2);s.close();
});

await check('已保存反馈和回执业务归属不可覆写', 'attempt to relabel saved vote and receipt target', 'original event/history and outbox identity preserved', () => {
  const s=fresh(),f=fixture(s),event=feedbackEvent(s,f);feedbackCurrent(s,f,event);const box=outbox(s,f);
  assert.throws(()=>run(s,"UPDATE feedback_event SET value='dislike',revision=77 WHERE event_id=?",event));
  assert.throws(()=>run(s,"UPDATE outbox SET object_ref='another',business_revision=99 WHERE outbox_id=?",box));
  assert.equal(one(s,'SELECT value FROM feedback_event WHERE event_id=?',event).value,'like');s.close();
});

await check('C2C F1：只有引用而无正文证据不能标成功', 'body_ref present, body and body_hash missing', 'reject and retain no material row', () => {
  const s=fresh(),cid=content(s);
  assert.throws(()=>saveMaterialVersion(s,{content_id:cid,body_ref:'private://unverified',media_kind:'text',completeness:'complete',evidence_refs:['synthetic://reference-only']}));
  assert.equal(count(s,'material_version'),0);s.close();
});

await check('C2C F1：明确读取到空正文可独立保存', 'explicit empty body with source evidence', 'valid SHA256 of observed empty body, no invented text', () => {
  const s=fresh(),cid=content(s);
  const r=saveMaterialVersion(s,{content_id:cid,body:'',body_ref:'private://observed-empty',media_kind:'text',completeness:'complete',evidence_refs:['synthetic://observed-empty-body']});
  assert.equal(r.status,'succeeded');
  assert.equal(one(s,'SELECT body_hash FROM material_version WHERE material_version_id=?',r.entity_id).body_hash,hash(''));s.close();
});

await check('C2C F1：完整封面与空正文不代表已读取视频', 'video cover, explicit empty body, video_unread', 'cover hash retained and video remains unread', () => {
  const s=fresh(),cid=content(s);
  const r=saveMaterialVersion(s,{content_id:cid,body:'',body_ref:'private://video-empty-body',media_kind:'video',cover_ref:'private://verified-cover',cover_hash:hash('verified cover'),completeness:'video_unread',evidence_refs:['synthetic://cover-and-empty-body-verified']});
  const actual=one(s,'SELECT completeness,body_hash,cover_hash FROM material_version WHERE material_version_id=?',r.entity_id);
  assert.equal(actual.completeness,'video_unread');assert.equal(actual.body_hash,hash(''));assert.equal(actual.cover_hash,hash('verified cover'));s.close();
});

await check('C2C F2：成功attempt、推荐及成功索引归账全部回滚', 'inject failure after all three writes before commit', 'no success attempt/index/history; original recommendation pending', () => {
  const s=fresh(),f=fixture(s),source=one(s,'SELECT source_content_id FROM content WHERE content_id=?',f.cid).source_content_id;
  assert.throws(()=>s.transaction(()=>{
    attempt(s,f.rec,'succeeded',{message_id:'synthetic-success',verification_evidence_refs_json:'["synthetic://reliable-receipt"]'});
    assert.equal(s.casState({entity:'recommendation',entity_id:f.rec,expectedState:'pending',expectedRevision:0,nextState:'succeeded',fields:{first_success_at:at}}).changes,1);
    insert(s,'delivered_content',{owner:'owner',platform:'synthetic',source_content_id:source,recommendation_id:f.rec,first_success_at:at});
    throw Error('injected before success-accounting commit');
  }),/injected before success-accounting commit/);
  assert.equal(count(s,'delivery_attempt'),0);assert.equal(count(s,'delivery_attempt_history'),0);assert.equal(count(s,'delivered_content'),0);
  const rec=one(s,'SELECT state,revision,first_success_at FROM recommendation WHERE recommendation_id=?',f.rec);
  assert.equal(rec.state,'pending');assert.equal(rec.revision,0);assert.equal(rec.first_success_at,null);
  assert.equal(count(s,'entity_state_history'),0);s.close();
});

// 结果写入独立本轮文件，不覆盖旧任务材料。
writeFileSync(process.env.REDBOOK_STORAGE_RESULTS ?? '.codex/task007-results-20261021.json', JSON.stringify({ date: '2026-10-21', executor: 'Codex', command: 'node tests/storage.test.mjs', evidence: 'isolated_synthetic_sqlite', passed: results.filter(x => x.result === 'pass').length, failed: results.filter(x => x.result === 'fail').length, cases: results }, null, 2));
process.exitCode = results.some(x => x.result === 'fail') ? 1 : 0;
