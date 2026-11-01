import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDelivery } from '../src/delivery.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

function harness(f, transport, coordination = null) {
  return createDelivery({ store: f.store, root: join(f.root, 'delivery'), owner: f.owner, targetRef: 'synthetic-chat',
    appRef: 'synthetic-app', transport, coordination, now: () => '2026-10-23T04:01:00.000Z', currentVersions: f.currentVersions });
}

const transport = (send = async () => ({ status: 'unknown' })) => ({ send, async lookup() { return { status: 'unknown' }; } });
const sha = value => createHash('sha256').update(value).digest('hex');

function insertCoordinatorHead(store, coordination, active, details = {}) {
  const committedAt = '2026-10-23T04:00:00.000Z';
  const proof = { ...coordination, active, process_id: process.pid, process_instance_id: 'delivery-cancel-test-instance',
    process_started_at: committedAt, invocation_state: active ? 'executing' : 'returned', worker_refs: [], phase_refs: [],
    updated_at: committedAt, ...details };
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
    succeeded_refs_json,input_hash,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?,?)`).run(randomUUID(), coordination.owner, coordination.runId,
    coordination.batchGeneration, coordination.batchId, JSON.stringify(active ? [coordination.runId] : []),
    JSON.stringify([{ orchestration: proof }]), sha(JSON.stringify(coordination)), sha(JSON.stringify(proof)), committedAt);
}

function insertReturnedPhases(store, coordination) {
  const stages = ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'];
  return stages.map(stage => {
    const phase = { phase: stage, status: 'skipped', result: { reason: 'synthetic-run-returned' }, evidence_refs: [], recorded_at: '2026-10-23T04:00:00.000Z' };
    const checkpointId = randomUUID();
    const outputHash = sha(JSON.stringify(phase));
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
      succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(checkpointId, coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
        `orchestration:phase:${coordination.batchId}:${stage}`, '[]', JSON.stringify([{ orchestration_phase: phase }]),
        sha(JSON.stringify(coordination)), outputHash, phase.recorded_at);
    return { stage, checkpoint_id: checkpointId, output_hash: outputHash, status: 'skipped' };
  });
}

async function cancelledAndContinued(f, send = async () => ({ status: 'unknown' })) {
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: '2026-10-23T04:00:00.000Z' });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinatorHead(f.store, previous, true);
  const oldDelivery = harness(f, transport(send), previous);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);
  assert.equal((await oldDelivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef })).status, 'cancelled_before_dispatch');

  const stopBatch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const stopped = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: stopBatch.status,
    expectedRevision: stopBatch.revision, nextState: stopBatch.status, fields: { stop_requested: 1 }, updatedAt: '2026-10-23T04:01:00.000Z' });
  assert.equal(stopped.status, 'succeeded');
  const phaseRefs = insertReturnedPhases(f.store, previous);
  insertCoordinatorHead(f.store, previous, false, { phase_refs: phaseRefs, phase_audit_complete: true });
  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime: { delivery: { transport: transport(send) } }, now: () => '2026-10-23T04:02:00.000Z' });
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-command-1',
    confirmedStoppedRunId: previous.runId, evidenceRef: 'synthetic-explicit-continue', explicitRequest: true });
  assert.equal(continued.status, 'continued');
  return { prepared, evidenceRef, oldDelivery, continued, delivery: harness(f, transport(send), continued.coordination) };
}

async function cancellationEvidence(f, attemptId, overrides = {}) {
  const row = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${attemptId}`);
  const proof = JSON.parse(row.succeeded_refs_json)[0];
  const intentState = JSON.parse(await readFile(proof.ref, 'utf8'));
  const intent = JSON.parse(await readFile(intentState.intent_ref, 'utf8'));
  const value = {
    attempt_id: intent.attempt_id, recommendation_id: intent.recommendation_id, content_id: intent.content_id,
    decision_id: intent.decision_id, delivery_batch_id: intent.delivery_batch_id, owner: intent.owner,
    target_ref: intent.target_ref, app_hash: intent.app_hash, payload_hash: intent.payload_hash,
    coordination: intent.coordination ?? null, intent_ref: intentState.intent_ref, intent_hash: intentState.intent_hash,
    reason: 'synthetic-explicit-cancel', ...overrides,
  };
  const ref = join(f.root, `cancel-${attemptId}-${Object.keys(overrides)[0] ?? 'valid'}.json`);
  await writeFile(ref, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  return ref;
}

