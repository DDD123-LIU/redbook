import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDelivery } from '../src/delivery.mjs';
import { createDisplay } from '../src/display.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { saveContent, saveMaterialVersion } from '../src/storage.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const at = '2026-10-23T04:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');

function delivery(f, transport, coordination) {
  return createDelivery({ store: f.store, root: join(f.root, 'delivery'), owner: f.owner, targetRef: 'synthetic-chat',
    appRef: 'synthetic-app', transport, coordination, now: () => at, currentVersions: f.currentVersions });
}

function insertCoordinator(store, coordination, active, phaseRefs = []) {
  const proof = { ...coordination, active, process_id: process.pid, process_instance_id: 'task013-continuation-test',
    process_started_at: at, invocation_state: active ? 'executing' : 'returned', worker_refs: [], phase_refs: phaseRefs, updated_at: at };
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
    succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?,?)`)
    .run(randomUUID(), coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
      JSON.stringify(active ? [coordination.runId] : []), JSON.stringify([{ orchestration: proof }]), sha(JSON.stringify(coordination)), sha(JSON.stringify(proof)), at);
}

function insertReturnedPhases(store, coordination) {
  return ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'].map(stage => {
    const value = { phase: stage, status: 'skipped', result: { reason: 'synthetic-stop' }, evidence_refs: [], recorded_at: at };
    const checkpointId = randomUUID();
    const outputHash = sha(JSON.stringify(value));
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
      succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(checkpointId, coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
        `orchestration:phase:${coordination.batchId}:${stage}`, '[]', JSON.stringify([{ orchestration_phase: value }]),
        sha(JSON.stringify(coordination)), outputHash, at);
    return { stage, checkpoint_id: checkpointId, output_hash: outputHash, status: 'skipped' };
  });
}

async function secondRecommendation(f, sourceId = '111111111111111111111111') {
  const contentId = saveContent(f.store, { platform: 'xiaohongshu', content_id: sourceId, source_state: 'available' }).entity_id;
  const body = JSON.stringify({ title: '第二条合成标题', description: '第二条合成正文', author_name: '合成作者' });
  const bodyRef = join(f.root, `second-body-${sourceId}.json`);
  await writeFile(bodyRef, body);
  const materialId = saveMaterialVersion(f.store, { content_id: contentId, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete' }).entity_id;
  const analysisId = randomUUID(), candidateId = randomUUID(), decisionId = randomUUID();
  const sourceRef = join(f.root, `second-source-${sourceId}.json`);
  await writeFile(sourceRef, JSON.stringify({ observations: [{ content_id: sourceId,
    complete_source_url: `https://www.xiaohongshu.com/explore/${sourceId}?synthetic=1` }] }));
  f.store.db.prepare(`INSERT INTO analysis(analysis_id,material_version_id,input_hash,prompt_version,model_requested,output_ref,completion_evidence,status,created_at)
    VALUES(?,?,?,?,?,?,?,'complete',?)`).run(analysisId, materialId, sha(body), 'synthetic', 'synthetic', 'synthetic:analysis', 'synthetic:complete', at);
  f.store.db.prepare(`INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,eligibility_state)
    VALUES(?,?,?,'homefeed',?,?,'eligible')`).run(candidateId, contentId, f.batchId, at, `file:${sourceRef}`);
  f.store.db.prepare(`INSERT INTO decision(decision_id,candidate_id,analysis_id,baseline_version,preference_version,strategy_version,category,relevance,gain_state,result,created_at)
    VALUES(?,?,?,?,?,?,'follow','matched','gain','eligible',?)`).run(decisionId, candidateId, analysisId,
    f.versions.baseline_version, f.versions.preference_version, f.versions.strategy_version, at);
  const display = createDisplay({ store: f.store, root: join(f.root, 'display'), owner: f.owner, appRef: 'synthetic-app', now: () => at });
  const built = await display.buildBatch(f.batchId, [{ decision_id: decisionId, candidate_id: candidateId, content_id: contentId }]);
  assert.equal(built.items[0]?.status, 'succeeded');
  return built.items[0];
}

async function seedNewCandidate(f) {
  const sourceId = '222222222222222222222222';
  const contentId = saveContent(f.store, { platform: 'xiaohongshu', content_id: sourceId, source_state: 'available' }).entity_id;
  const body = '新候选的合成步骤：先核对输入，再生成输出。';
  const bodyRef = join(f.root, 'new-candidate-body.json');
  await writeFile(bodyRef, body);
  const materialId = saveMaterialVersion(f.store, { content_id: contentId, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete' }).entity_id;
  const candidateId = randomUUID();
  const sourceRef = join(f.root, 'new-candidate-source.json');
  await writeFile(sourceRef, JSON.stringify({ observations: [{ content_id: sourceId,
    complete_source_url: `https://www.xiaohongshu.com/explore/${sourceId}?synthetic=1` }] }));
  f.store.db.prepare(`INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,eligibility_state)
    VALUES(?,?,?,'homefeed',?,?,'eligible')`).run(candidateId, contentId, f.batchId, '2026-10-23T03:59:00.000Z', `file:${sourceRef}`);
  return { sourceId, contentId, materialId, candidateId };
}

function syntheticModels() {
  return {
    async analysis(args) {
      const input = args.input;
      await writeFile(args.outputPath, JSON.stringify({ id: input.source_content_id, summary: '合成分析', images: [],
        direct_evidence: [{ source: 'body', index: null, quote: input.body }], inferences: [], actionable: ['核对输入'],
        uncertainties: ['仅合成材料'], media_scope: input.media_scope }));
      return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
    },
    async selection(args) {
      const quote = args.payload.candidate_analysis.direct_evidence[0].quote;
      const baseline = args.payload.baseline.items[0];
      await writeFile(args.outputPath, JSON.stringify({
        relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote, hypothesis_indexes: [0], explicit_request_quote: null },
        gain_state: 'gain', compared_candidate_refs: [0], compared_material_ids: [baseline.material_version_id],
        comparisons: [{ baseline_material_id: baseline.material_version_id, candidate_evidence_ref: 0, candidate_quote: quote,
          baseline_quote: baseline.direct_evidence[0].quote, relationship: 'adds', added_kind: 'steps', explanation: '合成新增步骤' }],
        explicit_instruction_assessment: [],
      }));
      return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
    },
  };
}

async function cancelEvidence(f, attemptId) {
  const row = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${attemptId}`);
  const checkpoint = JSON.parse(row.succeeded_refs_json)[0];
  const state = JSON.parse(await readFile(checkpoint.ref, 'utf8'));
  const intent = JSON.parse(await readFile(state.intent_ref, 'utf8'));
  const evidence = { attempt_id: intent.attempt_id, recommendation_id: intent.recommendation_id, content_id: intent.content_id,
    decision_id: intent.decision_id, delivery_batch_id: intent.delivery_batch_id, owner: intent.owner, target_ref: intent.target_ref,
    app_hash: intent.app_hash, payload_hash: intent.payload_hash, coordination: intent.coordination,
    intent_ref: state.intent_ref, intent_hash: state.intent_hash, reason: 'synthetic-stop-before-dispatch' };
  const path = join(f.root, `cancel-${attemptId}.json`);
  await writeFile(path, `${JSON.stringify(evidence)}\n`, { flag: 'wx' });
  return path;
}

async function attemptIntent(f, attemptId) {
  const row = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `delivery-attempt:${attemptId}`);
  const checkpoint = JSON.parse(row.succeeded_refs_json)[0];
  const state = JSON.parse(await readFile(checkpoint.ref, 'utf8'));
  return JSON.parse(await readFile(state.intent_ref, 'utf8'));
}

async function pendingContinuationFixture(t, transport) {
  const f = await deliveryFixture(t);
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const client = delivery(f, transport, previous);
  const prepared = await client.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  return { f, previous, client, prepared };
}

async function markStopped(f, previous) {
  const current = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const priorHead = f.store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
    AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
    .get(previous.owner, previous.runId, previous.batchGeneration, previous.batchId);
  const priorProof = priorHead && JSON.parse(priorHead.succeeded_refs_json).find(ref => ref?.orchestration)?.orchestration;
  const stopped = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: current.status,
    expectedRevision: current.revision, nextState: current.status, fields: { stop_requested: 1 }, updatedAt: at });
  assert.equal(stopped.status, 'succeeded');
  insertCoordinator(f.store, { ...previous, continued_from: priorProof?.continued_from,
    evidence_ref: priorProof?.evidence_ref }, false, insertReturnedPhases(f.store, previous));
  const evidenceRef = join(f.root, 'explicit-stop.json');
  await writeFile(evidenceRef, `${JSON.stringify({ run_id: previous.runId, reason: 'synthetic-stop' })}\n`);
  return evidenceRef;
}

async function stoppedAfterGen2(t, prefix, proposalCount = 2) {
  const f = await deliveryFixture(t, { target: proposalCount + 1 });
  const successfulRecommendation = await secondRecommendation(f);
  const proposalRecommendations = [f.recommendation, await secondRecommendation(f, '222222222222222222222222')];
  if (proposalCount > 2) proposalRecommendations.push(await secondRecommendation(f, '333333333333333333333333'));
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const setupTransport = { async send() { return { status: 'succeeded', message_id: 'synthetic-prior-success', evidence: 'synthetic:prior-success' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const oldDelivery = delivery(f, setupTransport, previous);
  const proposalAttempts = [];
  for (const recommendation of proposalRecommendations) {
    const prepared = await oldDelivery.prepareDelivery(recommendation, expectedGeneration);
    assert.equal(prepared.status, 'succeeded');
    proposalAttempts.push(prepared.attempt_id);
  }
  const successPrepared = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(successPrepared.status, 'succeeded');
  assert.equal((await oldDelivery.sendPrepared(successPrepared.attempt_id)).status, 'succeeded');
  for (const attemptId of proposalAttempts) {
    const evidenceRef = await cancelEvidence(f, attemptId);
    assert.equal((await oldDelivery.cancelPrepared({ attemptId, evidenceRef })).status, 'cancelled_before_dispatch');
  }
  const stopEvidence = await markStopped(f, previous);
  let orchestrator, sends = 0;
  const models = syntheticModels();
  const transport = { async send() {
    sends++;
    await orchestrator.requestStop({ batchId: f.batchId });
    return { status: 'succeeded', message_id: `synthetic-${prefix}-${sends}`, evidence: 'synthetic:stop' };
  }, async lookup() { throw new Error('unexpected lookup'); } };
  orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { collection: { cli: async () => { throw new Error('unexpected collection'); } },
      analysis: { model: models.analysis }, candidates: { model: models.selection },
      display: { uploadImage: async () => { throw new Error('unexpected image upload'); } },
      delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const generation2 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: `${prefix}-gen2`,
    confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(generation2.status, 'continued');
  const firstResume = await orchestrator.run({ coordination: generation2.coordination });
  assert.equal(firstResume.status, 'stopped', JSON.stringify(firstResume));
  assert.equal(sends, 1);
  const remainingAttemptId = proposalAttempts.find(attemptId => {
    const row = f.store.db.prepare(`SELECT a.status,r.state FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?`).get(attemptId);
    return row.status === 'cancelled_before_dispatch' && row.state === 'cancelled_before_dispatch';
  });
  assert.ok(remainingAttemptId);
  const secondStopEvidence = await markStopped(f, generation2.coordination);
  return { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId, proposalAttempts, proposalRecommendations,
    successfulRecommendation, transport, sends: () => sends,
    commandId: `${prefix}-gen3` };
}

function insertOtherBatchHead(f, active = false) {
  const batchId = randomUUID();
  f.store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,command_id,business_day,target,status,generation,created_at)
    VALUES(?,?,'additional_follow',?,'2026-10-23',3,'completed',1,?)`).run(batchId, f.owner, `other-${batchId}`, at);
  const coordination = { owner: f.owner, batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, coordination, active, active ? [] : insertReturnedPhases(f.store, coordination));
  return coordination;
}

