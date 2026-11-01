import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { openStore } from '../src/storage.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createFeedback } from '../src/feedback.mjs';

async function fixture(t, now) {
  const root = await mkdtemp(join(tmpdir(), 'task013-admission-'));
  const store = openStore(join(root, 'state.sqlite'));
  const owner = 'task013-test-owner';
  const runtime = {};
  const orchestrator = createOrchestrator({ store, root, owner, appRef: 'test-app', targetRef: 'test-target', runtime, now: () => now });
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  return { store, root, owner, runtime, orchestrator };
}

test('每日入口在11:15前不创建批次', async t => {
  const { store, orchestrator } = await fixture(t, '2026-10-23T03:14:59.000Z');
  const result = await orchestrator.run({ kind: 'daily_follow' });
  assert.equal(result.status, 'not_due');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM batch').get().n, 0);
});

test('首次到期但runtime不可用时持久化唯一blocked日批，稍后复用同一身份', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const first = await orchestrator.run({ kind: 'daily_follow' });
  const saved = store.db.prepare("SELECT delivery_batch_id,status FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-23'").get(owner);
  assert.equal(first.status, 'blocked');
  assert.ok(saved);
  assert.equal(first.batch_id, saved.delivery_batch_id);
  assert.equal(saved.status, 'blocked');

  const later = await orchestrator.run({ kind: 'daily_follow', tab: {} });
  assert.equal(later.status, 'blocked');
  assert.equal(later.batch_id, saved.delivery_batch_id);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-23'").get(owner).n, 1);
});

test('已存在的当日日批在runtime不可用时仍返回批身份', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-23',20,'2026-10-23T04:00:00.000Z','pending',0)`).run(batchId, owner);
  const result = await orchestrator.run({ kind: 'daily_follow', tab: {} });
  assert.equal(result.status, 'blocked');
  assert.equal(result.batch_id, batchId);
  assert.match(result.reason, /runtime capabilities/i);
});