test('精确准备证据允许取消未派发 intent，且不调用 transport', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, transport(async () => { sends++; return { status: 'unknown' }; }));
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);

  const result = await delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef });

  assert.equal(result.status, 'cancelled_before_dispatch');
  const attempt = f.store.db.prepare('SELECT status,dispatched_at,query_evidence_refs_json FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  assert.equal(attempt.status, 'cancelled_before_dispatch');
  assert.equal(attempt.dispatched_at, null);
  assert.deepEqual(JSON.parse(attempt.query_evidence_refs_json), [evidenceRef]);
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state, 'cancelled_before_dispatch');
  const cancelledProof = f.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${prepared.attempt_id}`);
  const cancelledRef = JSON.parse(cancelledProof.succeeded_refs_json)[0];
  const cancelledContext = await f.read(cancelledRef.ref);
  assert.equal(cancelledContext.phase, 'cancelled_before_dispatch');
  assert.equal(cancelledContext.cancellation_evidence_ref, evidenceRef);
  assert.equal(cancelledContext.cancellation_evidence_hash, sha(await readFile(evidenceRef)));
  assert.equal((await delivery.reconcileDelivery(prepared.attempt_id)).status, 'cancelled_before_dispatch');
  assert.equal((await delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef })).status, 'cancelled_before_dispatch');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'cancelled_before_dispatch');
  assert.equal(sends, 0);
});

test('取消evidence须精确绑定attempt、owner、target和app', async t => {
  const f = await deliveryFixture(t);
  const delivery = harness(f, transport());
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  for (const [field, wrong] of [['attempt_id', 'other-attempt'], ['owner', 'other-owner'], ['target_ref', 'other-target'], ['app_hash', 'other-app']]) {
    const evidenceRef = await cancellationEvidence(f, prepared.attempt_id, { [field]: wrong });
    assert.throws(() => delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef }), /evidence binding/i, field);
  }
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'intent');
});

test('取消拒绝被篡改的原 intent checkpoint，保留 attempt intent', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, transport(async () => { sends++; return { status: 'unknown' }; }));
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);
  const row = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${prepared.attempt_id}`);
  const ref = JSON.parse(row.succeeded_refs_json)[0];
  await writeFile(ref.ref, '{"attempt_id":"other-attempt"}\n');

  assert.throws(() => delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef }), /hash|evidence|intent|checkpoint/i);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'intent');
  assert.equal(sends, 0);
});

test('派发先取得 dispatched_at 后 cancellation 不得取消，发送仍只发生一次', async t => {
  const f = await deliveryFixture(t);
  let sends = 0, markSendStarted, resolveSend;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  const sendResult = new Promise(resolve => { resolveSend = resolve; });
  const delivery = harness(f, transport(async () => { sends++; markSendStarted(); return sendResult; }));
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);
  const sending = delivery.sendPrepared(prepared.attempt_id);
  await sendStarted;

  const result = await delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef });

  const attempt = f.store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  assert.notEqual(result.status, 'cancelled_before_dispatch');
  assert.equal(attempt.status, 'intent');
  assert.ok(attempt.dispatched_at);
  resolveSend({ status: 'succeeded', message_id: 'synthetic-message', evidence: 'synthetic:delivery-receipt' });
  assert.equal((await sending).status, 'succeeded');
  assert.equal(sends, 1);
});

