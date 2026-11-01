import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { openStore, saveContent } from '../src/storage.mjs';
import { createCollector, parseBusinessSummary } from '../src/collection.mjs';

const OWNER = 'YOUR_USER';
const PROFILE = 'a'.repeat(24);
const SOURCE = 'b'.repeat(24);
const SOURCE2 = 'c'.repeat(24);
const SOURCE_URL = `https://www.xiaohongshu.com/user/profile/${PROFILE}/${SOURCE}?xsec_token=private-token&xsec_source=pc_user`;
const SOURCE_PAGE = `https://www.xiaohongshu.com/user/profile/${PROFILE}/collect`;
const STAMP = '2026-10-21T04:00:00.000Z';
const SUMMARY = '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'redbook-collection-'));
  const store = openStore(join(root, 'state.sqlite'));
  let timestamp = STAMP;
  const collector = createCollector({
    store,
    root: join(root, 'private'),
    owner: OWNER,
    now: () => timestamp,
    uuid: randomUUID,
    decodeImage: async () => ({ width: 1, height: 1 }),
    cli: async () => ({ exitCode: 0, stdout: SUMMARY, stderr: '' }),
    ...options,
  });
  const token = await collector.claim();
  return {
    root,
    store,
    collector,
    token,
    setNow: (value) => { timestamp = value; },
    close: async () => { await collector.release(token); store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function observation(contentId = SOURCE, extra = {}) {
  return {
    content_id: contentId,
    complete_source_url: `https://www.xiaohongshu.com/user/profile/${PROFILE}/${contentId}?xsec_token=private-token&xsec_source=pc_user`,
    membership: 'present',
    observed_at: STAMP,
    ...extra,
  };
}

async function writeCliOutput(outputDir, { kind = '图文', body = '正文', rawBody = body, imageCount = 1, imageIndexes, sourceId = SOURCE, collectedAt = STAMP, sourceUrl = SOURCE_URL } = {}) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), rawBody);
  const indexes = imageIndexes ?? Array.from({ length: imageCount }, (_, index) => index + 1);
  for (const index of indexes) await writeFile(join(outputDir, `note_${index}.jpeg`), `synthetic-image-${index}`);
  const dbPath = join(outputDir, 'ExploreData.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE explore_data ("采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,"发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,"点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,"下载地址" TEXT,"动图地址" TEXT)');
  db.prepare('INSERT INTO explore_data("采集时间","作品ID","作品类型","作品标题","作品描述","作品标签","发布时间","最后更新时间","收藏数量","评论数量","分享数量","点赞数量","作者昵称","作者ID","作者链接","作品链接","下载地址","动图地址") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(collectedAt, sourceId, kind, '标题', body, '', STAMP, STAMP, 0, 0, 0, 0, '', PROFILE, '', sourceUrl, kind === '图文' ? Array.from({ length: imageCount }, (_, index) => `https://img.invalid/${index + 1}.jpeg`).join('\n') : '', '');
  db.close();
}

async function discover(f, batchId = 'batch-1', contentId = SOURCE, extras = {}) {
  return f.collector.recordDiscovery(batchId, {
    observations: [observation(contentId, extras)],
    source_page: SOURCE_PAGE,
    sub_tab: 'collected',
    read_method: 'edge_dom',
    source_kind: 'live_page',
    observed_at: STAMP,
    coverage: { state: 'partial', stop_reason: 'page_limit', scope: 'visible-page' },
    token: f.token,
  });
}

test('CLI业务摘要识别实际中文格式', () => {
  assert.deepEqual(parseBusinessSummary(SUMMARY), { total: 1, succeeded: 1, failed: 0, skipped: 0 });
  assert.equal(parseBusinessSummary('共处理 1 个作品，成功 1 个，失败 0 个，跳过 0\n共处理 1 个作品，成功 1 个，失败 0 个，跳过 0'), null);
});

test('批量发现幂等，写入pending checkpoint且DB引用为私有绝对路径', async () => {
  const f = await fixture();
  try {
    await discover(f);
    const second = await discover(f);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM content').get().n, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM collection_observation').get().n, 1);
    assert.deepEqual(second.observed_ids, [SOURCE]);
    assert.deepEqual(second.pending_ids, [SOURCE]);
    assert.equal(second.status, 'partial');
    assert.equal(second.entity_id, 'batch-1');
    assert.ok(second.evidence_refs.some((ref) => ref.startsWith(join(f.root, 'private'))));
    const content = f.store.db.prepare('SELECT source_url_ref FROM content').get();
    assert.equal(content.source_url_ref, resolve(content.source_url_ref));
    assert.ok(content.source_url_ref.startsWith(join(f.root, 'private')));
    assert.ok(!content.source_url_ref.includes('xsec_token'));
    const cp = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage LIKE 'collection:batch-1:%' ORDER BY committed_at DESC LIMIT 1").get();
    assert.equal(cp.delivery_batch_id, null);
    assert.deepEqual(JSON.parse(cp.pending_ids_json), [SOURCE]);
    assert.equal(f.store.db.prepare("SELECT batch_id FROM execution_slot WHERE slot_key='main'").get().batch_id, null);
  } finally { await f.close(); }
});

