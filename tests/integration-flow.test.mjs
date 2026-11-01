import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openStore } from '../src/storage.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

test('I01 完整入口从首页发现新候选并经真实工厂投递成功', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  for (const table of ['candidate', 'decision', 'recommendation', 'delivery_attempt']) {
    assert.equal(fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} must be empty before I01`);
  }
  const outcome = await fixture.run();
  const { store, calls } = fixture;
  const batchId = outcome.batch_id;
  if (outcome.status !== 'partial') {
    await fixture.writeEvidence({ outcome, calls,
      attempts: store.db.prepare(`SELECT a.*,r.state AS recommendation_state
        FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)`).all(),
      recommendations: store.db.prepare('SELECT recommendation_id,state FROM recommendation').all(),
    });
  }

  assert.equal(outcome.status, 'partial', JSON.stringify(outcome));
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.shortfall, 19);
  assert.deepEqual(calls.map(call => call.stage), [
    'homefeed.reload', 'homefeed.evaluate', 'collection.cli', 'analysis.model:analysis', 'candidates.model', 'delivery.send',
  ]);

  const candidate = store.db.prepare('SELECT candidate_id,content_id,source_evidence_ref FROM candidate WHERE discovery_batch_id=?').get(batchId);
  const material = store.db.prepare('SELECT material_version_id,body_hash FROM material_version WHERE content_id=? AND fetch_status=\'succeeded\'').get(candidate.content_id);
  const analysis = store.db.prepare('SELECT analysis_id,material_version_id,status FROM analysis WHERE material_version_id=?').get(material.material_version_id);
  const decision = store.db.prepare('SELECT decision_id,candidate_id,result,gain_state FROM decision WHERE candidate_id=?').get(candidate.candidate_id);
  const recommendation = store.db.prepare('SELECT recommendation_id,decision_id,state FROM recommendation WHERE decision_id=?').get(decision.decision_id);
  const attempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE recommendation_id=?').get(recommendation.recommendation_id);
  const buildCheckpoint = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1')
    .get(`display-build:${recommendation.recommendation_id}`);
  const buildRef = JSON.parse(buildCheckpoint.succeeded_refs_json)[0].ref;
  const displayEvidence = JSON.parse(await readFile(buildRef, 'utf8'));
  const attemptCheckpoints = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC')
    .all(fixture.owner, `delivery-attempt:${attempt.delivery_attempt_id}`);
  const receiptState = attemptCheckpoints.map(row => JSON.parse(row.succeeded_refs_json)[0])
    .map(ref => ({ ref, state: JSON.parse(readFileSync(ref.ref, 'utf8')) }))
    .find(entry => entry.state.receipt_ref);
  assert.ok(receiptState, 'delivery attempt checkpoint must point to its persisted receipt');
  const receiptBytes = await readFile(receiptState.state.receipt_ref);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex');
  const receiptEvidence = receipt.result.evidence_refs ?? receipt.result.evidence;
  const receiptEvidenceRefs = Array.isArray(receiptEvidence) ? receiptEvidence : [receiptEvidence];

  assert.equal(store.db.prepare('SELECT source_content_id FROM content WHERE content_id=?').get(candidate.content_id).source_content_id,
    fixture.candidateId);
  assert.equal(analysis.material_version_id, material.material_version_id);
  assert.equal(analysis.status, 'complete');
  assert.equal(decision.result, 'eligible');
  assert.equal(decision.gain_state, 'gain');
  assert.equal(recommendation.state, 'succeeded');
  assert.equal(attempt.status, 'succeeded');
  assert.equal(attempt.message_id, 'synthetic-integration-message');
  assert.equal(attempt.payload_hash, displayEvidence.payload_hash);
  assert.equal(receipt.attempt_id, attempt.delivery_attempt_id);
  assert.equal(receipt.recommendation_id, recommendation.recommendation_id);
  assert.equal(receipt.owner, fixture.owner);
  assert.equal(receipt.target_ref, attempt.target_ref);
  assert.equal(receipt.payload_hash, attempt.payload_hash);
  assert.equal(receiptState.state.receipt_hash, receiptDigest);
  assert.equal(receipt.result.status, attempt.status);
  assert.equal(receipt.result.message_id, attempt.message_id);
  assert.deepEqual(JSON.parse(attempt.query_evidence_refs_json), receiptEvidenceRefs);
  assert.deepEqual(JSON.parse(attempt.verification_evidence_refs_json), [receiptState.state.receipt_ref, ...receiptEvidenceRefs]);
  assert.equal(createHash('sha256').update(JSON.stringify(displayEvidence.payload)).digest('hex'), displayEvidence.payload_hash);
  assert.ok(candidate.source_evidence_ref);
  assert.match(material.body_hash, /^[a-f0-9]{64}$/);
  assert.match(displayEvidence.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(calls.filter(call => call.stage === 'delivery.send').length, 1);
  const persistenceAudit = fixture.auditRetained(batchId);
  assert.deepEqual(persistenceAudit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(persistenceAudit.foreign_key_violations, []);
  assert.equal(persistenceAudit.causal_business_rows, 1);
  assert.ok(persistenceAudit.checked_checkpoint_files > 0);
  assert.deepEqual(persistenceAudit.bad_checkpoint_files, []);
  await fixture.writeEvidence({ status: outcome.status, batch_id: batchId, content_id: candidate.content_id,
    candidate_id: candidate.candidate_id, material_version_id: material.material_version_id,
    material_hash: material.body_hash, analysis_id: analysis.analysis_id, decision_id: decision.decision_id,
    recommendation_id: recommendation.recommendation_id, payload_hash: displayEvidence.payload_hash,
    attempt_id: attempt.delivery_attempt_id, message_id: attempt.message_id,
    receipt: { receipt_ref: receiptState.state.receipt_ref, receipt_hash: receiptDigest,
      attempt_id: receipt.attempt_id, recommendation_id: receipt.recommendation_id,
      owner: receipt.owner, target_ref: receipt.target_ref, payload_hash: receipt.payload_hash,
      status: receipt.result.status, evidence_refs: receiptEvidenceRefs }, persistence_audit: persistenceAudit,
    result: { delivered: outcome.delivered, shortfall: outcome.shortfall }, calls });
});

test('I02 同一SQLite上的第二个完整入口在首页adapter挂起期间受控重叠并被协调器拦截', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const observerStore = openStore(fixture.dbPath);
  let observerClosed = false;
  t.after(() => { if (!observerClosed) observerStore.close(); });
  const gate = fixture.pauseNextReload();
  const firstPromise = fixture.run();
  let second;
  let observedHead;
  let observedSlot;
  let timer;
  try {
    await Promise.race([gate.entered, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('homefeed reload gate was not entered within 5 seconds')), 5000);
    })]);
    second = await fixture.run(fixture.makeOrchestrator(observerStore));
    observedHead = observerStore.db.prepare("SELECT checkpoint_id,run_id,generation,delivery_batch_id,succeeded_refs_json FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
    observedSlot = observerStore.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  } finally {
    clearTimeout(timer);
    gate.release();
  }
  const first = await firstPromise;
  const headPayload = observedHead ? JSON.parse(observedHead.succeeded_refs_json)[0] : null;
  observerStore.close();
  observerClosed = true;
  const persistenceAudit = fixture.auditRetained(first.batch_id);
  const evidence = {
    first: { status: first.status, batch_id: first.batch_id },
    second: { ...second, reason: second.reason ?? null, return_fields: Object.keys(second) },
    observed_head: observedHead ? { checkpoint_id: observedHead.checkpoint_id, run_id: observedHead.run_id,
      generation: observedHead.generation, delivery_batch_id: observedHead.delivery_batch_id, payload: headPayload } : null,
    observed_slot: observedSlot,
    persistence_audit: persistenceAudit,
    homefeed_reload_calls: fixture.calls.filter(call => call.stage === 'homefeed.reload').length,
    send_calls: fixture.calls.filter(call => call.stage === 'delivery.send').length,
    root: fixture.root,
  };
  await fixture.writeEvidence(evidence);
  assert.equal(second.status, 'recovery_required');
  assert.equal(second.batch_id, first.batch_id);
  assert.ok(observedHead);
  assert.equal(second.run_id, observedHead.run_id);
  assert.equal(second.batch_id, observedHead.delivery_batch_id);
  assert.ok(['running', 'occupied'].includes(observedSlot?.state));
  assert.equal(fixture.calls.filter(call => call.stage === 'homefeed.reload').length, 1);
  assert.equal(fixture.calls.filter(call => call.stage === 'delivery.send').length, 1);
  assert.equal(first.status, 'partial');
  assert.deepEqual(persistenceAudit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(persistenceAudit.foreign_key_violations, []);
  assert.equal(persistenceAudit.causal_business_rows, 1);
  assert.deepEqual(persistenceAudit.bad_checkpoint_files, []);
});

test('I03 同日重复完整入口不会重复采集分析或发送', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const first = await fixture.run();
  const countsAfterFirst = Object.fromEntries(['candidate', 'analysis', 'decision', 'recommendation', 'delivery_attempt']
    .map(table => [table, fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const callsAfterFirst = fixture.calls.length;
  const second = await fixture.run();
  const duplicateCalls = fixture.calls.slice(callsAfterFirst).map(call => call.stage);
  const countsAfterSecond = Object.fromEntries(Object.keys(countsAfterFirst).map(table =>
    [table, fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const callsAfterSecond = fixture.calls.length;
  const persistenceAudit = fixture.auditRetained(first.batch_id);
  assert.deepEqual(persistenceAudit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(persistenceAudit.foreign_key_violations, []);
  assert.equal(persistenceAudit.causal_business_rows, 1);
  assert.deepEqual(persistenceAudit.bad_checkpoint_files, []);
  const evidence = { first_status: first.status, second_status: second.status,
    first_batch_id: first.batch_id, second_batch_id: second.batch_id, counts_after_first: countsAfterFirst,
    counts_after_second: countsAfterSecond,
    calls_after_first: callsAfterFirst, calls_after_second: callsAfterSecond,
    duplicate_call_stages: duplicateCalls, persistence_audit: persistenceAudit, root: fixture.root };
  await fixture.writeEvidence(evidence);
  assert.equal(second.batch_id, first.batch_id);
  assert.deepEqual(duplicateCalls, ['homefeed.evaluate']);
  for (const [table, count] of Object.entries(countsAfterFirst)) {
    assert.equal(evidence.counts_after_second[table], count, `${table} count changed on same-day duplicate`);
  }
});