test('unknown attempt 不因 cancellation 被改写或重新发送', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, transport(async () => { sends++; return { status: 'unknown', evidence: 'synthetic:timeout' }; }));
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');

  const result = await delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef });

  assert.equal(result.status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'unknown');
  assert.equal(sends, 1);
});

test('已成功receipt保持原账且不会再次send', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const delivery = harness(f, transport(async () => { sends++; return { status: 'succeeded', message_id: 'synthetic-message', evidence: 'synthetic:delivery-receipt' }; }));
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  const evidenceRef = await cancellationEvidence(f, prepared.attempt_id);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'succeeded');

  assert.equal(delivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef }).status, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'succeeded');
  assert.equal(sends, 1);
});

test('明确同批continue后原取消推荐建立新attempt，旧attempt保持取消且仅发送一次', async t => {
  const f = await deliveryFixture(t);
  let sends = 0;
  const flow = await cancelledAndContinued(f, async () => {
    sends++;
    return { status: 'succeeded', message_id: 'synthetic-reprepared-message', evidence: 'synthetic:reprepared-receipt' };
  });
  const args = { attemptId: flow.prepared.attempt_id, item: f.recommendation, continueCommandId: 'continue-command-1',
    evidenceRef: flow.evidenceRef, expectedGeneration: f.generation };
  const reprepared = await flow.delivery.reprepareCancelled(args);
  const duplicate = await flow.delivery.reprepareCancelled(args);

  assert.equal(reprepared.status, 'succeeded');
  assert.equal(duplicate.attempt_id, reprepared.attempt_id);
  assert.notEqual(reprepared.attempt_id, flow.prepared.attempt_id);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(flow.prepared.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?').get(f.recommendation.recommendation_id).n, 2);
  const newProof = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${reprepared.attempt_id}`);
  const newIntent = JSON.parse(await readFile(JSON.parse(newProof.succeeded_refs_json)[0].ref, 'utf8'));
  assert.equal(newIntent.previous_attempt_id, flow.prepared.attempt_id);
  assert.equal(newIntent.continue_command_id, 'continue-command-1');
  assert.equal(newIntent.coordination.runId, flow.continued.coordination.runId);
  assert.equal(newIntent.ordinal, f.recommendation.ordinal);

  assert.equal((await flow.delivery.sendPrepared(reprepared.attempt_id)).status, 'succeeded');
  assert.equal(sends, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(flow.prepared.attempt_id).status,
    'cancelled_before_dispatch');
});

test('reprepare拒绝别的continue命令且取消推荐保持原态', async t => {
  const f = await deliveryFixture(t);
  const flow = await cancelledAndContinued(f);
  await assert.rejects(() => flow.delivery.reprepareCancelled({ attemptId: flow.prepared.attempt_id, item: f.recommendation,
    continueCommandId: 'other-continue-command', evidenceRef: flow.evidenceRef, expectedGeneration: f.generation }), /continue|command|coordinator/i);
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?').get(f.recommendation.recommendation_id).n, 1);
});

test('reprepare事务内创建新attempt失败时推荐状态回滚为cancelled', async t => {
  const f = await deliveryFixture(t);
  const flow = await cancelledAndContinued(f);
  f.store.db.exec(`CREATE TRIGGER reject_reprepare BEFORE INSERT ON delivery_attempt
    WHEN NEW.recommendation_id='${f.recommendation.recommendation_id}'
      AND EXISTS(SELECT 1 FROM delivery_attempt old WHERE old.recommendation_id=NEW.recommendation_id AND old.status='cancelled_before_dispatch')
    BEGIN SELECT RAISE(ABORT, 'injected reprepare transaction failure'); END`);

  await assert.rejects(() => flow.delivery.reprepareCancelled({ attemptId: flow.prepared.attempt_id, item: f.recommendation,
    continueCommandId: 'continue-command-1', evidenceRef: flow.evidenceRef, expectedGeneration: f.generation }), /injected reprepare transaction failure/i);
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(f.recommendation.recommendation_id).state,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?').get(f.recommendation.recommendation_id).n, 1);
});