test('按精确attempt归账成功receipt，不写收藏观察或重新运行CLI', async () => {
  let attemptId = null;
  let announcedAttempt = null;
  let announcedRun = null;
  let cliCalls = 0;
  const f = await fixture({
    cli: async ({ outputDir }) => { cliCalls += 1; await writeCliOutput(outputDir); return { exitCode: 0, stdout: SUMMARY, stderr: '' }; },
    afterReceipt: async ({ attempt_id }) => { attemptId = attempt_id; throw new Error('模拟receipt落盘后进程中断'); },
  });
  try {
    storeCandidateContent(f);
    const originalRunId = f.token.runId;
    await assert.rejects(f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token, onAttempt: async info => { announcedAttempt = info.attemptId; announcedRun = info.runId; } }), /模拟receipt落盘后进程中断/);
    assert.equal(cliCalls, 1);
    assert.ok(attemptId);
    assert.equal(announcedAttempt, attemptId);
    assert.equal(announcedRun, originalRunId);
    await f.collector.release(f.token);
    const resumedToken = await f.collector.claim();
    const committed = await f.collector.commitReceipt(attemptId, { token: resumedToken, sourceContentId: SOURCE, originalRunId });
    assert.equal(committed.status, 'succeeded');
    assert.equal(cliCalls, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM material_version').get().n, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM collection_observation').get().n, 0);
    const duplicate = await f.collector.commitReceipt(attemptId, { token: resumedToken, sourceContentId: SOURCE, originalRunId });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(cliCalls, 1);
  } finally { await f.close(); }
});

test('默认attempt回调在真实子进程spawn后保存child身份，close返回前等待证明', async () => {
  const spawned = [], exited = [];
  const f = await fixture({
    cli: async ({ onSpawn }) => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], { windowsHide: true, stdio: 'ignore' });
      await onSpawn({ pid: child.pid, started_at: STAMP, executable: process.execPath });
      const [exitCode] = await once(child, 'exit');
      return { exitCode, stdout: '', stderr: '', child_pid: child.pid };
    },
    onWorkerSpawned: async proof => { spawned.push(proof); },
  });
  try {
    await discover(f);
    storeCandidateContent(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token,
      onWorkerExited: async proof => { exited.push(proof); } });
    assert.equal(result.status, 'unknown');
    assert.equal(spawned.length, 1);
    assert.equal(exited.length, 1);
    assert.equal(spawned[0].attempt_id, exited[0].attempt_id);
    assert.equal(spawned[0].process_id, exited[0].process_id);
    assert.equal(spawned[0].stage_run_id, f.token.runId);
    const processInfo = JSON.parse(await readFile(spawned[0].process_ref, 'utf8'));
    assert.equal(processInfo.attempt_id, spawned[0].attempt_id);
    assert.equal(processInfo.run_id, f.token.runId);
    assert.equal(processInfo.parent_pid, process.pid);
    assert.ok(spawned[0].process_hash);
    let childAlive = true;
    try { process.kill(spawned[0].process_id, 0); } catch (error) { childAlive = error.code !== 'ESRCH'; }
    assert.equal(childAlive, false);
  } finally { await f.close(); }
});

function storeCandidateContent(f) {
  f.store.transaction(() => saveContent(f.store, {
    platform: 'xiaohongshu', content_id: SOURCE, source_url_ref: 'file:synthetic-homefeed-page', source_state: 'available',
  }));
}

test('私有目录初始化失败时claim回滚execution slot', async () => {
  const f = await fixture();
  try {
    await f.collector.release(f.token);
    const blockingFile = join(f.root, 'not-a-directory');
    await writeFile(blockingFile, 'x');
    const broken = createCollector({ store: f.store, root: join(blockingFile, 'private'), owner: OWNER });
    await assert.rejects(broken.claim());
    const slot = f.store.db.prepare("SELECT owner,run_id,state FROM execution_slot WHERE slot_key='main'").get();
    assert.equal(slot.owner, null);
    assert.equal(slot.run_id, null);
    assert.equal(slot.state, 'stopped');
  } finally { await f.close(); }
});

test('同一collector已有活动token时拒绝重复claim', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.collector.claim(), /already owns an active run/);
    assert.equal(f.collector.assertCurrent(f.token).state, 'running');
  } finally { await f.close(); }
});