function continuationOrchestrator(f, transport) {
  return createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
}

test('已静止的其他批次覆盖全局head后仍可只继续原批', async t => {
  for (const scenario of ['other-ended', 'other-active', 'original-generation-advanced']) await t.test(scenario, async t2 => {
    const transport = { async send() { throw new Error('continueBatch must not send'); }, async lookup() { throw new Error('continueBatch must not lookup'); } };
    const { f, previous } = await pendingContinuationFixture(t2, transport);
    const stopEvidence = await markStopped(f, previous);
    const other = insertOtherBatchHead(f, scenario === 'other-active');
    if (scenario === 'original-generation-advanced') {
      f.store.db.prepare('UPDATE batch SET generation=2,revision=revision+1 WHERE delivery_batch_id=?').run(f.batchId);
    }
    const result = await continuationOrchestrator(f, transport).continueBatch({ batchId: f.batchId,
      commandId: `continue-historical-${scenario}`, confirmedStoppedRunId: previous.runId,
      evidenceRef: stopEvidence, explicitRequest: true });
    const accepted = scenario === 'other-ended';
    assert.equal(result.status, accepted ? 'continued' : 'recovery_required');
    assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
      accepted ? 2 : (scenario === 'original-generation-advanced' ? 2 : 1));
    assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(other.batchId).generation, 1);
    assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(f.store.db.prepare('SELECT delivery_attempt_id FROM delivery_attempt WHERE recommendation_id=?')
        .get(f.recommendation.recommendation_id).delivery_attempt_id).status,
      accepted ? 'cancelled_before_dispatch' : 'intent');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM checkpoint WHERE stage=?')
      .get(`orchestration:command:${sha(`continue-historical-${scenario}`)}`).n, accepted ? 1 : 0);
  });
});

test('部分成功的同批继续只重建确认未派发intent，成功ID不重发', async t => {
  const f = await deliveryFixture(t, { target: 2 });
  const successfulRecommendation = await secondRecommendation(f);
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);

  let sends = 0;
  const transport = { async send() { sends++; return { status: 'succeeded', message_id: 'synthetic-success', evidence: 'synthetic:continuation-receipt' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const oldDelivery = delivery(f, transport, previous);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, expectedGeneration);
  assert.equal(prepared.status, 'succeeded');
  const delivered = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(delivered.status, 'succeeded');
  const successfulSend = await oldDelivery.sendPrepared(delivered.attempt_id);
  assert.equal(successfulSend.status, 'succeeded', JSON.stringify(successfulSend));
  const successfulAttemptCount = f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n;
  const successSendCount = sends;

  const evidenceRef = await cancelEvidence(f, prepared.attempt_id);
  assert.equal((await oldDelivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef })).status, 'cancelled_before_dispatch');
  const currentBatch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const stopped = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: currentBatch.status,
    expectedRevision: currentBatch.revision, nextState: currentBatch.status, fields: { stop_requested: 1 }, updatedAt: at });
  assert.equal(stopped.status, 'succeeded');
  const phaseRefs = insertReturnedPhases(f.store, previous);
  insertCoordinator(f.store, previous, false, phaseRefs);

  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime: { delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-partial-success',
    confirmedStoppedRunId: previous.runId, evidenceRef: 'synthetic-confirmed-stop', explicitRequest: true });
  assert.equal(continued.status, 'continued');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 1, 'continue reserves no replacement until the slot generation is current');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).state, 'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, successfulAttemptCount);
  assert.equal(sends, successSendCount, 'continue must not dispatch the replacement or resend the successful ID');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 1, 'continue leaves preparation for the current slot generation');

  const tab = { page: {
    async reload() {},
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at,
      page_state: 'ready', observations: [], anchor_id: null, advanced: false, read_method: 'synthetic-continuation-test' }; },
    async press() { throw new Error('unexpected pagination in empty synthetic page'); },
  } };
  const resumed = await orchestrator.run({ coordination: continued.coordination, tab });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.delivered, 2);
  assert.equal(sends, successSendCount + 1, 'continued attempt sends once; already-succeeded ID is not sent again');
  const replacementId = resumed.delivery[0].attempt_id;
  assert.notEqual(replacementId, prepared.attempt_id);
  assert.equal((await attemptIntent(f, replacementId)).ordinal, f.recommendation.ordinal);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(replacementId).status, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, successfulAttemptCount);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status,
    'cancelled_before_dispatch');

  const commandReplay = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-partial-success',
    confirmedStoppedRunId: previous.runId, evidenceRef: 'synthetic-confirmed-stop', explicitRequest: true });
  assert.equal(commandReplay.status, 'duplicate_command');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 2);
  assert.equal(sends, successSendCount + 1);
});

function continuationChildProgram() {
  return `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { openStore } from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)};
    import { createOrchestrator } from ${JSON.stringify(new URL('../src/orchestrator.mjs', import.meta.url).href)};
    const [configPath, latchArg] = process.argv.slice(1);
    const latchSend = latchArg === 'yes';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const store = openStore(config.dbPath);
    const transport = {
      async send(intent) {
        appendFileSync(config.sendLog, JSON.stringify({ attempt_id: intent.attempt_id }) + '\\n');
        if (latchSend) {
          writeFileSync(config.sendStarted, 'started');
          while (!existsSync(config.releaseSend)) await delay(10);
        }
        return { status: 'succeeded', message_id: 'synthetic-process-send', evidence: 'synthetic:process-continuation-receipt' };
      },
      async lookup() { throw new Error('unexpected lookup'); },
    };
    try {
      const orchestrator = createOrchestrator({ store, root: config.root, owner: config.owner,
        appRef: 'synthetic-app', targetRef: 'synthetic-chat', runtime: { delivery: {
          root: config.deliveryRoot, currentVersions: () => config.versions, transport,
        } }, now: () => config.now });
      const continued = await orchestrator.continueBatch({ batchId: config.batchId, commandId: config.commandId,
        confirmedStoppedRunId: config.previousRunId, evidenceRef: config.stopEvidence, explicitRequest: true });
      const run = await orchestrator.run({ coordination: continued.coordination });
      console.log(JSON.stringify({ continued, run }));
    } finally { store.close(); }
  `;
}

function prepareCrashChildProgram() {
  return `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { openStore } from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)};
    import { createOrchestrator } from ${JSON.stringify(new URL('../src/orchestrator.mjs', import.meta.url).href)};
    const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const store = openStore(config.dbPath);
    const originalTransaction = store.transaction.bind(store);
    store.transaction = callback => {
      const result = originalTransaction(callback);
      const replacement = store.db.prepare('SELECT delivery_attempt_id,status,dispatched_at FROM delivery_attempt WHERE recommendation_id=? AND delivery_attempt_id<>? ORDER BY intent_at DESC LIMIT 1')
        .get(config.recommendationId, config.originalAttemptId);
      if (replacement?.status === 'intent' && !replacement.dispatched_at) {
        const phaseRow = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
          .get(config.owner, 'orchestration:phase:' + config.batchId + ':delivery');
        const phase = JSON.parse(phaseRow.succeeded_refs_json)[0].orchestration_phase;
        if (phase.status === 'running') {
          writeFileSync(config.crashMarker, JSON.stringify({ attempt_id: replacement.delivery_attempt_id, committed: true }));
          process.exit(73);
        }
      }
      return result;
    };
    const transport = {
      async send() { throw new Error('fault must exit before synthetic send'); },
      async lookup() { throw new Error('unexpected lookup'); },
    };
    const orchestrator = createOrchestrator({ store, root: config.root, owner: config.owner, appRef: 'synthetic-app',
      targetRef: 'synthetic-chat', runtime: { delivery: { root: config.deliveryRoot,
        currentVersions: () => config.versions, transport } }, now: () => config.now });
    const continued = await orchestrator.continueBatch({ batchId: config.batchId, commandId: config.commandId,
      confirmedStoppedRunId: config.previousRunId, evidenceRef: config.stopEvidence, explicitRequest: true });
    const run = await orchestrator.run({ coordination: continued.coordination });
    console.log(JSON.stringify({ continued, run }));
    store.close();
  `;
}