test('跨过上海午夜后先关闭旧日批，即使未到12点也不抢占活动协调头', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T16:01:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-23',20,'2026-10-23T15:00:00.000Z','running',1)`).run(batchId, owner);
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?)`).run(randomUUID(), owner, runId, 1, batchId, JSON.stringify([runId]), '2026-10-23T15:00:00.000Z');
  const result = await orchestrator.run({ kind: 'daily_follow' });
  assert.equal(result.status, 'not_due');
  assert.equal(store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=?').get(batchId).status, 'closed_day');
  assert.equal(JSON.parse(store.db.prepare("SELECT pending_ids_json FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().pending_ids_json)[0], runId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM batch').get().n, 1);
});

test('活动的旧协调者阻止新业务命令获得执行许可', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'old-command','additional_follow','2026-10-23',3,'2026-10-23T04:00:00.000Z','running',1)`).run(batchId, owner);
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?)`).run(randomUUID(), owner, runId, 1, batchId, JSON.stringify([runId]), '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.run({ kind: 'additional_follow', commandId: 'new-command', explicitRequest: true });
  assert.equal(result.status, 'recovery_required');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM batch').get().n, 1);
});

test('追加和探索入口都要求受支持的tab；探索还必须带原始请求与方向', async t => {
  const { store, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const additional = await orchestrator.run({ kind: 'additional_follow', commandId: 'extra-1', explicitRequest: '追加关注' });
  assert.equal(additional.status, 'blocked');
  assert.match(additional.reason, /tab/i);
  const explore = await orchestrator.run({ kind: 'explore', commandId: 'explore-1', explicitRequest: '探索请求' });
  assert.equal(explore.status, 'blocked');
  assert.match(explore.reason, /direction/i);
  const savedExplore = store.db.prepare('SELECT kind,status,command_id FROM batch WHERE command_id=?').get('explore-1');
  assert.deepEqual({ ...savedExplore }, { kind: 'explore', status: 'blocked', command_id: 'explore-1' });
});

test('追加请求保留requestText契约并在能力缺失时阻塞', async t => {
  const { store, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.run({ kind: 'additional_follow', commandId: 'request-text-1', requestText: '请追加关注', tab: {} });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /runtime capabilities/i);
  const request = JSON.parse(store.db.prepare("SELECT succeeded_refs_json FROM checkpoint WHERE stage LIKE 'orchestration:request:%'").get().succeeded_refs_json)[0].orchestration_request;
  assert.equal(request.source, 'direct_user');
  assert.equal(request.command_id, 'request-text-1');
  assert.equal(request.request_text, '请追加关注');
});

test('feedback事件原文和类型绑定稳定commandId，重放不产生第二批', async t => {
  const { store, root, owner, runtime, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  runtime.feedback = createFeedback({ store, root, owner, appRef: 'test-app', chatRef: 'test-chat', senderRef: 'test-sender',
    transport: { async send() { return { status: 'succeeded', message_id: 'unused' }; }, async lookup() { return { status: 'unknown' }; } } });
  const event = { app_ref: 'test-app', chat_ref: 'test-chat', sender_ref: 'test-sender', event_id: 'feedback-request-1',
    message_id: 'message-1', created_at: '2026-10-23T04:00:00.000Z', received_at: '2026-10-23T04:00:00.000Z',
    source_message_type: 'text', text: '再来3条' };
  await runtime.feedback.applyFeedback(event);
  const [pending] = await runtime.feedback.pendingRequests({ eventId: event.event_id });
  const commandId = pending.provenance.command_id;
  const first = await orchestrator.run({ kind: 'additional_follow', commandId, requestText: event.text, requestSource: 'feedback', tab: {} });
  const second = await orchestrator.run({ kind: 'additional_follow', commandId, requestText: event.text, requestSource: 'feedback', tab: {} });
  assert.equal(first.status, 'blocked');
  assert.equal(first.batch_id, second.batch_id);
  const saved = JSON.parse(store.db.prepare("SELECT succeeded_refs_json FROM checkpoint WHERE stage LIKE 'orchestration:request:%'").get().succeeded_refs_json)[0].orchestration_request;
  assert.equal(saved.source, 'feedback');
  assert.equal(saved.feedback.kind, 'feedback_event');
  assert.equal(saved.feedback.event_id, event.event_id);
  assert.equal(saved.request_text, event.text);
  await assert.rejects(orchestrator.run({ kind: 'additional_follow', commandId, requestText: '别的原文', requestSource: 'feedback', tab: {} }), /provenance|already bound/i);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM batch').get().n, 1);
});

test('活动协调者的PID仍存活时recover不能仅凭证据字符串静止全局头', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  const proof = { owner, batchId, runId, batchGeneration: 1, active: true, process_id: process.pid,
    process_instance_id: 'other-live-process-instance', process_started_at: '2026-10-23T04:00:00.000Z',
    invocation_state: 'executing', worker_refs: [] };
  const outputHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-23',20,'2026-10-23T04:00:00.000Z','running',1)`).run(batchId, owner);
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), owner, runId, 1, batchId, JSON.stringify([runId]),
    JSON.stringify([{ orchestration: proof }]), outputHash, '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: runId, evidenceRef: 'operator-assertion' });
  assert.equal(result.status, 'recovery_required');
  assert.equal(JSON.parse(store.db.prepare("SELECT pending_ids_json FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().pending_ids_json)[0], runId);
});

test('continue不能把其他owner的静止协调头当作本批退出证明', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,generation,stop_requested)
    VALUES(?,?,'continue-owner-test','additional_follow','2026-10-23',3,'2026-10-23T04:00:00.000Z','stopped',1,1)`).run(batchId, owner);
  const proof = { owner: 'foreign-owner', batchId, runId, batchGeneration: 1, active: false, process_id: process.pid,
    process_instance_id: 'foreign-instance', process_started_at: '2026-10-23T04:00:00.000Z',
    invocation_state: 'returned', worker_refs: [] };
  const outputHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main','[]',?,?,?)`).run(randomUUID(), 'foreign-owner', runId, 1, batchId,
    JSON.stringify([{ orchestration: proof }]), outputHash, '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.continueBatch({ batchId, commandId: 'continue-owner-test',
    confirmedStoppedRunId: runId, evidenceRef: 'operator-confirmation', explicitRequest: true });
  assert.equal(result.status, 'recovery_required');
  assert.equal(store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=?').get(batchId).status, 'stopped');
});