test('恢复要求显式证据且拒绝活进程，已退出子进程可CAS恢复新代次', async () => {
  const f = await fixture();
  let child;
  try {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    while (!child.pid) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const runPath = join(f.root, 'private', 'runs', f.token.runId, 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    run.process_id = child.pid;
    run.process_started_at = STAMP;
    await writeFile(runPath, `${JSON.stringify(run)}\n`);
    const recovery = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER, decodeImage: async () => {} });
    await assert.rejects(recovery.recover({ confirmedStoppedRunId: f.token.runId }), /evidenceRef/);
    await assert.rejects(recovery.recover({ confirmedStoppedRunId: f.token.runId, evidenceRef: 'synthetic-evidence' }), /still present/);
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => child.once('close', resolvePromise));
    child = null;
    const recovered = await recovery.recover({ confirmedStoppedRunId: f.token.runId, evidenceRef: 'synthetic-child-exit' });
    assert.equal(recovered.generation, f.token.generation + 1);
    assert.equal(f.store.db.prepare("SELECT state FROM execution_slot WHERE slot_key='main'").get().state, 'running');
    await recovery.release(recovered);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await f.close();
  }
});

test('collection batch拒绝跨账号/来源tab复用，禁止把导入来源混入现场', async () => {
  const f = await fixture();
  try {
    await discover(f);
    await assert.rejects(f.collector.recordDiscovery('batch-1', {
      observations: [], source_page: SOURCE_PAGE, sub_tab: 'liked', source_kind: 'live_page', token: f.token,
    }), /scope changed/);
    await assert.rejects(f.collector.recordDiscovery('batch-import', {
      observations: [], source_page: SOURCE_PAGE, sub_tab: 'collected', source_kind: 'historical_import', token: f.token,
    }), /only live_page/);
  } finally { await f.close(); }
});

test('业务计数、源DB sourceID、正文、媒体数量及解码均通过才归账；材料路径可由下游读取', async () => {
  const f = await fixture({ cli: async ({ outputDir }) => { await writeCliOutput(outputDir, { imageCount: 2 }); return { exitCode: 0, stdout: SUMMARY, stderr: '' }; } });
  try {
    await discover(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.entity_id, result.material_version_id);
    assert.ok(result.evidence_refs.length > 0);
    const material = f.store.db.prepare("SELECT * FROM material_version WHERE fetch_status='succeeded'").get();
    assert.equal(material.completeness, 'complete');
    assert.equal(material.body_ref, resolve(material.body_ref));
    assert.deepEqual(JSON.parse(await readFile(material.body_ref, 'utf8')), {
      title: '标题', description: '正文', tags: '', published_at: STAMP,
      author_name: '', author_id: PROFILE,
    });
    const images = JSON.parse(material.ordered_images_json);
    assert.deepEqual(images.map((image) => image.index), [0, 1]);
    assert.equal(images[0].path, resolve(images[0].path));
    assert.deepEqual(await Promise.all(images.map((image) => readFile(image.path, 'utf8'))), ['synthetic-image-1', 'synthetic-image-2']);
    const cp = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage LIKE 'collection:batch-1:material:%' LIMIT 1").get();
    assert.equal(cp.delivery_batch_id, null);
    assert.deepEqual(JSON.parse(cp.pending_ids_json), []);
    assert.equal(JSON.parse(cp.succeeded_refs_json).at(-1), f.store.db.prepare('SELECT evidence_refs_json FROM material_version WHERE material_version_id=?').get(material.material_version_id).evidence_refs_json
      ? JSON.parse(f.store.db.prepare('SELECT evidence_refs_json FROM material_version WHERE material_version_id=?').get(material.material_version_id).evidence_refs_json)[0] : null);
  } finally { await f.close(); }
});

test('时间戳和短期URL参数变化不改变相同正文与图片的材料指纹', async () => {
  let calls = 0;
  const f = await fixture({ cli: async ({ outputDir }) => {
    calls += 1;
    await writeCliOutput(outputDir, {
      imageCount: 1,
      collectedAt: calls === 1 ? '2026-10-20T00:00:00.000Z' : '2026-10-21T00:00:00.000Z',
      sourceUrl: SOURCE_URL.replace('private-token', `rotated-${calls}`),
    });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const first = f.store.db.prepare("SELECT material_hash FROM material_version WHERE fetch_status='succeeded'").get().material_hash;
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token, refresh: true });
    const versions = f.store.db.prepare("SELECT material_hash FROM material_version WHERE fetch_status='succeeded'").all();
    assert.equal(calls, 2);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].material_hash, first);
  } finally { await f.close(); }
});