async function makeCrashFixture(t, commandId) {
  const f = await deliveryFixture(t, { target: 1 });
  const generation = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const prepTransport = { async send() { throw new Error('unexpected send during preparation'); }, async lookup() { throw new Error('unexpected lookup'); } };
  const prepared = await delivery(f, prepTransport, previous).prepareDelivery(f.recommendation, generation);
  assert.equal(prepared.status, 'succeeded');
  const stopEvidence = await markStopped(f, previous);
  const crashMarker = join(f.root, 'after-reprepare-commit.json');
  const sendLog = join(f.root, 'crash-child-sends.jsonl');
  const configPath = join(f.root, 'prepare-crash-process.json');
  await writeFile(configPath, JSON.stringify({ dbPath: f.dbPath, root: f.root, owner: f.owner, batchId: f.batchId,
    recommendationId: f.recommendation.recommendation_id, originalAttemptId: prepared.attempt_id, previousRunId: previous.runId,
    commandId, stopEvidence, crashMarker, sendLog, now: at, deliveryRoot: join(f.root, 'delivery'), versions: f.versions }));
  return { f, previous, prepared, commandId, configPath, crashMarker, sendLog, stopEvidence };
}

function startPrepareCrashChild(configPath) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', prepareCrashChildProgram(), configPath], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

function startContinuationChild(configPath, latchSend) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', continuationChildProgram(), configPath, latchSend ? 'yes' : 'no'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed, latchSend };
}

async function waitForFile(path, child, closed, label) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (child.exitCode !== null) throw new Error(`${label} exited before latch: ${JSON.stringify(await closed)}`);
    if (Date.now() >= deadline) throw new Error(`${label} did not reach latch`);
    await delay(10);
  }
}

test('两个Node进程重放同一continue命令只产生一个replacement和一次send', async t => {
  const f = await deliveryFixture(t, { target: 2 });
  const successfulRecommendation = await secondRecommendation(f);
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  let preparationSends = 0;
  const preparationTransport = { async send() { preparationSends++; return { status: 'succeeded', message_id: 'synthetic-success', evidence: 'synthetic:process-preparation-receipt' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const oldDelivery = delivery(f, preparationTransport, previous);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, expectedGeneration);
  assert.equal(prepared.status, 'succeeded');
  const delivered = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(delivered.status, 'succeeded');
  const successfulSend = await oldDelivery.sendPrepared(delivered.attempt_id);
  assert.equal(successfulSend.status, 'succeeded', JSON.stringify(successfulSend));
  const batchAfterSuccess = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const stopped = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batchAfterSuccess.status,
    expectedRevision: batchAfterSuccess.revision, nextState: batchAfterSuccess.status, fields: { stop_requested: 1 }, updatedAt: at });
  assert.equal(stopped.status, 'succeeded');
  const phaseRefs = insertReturnedPhases(f.store, previous);
  insertCoordinator(f.store, previous, false, phaseRefs);

  const sendLog = join(f.root, 'process-sends.jsonl');
  const sendStarted = join(f.root, 'send-started');
  const releaseSend = join(f.root, 'release-send');
  const stopEvidence = join(f.root, 'explicit-stop.json');
  const configPath = join(f.root, 'continue-process.json');
  await writeFile(stopEvidence, `${JSON.stringify({ confirmed_stopped_run_id: previous.runId, reason: 'synthetic-explicit-stop' })}\n`);
  const config = { dbPath: f.dbPath, root: f.root, owner: f.owner, batchId: f.batchId, previousRunId: previous.runId,
    commandId: 'continue-two-processes', stopEvidence, sendLog, sendStarted, releaseSend, now: at,
    deliveryRoot: join(f.root, 'delivery'), versions: f.versions };
  await writeFile(configPath, JSON.stringify(config));
  const first = startContinuationChild(configPath, true);
  t.after(() => { if (first.child.exitCode === null) first.child.kill(); });
  try {
    await waitForFile(sendStarted, first.child, first.closed, 'first continue process');
    const second = startContinuationChild(configPath, false);
    t.after(() => { if (second.child.exitCode === null) second.child.kill(); });
    const secondResult = await second.closed;
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.equal(readFileSync(sendLog, 'utf8').trim().split(/\r?\n/).length, 1, 'second process must not send while first send is latched');
  } finally {
    writeFileSync(releaseSend, 'release');
  }
  const firstResult = await first.closed;
  assert.equal(firstResult.code, 0, firstResult.stderr);
  const firstOutput = JSON.parse(firstResult.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(firstOutput.continued.status, 'continued');
  assert.equal(firstOutput.run.status, 'completed');

  const store = f.reopen();
  const sends = readFileSync(sendLog, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(sends.length, 1);
  assert.equal(preparationSends, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 2);
  const replacementId = store.db.prepare('SELECT delivery_attempt_id FROM delivery_attempt WHERE recommendation_id=? AND delivery_attempt_id<>?')
    .get(f.recommendation.recommendation_id, prepared.attempt_id).delivery_attempt_id;
  assert.equal((await attemptIntent(f, replacementId)).ordinal, f.recommendation.ordinal);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).state, 'succeeded');
});

test('真实Node在replacement intent提交后、send前退出，可核验恢复并显式续跑一次', async t => {
  const setup = await makeCrashFixture(t, 'continue-after-prepare-crash');
  const child = startPrepareCrashChild(setup.configPath);
  const childResult = await child.closed;
  assert.equal(childResult.code, 73, JSON.stringify(childResult));
  assert.equal(childResult.stdout, '');
  const marker = JSON.parse(readFileSync(setup.crashMarker, 'utf8'));
  assert.equal(marker.committed, true);
  assert.equal(existsSync(setup.sendLog), false, '故障点位于事务提交后和transport.send前');

  const store = setup.f.reopen();
  const crashEvidence = join(setup.f.root, 'child-exit-proof.json');
  await writeFile(crashEvidence, JSON.stringify({ child_exit_code: childResult.code, attempt_id: marker.attempt_id, observed_at: at }));
  const sent = [];
  const transport = { async send(intent) {
    sent.push(intent.attempt_id);
    appendFileSync(setup.sendLog, `${JSON.stringify({ attempt_id: intent.attempt_id })}\n`);
    return { status: 'succeeded', message_id: 'synthetic-after-recovery', evidence: 'synthetic:recovered-send' };
  }, async lookup() { throw new Error('unexpected lookup'); } };
  const orchestrator = createOrchestrator({ store, root: setup.f.root, owner: setup.f.owner,
    appRef: 'synthetic-app', targetRef: 'synthetic-chat', runtime: { delivery: {
      root: join(setup.f.root, 'delivery'), currentVersions: setup.f.currentVersions, transport,
  } }, now: () => at });
  const head = store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const idle = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(idle.owner, null);
  assert.equal(idle.run_id, null);
  const recovered = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: head.run_id, evidenceRef: crashEvidence });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered));
  const failedPhaseRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(setup.f.owner, `orchestration:phase:${setup.f.batchId}:delivery`);
  const failedPhase = JSON.parse(failedPhaseRow.succeeded_refs_json)[0].orchestration_phase;
  assert.equal(failedPhase.status, 'failed');
  assert.equal(failedPhase.result.reason, 'coordinator_exit_before_dispatch');
  assert.equal(failedPhase.result.execution_state, 'confirmed_idle_before_dispatch');
  const crashedAttempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(marker.attempt_id);
  assert.equal(crashedAttempt.status, 'cancelled_before_dispatch');
  assert.equal(crashedAttempt.dispatched_at, null);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(setup.prepared.attempt_id).status,
    'cancelled_before_dispatch');

  const continued = await orchestrator.continueBatch({ batchId: setup.f.batchId, commandId: 'continue-after-crash-recovery',
    confirmedStoppedRunId: head.run_id, evidenceRef: crashEvidence, explicitRequest: true });
  assert.equal(continued.status, 'continued', JSON.stringify(continued));
  const resumed = await orchestrator.run({ coordination: continued.coordination });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.delivered, 1);
  assert.equal(sent.length, 1);
  const newAttemptId = resumed.delivery[0].attempt_id;
  assert.notEqual(newAttemptId, marker.attempt_id);
  assert.notEqual(newAttemptId, setup.prepared.attempt_id);
  const newAttemptProof = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(setup.f.owner, `delivery-attempt:${newAttemptId}`);
  assert.ok(newAttemptProof, JSON.stringify({ newAttemptId, delivery_attempt: store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(newAttemptId),
    related_checkpoints: store.db.prepare("SELECT stage,checkpoint_id FROM checkpoint WHERE owner=? AND stage LIKE 'delivery-attempt:%' ORDER BY rowid").all(setup.f.owner) }));
  const newAttemptState = JSON.parse(readFileSync(JSON.parse(newAttemptProof.succeeded_refs_json)[0].ref, 'utf8'));
  assert.equal(JSON.parse(readFileSync(newAttemptState.intent_ref, 'utf8')).ordinal, setup.f.recommendation.ordinal);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(newAttemptId).status, 'succeeded');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(setup.f.recommendation.recommendation_id).n, 3);
  assert.equal(readFileSync(setup.sendLog, 'utf8').trim().split(/\r?\n/).length, 1);
});

