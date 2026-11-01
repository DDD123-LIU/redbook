import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createQuality, readCurrentStrategy } from '../src/quality.mjs';
import { createCandidates } from '../src/candidates.mjs';
import { createDelivery } from '../src/delivery.mjs';
import { createDisplay } from '../src/display.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const beforeCut = '2026-10-23T04:01:00.000Z';
const afterCut = '2026-10-23T04:03:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');

function activateCurrentStrategy(fixture) {
  const parent = fixture.versions.strategy_version;
  const decision = fixture.store.db.prepare('SELECT preference_version FROM decision WHERE decision_id=?').get(fixture.recommendation.decision_id);
  const quality = createQuality({ store: fixture.store, owner: fixture.owner, now: () => afterCut });
  return quality.activateStrategy({ strategy_version: `strategy-${randomUUID()}`, parent_version: parent,
    rules: ['合成新版规则'], rule_diff: { added: ['合成新版规则'] }, evidence_refs: ['synthetic:strategy-review'],
    preference_version: decision.preference_version, incident_bindings: [] });
}

function delivery(fixture, transport, now, currentVersions = fixture.currentVersions, coordination = null) {
  return createDelivery({ store: fixture.store, root: join(fixture.root, 'permit-delivery'), owner: fixture.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', transport, now: () => now, currentVersions, coordination });
}

const transport = {
  async send() { return { status: 'succeeded', message_id: 'synthetic-message', evidence: 'synthetic:receipt' }; },
  async lookup() { return { status: 'unknown' }; },
};

function insertCoordinatorHead(store, coordination, active, details = {}) {
  const committedAt = '2026-10-23T04:00:00.000Z';
  const proof = { ...coordination, active, process_id: process.pid, process_instance_id: 'quality-permit-test-instance',
    process_started_at: committedAt, invocation_state: active ? 'executing' : 'returned', worker_refs: [], phase_refs: [],
    updated_at: committedAt, ...details };
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
    succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?,?)`).run(
    randomUUID(), coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
    JSON.stringify(active ? [coordination.runId] : []), JSON.stringify([{ orchestration: proof }]),
    sha(JSON.stringify(coordination)), sha(JSON.stringify(proof)), committedAt);
}

function insertReturnedPhases(store, coordination) {
  const stages = ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'];
  return stages.map(stage => {
    const phase = { phase: stage, status: 'skipped', result: { reason: 'synthetic-run-returned' }, evidence_refs: [], recorded_at: '2026-10-23T04:00:00.000Z' };
    const outputHash = sha(JSON.stringify(phase));
    const checkpointId = randomUUID();
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
      succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(checkpointId, coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
        `orchestration:phase:${coordination.batchId}:${stage}`, '[]', JSON.stringify([{ orchestration_phase: phase }]),
        sha(JSON.stringify(coordination)), outputHash, phase.recorded_at);
    return { stage, checkpoint_id: checkpointId, output_hash: outputHash, status: 'skipped' };
  });
}

async function cancellationEvidence(fixture, attemptId) {
  const row = fixture.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(fixture.owner, `delivery-attempt:${attemptId}`);
  const state = JSON.parse(row.succeeded_refs_json)[0];
  const intentState = JSON.parse(await readFile(state.ref, 'utf8'));
  const intent = JSON.parse(await readFile(intentState.intent_ref, 'utf8'));
  const evidence = { attempt_id: intent.attempt_id, recommendation_id: intent.recommendation_id, content_id: intent.content_id,
    decision_id: intent.decision_id, delivery_batch_id: intent.delivery_batch_id, owner: intent.owner,
    target_ref: intent.target_ref, app_hash: intent.app_hash, payload_hash: intent.payload_hash,
    coordination: intent.coordination, intent_ref: intentState.intent_ref, intent_hash: intentState.intent_hash,
    reason: 'synthetic-permit-reprepare' };
  const ref = join(fixture.root, `permit-cancel-${attemptId}.json`);
  await writeFile(ref, `${JSON.stringify(evidence)}\n`, { flag: 'wx' });
  return ref;
}

async function cancelledAndContinued(fixture) {
  const batch = fixture.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(fixture.batchId);
  const started = fixture.store.casState({ entity: 'batch', entity_id: fixture.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: beforeCut });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: fixture.owner, batchId: fixture.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinatorHead(fixture.store, previous, true);
  const first = delivery(fixture, transport, beforeCut, fixture.currentVersions, previous);
  const prepared = await first.prepareDelivery(fixture.recommendation, fixture.generation);
  const evidenceRef = await cancellationEvidence(fixture, prepared.attempt_id);
  assert.equal((await first.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef })).status, 'cancelled_before_dispatch');
  const liveBatch = fixture.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(fixture.batchId);
  const stopped = fixture.store.casState({ entity: 'batch', entity_id: fixture.batchId, expectedState: liveBatch.status,
    expectedRevision: liveBatch.revision, nextState: liveBatch.status, fields: { stop_requested: 1 }, updatedAt: beforeCut });
  assert.equal(stopped.status, 'succeeded');
  const phaseRefs = insertReturnedPhases(fixture.store, previous);
  insertCoordinatorHead(fixture.store, previous, false, { phase_refs: phaseRefs, phase_audit_complete: true });
  const orchestrator = createOrchestrator({ store: fixture.store, root: fixture.root, owner: fixture.owner,
    appRef: 'synthetic-app', targetRef: 'synthetic-chat', runtime: { delivery: { transport } }, now: () => beforeCut });
  const continued = await orchestrator.continueBatch({ batchId: fixture.batchId, commandId: 'quality-permit-continue',
    confirmedStoppedRunId: previous.runId, evidenceRef: 'synthetic-explicit-continue', explicitRequest: true });
  assert.equal(continued.status, 'continued');
  return { prepared, evidenceRef, previous, continued };
}

test('quality创建器提供可事务化激活策略的真实入口', async t => {
  const fixture = await deliveryFixture(t);
  const quality = createQuality({ store: fixture.store, owner: fixture.owner, now: () => beforeCut });
  assert.equal(typeof quality.activateStrategy, 'function');
});

test('显式旧策略不能重新筛选，旧display预约也不能再次预留', async t => {
  const fixture = await deliveryFixture(t);
  const candidates = createCandidates({ store: fixture.store, root: join(fixture.root, 'candidates'), owner: fixture.owner,
    collector: {}, analyzer: { async currentPreference() { return null; }, async run() {} }, model: async () => assert.fail('不应运行筛选') });
  const activated = activateCurrentStrategy(fixture);
  const next = activated.strategy.strategy_version;
  assert.equal(activated.status, 'succeeded');

  assert.equal(readCurrentStrategy(fixture.store, fixture.owner, afterCut).strategy_version, next);
  await assert.rejects(candidates.run({ batchId: fixture.batchId, strategyVersion: fixture.versions.strategy_version }), /strategy_version_not_current/);
  const display = createDisplay({ store: fixture.store, root: join(fixture.root, 'display'), owner: fixture.owner,
    appRef: 'synthetic-app', now: () => afterCut });
  await assert.rejects(display.buildBatch(fixture.batchId, [{ decision_id: fixture.recommendation.decision_id,
    candidate_id: fixture.recommendation.candidate_id, content_id: fixture.recommendation.content_id }]), /strategy_version_not_current/);
});

test('旧currentVersions回调不能授权prepare', async t => {
  const fixture = await deliveryFixture(t);
  const activated = activateCurrentStrategy(fixture);
  assert.equal(activated.status, 'succeeded');
  let sends = 0;
  const client = delivery(fixture, { ...transport, async send() { sends++; return transport.send(); } }, afterCut);

  await assert.rejects(client.prepareDelivery(fixture.recommendation, fixture.generation), /current strategy evidence is stale/);
  assert.equal(sends, 0);
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt').get().n, 0);
});

test('旧intent在策略切换后未claim时走既有取消路径', async t => {
  const fixture = await deliveryFixture(t);
  let sends = 0;
  let now = beforeCut;
  const client = createDelivery({ store: fixture.store, root: join(fixture.root, 'permit-delivery'), owner: fixture.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', transport: { ...transport, async send() { sends++; return transport.send(); } },
    now: () => now, currentVersions: fixture.currentVersions });
  const prepared = await client.prepareDelivery(fixture.recommendation, fixture.generation);
  const activated = activateCurrentStrategy(fixture);
  assert.equal(activated.status, 'succeeded');
  now = afterCut;

  const outcome = await client.sendPrepared(prepared.attempt_id);
  assert.equal(outcome.status, 'cancelled_before_dispatch');
  assert.equal(sends, 0);
  const attempt = fixture.store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  assert.equal(attempt.status, 'cancelled_before_dispatch');
  assert.equal(attempt.dispatched_at, null);
});

test('新continue的reprepare仍复核当前策略许可', async t => {
  const fixture = await deliveryFixture(t);
  const flow = await cancelledAndContinued(fixture);
  const activated = activateCurrentStrategy(fixture);
  assert.equal(activated.status, 'succeeded');
  const resumed = delivery(fixture, transport, afterCut, fixture.currentVersions, flow.continued.coordination);

  await assert.rejects(resumed.reprepareCancelled({ attemptId: flow.prepared.attempt_id, item: fixture.recommendation,
    continueCommandId: 'quality-permit-continue', evidenceRef: flow.evidenceRef, expectedGeneration: fixture.generation }),
  /current strategy evidence is stale/);
  assert.equal(fixture.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(fixture.recommendation.recommendation_id).state, 'cancelled_before_dispatch');
  assert.equal(fixture.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(fixture.recommendation.recommendation_id).n, 1);
});

test('策略切换后已claim的旧版本仍可归账且时间证据一致', async t => {
  const fixture = await deliveryFixture(t);
  let now = beforeCut;
  let startSend;
  let finishSend;
  const started = new Promise(resolve => { startSend = resolve; });
  const receipt = new Promise(resolve => { finishSend = resolve; });
  const client = createDelivery({ store: fixture.store, root: join(fixture.root, 'permit-delivery'), owner: fixture.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', transport: { async send() { startSend(); return receipt; }, async lookup() { return { status: 'unknown' }; } },
    now: () => now, currentVersions: fixture.currentVersions });
  const prepared = await client.prepareDelivery(fixture.recommendation, fixture.generation);
  const sending = client.sendPrepared(prepared.attempt_id);
  await started;
  assert.ok(fixture.store.db.prepare('SELECT dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).dispatched_at);
  const activated = activateCurrentStrategy(fixture);
  assert.equal(activated.status, 'succeeded');
  now = afterCut;
  finishSend({ status: 'succeeded', message_id: 'synthetic-message', evidence: 'synthetic:receipt' });

  assert.equal((await sending).status, 'succeeded');
  const attempt = fixture.store.db.prepare('SELECT returned_at,updated_at FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id);
  const recommendation = fixture.store.db.prepare('SELECT first_success_at,updated_at FROM recommendation WHERE recommendation_id=?').get(fixture.recommendation.recommendation_id);
  const delivered = fixture.store.db.prepare('SELECT first_success_at FROM delivered_content WHERE recommendation_id=?').get(fixture.recommendation.recommendation_id);
  const attemptHistory = fixture.store.db.prepare("SELECT changed_at FROM delivery_attempt_history WHERE delivery_attempt_id=? AND new_status='succeeded'").get(prepared.attempt_id);
  const entityHistory = fixture.store.db.prepare("SELECT changed_at FROM entity_state_history WHERE entity_type='recommendation' AND entity_id=? AND new_state='succeeded'").get(fixture.recommendation.recommendation_id);
  assert.equal(attempt.returned_at, attempt.updated_at);
  assert.equal(attempt.returned_at, recommendation.first_success_at);
  assert.equal(attempt.returned_at, recommendation.updated_at);
  assert.equal(attempt.returned_at, delivered.first_success_at);
  assert.equal(attempt.returned_at, attemptHistory.changed_at);
  assert.equal(attempt.returned_at, entityHistory.changed_at);
});