test('单张图片损坏时仅补采缺失序号并写入显式repair版本', async () => {
  let calls = 0;
  const requestedIndexes = [];
  const f = await fixture({ cli: async ({ outputDir, indexes }) => {
    calls += 1;
    requestedIndexes.push(indexes ?? null);
    await writeCliOutput(outputDir, { imageCount: 2, imageIndexes: calls === 1 ? [1, 2] : indexes });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const first = f.store.db.prepare("SELECT * FROM material_version WHERE fetch_status='succeeded'").get();
    const originalRow = { ...first };
    const oldImages = JSON.parse(first.ordered_images_json);
    const intactPath = oldImages[0].path;
    const damagedPath = oldImages[1].path;
    await writeFile(damagedPath, 'corrupted-image');
    const repairResult = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(repairResult.status, 'succeeded');
    assert.equal(calls, 2);
    assert.deepEqual(requestedIndexes, [null, [2]]);
    assert.equal(await readFile(intactPath, 'utf8'), 'synthetic-image-1');
    assert.equal(await readFile(damagedPath, 'utf8'), 'corrupted-image');
    assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(first.material_version_id) }, originalRow);
    const repairedRow = f.store.db.prepare('SELECT * FROM material_version WHERE repair_of_material_version_id=?').get(first.material_version_id);
    assert.ok(repairedRow);
    assert.equal(repairedRow.fetch_status, 'succeeded');
    assert.match(repairedRow.artifact_hash, /^[a-f\d]{64}$/);
    assert.equal(repairResult.material_version_id, repairedRow.material_version_id);
    assert.equal(repairedRow.repair_of_material_version_id, first.material_version_id);
    const repairReceipt = JSON.parse(await readFile(join(f.root, 'private', 'attempts', repairResult.attempt_id, 'receipt.json'), 'utf8'));
    assert.equal(repairReceipt.material.repair_of_material_version_id, first.material_version_id);
    const repaired = JSON.parse(repairedRow.ordered_images_json);
    assert.deepEqual(await Promise.all(repaired.map((image) => readFile(image.path, 'utf8'))), ['synthetic-image-1', 'synthetic-image-2']);
    assert.ok(repaired.every((image) => image.path.startsWith(join(f.root, 'private', 'attempts'))));
    const cachedRepair = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(cachedRepair.status, 'duplicate');
    assert.equal(cachedRepair.material_version_id, repairedRow.material_version_id);
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test('resume重验成功材料引用；已归账图片损坏时重新修复而不误报complete', async () => {
  let calls = 0;
  const requestedIndexes = [];
  const f = await fixture({ cli: async ({ outputDir, indexes }) => {
    calls += 1;
    requestedIndexes.push(indexes ?? null);
    await writeCliOutput(outputDir, { imageCount: 1, imageIndexes: indexes ?? [1] });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const root = f.store.db.prepare("SELECT * FROM material_version WHERE fetch_status='succeeded'").get();
    const image = JSON.parse(root.ordered_images_json)[0];
    await writeFile(image.path, 'synthetic corruption');
    const redicovered = await discover(f);
    assert.deepEqual(redicovered.pending_ids, [SOURCE]);
    const result = await f.collector.resume('batch-1', { token: f.token });
    assert.equal(calls, 2);
    assert.equal(requestedIndexes[1]?.[0], 1);
    assert.equal(result.state, 'complete');
    assert.equal(result.status, 'complete');
    assert.ok(result.evidence_refs.some((ref) => ref.startsWith('checkpoint:')));
    const repair = f.store.db.prepare('SELECT * FROM material_version WHERE repair_of_material_version_id=?').get(root.material_version_id);
    assert.ok(repair);
    assert.notEqual(repair.material_version_id, root.material_version_id);
    assert.notEqual(await readFile(JSON.parse(repair.ordered_images_json)[0].path, 'utf8'), 'synthetic corruption');
  } finally { await f.close(); }
});

test('本轮unknown不能被历史成功行覆盖并从pending移除', async () => {
  const f = await fixture({ cli: async ({ outputDir }) => {
    await writeCliOutput(outputDir, { imageCount: 1 });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    f.store.db.exec('DROP TRIGGER material_version_immutable_update');
    f.store.db.prepare("UPDATE material_version SET ordered_images_json='invalid-json' WHERE fetch_status='succeeded'").run();
    await discover(f);
    const result = await f.collector.resume('batch-1', { token: f.token });
    assert.equal(result.state, 'unknown');
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.pending_ids, [SOURCE]);
  } finally { await f.close(); }
});

test('正文损坏的同哈希下载写root repair版本，不把损坏duplicate归账成功', async () => {
  let calls = 0;
  const settingsRoot = await mkdtemp(join(tmpdir(), 'redbook-settings-'));
  const settingsPath = join(settingsRoot, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ image_download: true }));
  const f = await fixture({ settingsPath, cli: async ({ outputDir, settingsPath: attemptSettings }) => {
    calls += 1;
    const settings = JSON.parse(await readFile(attemptSettings, 'utf8'));
    await writeCliOutput(outputDir, { imageCount: 1, imageIndexes: settings.image_download === false ? [] : [1] });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const root = f.store.db.prepare("SELECT * FROM material_version WHERE fetch_status='succeeded'").get();
    const badBody = root.body_ref;
    await writeFile(badBody, 'damaged canonical body');
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(calls, 2);
    const repairAttempt = f.store.db.prepare("SELECT evidence_refs_json FROM material_version WHERE repair_of_material_version_id=? AND fetch_status='succeeded'").get(root.material_version_id);
    const receiptRef = JSON.parse(repairAttempt.evidence_refs_json)[0];
    const attemptSettings = JSON.parse(await readFile(join(dirname(receiptRef), 'settings.json'), 'utf8'));
    assert.equal(attemptSettings.image_download, false);
    assert.equal(result.status, 'succeeded');
    assert.notEqual(result.material_version_id, root.material_version_id);
    assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(root.material_version_id) }, { ...root });
    assert.equal(await readFile(badBody, 'utf8'), 'damaged canonical body');
    const repair = f.store.db.prepare('SELECT * FROM material_version WHERE repair_of_material_version_id=?').get(root.material_version_id);
    assert.equal(result.material_version_id, repair.material_version_id);
    assert.deepEqual(JSON.parse(await readFile(repair.body_ref, 'utf8')), { title: '标题', description: '正文', tags: '', published_at: STAMP, author_name: '', author_id: PROFILE });
  } finally { await f.close(); await rm(settingsRoot, { recursive: true, force: true }); }
});

test('一项素材因登录阻断后停止该批，不继续调用后续来源', async () => {
  let calls = 0;
  const f = await fixture({ cli: async ({ outputDir, sourceContentId }) => {
    calls += 1;
    if (sourceContentId === SOURCE) return { exitCode: 1, stdout: '请先登录后查看', stderr: '' };
    await writeCliOutput(outputDir, { imageCount: 1, sourceId: SOURCE2, sourceUrl: observation(SOURCE2).complete_source_url });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await f.collector.recordDiscovery('batch-login', {
      observations: [observation(SOURCE), observation(SOURCE2)], source_page: SOURCE_PAGE, sub_tab: 'collected',
      source_kind: 'live_page', read_method: 'edge_dom', observed_at: STAMP, token: f.token,
      coverage: { state: 'partial', stop_reason: 'bounded_sample' },
    });
    const result = await f.collector.resume('batch-login', { token: f.token });
    assert.equal(calls, 1);
    assert.ok(['blocked', 'partial'].includes(result.state));
    assert.deepEqual(result.pending_ids, [SOURCE, SOURCE2]);
  } finally { await f.close(); }
});

test('显式访问恢复证据解除blocked并允许新run续同一批', async () => {
  let calls = 0;
  const cli = async ({ outputDir, sourceContentId }) => {
    calls += 1;
    if (calls === 1) return { exitCode: 1, stdout: '请先登录后查看', stderr: '' };
    await writeCliOutput(outputDir, { imageCount: 1, sourceId: sourceContentId, sourceUrl: observation(sourceContentId).complete_source_url });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  };
  const f = await fixture({ cli });
  try {
    await f.collector.recordDiscovery('batch-login-recovery', {
      observations: [observation(SOURCE), observation(SOURCE2)], source_page: SOURCE_PAGE, sub_tab: 'collected',
      source_kind: 'live_page', read_method: 'edge_dom', observed_at: STAMP, token: f.token,
      coverage: { state: 'partial', stop_reason: 'bounded_sample' },
    });
    const first = await f.collector.resume('batch-login-recovery', { token: f.token });
    assert.equal(first.state, 'blocked');
    assert.equal(calls, 1);
    await f.collector.release(f.token);
    const resumed = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER, cli, decodeImage: async () => {}, now: () => STAMP });
    const result = await resumed.resume('batch-login-recovery', { accessRestoredEvidenceRef: 'synthetic-access-restored' });
    assert.equal(result.state, 'complete');
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('相同提交时刻的多来源归账写入最后一个checkpoint且不遗失成功引用', async () => {
  let calls = 0;
  const f = await fixture({ cli: async ({ outputDir, sourceContentId }) => {
    calls += 1;
    await writeCliOutput(outputDir, { imageCount: 1, sourceId: sourceContentId, sourceUrl: observation(sourceContentId).complete_source_url });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await f.collector.recordDiscovery('batch-tied-checkpoints', {
      observations: [observation(SOURCE), observation(SOURCE2)], source_page: SOURCE_PAGE, sub_tab: 'collected',
      source_kind: 'live_page', read_method: 'edge_dom', observed_at: STAMP, token: f.token,
      coverage: { state: 'partial', stop_reason: 'bounded_sample' },
    });
    const result = await f.collector.resume('batch-tied-checkpoints', { token: f.token });
    assert.equal(calls, 2);
    assert.equal(result.state, 'complete');
    assert.equal(result.status, 'complete');
    assert.equal(result.entity_id, 'batch-tied-checkpoints');
    assert.ok(result.evidence_refs.some((ref) => ref.startsWith('checkpoint:')));
    const checkpoint = f.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND run_id=? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(OWNER, f.token.runId);
    assert.deepEqual(JSON.parse(checkpoint.pending_ids_json), []);
    assert.equal(JSON.parse(checkpoint.succeeded_refs_json).length, 2);
  } finally { await f.close(); }
});

test('repair的repair继续指向普通根版本，不生成修复链', async () => {
  let calls = 0;
  const f = await fixture({ cli: async ({ outputDir, indexes }) => {
    calls += 1;
    await writeCliOutput(outputDir, { imageCount: 2, imageIndexes: indexes ?? [1, 2] });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f, 'batch-root');
    await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const root = f.store.db.prepare("SELECT * FROM material_version WHERE repair_of_material_version_id IS NULL AND fetch_status='succeeded'").get();
    await writeFile(JSON.parse(root.ordered_images_json)[1].path, 'repair one damage');
    await discover(f, 'batch-repair-one');
    const firstRepair = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(firstRepair.status, 'succeeded');
    const row1 = f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(firstRepair.material_version_id);
    assert.equal(row1.repair_of_material_version_id, root.material_version_id);
    await writeFile(JSON.parse(row1.ordered_images_json)[0].path, 'repair two damage');
    await discover(f, 'batch-repair-two');
    const secondRepair = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(secondRepair.status, 'succeeded');
    const row2 = f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(secondRepair.material_version_id);
    assert.equal(row2.repair_of_material_version_id, root.material_version_id);
    assert.notEqual(row2.repair_of_material_version_id, row1.material_version_id);
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('CLI exit 0不能覆盖业务失败或缺失源记录', async () => {
  const f = await fixture({ cli: async ({ outputDir }) => { await writeCliOutput(outputDir, { imageCount: 1 }); return { exitCode: 0, stdout: '共处理 1 个作品，成功 0 个，失败 1 个，跳过 0', stderr: '' }; } });
  try {
    await discover(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(result.status, 'failed');
    assert.notEqual(f.store.db.prepare('SELECT completeness FROM material_version').get()?.completeness, 'complete');
  } finally { await f.close(); }
});

test('失败最多重试一次，登录或验证码会立即阻断后续CLI调用', async () => {
  let attempts = 0;
  const f = await fixture({ cli: async ({ outputDir }) => {
    attempts += 1;
    await writeCliOutput(outputDir, { imageCount: 1 });
    return { exitCode: 0, stdout: '共处理 1 个作品，成功 0 个，失败 1 个，跳过 0', stderr: '' };
  } });
  try {
    await discover(f);
    assert.equal((await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token })).status, 'failed');
    assert.equal((await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token })).status, 'failed');
    const exhausted = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(exhausted.status, 'unknown');
    assert.equal(exhausted.reason, 'retry_limit_reached');
    assert.equal(exhausted.entity_id, SOURCE);
    assert.equal(exhausted.evidence_refs.length, 1);
    assert.equal(attempts, 2);
  } finally { await f.close(); }

  let blockedCalls = 0;
  const blocked = await fixture({ cli: async () => { blockedCalls += 1; return { exitCode: 1, stdout: '', stderr: 'login required', blocked: true }; } });
  try {
    await discover(blocked);
    assert.equal((await blocked.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: blocked.token })).status, 'blocked');
    assert.equal((await blocked.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: blocked.token })).status, 'blocked');
    assert.equal(blockedCalls, 1);
  } finally { await blocked.close(); }
});

test('CLI正文文件可含元数据，描述文本在去空白后存在即可核验', async () => {
  const f = await fixture({ cli: async ({ outputDir }) => {
    await writeCliOutput(outputDir, { rawBody: '标题：标题\r\n作者：示例\r\n采集时间：刚刚\r\n正文：正 文\r\n签名：保留的其它字段', body: '正文', imageCount: 1 });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(result.status, 'succeeded');
    const receipt = JSON.parse(await readFile(join(f.root, 'private', 'attempts', result.attempt_id, 'receipt.json'), 'utf8'));
    assert.equal(receipt.source_evidence.description_matches, true);
    assert.ok(receipt.files.some((file) => file.path.endsWith('cli-output.json')));
    const cliOutput = JSON.parse(await readFile(join(f.root, 'private', 'attempts', result.attempt_id, 'cli-output.json'), 'utf8'));
    assert.equal(cliOutput.stdout, SUMMARY);
  } finally { await f.close(); }
});

test('System.Drawing能通过UTF8 stdin解码中文文件名图片', { skip: process.platform !== 'win32' }, async () => {
  const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZcAAAAASUVORK5CYII=', 'base64');
  const f = await fixture({ decodeImage: undefined, cli: async ({ outputDir }) => {
    await writeCliOutput(outputDir, { imageCount: 1 });
    await rename(join(outputDir, 'note_1.jpeg'), join(outputDir, '中文图片_1.jpeg'));
    await writeFile(join(outputDir, '中文图片_1.jpeg'), onePixelPng);
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(result.status, 'succeeded');
  } finally { await f.close(); }
});

test('旧unknown回执可由已保存文件重验，新增回执不覆盖原记录且不再调用CLI', async () => {
  let calls = 0;
  const f = await fixture({ cli: async ({ outputDir }) => {
    calls += 1;
    await writeCliOutput(outputDir, { imageCount: 1, collectedAt: '2026-10-21 12:00:00' });
    return { exitCode: 0, stdout: SUMMARY, stderr: '' };
  } });
  try {
    await discover(f);
    const first = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    const base = join(f.root, 'private', 'attempts', first.attempt_id);
    const original = JSON.parse(await readFile(join(base, 'receipt.json'), 'utf8'));
    const cliOutput = JSON.parse(await readFile(join(base, 'cli-output.json'), 'utf8'));
    assert.equal(original.completed_at, cliOutput.completed_at);
    assert.equal(original.source_evidence.source_collection_time_raw, '2026-10-21 12:00:00');
    assert.equal(original.source_evidence.source_collection_time_timezone, 'Asia/Shanghai');
    f.setNow('2026-10-21T05:00:00.000Z');
    original.status = 'unknown';
    await writeFile(join(base, 'receipt.json'), `${JSON.stringify(original)}\n`);
    const checked = await f.collector.recheckAttempt(first.attempt_id, { token: f.token });
    assert.equal(checked.status, 'duplicate');
    assert.equal(checked.entity_id, checked.material_version_id);
    assert.ok(checked.evidence_refs.length > 0);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(join(base, 'receipt.json'), 'utf8')).status, 'unknown');
    const rechecked = JSON.parse(await readFile(checked.receipt_path, 'utf8'));
    assert.equal(rechecked.completed_at, cliOutput.completed_at);
    assert.equal(rechecked.verified_at, '2026-10-21T05:00:00.000Z');
    assert.ok(rechecked.rechecked_at);
    assert.equal(rechecked.status, 'succeeded');
  } finally { await f.close(); }
});

test('视频保留已观察正文并标记video_unread', async () => {
  const f = await fixture({ cli: async ({ outputDir }) => { await writeCliOutput(outputDir, { kind: '视频', imageCount: 0 }); return { exitCode: 0, stdout: SUMMARY, stderr: '' }; } });
  try {
    await discover(f);
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    assert.equal(result.completeness, 'video_unread');
  } finally { await f.close(); }
});

test('回执先落盘后崩溃可核验归账而不重复调用CLI', async () => {
  let calls = 0;
  const f = await fixture({
    cli: async ({ outputDir }) => { calls += 1; await writeCliOutput(outputDir, { imageCount: 1 }); return { exitCode: 0, stdout: SUMMARY, stderr: '' }; },
    afterReceipt: async () => { throw new Error('synthetic crash after receipt'); },
  });
  try {
    await discover(f);
    await assert.rejects(f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token }), /synthetic crash/);
    await f.collector.release(f.token);
    const reconciler = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER, decodeImage: async () => {}, now: () => STAMP });
    const result = await reconciler.resume('batch-1');
    assert.equal(calls, 1);
    assert.equal(result.reconciled, 1, JSON.stringify(result));
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM material_version WHERE fetch_status='succeeded'").get().n, 1);
  } finally { await f.close(); }
});

test('原始完整URL仅保存在私有输入证据；停止后的late worker不归账', async () => {
  let finish;
  let outputDir;
  const f = await fixture({ cli: (input) => { outputDir = input.outputDir; return new Promise((resolvePromise) => { finish = resolvePromise; }); } });
  try {
    await discover(f);
    const pending = f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token });
    while (!finish) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    f.store.db.prepare("UPDATE execution_slot SET stop_requested=1,state='stopping',revision=revision+1 WHERE slot_key='main'").run();
    await writeCliOutput(outputDir, { imageCount: 1 });
    finish({ exitCode: 0, stdout: SUMMARY, stderr: '' });
    const result = await pending;
    assert.equal(result.late_result, true);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM material_version WHERE fetch_status='succeeded'").get().n, 0);
    const privateFiles = await readFile(join(dirname(dirname(outputDir)), 'intent.json'), 'utf8');
    assert.ok(privateFiles.includes('xsec_token=private-token'));
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM content').all()).includes('private-token'));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('不可用CLI在claim attempt前阻断，且不写虚假attempt', async () => {
  const f = await fixture();
  try {
    await discover(f);
    await f.collector.release(f.token);
    const unavailable = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER,
      executable: join(f.root, 'missing-XHS-Downloader.exe'), settingsPath: join(f.root, 'settings.json'), now: () => STAMP });
    assert.deepEqual(await unavailable.preflight(), { status: 'blocked', reason: 'collection_cli_executable_unavailable' });
    const token = await unavailable.claim();
    const result = await unavailable.ensureMaterial(SOURCE, SOURCE_URL, { token });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'collection_cli_executable_unavailable');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM material_version').get().n, 0);
    await unavailable.release(token);
  } finally { await f.close(); }
});