test('prepare崩溃恢复后普通日批必须等待明确继续，原推荐沿原批reprepare一次', async t => {
  const setup = await makeCrashFixture(t, 'daily-after-prepare-crash-recovery');
  const child = startPrepareCrashChild(setup.configPath);
  const childResult = await child.closed;
  assert.equal(childResult.code, 73, JSON.stringify(childResult));
  const marker = JSON.parse(readFileSync(setup.crashMarker, 'utf8'));
  const store = setup.f.reopen();
  const crashEvidence = join(setup.f.root, 'daily-child-exit-proof.json');
  await writeFile(crashEvidence, JSON.stringify({ child_exit_code: childResult.code, attempt_id: marker.attempt_id, observed_at: at }));
  let sends = 0;
  const transport = { async send(intent) { sends++; return { status: 'succeeded', message_id: 'synthetic-explicit-resume', evidence: `synthetic:${intent.attempt_id}` }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const runtime = { collection: {}, analysis: {}, candidates: {}, display: {}, homefeed: { options: { maxPages: 1 } },
    delivery: { root: join(setup.f.root, 'delivery'), currentVersions: setup.f.currentVersions, transport } };
  const orchestrator = createOrchestrator({ store, root: setup.f.root, owner: setup.f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime, now: () => at });
  const crashedHead = store.db.prepare("SELECT run_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const recovered = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: crashedHead.run_id, evidenceRef: crashEvidence });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered));
  const headBefore = store.db.prepare("SELECT checkpoint_id,run_id,generation FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const batchBefore = store.db.prepare('SELECT generation,revision,status,stop_requested FROM batch WHERE delivery_batch_id=?').get(setup.f.batchId);
  const slotBefore = store.db.prepare("SELECT generation,revision,state,owner,run_id,stop_requested FROM execution_slot WHERE slot_key='main'").get();
  const originalIntent = await attemptIntent(setup.f, marker.attempt_id);
  const attemptCountBefore = store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(setup.f.recommendation.recommendation_id).n;
  const ordinary = await orchestrator.ensureDailyBatch({ tab: { page: { async reload() {}, async evaluate() { return []; } } } });
  assert.equal(ordinary.status, 'blocked', JSON.stringify(ordinary));
  assert.equal(ordinary.reason, 'explicit_continue_required');
  assert.equal(ordinary.batch_id, setup.f.batchId);
  assert.equal(ordinary.run_id, headBefore.run_id);
  assert.equal(ordinary.generation, headBefore.generation);
  assert.deepEqual(ordinary.attempt_ids, [marker.attempt_id]);
  assert.equal(store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().checkpoint_id,
    headBefore.checkpoint_id);
  assert.deepEqual(store.db.prepare('SELECT generation,revision,status,stop_requested FROM batch WHERE delivery_batch_id=?').get(setup.f.batchId), batchBefore);
  assert.deepEqual(store.db.prepare("SELECT generation,revision,state,owner,run_id,stop_requested FROM execution_slot WHERE slot_key='main'").get(), slotBefore);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?').get(setup.f.recommendation.recommendation_id).n,
    attemptCountBefore);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(marker.attempt_id).status,
    'cancelled_before_dispatch');
  assert.deepEqual(await attemptIntent(setup.f, marker.attempt_id), originalIntent);
  assert.equal(sends, 0);

  const continued = await orchestrator.continueBatch({ batchId: setup.f.batchId, commandId: 'explicit-after-daily-gate',
    confirmedStoppedRunId: headBefore.run_id, evidenceRef: crashEvidence, explicitRequest: true });
  assert.equal(continued.status, 'continued', JSON.stringify(continued));
  const resumed = await orchestrator.run({ coordination: continued.coordination });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(sends, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(setup.f.recommendation.recommendation_id).n, attemptCountBefore + 1);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(marker.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(setup.f.recommendation.recommendation_id).state, 'succeeded');
});

test('取消证明损坏时普通日批fail-closed且不改变恢复快照', async t => {
  const setup = await makeCrashFixture(t, 'daily-after-prepare-crash-corrupt-cancel-proof');
  const child = startPrepareCrashChild(setup.configPath);
  const childResult = await child.closed;
  assert.equal(childResult.code, 73, JSON.stringify(childResult));
  const marker = JSON.parse(readFileSync(setup.crashMarker, 'utf8'));
  const store = setup.f.reopen();
  const crashEvidence = join(setup.f.root, 'corrupt-cancel-child-exit-proof.json');
  await writeFile(crashEvidence, JSON.stringify({ child_exit_code: childResult.code, attempt_id: marker.attempt_id, observed_at: at }));
  let sends = 0;
  const transport = { async send() { sends++; return { status: 'succeeded', message_id: 'unexpected', evidence: 'synthetic:unexpected' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const runtime = { collection: {}, analysis: {}, candidates: {}, display: {}, homefeed: { options: { maxPages: 1 } },
    delivery: { root: join(setup.f.root, 'delivery'), currentVersions: setup.f.currentVersions, transport } };
  const orchestrator = createOrchestrator({ store, root: setup.f.root, owner: setup.f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime, now: () => at });
  const crashedHead = store.db.prepare("SELECT run_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const recovered = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: crashedHead.run_id, evidenceRef: crashEvidence });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered));
  const attemptCheckpoint = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(setup.f.owner, `delivery-attempt:${marker.attempt_id}`);
  const context = JSON.parse(readFileSync(JSON.parse(attemptCheckpoint.succeeded_refs_json)[0].ref, 'utf8'));
  await writeFile(context.cancellation_evidence_ref, 'synthetic-corrupt-cancellation-proof');
  const headBefore = store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().checkpoint_id;
  const batchBefore = store.db.prepare('SELECT generation,revision,status,stop_requested FROM batch WHERE delivery_batch_id=?').get(setup.f.batchId);
  const slotBefore = store.db.prepare("SELECT generation,revision,state,owner,run_id,stop_requested FROM execution_slot WHERE slot_key='main'").get();
  const result = await orchestrator.ensureDailyBatch({ tab: {} });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.reason, 'cancelled_continuation_proof_invalid');
  assert.equal(store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().checkpoint_id,
    headBefore);
  assert.deepEqual(store.db.prepare('SELECT generation,revision,status,stop_requested FROM batch WHERE delivery_batch_id=?').get(setup.f.batchId), batchBefore);
  assert.deepEqual(store.db.prepare("SELECT generation,revision,state,owner,run_id,stop_requested FROM execution_slot WHERE slot_key='main'").get(), slotBefore);
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(marker.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(sends, 0);
});

test('owner reconcile把未派发intent映射为blocked phase并保留业务attempt身份', async t => {
  const f = await deliveryFixture(t, { kind: 'additional_follow', commandId: 'old-additional-run' });
  const oldBatch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: oldBatch.status,
    expectedRevision: oldBatch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const oldCoordination = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, oldCoordination, true);
  let sends = 0, lookups = 0;
  const transport = { async send() { sends++; return { status: 'succeeded', message_id: 'unexpected', evidence: 'synthetic:unexpected' }; },
    async lookup() { lookups++; return { status: 'unknown', evidence: 'synthetic:lookup' }; } };
  const prepared = await delivery(f, transport, oldCoordination).prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  const phaseRefs = insertReturnedPhases(f.store, oldCoordination);
  insertCoordinator(f.store, oldCoordination, false, phaseRefs);
  const intentBefore = await attemptIntent(f, prepared.attempt_id);
  const runtime = { collection: {}, analysis: {}, candidates: {}, display: {}, homefeed: { options: { maxPages: 1 } },
    delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } };
  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime, now: () => at });
  const result = await orchestrator.ensureDailyBatch({ tab: {} });
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.reason, 'prepared_delivery_requires_same_batch_resume');
  assert.equal(result.attempt_status, 'intent');
  assert.equal(result.attempt_id, prepared.attempt_id);
  assert.equal(result.original_batch_id, f.batchId);
  assert.equal(f.store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(prepared.attempt_id).status, 'intent');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).state, 'intent');
  assert.deepEqual(await attemptIntent(f, prepared.attempt_id), intentBefore);
  const phase = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `orchestration:phase:${result.batch_id}:delivery_reconcile`);
  const phaseValue = JSON.parse(phase.succeeded_refs_json)[0].orchestration_phase;
  assert.equal(phaseValue.status, 'blocked');
  assert.equal(phaseValue.result.attempt_status, 'intent');
  assert.equal(phaseValue.result.attempt_id, prepared.attempt_id);
  assert.equal(sends, 0);
  assert.equal(lookups, 0);
});

test('owner reconcile的unknown仍要求worker退出证明且不重复send', async t => {
  const f = await deliveryFixture(t, { kind: 'additional_follow', commandId: 'old-additional-unknown' });
  const oldBatch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: oldBatch.status,
    expectedRevision: oldBatch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const oldCoordination = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, oldCoordination, true);
  let sends = 0, lookups = 0;
  const transport = { async send() { sends++; return { status: 'unknown', reason: 'synthetic-dispatch-unknown', evidence: 'synthetic:send-unknown' }; },
    async lookup() { lookups++; return { status: 'unknown', evidence: 'synthetic:still-unknown' }; } };
  const client = delivery(f, transport, oldCoordination);
  const prepared = await client.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  assert.equal((await client.sendPrepared(prepared.attempt_id)).status, 'unknown');
  const phaseRefs = insertReturnedPhases(f.store, oldCoordination);
  insertCoordinator(f.store, oldCoordination, false, phaseRefs);
  const runtime = { collection: {}, analysis: {}, candidates: {}, display: {}, homefeed: { options: { maxPages: 1 } },
    delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } };
  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime, now: () => at });
  const result = await orchestrator.ensureDailyBatch({ tab: {} });
  assert.equal(result.status, 'recovery_required', JSON.stringify(result));
  assert.equal(result.reason, 'delivery_worker_exit_unconfirmed');
  assert.equal(f.store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(prepared.attempt_id).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).state, 'unknown');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 1);
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
  const phase = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `orchestration:phase:${result.batch_id}:delivery_reconcile`);
  const phaseValue = JSON.parse(phase.succeeded_refs_json)[0].orchestration_phase;
  assert.equal(phaseValue.status, 'unknown');
  assert.equal(phaseValue.result.attempt_status, 'unknown');
  assert.equal(phaseValue.result.attempt_id, prepared.attempt_id);
});

