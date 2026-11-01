// 2026-10-23 Codex：仅用隔离SQLite和合成transport验证投递状态，不连接账号或网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createDelivery } from '../src/delivery.mjs';
import { createDisplay } from '../src/display.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

function harness(fixture, transport, now = '2026-10-23T04:01:00.000Z') {
  return createDelivery({
    store: fixture.store,
    root: `${fixture.root}/delivery`,
    owner: fixture.owner,
    targetRef: 'synthetic-chat',
    appRef: 'synthetic-app',
    transport,
    now: () => now,
    currentVersions: fixture.currentVersions,
  });
}

function defaultVersionsHarness(fixture, transport, now = '2026-10-23T04:01:00.000Z') {
  return createDelivery({
    store: fixture.store, root: `${fixture.root}/delivery-default`, owner: fixture.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', transport, now: () => now,
  });
}

test('默认基线选择遇到历史非JSON说明时按原门禁拒绝，不抛malformed JSON',async t=>{
  const f=await deliveryFixture(t);
  f.store.db.prepare("INSERT INTO baseline_version(baseline_version,coverage_description,created_at) VALUES('legacy-non-json','synthetic-only; no real recommendation evaluation','2099-01-01T00:00:00Z')").run();
  const delivery=defaultVersionsHarness(f,{send:async()=>{throw Error('must not send');},lookup:async()=>({status:'unknown'})});
  await assert.rejects(delivery.prepareDelivery(f.recommendation),error=>/current baseline evidence invalid/.test(error.message)&&!/malformed JSON/.test(error.message));
});