test('已记录的精确spawn ENOENT失败可确认后恢复，不删除原unknown receipt', async () => {
  const f = await fixture({ cli: async () => { const error = new Error('spawn failed'); error.code = 'ENOENT'; throw error; } });
  try {
    await discover(f);
    let attempt = null;
    const result = await f.collector.ensureMaterial(SOURCE, SOURCE_URL, { token: f.token, onAttempt: async value => { attempt = value; } });
    assert.equal(result.status, 'unknown');
    assert.ok(attempt?.attemptId && attempt?.runId);
    const receiptRef = join(f.root, 'private', 'attempts', attempt.attemptId, 'receipt.json');
    const before = await readFile(receiptRef, 'utf8');
    assert.equal(JSON.parse(before).error_code, 'ENOENT');
    assert.equal(JSON.parse(before).failure_phase, 'spawn');
    await f.collector.release(f.token);
    const recovery = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER, cli: async () => { throw Error('must not run'); }, now: () => STAMP });
    const token = await recovery.claim();
    const resolved = await recovery.resolvePreDispatchFailure(attempt.attemptId, { token, sourceContentId: SOURCE, originalRunId: attempt.runId, evidenceRef: 'process:confirmed-no-child' });
    assert.equal(resolved.status, 'resolved_pre_dispatch_failure');
    assert.equal(await readFile(receiptRef, 'utf8'), before);
    await recovery.release(token);
  } finally { await f.close(); }
});