test('活动协调头缺少阶段worker引用时recover保持阻塞', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  const proof = { owner, batchId, runId, batchGeneration: 1, active: true, process_id: 2147483647,
    process_instance_id: 'crashed-process-instance', process_started_at: '2026-10-23T04:00:00.000Z',
    invocation_state: 'executing', worker_refs: [] };
  const outputHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-23',20,'2026-10-23T04:00:00.000Z','running',1)`).run(batchId, owner);
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), owner, runId, 1, batchId, JSON.stringify([runId]),
    JSON.stringify([{ orchestration: proof }]), outputHash, '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: runId, evidenceRef: 'operator-confirmation' });
  assert.equal(result.status, 'recovery_required');
  assert.match(result.reason, /worker.*proof|worker.*reference|worker.*exit|stage_worker/i);
  assert.equal(JSON.parse(store.db.prepare("SELECT pending_ids_json FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().pending_ids_json)[0], runId);
});

test('recoverCoordinator先用homefeed原run证明回收残留slot', async t => {
  const { store, root, owner, runtime, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  Object.assign(runtime, { collection: {}, analysis: {}, candidates: {}, display: {},
    delivery: { transport: { async send() { throw new Error('unexpected recovery fixture send'); }, async lookup() { throw new Error('unexpected recovery fixture lookup'); } } } });
  const batchId = randomUUID(), coordinatorRunId = randomUUID(), stageRunId = randomUUID();
  const batchGeneration = 1;
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const stagePid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`fixture child exited ${code}`)));
  });

  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-23',20,'2026-10-23T04:00:00.000Z','running',?)`).run(batchId, owner, batchGeneration);
  const phaseRefs = [];
  for (const stage of ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery']) {
    const value = { phase: stage, status: stage === 'homefeed' ? 'succeeded' : 'skipped',
      result: { reason: 'synthetic stopped coordinator recovery test' }, evidence_refs: [], recorded_at: '2026-10-23T04:00:00.000Z' };
    const checkpointId = randomUUID(), outputHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,input_hash,output_hash,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(checkpointId, owner, coordinatorRunId, batchGeneration, batchId,
      `orchestration:phase:${batchId}:${stage}`, '[]', JSON.stringify([{ orchestration_phase: value }]), 'phase-input', outputHash, '2026-10-23T04:00:00.000Z');
    phaseRefs.push({ stage, status: value.status, checkpoint_id: checkpointId, output_hash: outputHash });
  }
  const proof = { owner, batchId, runId: coordinatorRunId, batchGeneration, active: true, process_id: stagePid,
    process_instance_id: 'dead-coordinator-process-instance', process_started_at: '2026-10-23T04:00:00.000Z',
    invocation_state: 'executing', worker_refs: [], phase_refs: phaseRefs };
  const outputHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), owner, coordinatorRunId, batchGeneration, batchId,
    JSON.stringify([coordinatorRunId]), JSON.stringify([{ orchestration: proof }]), outputHash, '2026-10-23T04:00:00.000Z');
  const stageSlot = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  const claimed = store.casSlot({ owner, runId: stageRunId, generation: stageSlot.generation + 1, batchId,
    stopRequested: false, expectedOwner: null, expectedRunId: null, expectedGeneration: stageSlot.generation,
    expectedStopRequested: false, expectedState: stageSlot.state, expectedRevision: stageSlot.revision,
    nextState: 'running', updatedAt: '2026-10-23T04:00:00.000Z',
    coordination: { owner, batchId, runId: coordinatorRunId, batchGeneration } });
  assert.equal(claimed.status, 'succeeded');
  const runDir = join(root, 'homefeed', 'runs');
  await mkdir(runDir, { recursive: true });
  const runPath = join(runDir, `${stageRunId}.json`);
  await writeFile(runPath, `${JSON.stringify({ pid: stagePid, batchId, owner, generation: stageSlot.generation + 1,
    started_at: '2026-10-23T04:00:00.000Z', state: 'running' })}\n`);

  const result = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: coordinatorRunId, evidenceRef: 'operator-confirmation' });
  assert.equal(result.status, 'recovered', JSON.stringify(result));
  assert.equal(result.batch_id, batchId);
  assert.equal(store.db.prepare("SELECT state,owner,run_id FROM execution_slot WHERE slot_key='main'").get().state, 'stopped');
  assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(runPath, 'utf8')).state, 'recovered');
});

test('正常静止头可由同一常驻进程明确继续', async t => {
  const { store, owner, orchestrator } = await fixture(t, '2026-10-23T04:00:00.000Z');
  const batchId = randomUUID(), runId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,generation,stop_requested)
    VALUES(?,?,'continue-same-host','additional_follow','2026-10-23',3,'2026-10-23T04:00:00.000Z','stopped',1,1)`).run(batchId, owner);
  const workerRefs = [];
  for (const stage of ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery']) {
    const value = { phase: stage, status: 'succeeded', result: null, evidence_refs: [], recorded_at: '2026-10-23T04:00:00.000Z' };
    const checkpointId = randomUUID(), outputHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,input_hash,output_hash,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(checkpointId, owner, runId, 1, batchId, `orchestration:phase:${batchId}:${stage}`, '[]',
      JSON.stringify([{ orchestration_phase: value }]), 'input-hash', outputHash, '2026-10-23T04:00:00.000Z');
    workerRefs.push({ stage, status: 'succeeded', checkpoint_id: checkpointId, output_hash: outputHash });
  }
  const proof = { owner, batchId, runId, batchGeneration: 1, active: false, process_id: process.pid,
    process_instance_id: 'same-long-lived-host', process_started_at: '2026-10-23T04:00:00.000Z',
    invocation_state: 'returned', worker_refs: [], phase_refs: workerRefs, worker_audit_complete: true };
  const outputHash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main','[]',?,?,?)`).run(randomUUID(), owner, runId, 1, batchId,
    JSON.stringify([{ orchestration: proof }]), outputHash, '2026-10-23T04:00:00.000Z');
  const result = await orchestrator.continueBatch({ batchId, commandId: 'continue-same-host',
    confirmedStoppedRunId: runId, evidenceRef: 'normal-return-checkpoint', explicitRequest: true });
  assert.equal(result.status, 'continued');
  assert.equal(store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(batchId).generation, 2);
});