test('replacement已unknown/dispatch时恢复保持blocked且不二次send', async t => {
  const setup = await makeCrashFixture(t, 'continue-after-prepare-unknown');
  const child = startPrepareCrashChild(setup.configPath);
  const childResult = await child.closed;
  assert.equal(childResult.code, 73, JSON.stringify(childResult));
  const marker = JSON.parse(readFileSync(setup.crashMarker, 'utf8'));

  const store = setup.f.reopen();
  let sends = 0;
  const transport = { async send() { sends++; return { status: 'unknown', reason: 'synthetic-dispatch-unknown' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const head = store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const deliveryClient = createDelivery({ store, root: join(setup.f.root, 'delivery'), owner: setup.f.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', transport,
    coordination: { owner: setup.f.owner, batchId: setup.f.batchId, runId: head.run_id, batchGeneration: head.generation },
    now: () => at, currentVersions: setup.f.currentVersions });
  const outcome = await deliveryClient.sendPrepared(marker.attempt_id);
  assert.equal(outcome.status, 'unknown');
  assert.equal(sends, 1);
  const crashEvidence = join(setup.f.root, 'child-exit-proof-unknown.json');
  await writeFile(crashEvidence, JSON.stringify({ child_exit_code: childResult.code, attempt_id: marker.attempt_id, observed_at: at }));
  const orchestrator = createOrchestrator({ store, root: setup.f.root, owner: setup.f.owner,
    appRef: 'synthetic-app', targetRef: 'synthetic-chat', runtime: { delivery: {
      root: join(setup.f.root, 'delivery'), currentVersions: setup.f.currentVersions, transport,
    } }, now: () => at });
  const beforeHeadId = store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().checkpoint_id;
  const beforePhaseId = store.db.prepare('SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(setup.f.owner, `orchestration:phase:${setup.f.batchId}:delivery`).checkpoint_id;
  const result = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: head.run_id, evidenceRef: crashEvidence });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.reason, 'delivery_attempt_outcome_unconfirmed');
  assert.equal(store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(marker.attempt_id).status, 'unknown');
  assert.equal(store.db.prepare("SELECT owner FROM execution_slot WHERE slot_key='main'").get().owner, null);
  assert.equal(store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get().checkpoint_id,
    beforeHeadId);
  assert.equal(store.db.prepare('SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(setup.f.owner, `orchestration:phase:${setup.f.batchId}:delivery`).checkpoint_id, beforePhaseId);
  assert.equal(sends, 1, 'recovery不能再次调用transport');
});

test('损坏的原display build proof阻止continue run且不刷新或发送', async t => {
  let sends = 0, lookups = 0, reloads = 0;
  const transport = { async send() { sends++; return { status: 'succeeded', message_id: 'unused', evidence: 'synthetic:unused' }; },
    async lookup() { lookups++; return { status: 'unknown' }; } };
  const { f, previous, prepared } = await pendingContinuationFixture(t, transport);
  const stopEvidence = await markStopped(f, previous);
  const orchestrator = continuationOrchestrator(f, transport);
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-bad-build',
    confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(continued.status, 'continued');
  const intent = await attemptIntent(f, prepared.attempt_id);
  await writeFile(intent.build_ref, 'synthetic-corrupt-build');
  const tab = { page: { async reload() { reloads++; }, async evaluate() { throw new Error('unexpected page evaluate'); } } };
  const resumed = await orchestrator.run({ coordination: continued.coordination, tab });
  assert.equal(resumed.status, 'recovery_required');
  assert.equal(resumed.reason, 'continuation_proposal_proof_invalid');
  assert.equal(sends, 0);
  assert.equal(lookups, 0);
  assert.equal(reloads, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 1);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(prepared.attempt_id).status, 'cancelled_before_dispatch');
});

test('unknown attempt阻止continue，不能再次send或lookup', async t => {
  let sends = 0, lookups = 0;
  const transport = { async send() { sends++; return { status: 'unknown', reason: 'synthetic-unknown' }; },
    async lookup() { lookups++; return { status: 'unknown' }; } };
  const { f, previous, client, prepared } = await pendingContinuationFixture(t, transport);
  assert.equal((await client.sendPrepared(prepared.attempt_id)).status, 'unknown');
  const stopEvidence = await markStopped(f, previous);
  const result = await continuationOrchestrator(f, transport).continueBatch({ batchId: f.batchId,
    commandId: 'continue-unknown', confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.reason, 'delivery_attempt_outcome_unconfirmed');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(prepared.attempt_id).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).n, 1);
  assert.equal(sends, 1);
  assert.equal(lookups, 0);
});

test('proposal与新候选混合时display先推进slot generation，stop阻止下一项', async t => {
  const f = await deliveryFixture(t, { target: 3 });
  const successfulRecommendation = await secondRecommendation(f);
  const newCandidate = await seedNewCandidate(f);
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const setupTransport = { async send() { return { status: 'succeeded', message_id: 'synthetic-prior-success', evidence: 'synthetic:prior-success' }; },
    async lookup() { return { status: 'unknown' }; } };
  const oldDelivery = delivery(f, setupTransport, previous);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, expectedGeneration);
  assert.equal(prepared.status, 'succeeded');
  const delivered = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(delivered.status, 'succeeded');
  assert.equal((await oldDelivery.sendPrepared(delivered.attempt_id)).status, 'succeeded');
  const evidenceRef = await cancelEvidence(f, prepared.attempt_id);
  assert.equal((await oldDelivery.cancelPrepared({ attemptId: prepared.attempt_id, evidenceRef })).status, 'cancelled_before_dispatch');
  const stopEvidence = await markStopped(f, previous);

  let orchestrator, runSends = 0, runLookups = 0, pageReloads = 0, uploads = 0;
  const transport = { async send() {
    runSends++;
    if (runSends === 1) await orchestrator.requestStop({ batchId: f.batchId });
    return { status: 'succeeded', message_id: `synthetic-resume-${runSends}`, evidence: 'synthetic:resume-receipt' };
  }, async lookup() { runLookups++; return { status: 'unknown' }; } };
  const models = syntheticModels();
  orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { collection: { cli: async () => { throw new Error('unexpected collection'); } },
      analysis: { model: models.analysis }, candidates: { model: models.selection },
      display: { uploadImage: async () => { uploads++; throw new Error('unexpected image upload'); } },
      delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-mixed-stop',
    confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(continued.status, 'continued');
  const proposalCandidateId = f.store.db.prepare('SELECT candidate_id FROM decision WHERE decision_id=?')
    .get(f.recommendation.decision_id).candidate_id;
  const proposalCandidateBefore = f.store.db.prepare('SELECT eligibility_state FROM candidate WHERE candidate_id=?')
    .get(proposalCandidateId);
  const proposalDecisionBefore = f.store.db.prepare('SELECT result,created_at FROM decision WHERE decision_id=?')
    .get(f.recommendation.decision_id);
  const beforeRunGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  assert.equal(beforeRunGeneration, expectedGeneration);
  const tab = { page: {
    async reload() { pageReloads++; },
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at,
      page_state: 'ready', observations: [], anchor_id: null, advanced: false, read_method: 'synthetic-mixed-continuation-test' }; },
    async press() { throw new Error('unexpected pagination in synthetic mixed test'); },
  } };
  const resumed = await orchestrator.run({ coordination: continued.coordination, tab });
  const proposalCandidateAfter = f.store.db.prepare('SELECT eligibility_state FROM candidate WHERE candidate_id=?')
    .get(proposalCandidateId);
  const proposalDecisionAfter = f.store.db.prepare('SELECT result,created_at FROM decision WHERE decision_id=?')
    .get(f.recommendation.decision_id);
  const candidateReportRow = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, `candidates:${f.batchId}`);
  const candidateReport = candidateReportRow
    ? JSON.parse(readFileSync(JSON.parse(candidateReportRow.succeeded_refs_json)[0].snapshot_ref, 'utf8')) : null;
  console.log(`MIXED_PROPOSAL_CANDIDATE_DIAGNOSTIC=${JSON.stringify({
    proposal_candidate_id: proposalCandidateId, new_candidate_id: newCandidate.candidateId,
    proposalCandidateBefore, proposalCandidateAfter, proposalDecisionBefore, proposalDecisionAfter,
    candidate_result: candidateReport && Object.fromEntries(['eligible', 'excluded', 'held'].map(key => [key,
      (candidateReport[key] ?? []).filter(item => [proposalCandidateId, newCandidate.candidateId].includes(item.candidate_id))])),
    recommendation: f.store.db.prepare('SELECT state,revision FROM recommendation WHERE recommendation_id=?')
      .get(f.recommendation.recommendation_id), resumed,
  })}`);
  assert.equal(resumed.status, 'stopped', JSON.stringify(resumed));
  assert.equal(runSends, 1, 'stop after continuation send blocks the next candidate item');
  assert.equal(runLookups, 0);
  assert.equal(uploads, 0);
  assert.ok(pageReloads >= 1);
  const afterRunGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  assert.ok(afterRunGeneration > beforeRunGeneration, 'real display factory advanced the slot before reprepare');
  const replacementId = resumed.delivery[0].attempt_id;
  const replacementIntent = await attemptIntent(f, replacementId);
  assert.equal(replacementIntent.expected_generation, afterRunGeneration);
  assert.equal(replacementIntent.ordinal, f.recommendation.ordinal);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare("SELECT count(DISTINCT content_id) AS n FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
    .get(f.batchId).n, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, 1);
});