test('旧unknown回执无errno时只接受匹配哈希、已退出进程且无输出的恢复证明', async () => {
  const f = await fixture();
  try {
    await discover(f);
    const attemptId = randomUUID(), runId = randomUUID(), attemptDir = join(f.root, 'private', 'attempts', attemptId);
    await mkdir(join(attemptDir, 'work', 'Download'), { recursive: true });
    const intent = { attempt_id: attemptId, source_content_id: SOURCE, run_id: runId, process_id: -1,
      complete_source_url: SOURCE_URL, complete_source_url_hash: createHash('sha256').update(SOURCE_URL).digest('hex') };
    const receipt = { attempt_id: attemptId, run_id: runId, source_content_id: SOURCE, complete_source_url_hash: intent.complete_source_url_hash,
      status: 'unknown', error_name: 'Error', business: null, files: [], material: null };
    const intentRef = join(attemptDir, 'intent.json'), receiptRef = join(attemptDir, 'receipt.json'), cliRef = join(attemptDir, 'cli-output.json');
    await writeFile(intentRef, JSON.stringify(intent)); await writeFile(receiptRef, JSON.stringify(receipt));
    await writeFile(cliRef, JSON.stringify({ error_name: 'Error', started_at: STAMP, completed_at: STAMP }));
    const proofRef = join(f.root, 'legacy-resolution.json');
    const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    await writeFile(proofRef, JSON.stringify({ resolution: 'precondition_repaired_no_output', raw_errno_unavailable: true, attempt_id: attemptId,
      original_run_id: runId, candidate_id: 'candidate-legacy', source_content_id: SOURCE, intent_hash: await sha(intentRef), receipt_hash: await sha(receiptRef),
      cli_output_hash: await sha(cliRef), original_process_id: -1, original_process_exited: true, no_download_output: true, output_files: [],
      slot: 'stopped', repair_evidence_ref: 'public:verified-cli-repair' }));
    await f.collector.release(f.token);
    const resolution = createCollector({ store: f.store, root: join(f.root, 'private'), owner: OWNER, cli: async () => { throw Error('must not run'); } });
    const resolvedToken = await resolution.claim();
    const result = await resolution.resolvePreDispatchFailure(attemptId, { token: resolvedToken, sourceContentId: SOURCE,
      candidateId: 'candidate-legacy', originalRunId: runId, evidenceRef: proofRef });
    assert.equal(result.status, 'resolved_pre_dispatch_failure');
    assert.equal(result.resolution_kind, 'precondition_repaired_no_output');
    assert.equal(JSON.parse(await readFile(receiptRef, 'utf8')).error_code, undefined);
    await resolution.release(resolvedToken);
  } finally { await f.close(); }
});