async function siblingRecommendation(f) {
  const batchId = randomUUID();
  const decision = f.store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(f.recommendation.decision_id);
  const originalCandidate = f.store.db.prepare('SELECT * FROM candidate WHERE candidate_id=?').get(decision.candidate_id);
  const at = '2026-10-23T04:00:00.000Z';
  f.store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,status,created_at)
    VALUES(?,?,'manual_follow','2026-10-23',1,'pending',?)`).run(batchId, f.owner, at);
  const candidateId = randomUUID();
  const decisionId = randomUUID();
  f.store.db.prepare(`INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,eligibility_state)
    VALUES(?,?,?,'homefeed',?,?,'eligible')`).run(candidateId, f.contentId, batchId, at, originalCandidate.source_evidence_ref);
  f.store.db.prepare(`INSERT INTO decision(decision_id,candidate_id,analysis_id,baseline_version,preference_version,strategy_version,category,relevance,gain_state,result,created_at)
    VALUES(?,?,?,?,?,?,?,'matched','gain','eligible',?)`).run(decisionId, candidateId, f.analysisId, decision.baseline_version,
    decision.preference_version, decision.strategy_version, decision.category, at);
  const display = createDisplay({ store: f.store, root: join(f.root, 'display'), owner: f.owner, appRef: 'synthetic-app', now: () => at });
  const built = await display.buildBatch(batchId, [{ decision_id: decisionId, candidate_id: candidateId, content_id: f.contentId }]);
  assert.equal(built.items[0]?.status, 'succeeded');
  return built.items[0];
}

function runChild(script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const done = new Promise((resolve, reject) => child.once('close', code => code === 0
    ? resolve(stdout.trim()) : reject(new Error(`child exit ${code}: ${stderr}`))));
  return { child, done };
}

function childProgram(f, attemptId, counter, behavior = 'succeed') {
  const storageUrl = pathToFileURL(join(process.cwd(), 'src/storage.mjs')).href;
  const deliveryUrl = pathToFileURL(join(process.cwd(), 'src/delivery.mjs')).href;
  return `
    import { appendFileSync } from 'node:fs';
    import { openStore } from ${JSON.stringify(storageUrl)};
    import { createDelivery } from ${JSON.stringify(deliveryUrl)};
    const store = openStore(${JSON.stringify(f.dbPath)});
    const client = createDelivery({ store, root: ${JSON.stringify(join(f.root, 'delivery'))}, owner: ${JSON.stringify(f.owner)},
      targetRef: 'synthetic-chat', appRef: 'synthetic-app', now: () => '2026-10-23T04:01:00.000Z',
      currentVersions: () => (${JSON.stringify(f.versions)}),
      transport: { async send() {
        appendFileSync(${JSON.stringify(counter)}, 'x');
        ${behavior === 'hang' ? "setInterval(() => {}, 1000); await new Promise(() => {});" : "await new Promise(resolve => setTimeout(resolve, 40));"}
        return { status: 'succeeded', message_id: 'process-message', evidence: 'synthetic:process-receipt' };
      }, async lookup() { return { status: 'unknown' }; } } });
    try { console.log(JSON.stringify(await client.sendPrepared(${JSON.stringify(attemptId)}))); }
    finally { store.close(); }
  `;
}

test('成功发送必须落receipt、成功账和唯一内容索引', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, {
    async send() { sends += 1; return { status: 'succeeded', message_id: 'message-1', evidence: 'synthetic:send-receipt-1' }; },
    async lookup() { return { status: 'unknown' }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  const sent = await delivery.sendPrepared(prepared.attempt_id);
  assert.equal(sent.status, 'succeeded');
  assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT status,message_id FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT message_id FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).message_id, 'message-1');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM delivered_content WHERE owner=? AND platform='xiaohongshu' AND source_content_id=?").get(f.owner, f.sourceContentId).n, 1);
});

test('明确平台拒绝归failed，重复调用不再发送', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, {
    async send() { sends += 1; return { status: 'failed', reason: 'platform_rejected', evidence: 'synthetic:platform-rejection' }; },
    async lookup() { return { status: 'unknown' }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'failed');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'failed');
  assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'failed');
});

test('未知发送结果只能查询核实，不会再次调用发送transport', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  let lookups = 0;
  const delivery = harness(f, {
    async send() { sends += 1; return { status: 'unknown', evidence: 'synthetic:timeout' }; },
    async lookup() { lookups += 1; return { status: 'unknown', evidence: 'synthetic:no-match-yet' }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  assert.equal((await delivery.reconcileDelivery(prepared.attempt_id)).status, 'unknown');
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
});

test('两个并发调用争用同一attempt时仅赢家调用transport', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const delivery = harness(f, {
    async send() { sends += 1; await waiting; return { status: 'succeeded', message_id: 'message-race', evidence: 'synthetic:race-receipt' }; },
    async lookup() { return { status: 'unknown' }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const first = delivery.sendPrepared(prepared.attempt_id);
  const second = delivery.sendPrepared(prepared.attempt_id);
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.equal(results.filter(result => result.status === 'succeeded').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 1);
});

test('receipt已落盘但归账事务失败，重启后精确恢复且不再次发送', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const transport = {
    async send() { sends += 1; return { status: 'succeeded', message_id: 'message-recovered', evidence: 'synthetic:receipt-recovery' }; },
    async lookup() { return { status: 'unknown' }; },
  };
  const first = harness(f, transport);
  const prepared = await first.prepareDelivery(f.recommendation, f.generation);
  f.store.db.exec("CREATE TRIGGER fail_delivery_account BEFORE UPDATE OF status ON delivery_attempt WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic account failure'); END");
  await assert.rejects(first.sendPrepared(prepared.attempt_id), /synthetic account failure/);
  f.store.db.exec('DROP TRIGGER fail_delivery_account');
  f.reopen();
  const restarted = harness(f, transport);
  assert.equal((await restarted.sendPrepared(prepared.attempt_id)).status, 'succeeded');
  assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT message_id FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).message_id, 'message-recovered');
});

test('独立进程收到成功响应并落receipt后归账失败，重启按receipt恢复', async t => {
  const f = await deliveryFixture(t);
  const prepared = await harness(f, { async send() { throw Error('主进程不得发送'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  f.store.db.exec("CREATE TRIGGER fail_delivery_account BEFORE UPDATE OF status ON delivery_attempt WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic child account failure'); END");
  const child = runChild(childProgram(f, prepared.attempt_id, join(f.root, 'child-call.txt')));
  await assert.rejects(child.done, /synthetic child account failure/);
  f.store.db.exec('DROP TRIGGER fail_delivery_account');
  f.reopen();
  let sends = 0;
  const restarted = harness(f, { async send() { sends += 1; throw Error('receipt must recover without resend'); }, async lookup() { return { status: 'unknown' }; } });
  assert.equal((await restarted.sendPrepared(prepared.attempt_id)).status, 'succeeded');
  assert.equal(sends, 0);
});

test('两个独立Node进程同时发送同一attempt，SQLite claim只允许一次外部调用', async t => {
  const f = await deliveryFixture(t);
  const prepared = await harness(f, { async send() { throw Error('主进程不得发送'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  const counter = join(f.root, 'calls.txt');
  const a = runChild(childProgram(f, prepared.attempt_id, counter));
  const b = runChild(childProgram(f, prepared.attempt_id, counter));
  const results = await Promise.all([a.done, b.done].map(done => done.then(value => ({ value }), error => ({ error: error.message }))));
  const calls = await readFile(counter, 'utf8');
  assert.equal(calls, 'x', JSON.stringify({ calls, results }));
  assert.deepEqual(results.filter(result => result.error), []);
  assert(results.every(result => ['succeeded', 'unknown'].includes(JSON.parse(result.value).status)));
  assert(results.some(result => JSON.parse(result.value).status === 'succeeded'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 1);
});

test('prepare完成后进程在claim前退出，重启仍可安全派发一次', async t => {
  const f = await deliveryFixture(t);
  const prepared = await harness(f, { async send() { throw Error('主进程不得发送'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  const storageUrl = pathToFileURL(join(process.cwd(), 'src/storage.mjs')).href;
  const child = runChild(`import { openStore } from ${JSON.stringify(storageUrl)}; const store=openStore(${JSON.stringify(f.dbPath)}); store.close();`);
  await child.done;
  let sends = 0;
  const restarted = harness(f, { async send() { sends += 1; return { status: 'succeeded', message_id: 'preclaim-message', evidence: 'synthetic:preclaim-receipt' }; }, async lookup() { return { status: 'unknown' }; } });
  assert.equal((await restarted.sendPrepared(prepared.attempt_id)).status, 'succeeded');
  assert.equal(sends, 1);
});

test('派发进程退出且没有receipt，重启核验转unknown且不会再次发送', async t => {
  const f = await deliveryFixture(t);
  const prepared = await harness(f, { async send() { throw Error('主进程不得发送'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  const counter = join(f.root, 'started.txt');
  const run = runChild(childProgram(f, prepared.attempt_id, counter, 'hang'));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await readFile(counter); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(await readFile(counter, 'utf8'), 'x');
  const childStopped = run.done.catch(() => {});
  run.child.kill();
  await childStopped;
  f.reopen();
  let sends = 0;
  let lookups = 0;
  const restarted = harness(f, {
    async send() { sends += 1; throw Error('unknown attempt must never resend'); },
    async lookup() { lookups += 1; return { status: 'unknown', evidence: 'synthetic:recovery-no-match' }; },
  });
  assert.equal((await restarted.reconcileDelivery(prepared.attempt_id)).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'unknown');
  assert.equal(sends, 0);
  assert.equal(lookups, 1);
});

test('无checkpoint的receipt文件不能被当作成功，恢复只能lookup且不重发', async t => {
  const f = await deliveryFixture(t);
  const prepared = await harness(f, { async send() { throw Error('主进程不得发送'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  const counter = join(f.root, 'receipt-pending-started.txt');
  const run = runChild(childProgram(f, prepared.attempt_id, counter, 'hang'));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await readFile(counter); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(await readFile(counter, 'utf8'), 'x');
  const attempt = f.store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  await writeFile(join(f.root, 'delivery', `receipt-${prepared.attempt_id}.json`), JSON.stringify({
    attempt_id: prepared.attempt_id,
    recommendation_id: attempt.recommendation_id,
    owner: f.owner,
    target_ref: 'synthetic-chat',
    app_hash: createHash('sha256').update('synthetic-app').digest('hex'),
    payload_hash: attempt.payload_hash,
    result: { status: 'succeeded', message_id: 'unverified-message', evidence: 'synthetic:unverified-file' },
    received_at: '2026-10-23T04:02:00.000Z',
  }));
  const stopped = run.done.catch(() => {});
  run.child.kill();
  await stopped;
  f.reopen();
  let sends = 0;
  let lookups = 0;
  const restarted = harness(f, {
    async send() { sends += 1; throw Error('claimed attempt must never resend'); },
    async lookup() { lookups += 1; return { status: 'unknown', evidence: 'synthetic:no-verified-platform-match' }; },
  });
  assert.equal((await restarted.reconcileDelivery(prepared.attempt_id)).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 0);
  assert.equal(sends, 0);
  assert.equal(lookups, 1);
});

test('停止标志或代次变化发生在派发前时取消意图且不调用发送', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, { async send() { sends += 1; return { status: 'unknown' }; }, async lookup() { return { status: 'unknown' }; } });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const current = f.store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(f.store.casSlot({ owner: null, runId: null, generation: current.generation + 1, stopRequested: true,
    expectedOwner: current.owner, expectedRunId: current.run_id, expectedGeneration: current.generation,
    expectedStopRequested: Boolean(current.stop_requested), expectedState: current.state, expectedRevision: current.revision,
    nextState: 'stopped' }).status, 'succeeded');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state, 'cancelled_before_dispatch');
  assert.equal(sends, 0);
});

test('dispatch前偏好/策略/基线变化取消旧decision并保存失效证据', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, { async send() { sends += 1; return { status: 'unknown' }; }, async lookup() { return { status: 'unknown' }; } });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  f.versions.baseline_version = 'new-baseline-version';
  const result = await delivery.sendPrepared(prepared.attempt_id);
  assert.equal(result.status, 'cancelled_before_dispatch');
  assert.equal(result.decision_invalidated, true);
  assert.equal(sends, 0);
  const checkpoint = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${prepared.attempt_id}`);
  const ref = JSON.parse(checkpoint.succeeded_refs_json)[0];
  const snapshot = await f.read(ref.ref);
  assert.equal(snapshot.decision_invalidated, true);
  assert.match(snapshot.cancellation_reason, /versions/);
});