test('两条有效continuation proposal首项stop后第二项不新建attempt也不send', async t => {
  const f = await deliveryFixture(t, { target: 3 });
  const successfulRecommendation = await secondRecommendation(f);
  const secondProposalRecommendation = await secondRecommendation(f, '222222222222222222222222');
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const setupTransport = { async send() { return { status: 'succeeded', message_id: 'synthetic-prior-success', evidence: 'synthetic:prior-success' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const oldDelivery = delivery(f, setupTransport, previous);
  const firstPrepared = await oldDelivery.prepareDelivery(f.recommendation, expectedGeneration);
  const secondPrepared = await oldDelivery.prepareDelivery(secondProposalRecommendation, expectedGeneration);
  const successPrepared = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(firstPrepared.status, 'succeeded');
  assert.equal(secondPrepared.status, 'succeeded');
  assert.equal((await oldDelivery.sendPrepared(successPrepared.attempt_id)).status, 'succeeded');
  for (const attemptId of [firstPrepared.attempt_id, secondPrepared.attempt_id]) {
    const evidenceRef = await cancelEvidence(f, attemptId);
    assert.equal((await oldDelivery.cancelPrepared({ attemptId, evidenceRef })).status, 'cancelled_before_dispatch');
  }
  const stopEvidence = await markStopped(f, previous);

  let orchestrator, runSends = 0, lookups = 0;
  const transport = { async send() {
    runSends++;
    await orchestrator.requestStop({ batchId: f.batchId });
    return { status: 'succeeded', message_id: 'synthetic-first-proposal-only', evidence: 'synthetic:proposal-stop' };
  }, async lookup() { lookups++; throw new Error('unexpected lookup'); } };
  orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-two-proposal-stop',
    confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(continued.status, 'continued');
  const resumed = await orchestrator.run({ coordination: continued.coordination });
  assert.equal(resumed.status, 'stopped', JSON.stringify(resumed));
  assert.equal(f.store.db.prepare("SELECT count(DISTINCT content_id) AS n FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
    .get(f.batchId).n, 2);
  assert.equal(resumed.delivery.length, 1);
  assert.equal(runSends, 1);
  assert.equal(lookups, 0);
  const sentAttemptId = resumed.delivery[0].attempt_id;
  const sentRecommendationId = f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(sentAttemptId).recommendation_id;
  const proposalIds = [f.recommendation.recommendation_id, secondProposalRecommendation.recommendation_id];
  assert.ok(proposalIds.includes(sentRecommendationId));
  const untouchedRecommendationId = proposalIds.find(id => id !== sentRecommendationId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(sentRecommendationId).n, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(untouchedRecommendationId).n, 1, 'stopped second proposal keeps only its original cancelled attempt');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(sentAttemptId).status, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, 1, 'already-succeeded recommendation is not resent');
  assert.equal((await attemptIntent(f, sentAttemptId)).ordinal,
    sentRecommendationId === f.recommendation.recommendation_id ? f.recommendation.ordinal : secondProposalRecommendation.ordinal);
});

test('两轮明确continue保留旧proposal且不重发成功项或替换推荐身份', async t => {
  const f = await deliveryFixture(t, { target: 3 });
  const successfulRecommendation = await secondRecommendation(f);
  const secondProposalRecommendation = await secondRecommendation(f, '222222222222222222222222');
  const initialRecommendationIds = new Set([f.recommendation.recommendation_id,
    successfulRecommendation.recommendation_id, secondProposalRecommendation.recommendation_id]);
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at }).status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  const setupTransport = { async send() { return { status: 'succeeded', message_id: 'synthetic-prior-success', evidence: 'synthetic:prior-success' }; },
    async lookup() { throw new Error('unexpected lookup'); } };
  const oldDelivery = delivery(f, setupTransport, previous);
  const firstPrepared = await oldDelivery.prepareDelivery(f.recommendation, expectedGeneration);
  const secondPrepared = await oldDelivery.prepareDelivery(secondProposalRecommendation, expectedGeneration);
  const successPrepared = await oldDelivery.prepareDelivery(successfulRecommendation, expectedGeneration);
  assert.equal(firstPrepared.status, 'succeeded');
  assert.equal(secondPrepared.status, 'succeeded');
  assert.equal((await oldDelivery.sendPrepared(successPrepared.attempt_id)).status, 'succeeded');
  for (const attemptId of [firstPrepared.attempt_id, secondPrepared.attempt_id]) {
    const evidenceRef = await cancelEvidence(f, attemptId);
    assert.equal((await oldDelivery.cancelPrepared({ attemptId, evidenceRef })).status, 'cancelled_before_dispatch');
  }
  const stopEvidence = await markStopped(f, previous);

  let orchestrator, runSends = 0, lookups = 0;
  const models = syntheticModels();
  const transport = { async send() {
    runSends++;
    if (runSends === 1) await orchestrator.requestStop({ batchId: f.batchId });
    return { status: 'succeeded', message_id: `synthetic-proposal-${runSends}`, evidence: 'synthetic:proposal-stop' };
  }, async lookup() { lookups++; throw new Error('unexpected lookup'); } };
  orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { collection: { cli: async () => { throw new Error('unexpected collection'); } },
      analysis: { model: models.analysis }, candidates: { model: models.selection },
      display: { uploadImage: async () => { throw new Error('unexpected image upload'); } },
      delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const tab = { page: {
    async reload() {},
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at,
      page_state: 'ready', observations: [], anchor_id: null, advanced: false, read_method: 'synthetic-continuation-test' }; },
    async press() { throw new Error('unexpected pagination in empty synthetic page'); },
  } };
  const generation2 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-two-proposal-stop-first',
    confirmedStoppedRunId: previous.runId, evidenceRef: stopEvidence, explicitRequest: true });
  assert.equal(generation2.status, 'continued');
  const firstResume = await orchestrator.run({ coordination: generation2.coordination });
  assert.equal(firstResume.status, 'stopped', JSON.stringify(firstResume));
  assert.equal(runSends, 1);
  const generation2SentAttemptId = firstResume.delivery[0].attempt_id;
  const generation2SentRecommendationId = f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(generation2SentAttemptId).recommendation_id;
  const remainingRecommendationId = [f.recommendation.recommendation_id, secondProposalRecommendation.recommendation_id]
    .find(id => id !== generation2SentRecommendationId);
  const remainingOriginalAttemptId = f.store.db.prepare(`SELECT delivery_attempt_id FROM delivery_attempt
    WHERE recommendation_id=? AND status='cancelled_before_dispatch' ORDER BY rowid DESC LIMIT 1`).get(remainingRecommendationId).delivery_attempt_id;
  const secondStopEvidence = await markStopped(f, generation2.coordination);
  const stoppedBatchGeneration = f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation;
  const ordinaryRun = await orchestrator.run({ tab });
  assert.equal(ordinaryRun.status, 'stopped');
  assert.equal(runSends, 1, 'ordinary daily run cannot authorize a cancelled proposal');
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
    stoppedBatchGeneration, 'ordinary daily run leaves the stopped generation unchanged');

  const generation3 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'continue-two-proposal-stop-second',
    confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(generation3.status, 'continued', JSON.stringify(generation3));
  const secondResume = await orchestrator.run({ coordination: generation3.coordination, tab });
  const finalSucceededRecommendationIds = new Set(f.store.db.prepare("SELECT recommendation_id FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
    .all(f.batchId).map(row => row.recommendation_id));
  const observed = {
    status: secondResume.status,
    delivered: secondResume.delivered ?? null,
    shortfall: secondResume.shortfall ?? null,
    deliveryCount: secondResume.delivery?.length ?? null,
    runSends,
    lookups,
    remainingAttemptCount: f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
      .get(remainingRecommendationId).n,
    remainingOriginalAttemptStatus: f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(remainingOriginalAttemptId).status,
    succeededRecommendationIds: [...finalSucceededRecommendationIds].sort(),
    recommendationIds: f.store.db.prepare('SELECT recommendation_id FROM recommendation WHERE delivery_batch_id=? ORDER BY recommendation_id')
      .all(f.batchId).map(row => row.recommendation_id),
    candidateCount: f.store.db.prepare('SELECT count(*) AS n FROM candidate WHERE discovery_batch_id=?').get(f.batchId).n,
  };
  assert.deepEqual(observed, {
    status: 'completed', delivered: 3, shortfall: 0, deliveryCount: 1, runSends: 2, lookups: 0,
    remainingAttemptCount: 2, remainingOriginalAttemptStatus: 'cancelled_before_dispatch',
    succeededRecommendationIds: [...initialRecommendationIds].sort(),
    recommendationIds: [...initialRecommendationIds].sort(), candidateCount: 3,
  }, 'second explicit continue must reprepare and send the remaining original proposal');
  assert.deepEqual(finalSucceededRecommendationIds, initialRecommendationIds);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, 1, 'previously successful recommendation is not resent');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(remainingRecommendationId).n, 2, 'remaining proposal gets one replacement attempt');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(remainingOriginalAttemptId).status, 'cancelled_before_dispatch', 'original cancelled attempt remains immutable');
  const finalAttemptId = secondResume.delivery[0].attempt_id;
  assert.equal(f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(finalAttemptId).recommendation_id, remainingRecommendationId);
  const finalIntent = await attemptIntent(f, finalAttemptId);
  assert.equal(finalIntent.ordinal, remainingRecommendationId === f.recommendation.recommendation_id
    ? f.recommendation.ordinal : secondProposalRecommendation.ordinal);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=?').get(f.batchId).n,
    initialRecommendationIds.size, 'no replacement recommendation or candidate is introduced');
  const duplicateContinue = await orchestrator.continueBatch({ batchId: f.batchId,
    commandId: 'continue-two-proposal-stop-second', confirmedStoppedRunId: generation2.coordination.runId,
    evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(duplicateContinue.status, 'duplicate_command');
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation, 3);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(remainingRecommendationId).n, 2, 'replayed continue mapping does not create a second attempt');
  assert.equal(runSends, 2);
});

test('跨代授权链损坏时带原attempt fail closed且不增代或send', async t => {
  for (const scenario of ['missing-command', 'command-hash', 'parent-run', 'parent-active', 'chain-out-successor']) {
    await t.test(scenario, async t2 => {
      const setup = await stoppedAfterGen2(t2, `i4-${scenario}`);
      const { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId } = setup;
      const gen2Head = f.store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=2
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(f.owner, generation2.coordination.runId, f.batchId);
      const gen1Attempt = await attemptIntent(f, remainingAttemptId);
      const gen1Head = f.store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=1
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(f.owner, gen1Attempt.coordination.runId, f.batchId);
      if (scenario === 'missing-command') {
        f.store.db.prepare('DELETE FROM checkpoint WHERE owner=? AND stage=?')
          .run(f.owner, `orchestration:command:${sha(`${generation2.command_id}`)}`);
      } else if (scenario === 'command-hash') {
        f.store.db.prepare('UPDATE checkpoint SET input_hash=? WHERE owner=? AND stage=?')
          .run('broken-command-input-hash', f.owner, `orchestration:command:${sha(generation2.coordination.continueCommandId)}`);
      } else if (scenario === 'parent-run') {
        const proof = JSON.parse(gen2Head.succeeded_refs_json)[0].orchestration;
        const broken = { ...proof, continued_from: randomUUID() };
        f.store.db.prepare('UPDATE checkpoint SET succeeded_refs_json=?,output_hash=? WHERE checkpoint_id=?')
          .run(JSON.stringify([{ orchestration: broken }]), sha(JSON.stringify(broken)), gen2Head.checkpoint_id);
      } else if (scenario === 'parent-active') {
        const proof = JSON.parse(gen1Head.succeeded_refs_json)[0].orchestration;
        const broken = { ...proof, active: true };
        f.store.db.prepare('UPDATE checkpoint SET pending_ids_json=?,succeeded_refs_json=?,output_hash=? WHERE checkpoint_id=?')
          .run(JSON.stringify([gen1Head.run_id]), JSON.stringify([{ orchestration: broken }]), sha(JSON.stringify(broken)), gen1Head.checkpoint_id);
      } else {
        f.store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
          succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), gen1Head.owner, gen1Head.run_id, gen1Head.generation, gen1Head.delivery_batch_id,
            gen1Head.stage, gen1Head.pending_ids_json, gen1Head.succeeded_refs_json, gen1Head.input_hash,
            gen1Head.output_hash, gen1Head.committed_at);
      }
      const beforeGeneration = f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation;
      const result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
        confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
      assert.equal(result.status, 'recovery_required', JSON.stringify(result));
      assert.equal(result.attempt_id, remainingAttemptId, 'failure identifies the original cancelled attempt');
      assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
        beforeGeneration, 'invalid chain does not create a new generation');
      assert.equal(setup.sends(), 1, 'invalid chain does not send');
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE delivery_attempt_id=?')
        .get(remainingAttemptId).n, 1, 'invalid chain does not create a replacement attempt');
    });
  }
});

test('取消proposal出现unknown后继时不能回退重备旧attempt', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-unknown-successor');
  const { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId } = setup;
  const oldAttempt = f.store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(remainingAttemptId);
  const unknownAttemptId = randomUUID();
  f.store.db.prepare(`INSERT INTO delivery_attempt(delivery_attempt_id,recommendation_id,target_ref,payload_hash,intent_at,
    dispatched_at,status,created_at) VALUES(?,?,?,?,?,?,'unknown',?)`)
    .run(unknownAttemptId, oldAttempt.recommendation_id, oldAttempt.target_ref, oldAttempt.payload_hash,
      at, at, at);
  const recommendation = f.store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(oldAttempt.recommendation_id);
  assert.equal(f.store.casState({ entity: 'recommendation', entity_id: recommendation.recommendation_id,
    expectedState: 'cancelled_before_dispatch', expectedRevision: recommendation.revision,
    nextState: 'unknown', evidence_refs: ['synthetic:unknown-successor'] }).status, 'succeeded');
  const beforeGeneration = f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation;
  const result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
    confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(result.status, 'recovery_required', JSON.stringify(result));
  assert.equal(result.reason, 'delivery_attempt_outcome_unconfirmed');
  assert.equal(result.attempt_id, unknownAttemptId);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(remainingAttemptId).status,
    'cancelled_before_dispatch', 'original cancellation remains immutable');
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
    beforeGeneration, 'uncertain successor cannot create a later generation');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(oldAttempt.recommendation_id).n, 2, 'unknown successor does not create a replacement-of-the-old replacement');
  assert.equal(setup.sends(), 1);
});

test('continue事务前命令checkpoint变化时整代拒绝且保留原attempt ID', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-transaction-command-change');
  const { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId } = setup;
  const commandStage = `orchestration:command:${sha(generation2.command_id)}`;
  const command = f.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(f.owner, commandStage);
  assert.ok(command);
  const originalTransaction = f.store.transaction;
  let injected = false;
  f.store.transaction = callback => {
    if (!injected) {
      injected = true;
      f.store.db.prepare('UPDATE checkpoint SET output_hash=? WHERE checkpoint_id=?')
        .run('synthetic-command-output-changed-after-review', command.checkpoint_id);
    }
    return originalTransaction.call(f.store, callback);
  };
  const beforeGeneration = f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation;
  let result;
  try {
    result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
      confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  } finally {
    f.store.transaction = originalTransaction;
  }
  assert.equal(injected, true);
  assert.equal(result.status, 'recovery_required', JSON.stringify(result));
  assert.equal(result.reason, 'continuation_obligation_changed_during_continue');
  assert.equal(result.attempt_id, remainingAttemptId);
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
    beforeGeneration, 'checkpoint race does not create a new generation');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(remainingAttemptId).n, 1);
  assert.equal(setup.sends(), 1);
});

test('continue事务前batch revision变化时不清stop或增加generation', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-transaction-batch-change');
  const { f, orchestrator, generation2, secondStopEvidence } = setup;
  const originalTransaction = f.store.transaction;
  let injected = false;
  f.store.transaction = callback => {
    if (!injected) {
      injected = true;
      f.store.db.prepare('UPDATE batch SET revision=revision+1 WHERE delivery_batch_id=?').run(f.batchId);
    }
    return originalTransaction.call(f.store, callback);
  };
  const before = f.store.db.prepare('SELECT generation,revision,stop_requested FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  let result;
  try {
    result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
      confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  } finally {
    f.store.transaction = originalTransaction;
  }
  const after = f.store.db.prepare('SELECT generation,revision,stop_requested FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  assert.equal(injected, true);
  assert.equal(result.status, 'recovery_required', JSON.stringify(result));
  assert.equal(result.reason, 'coordinator_exit_not_confirmed');
  assert.equal(after.generation, before.generation);
  assert.equal(after.stop_requested, before.stop_requested);
  assert.equal(after.revision, before.revision + 1, 'only the synthetic concurrent revision change is observed');
  assert.equal(setup.sends(), 1);
});

test('continue事务前command input hash变化时拒绝授权', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-transaction-command-input-change');
  const { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId } = setup;
  const commandStage = `orchestration:command:${sha(generation2.command_id)}`;
  const command = f.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(f.owner, commandStage);
  const originalTransaction = f.store.transaction;
  let injected = false;
  f.store.transaction = callback => {
    if (!injected) {
      injected = true;
      f.store.db.prepare('UPDATE checkpoint SET input_hash=? WHERE checkpoint_id=?')
        .run('synthetic-command-input-changed-after-review', command.checkpoint_id);
    }
    return originalTransaction.call(f.store, callback);
  };
  const beforeGeneration = f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation;
  let result;
  try {
    result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
      confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  } finally {
    f.store.transaction = originalTransaction;
  }
  assert.equal(injected, true);
  assert.equal(result.status, 'recovery_required', JSON.stringify(result));
  assert.equal(result.attempt_id, remainingAttemptId);
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation,
    beforeGeneration, 'command identity race does not create a new generation');
  assert.equal(setup.sends(), 1);
});

test('另一批静止head成为全局head后仍能明确继续原批早代proposal', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-historical-global-head');
  const { f, orchestrator, generation2, secondStopEvidence } = setup;
  const other = insertOtherBatchHead(f, false);
  const result = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
    confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(result.status, 'continued', JSON.stringify(result));
  assert.equal(f.store.db.prepare('SELECT generation FROM batch WHERE delivery_batch_id=?').get(f.batchId).generation, 3);
  const currentHead = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(currentHead.delivery_batch_id, f.batchId);
  assert.notEqual(currentHead.delivery_batch_id, other.batchId);
  assert.equal(setup.sends(), 1, 'continuing the original batch does not send during authorization');
});

test('Gen3再次stop保留未派发proposal且Gen4仍能恢复原proposal', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-restop', 3);
  const { f, orchestrator, generation2, secondStopEvidence, proposalAttempts, proposalRecommendations,
    successfulRecommendation, sends } = setup;
  const generation3 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'i4-restop-gen3',
    confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(generation3.status, 'continued');
  const gen3Run = await orchestrator.run({ coordination: generation3.coordination });
  assert.equal(gen3Run.status, 'stopped', JSON.stringify(gen3Run));
  assert.equal(sends(), 2);
  const gen3AttemptId = gen3Run.delivery[0].attempt_id;
  const gen3RecommendationId = f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(gen3AttemptId).recommendation_id;
  const stillCancelled = proposalAttempts.filter(attemptId => {
    const row = f.store.db.prepare(`SELECT a.status,r.state FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE a.delivery_attempt_id=?`).get(attemptId);
    return row.status === 'cancelled_before_dispatch' && row.state === 'cancelled_before_dispatch';
  });
  assert.equal(stillCancelled.length, 1);
  const untouchedAttemptId = stillCancelled[0];
  assert.notEqual(f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(untouchedAttemptId).recommendation_id, gen3RecommendationId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(untouchedAttemptId).n, 1, 'stop after Gen3 send leaves the next old attempt untouched');
  const gen3StopEvidence = await markStopped(f, generation3.coordination);

  const generation4 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'i4-restop-gen4',
    confirmedStoppedRunId: generation3.coordination.runId, evidenceRef: gen3StopEvidence, explicitRequest: true });
  assert.equal(generation4.status, 'continued', JSON.stringify(generation4));
  const gen4Run = await orchestrator.run({ coordination: generation4.coordination });
  assert.equal(sends(), 3);
  const gen4AttemptId = gen4Run.delivery[0].attempt_id;
  assert.equal(f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(gen4AttemptId).recommendation_id, f.store.db.prepare('SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(untouchedAttemptId).recommendation_id);
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(untouchedAttemptId).status,
    'cancelled_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=? AND state=?')
    .get(f.batchId, 'succeeded').n, 4);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(successfulRecommendation.recommendation_id).n, 1, 'originally successful recommendation is never resent');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=?').get(f.batchId).n,
    proposalRecommendations.length + 1, 'no replacement candidates or recommendations are introduced');
});