test('另一批同owner同source的intent阻止重复prepare', async t => {
  const f = await deliveryFixture(t);
  const delivery = harness(f, { async send() { return { status: 'unknown' }; }, async lookup() { return { status: 'unknown' }; } });
  await delivery.prepareDelivery(f.recommendation, f.generation);
  const sibling = await siblingRecommendation(f);
  await assert.rejects(harness(f, { async send() { throw Error('must not send'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(sibling), /content already has intent delivery/);
});

test('unknown收藏观测不推断为当前已收藏', async t => {
  const f = await deliveryFixture(t);
  const collectionId = randomUUID();
  f.store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_known,created_at)
    VALUES(?,?,?,?,1,?)`).run(collectionId, '2026-10-23', '2026-10-23', '{}', '2026-10-23T04:00:00.000Z');
  f.store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref)
    VALUES(?,?,?,?,?,?)`).run(randomUUID(), collectionId, f.contentId, '2026-10-23T04:00:00.000Z', 'unknown', 'synthetic:incomplete-observation');
  const prepared = await harness(f, { async send() { return { status: 'unknown' }; }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
});

test('默认版本门禁读取已验证偏好，并接受完整收藏基线', async t => {
  const f = await deliveryFixture(t);
  const delivery = defaultVersionsHarness(f, {
    async send() { return { status: 'succeeded', message_id: 'default-version-message', evidence: 'synthetic:default-version-receipt' }; },
    async lookup() { return { status: 'unknown' }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'succeeded');
});

test('默认版本门禁拒绝偏好证据损坏、收藏集合变化和不完整baseline', async t => {
  const damaged = await deliveryFixture(t);
  await writeFile(damaged.preferenceReceiptRef, '{}');
  await assert.rejects(defaultVersionsHarness(damaged, { async send() { throw Error('must not send'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(damaged.recommendation, damaged.generation), /current preference evidence invalid/);

  const membership = await deliveryFixture(t);
  const collectionId = randomUUID();
  membership.store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_known,created_at)
    VALUES(?,?,?,?,1,?)`).run(collectionId, '2026-10-23', '2026-10-23', '{"input_complete":true}', '2026-10-23T04:02:00.000Z');
  membership.store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref)
    VALUES(?,?,?,?,?,?)`).run(randomUUID(), collectionId, membership.contentId, '2026-10-23T04:02:00.000Z', 'present', 'synthetic:new-favorite');
  await assert.rejects(defaultVersionsHarness(membership, { async send() { throw Error('must not send'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(membership.recommendation, membership.generation), /baseline membership changed/);

  const incomplete = await deliveryFixture(t);
  incomplete.store.db.prepare(`INSERT INTO baseline_version(baseline_version,material_version_ids_json,coverage_description,created_at)
    VALUES(?,?,?,?)`).run(randomUUID(), JSON.stringify([incomplete.baselineMaterialId]),
    JSON.stringify({ material_ids: [incomplete.baselineMaterialId], coverage: { input_complete: false } }), '2026-10-23T04:03:00.000Z');
  await assert.rejects(defaultVersionsHarness(incomplete, { async send() { throw Error('must not send'); }, async lookup() { return { status: 'unknown' }; } })
    .prepareDelivery(incomplete.recommendation, incomplete.generation), /current baseline is incomplete/);
});

test('明确失败项可重新准备，成功项不可重发', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const refused = harness(f, { async send() { sends += 1; return { status: 'failed', reason: 'platform_rejected', evidence: ['synthetic:reject-1', 'synthetic:reject-2'] }; }, async lookup() { return { status: 'unknown' }; } });
  const first = await refused.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await refused.sendPrepared(first.attempt_id)).status, 'failed');
  const accepted = harness(f, { async send() { sends += 1; return { status: 'succeeded', message_id: 'message-retry', evidence: ['synthetic:retry-proof'] }; }, async lookup() { return { status: 'unknown' }; } });
  const second = await accepted.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await accepted.sendPrepared(second.attempt_id)).status, 'succeeded');
  await assert.rejects(accepted.prepareDelivery(f.recommendation, f.generation), /not dispatchable/);
  assert.equal(sends, 2);
  assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT query_evidence_refs_json FROM delivery_attempt WHERE delivery_attempt_id=?').get(first.attempt_id).query_evidence_refs_json), ['synthetic:reject-1', 'synthetic:reject-2']);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM delivery_attempt WHERE recommendation_id=? AND status='failed'").get(f.recommendation.recommendation_id).n, 1);
});

test('unknown跨北京时间日界核实成功后仍归原批', async t => {
  const f = await deliveryFixture(t);
  const first = harness(f, { async send() { return { status: 'unknown', evidence: 'synthetic:timeout' }; }, async lookup() { return { status: 'unknown' }; } }, '2026-10-23T15:59:00.000Z');
  const prepared = await first.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await first.sendPrepared(prepared.attempt_id)).status, 'unknown');
  let query;
  const afterMidnight = harness(f, { async send() { throw Error('unknown must never resend'); }, async lookup(input) {
    query = input;
    return { status: 'succeeded', message_id: 'late-message', evidence: ['synthetic:exact-readback'] };
  } }, '2026-10-23T16:01:00.000Z');
  const resolved = await afterMidnight.reconcileDelivery(prepared.attempt_id);
  assert.equal(resolved.status, 'succeeded');
  assert.equal(query.target_ref, 'synthetic-chat');
  assert.equal(query.payload.content, f.recommendation.payload.content);
  assert.equal(query.ordinal, f.recommendation.ordinal);
  assert(query.started_at && query.ended_at);
  assert.equal(f.store.db.prepare('SELECT delivery_batch_id FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).delivery_batch_id, f.batchId);
});

test('损坏的成功receipt在重启恢复时拒绝归账', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const transport = { async send() { sends += 1; return { status: 'succeeded', message_id: 'message-corrupt', evidence: 'synthetic:receipt' }; }, async lookup() { return { status: 'unknown' }; } };
  const delivery = harness(f, transport);
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  f.store.db.exec("CREATE TRIGGER fail_delivery_account BEFORE UPDATE OF status ON delivery_attempt WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic account failure'); END");
  await assert.rejects(delivery.sendPrepared(prepared.attempt_id), /synthetic account failure/);
  f.store.db.exec('DROP TRIGGER fail_delivery_account');
  await writeFile(join(f.root, 'delivery', `receipt-${prepared.attempt_id}.json`), '{}');
  f.reopen();
  await assert.rejects(harness(f, transport).sendPrepared(prepared.attempt_id), /checkpoint missing or mismatched/);
  assert.equal(sends, 1);
});

test('后续查询成功receipt损坏时，历史unknown receipt不能替代成功证据', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, {
    async send() { sends += 1; return { status: 'unknown', evidence: ['synthetic:initial-unknown'] }; },
    async lookup() { return { status: 'succeeded', message_id: 'verified-message', evidence: ['synthetic:exact-query-proof'] }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  assert.equal((await delivery.reconcileDelivery(prepared.attempt_id)).status, 'succeeded');
  const checkpointRows = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC')
    .all(f.owner, `delivery-attempt:${prepared.attempt_id}`);
  let successReceipt;
  for (const row of checkpointRows) {
    const checkpoint = await f.read(JSON.parse(row.succeeded_refs_json)[0].ref);
    if (checkpoint.receipt_result?.status === 'succeeded') successReceipt = checkpoint.receipt_ref;
  }
  assert.ok(successReceipt, '查询成功的receipt应有checkpoint引用');
  await writeFile(successReceipt, '{}');
  f.reopen();
  await assert.rejects(harness(f, {
    async send() { sends += 1; throw Error('已成功归账的attempt不得重发'); },
    async lookup() { throw Error('此次定向只核验已归账证据'); },
  }).sendPrepared(prepared.attempt_id), /evidence_unverifiable|accounted delivery receipt missing or corrupt/);
  const restarted = harness(f, {
    async send() { sends += 1; throw Error('终态恢复不得重发'); },
    async lookup() { throw Error('终态证据校验不执行新查询'); },
  });
  await assert.rejects(restarted.reconcileDelivery(prepared.attempt_id), /evidence_unverifiable/);
  await assert.rejects(restarted.recover({attemptId:prepared.attempt_id,confirmedStoppedRunId:'synthetic-stopped',evidenceRef:'synthetic:recovery'}), /evidence_unverifiable/);
  const attempt = f.store.db.prepare('SELECT status,message_id FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.message_id, 'verified-message');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 1);
  assert.equal(sends, 1);
});

test('已归账成功回执必须匹配最终message_id和query evidence', async t => {
  const f = await deliveryFixture(t);
  const delivery = harness(f, {
    async send() { return { status: 'unknown', evidence: ['synthetic:initial-unknown'] }; },
    async lookup() { return { status: 'succeeded', message_id: 'verified-message', evidence: ['synthetic:exact-query-proof'] }; },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  await delivery.sendPrepared(prepared.attempt_id);
  await delivery.reconcileDelivery(prepared.attempt_id);
  f.store.db.prepare('UPDATE delivery_attempt SET message_id=? WHERE delivery_attempt_id=?')
    .run('different-message-id', prepared.attempt_id);
  await assert.rejects(harness(f, { async send() { throw Error('must not resend'); }, async lookup() { return { status: 'unknown' }; } })
    .sendPrepared(prepared.attempt_id), /evidence_unverifiable/);
  f.store.db.prepare('UPDATE delivery_attempt SET message_id=?,query_evidence_refs_json=? WHERE delivery_attempt_id=?')
    .run('verified-message', '[]', prepared.attempt_id);
  await assert.rejects(harness(f, { async send() { throw Error('must not resend'); }, async lookup() { return { status: 'unknown' }; } })
    .sendPrepared(prepared.attempt_id), /evidence_unverifiable/);
  assert.equal(f.store.db.prepare('SELECT status,message_id FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 1);
});