test('delivery私有重备proof独立拒绝被篡改的中间command', async t => {
  const setup = await stoppedAfterGen2(t, 'i4-delivery-proof');
  const { f, orchestrator, generation2, secondStopEvidence, remainingAttemptId, transport } = setup;
  const generation3 = await orchestrator.continueBatch({ batchId: f.batchId, commandId: setup.commandId,
    confirmedStoppedRunId: generation2.coordination.runId, evidenceRef: secondStopEvidence, explicitRequest: true });
  assert.equal(generation3.status, 'continued');
  const oldIntent = await attemptIntent(f, remainingAttemptId);
  const item = { status: 'succeeded', recommendation_id: oldIntent.recommendation_id,
    delivery_batch_id: oldIntent.delivery_batch_id, decision_id: oldIntent.decision_id, content_id: oldIntent.content_id,
    category: oldIntent.category, actual_preference_version: oldIntent.actual_preference_version,
    actual_strategy_version: oldIntent.actual_strategy_version, ordinal: oldIntent.ordinal,
    payload_hash: oldIntent.payload_hash, build_ref: oldIntent.build_ref, build_hash: oldIntent.build_hash };
  const intermediateCommandStage = `orchestration:command:${sha(generation2.command_id)}`;
  const intermediateCommand = f.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?')
    .get(f.owner, intermediateCommandStage);
  assert.ok(intermediateCommand);
  f.store.db.prepare('UPDATE checkpoint SET output_hash=? WHERE checkpoint_id=?')
    .run('tampered-intermediate-command-hash', intermediateCommand.checkpoint_id);
  const directDelivery = delivery(f, transport, generation3.coordination);
  const expectedGeneration = f.store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  await assert.rejects(() => directDelivery.reprepareCancelled({ attemptId: remainingAttemptId, item,
    continueCommandId: setup.commandId, evidenceRef: join(f.root, `cancel-${remainingAttemptId}.json`), expectedGeneration }),
  /continue lineage command identity or hash is invalid/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt WHERE recommendation_id=?')
    .get(item.recommendation_id).n, 1, 'invalid delivery proof creates no attempt');
  assert.equal(setup.sends(), 1, 'invalid delivery proof does not send');
});

test('追加和探索批跨午夜先封闭旧批，保留unknown且不启动新stage', async t => {
  for (const kind of ['additional_follow', 'explore']) await t.test(kind, async t => {
  const commandId = `midnight-${kind}-command`;
  const f = await deliveryFixture(t, { target: 3, kind, commandId });
  const batch = f.store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(f.batchId);
  const started = f.store.casState({ entity: 'batch', entity_id: f.batchId, expectedState: batch.status,
    expectedRevision: batch.revision, nextState: 'running', fields: { generation: 1 }, updatedAt: at });
  assert.equal(started.status, 'succeeded');
  const previous = { owner: f.owner, batchId: f.batchId, runId: randomUUID(), batchGeneration: 1 };
  insertCoordinator(f.store, previous, true);
  let sends = 0, lookups = 0, collection = 0, analysis = 0, selection = 0, uploads = 0;
  const oldTransport = { async send() { sends++; return { status: 'unknown', reason: 'synthetic-before-midnight' }; },
    async lookup() { lookups++; return { status: 'unknown' }; } };
  const oldDelivery = delivery(f, oldTransport, previous);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  assert.equal((await oldDelivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  assert.equal(sends, 1);
  assert.equal(lookups, 0);
  const phasesBefore = f.store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE stage LIKE 'orchestration:phase:%'").get().n;

  const afterMidnight = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { collection: { cli: async () => { collection++; } }, analysis: { model: async () => { analysis++; } },
      candidates: { model: async () => { selection++; } }, display: { uploadImage: async () => { uploads++; } },
      delivery: { transport: oldTransport, currentVersions: f.currentVersions } },
    now: () => '2026-10-23T16:01:00.000Z' });
  const result = await afterMidnight.run({ kind, commandId, explicitRequest: true, requestText: '合成追加需求',
    ...(kind === 'explore' ? { direction: '合成探索方向' } : {}) });
  assert.equal(result.status, 'closed_day');
  assert.equal(result.batch_id, f.batchId);
  assert.equal(f.store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=?').get(f.batchId).status, 'closed_day');
  const originalCandidateId = f.store.db.prepare('SELECT candidate_id FROM decision WHERE decision_id=?')
    .get(f.recommendation.decision_id).candidate_id;
  assert.equal(f.store.db.prepare('SELECT eligibility_state FROM candidate WHERE candidate_id=?')
    .get(originalCandidateId).eligibility_state, 'hold');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(prepared.attempt_id).status, 'unknown');
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id).state, 'unknown');
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE stage LIKE 'orchestration:phase:%'").get().n, phasesBefore);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM batch WHERE owner=? AND command_id=?").get(f.owner, commandId).n, 1);
  assert.equal(sends, 1);
  assert.equal(lookups, 0);
  assert.equal(collection + analysis + selection + uploads, 0);
  });
});

test('真实finish静止head保留阶段证明后，其他批次结束仍可明确继续原批', async t => {
  let orchestrator, sends = 0;
  const transport = {
    async send() {
      sends++;
      if (sends === 1) await orchestrator.requestStop({ batchId: f.batchId });
      return { status: 'succeeded', message_id: `synthetic-finish-${sends}`, evidence: 'synthetic:finish-phase-receipt' };
    },
    async lookup() { return { status: 'unknown' }; },
  };
  const { f, previous } = await pendingContinuationFixture(t, transport);
  const models = syntheticModels();
  orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app', targetRef: 'synthetic-chat',
    runtime: { collection: { cli: async () => { throw new Error('unexpected collection CLI'); } },
      analysis: { model: models.analysis }, candidates: { model: models.selection },
      display: { uploadImage: async () => { throw new Error('unexpected image upload'); } },
      delivery: { root: join(f.root, 'delivery'), currentVersions: f.currentVersions, transport } }, now: () => at });
  const initialStopEvidence = await markStopped(f, previous);
  const authorized = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'i3-finish-phase-initial-continue',
    confirmedStoppedRunId: previous.runId, evidenceRef: initialStopEvidence, explicitRequest: true });
  assert.equal(authorized.status, 'continued');
  const tab = { page: {
    async reload() {},
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at,
      page_state: 'ready', observations: [], anchor_id: null, advanced: false, read_method: 'synthetic-finish-phase-test' }; },
    async press() { throw new Error('unexpected pagination'); },
  } };
  const stopped = await orchestrator.run({ coordination: authorized.coordination });
  assert.equal(stopped.status, 'stopped', JSON.stringify(stopped));
  assert.equal(sends, 1);
  const returnedA = f.store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND delivery_batch_id=?
    AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(f.owner, f.batchId);
  const proofA = JSON.parse(returnedA.succeeded_refs_json)[0].orchestration;
  assert.equal(proofA.invocation_state, 'returned');
  const phaseRefs = proofA.phase_refs ?? [];

  const other = await orchestrator.run({ kind: 'additional_follow', commandId: 'i3-finish-phase-other-batch',
    explicitRequest: true, requestText: '合成另一个批次', tab });
  const otherHead = f.store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND delivery_batch_id=?
    AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(f.owner, other.batch_id);
  const otherProof = JSON.parse(otherHead.succeeded_refs_json)[0].orchestration;
  assert.equal(otherProof.invocation_state, 'returned');
  assert.equal(otherProof.active, false);
  assert.deepEqual(JSON.parse(otherHead.pending_ids_json), []);
  assert.notEqual(f.store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=?').get(other.batch_id).status, 'running');
  assert.notEqual(other.batch_id, f.batchId);

  const stopEvidence = join(f.root, 'real-run-stop.json');
  await writeFile(stopEvidence, `${JSON.stringify({ run_id: returnedA.run_id, reason: 'synthetic-stop' })}\n`, { flag: 'wx' });
  const continued = await orchestrator.continueBatch({ batchId: f.batchId, commandId: 'i3-finish-phase-continue-original',
    confirmedStoppedRunId: returnedA.run_id, evidenceRef: stopEvidence, explicitRequest: true });
  assert.deepEqual(phaseRefs.map(ref => ref.stage).sort(),
    ['candidates', 'delivery', 'delivery_reconcile', 'display', 'homefeed'], 'real finish must preserve all five validated phase refs');
  for (const ref of phaseRefs) {
    const checkpoint = f.store.db.prepare('SELECT checkpoint_id,output_hash FROM checkpoint WHERE checkpoint_id=? AND owner=? AND run_id=? AND generation=? AND delivery_batch_id=?')
      .get(ref.checkpoint_id, f.owner, returnedA.run_id, returnedA.generation, f.batchId);
    assert.equal(checkpoint?.checkpoint_id, ref.checkpoint_id);
    assert.equal(checkpoint?.output_hash, ref.output_hash);
  }
  assert.equal(continued.status, 'continued', JSON.stringify(continued));
  assert.equal(continued.batch_id, f.batchId);
  assert.equal(continued.generation, returnedA.generation + 1);
  assert.equal(sends, 1, 'continuation authorization must not send again');
});
