import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const at = '2026-10-26T03:15:00.000Z';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const multiFixtureUrl = pathToFileURL(resolve('tests/helpers/integration-multi-fixture.mjs')).href;

async function waitForChild(child, timeoutMs = 45000) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`synthetic crash child timed out after ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal, stdout, stderr }); });
  });
}

function candidateIds() {
  return Array.from({ length: 20 }, (_, index) => `a15a${String(index + 1).padStart(20, '0')}`);
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

function snapshotSuccessfulBatch(store, batchId) {
  return store.db.prepare(`SELECT c.source_content_id,m.material_version_id,m.body_hash,a.analysis_id,a.input_hash,a.output_ref,
      r.recommendation_id,r.decision_id,r.state AS recommendation_state,da.delivery_attempt_id,da.status AS attempt_status,
      da.payload_hash,da.message_id
    FROM candidate ca JOIN content c USING(content_id)
    JOIN material_version m USING(content_id) JOIN analysis a USING(material_version_id)
    JOIN decision d USING(analysis_id) JOIN recommendation r USING(decision_id)
    JOIN delivery_attempt da USING(recommendation_id)
    WHERE ca.discovery_batch_id=? AND da.status='succeeded' ORDER BY c.source_content_id`).all(batchId).map(row => {
      const analysisHash = sha256(readFileSync(row.output_ref));
      const build = store.db.prepare('SELECT succeeded_refs_json,output_hash FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1')
        .get(`display-build:${row.recommendation_id}`);
      assert.ok(build, `display build proof missing for ${row.recommendation_id}`);
      const reference = JSON.parse(build.succeeded_refs_json)[0];
      const artifactBytes = readFileSync(reference.ref);
      return { ...row, analysis_output_hash: analysisHash, build_ref: reference.ref,
        build_hash: sha256(artifactBytes), checkpoint_hash: build.output_hash };
    });
}

test('I08 full-entry 19/20发送后真实崩溃，经恢复与明确continue完成原批', { timeout: 60000 }, async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const ids = candidateIds();
  assert.equal(ids[0], fixture.candidateId);
  for (const table of ['candidate', 'decision', 'recommendation', 'delivery_attempt']) {
    assert.equal(fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} must start empty`);
  }
  const sendLogPath = join(fixture.root, 'task015-send-log.jsonl');
  const callLogPath = join(fixture.root, 'task015-call-log.jsonl');
  const crashMarkerPath = join(fixture.root, 'task015-crash-marker.json');
  const configPath = join(fixture.root, 'task015-multi-child-config.json');
  const config = { root: fixture.root, db_path: fixture.dbPath, owner: fixture.owner, candidate_ids: ids,
    now: at, current_versions: fixture.runtime.delivery.currentVersions(), send_log_path: sendLogPath,
    call_log_path: callLogPath, crash_marker_path: crashMarkerPath };
  await fixture.writeEvidence({ scenario: 'I08-crash-continuation-input', synthetic_only: true,
    candidate_ids: ids, current_versions: config.current_versions, root: fixture.root, database_path: fixture.dbPath });
  await (await import('node:fs/promises')).writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx' });

  const helperPath = resolve('tests/helpers/integration-multi-fixture.mjs');
  const child = spawn(process.execPath, [helperPath, configPath],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const childResult = await waitForChild(child);
  assert.equal(childResult.code, 73, `${childResult.stdout}\n${childResult.stderr}`);
  assert.equal(childResult.signal, null);
  const markerBytes = readFileSync(crashMarkerPath);
  const markerHash = sha256(markerBytes);
  const marker = JSON.parse(markerBytes.toString('utf8'));
  assert.equal(marker.root, fixture.root);
  assert.equal(marker.db_path, fixture.dbPath);
  assert.equal(marker.owner, fixture.owner);
  assert.equal(marker.process_id > 0, true);
  assert.equal(marker.success_count, 19);
  assert.ok(['running', 'succeeded'].includes(marker.phase_status));
  if (marker.phase_status === 'succeeded') assert.equal(marker.phase_result_attempt_id, marker.last_succeeded_attempt_id);
  if (marker.phase_status === 'running') assert.equal(marker.phase_result_recommendation_id, marker.recommendation_id);
  assert.equal(marker.batch_status, 'running');
  assert.equal(marker.head_batch_id, marker.batch_id);
  assert.equal(marker.outer_commit_returned, true);
  assert.deepEqual(marker.execution_slot, { state: 'stopped', owner: null, run_id: null });
  assert.throws(() => process.kill(marker.process_id, 0), { code: 'ESRCH' });

  const batch = fixture.store.db.prepare(`SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-26'`)
    .get(fixture.owner);
  assert.ok(batch);
  assert.equal(batch.target, 20);
  const beforeBatchCounts = {
    candidates: fixture.store.db.prepare('SELECT count(*) AS n FROM candidate WHERE discovery_batch_id=?').get(batch.delivery_batch_id).n,
    materials: fixture.store.db.prepare(`SELECT count(DISTINCT m.content_id) AS n FROM material_version m
      JOIN candidate c USING(content_id) WHERE c.discovery_batch_id=? AND m.fetch_status='succeeded'`).get(batch.delivery_batch_id).n,
    analyses: fixture.store.db.prepare(`SELECT count(DISTINCT a.material_version_id) AS n FROM analysis a
      JOIN material_version m USING(material_version_id) JOIN candidate c USING(content_id)
      WHERE c.discovery_batch_id=? AND a.status='complete'`).get(batch.delivery_batch_id).n,
    decisions: fixture.store.db.prepare('SELECT count(*) AS n FROM decision d JOIN candidate c USING(candidate_id) WHERE c.discovery_batch_id=?').get(batch.delivery_batch_id).n,
    recommendations: fixture.store.db.prepare('SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=?').get(batch.delivery_batch_id).n,
    succeeded_recommendations: fixture.store.db.prepare("SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'").get(batch.delivery_batch_id).n,
    succeeded_attempts: fixture.store.db.prepare(`SELECT count(*) AS n FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=? AND a.status='succeeded'`).get(batch.delivery_batch_id).n,
  };
  assert.deepEqual(beforeBatchCounts, { candidates: 20, materials: 20, analyses: 20, decisions: 20,
    recommendations: 20, succeeded_recommendations: 19, succeeded_attempts: 19 });
  const crashedAttempt = fixture.store.db.prepare(`SELECT a.*,r.recommendation_id,r.decision_id,r.content_id,r.state AS recommendation_state
    FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?`).get(marker.attempt_id);
  assert.ok(crashedAttempt);
  assert.equal(crashedAttempt.status, 'intent');
  assert.equal(crashedAttempt.dispatched_at, null);
  assert.equal(crashedAttempt.recommendation_id, marker.recommendation_id);
  assert.equal(crashedAttempt.payload_hash, marker.payload_hash);
  const deliveryCheckpoint = fixture.store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(fixture.owner, `delivery-attempt:${marker.attempt_id}`);
  assert.ok(deliveryCheckpoint, 'the dispatched boundary must persist a real delivery-attempt checkpoint');
  const attemptState = readJson(JSON.parse(deliveryCheckpoint.succeeded_refs_json)[0].ref);
  const intent = readJson(attemptState.intent_ref);
  assert.equal(intent.attempt_id, marker.attempt_id);
  assert.equal(intent.recommendation_id, marker.recommendation_id);
  assert.equal(intent.payload_hash, marker.payload_hash);
  assert.ok(attemptState.build_ref);
  assert.equal(sha256(readFileSync(attemptState.build_ref)), attemptState.build_hash);
  const sendRowsBefore = readFileSync(sendLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(sendRowsBefore.length, 19);
  assert.equal(new Set(sendRowsBefore.map(row => row.recommendation_id)).size, 19);
  const callRowsBefore = readFileSync(callLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.deepEqual(['collection', 'analysis', 'selection'].map(stage => callRowsBefore.filter(row => row.stage === stage).length), [20, 20, 20]);
  const first19 = snapshotSuccessfulBatch(fixture.store, batch.delivery_batch_id);
  assert.equal(first19.length, 19);

  const proofPath = join(fixture.root, 'task015-child-exit-proof.json');
  const proof = { child_exit_code: childResult.code, process_id: marker.process_id, attempt_id: marker.attempt_id,
    run_id: marker.run_id, observed_at: new Date().toISOString(), marker_hash: markerHash };
  await (await import('node:fs/promises')).writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });

  const originalTransport = fixture.runtime.delivery.transport;
  fixture.setTransport({
    async send(request) {
      const result = await originalTransport.send(request);
      const attempt = fixture.store.db.prepare('SELECT delivery_attempt_id,payload_hash FROM delivery_attempt WHERE recommendation_id=? ORDER BY rowid DESC LIMIT 1')
        .get(request.uuid);
      assert.ok(attempt?.delivery_attempt_id);
      appendFileSync(sendLogPath, `${JSON.stringify({ attempt_id: attempt.delivery_attempt_id,
        recommendation_id: request.uuid, payload_hash: attempt.payload_hash, message_id: `synthetic-${request.uuid}` })}\n`);
      return { ...result, message_id: `synthetic-${request.uuid}` };
    },
    async lookup(query) { return originalTransport.lookup(query); },
  });
  const orchestrator = fixture.makeOrchestrator();
  const recovered = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: marker.run_id, evidenceRef: proofPath });
  assert.equal(recovered.status, 'recovered', JSON.stringify(recovered));
  assert.equal(recovered.batch_id, batch.delivery_batch_id);
  assert.equal(recovered.run_id, marker.run_id);
  const cancelledAttempt = fixture.store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?')
    .get(marker.attempt_id);
  assert.equal(cancelledAttempt.status, 'cancelled_before_dispatch');
  assert.equal(cancelledAttempt.dispatched_at, null);
  const failedPhase = JSON.parse(fixture.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(fixture.owner, `orchestration:phase:${batch.delivery_batch_id}:delivery`).succeeded_refs_json)[0].orchestration_phase;
  assert.equal(failedPhase.status, 'failed');
  assert.equal(failedPhase.result.reason, 'coordinator_exit_before_dispatch');
  assert.equal(failedPhase.result.execution_state, 'confirmed_idle_before_dispatch');
  const headBeforeContinue = fixture.store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1")
    .get(fixture.owner);
  assert.equal(JSON.parse(headBeforeContinue.succeeded_refs_json)[0].orchestration.active, false);

  const callsBeforeOrdinary = fixture.calls.length;
  const ordinary = await fixture.run();
  assert.equal(ordinary.status, 'blocked');
  assert.equal(ordinary.reason, 'explicit_continue_required');
  assert.deepEqual(ordinary.attempt_ids, [marker.attempt_id]);
  assert.equal(fixture.calls.length, callsBeforeOrdinary);
  assert.equal(readFileSync(sendLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length, 19);

  const commandId = `task015-crash-continue-${randomUUID()}`;
  const continued = await orchestrator.continueBatch({ batchId: batch.delivery_batch_id, commandId,
    confirmedStoppedRunId: marker.run_id, evidenceRef: proofPath, explicitRequest: true });
  assert.equal(continued.status, 'continued', JSON.stringify(continued));
  const resumed = await fixture.runWith({ coordination: continued.coordination, tab: fixture.tab });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.batch_id, batch.delivery_batch_id);
  assert.equal(resumed.delivered, 20);
  assert.equal(resumed.shortfall, 0);

  const finalBatch = fixture.store.db.prepare('SELECT status,target,generation FROM batch WHERE delivery_batch_id=?').get(batch.delivery_batch_id);
  assert.equal(finalBatch.status, 'completed');
  assert.equal(finalBatch.target, 20);
  const finalCounts = {
    candidates: fixture.store.db.prepare('SELECT count(*) AS n FROM candidate WHERE discovery_batch_id=?').get(batch.delivery_batch_id).n,
    materials: fixture.store.db.prepare(`SELECT count(DISTINCT m.content_id) AS n FROM material_version m
      JOIN candidate c USING(content_id) WHERE c.discovery_batch_id=? AND m.fetch_status='succeeded'`).get(batch.delivery_batch_id).n,
    analyses: fixture.store.db.prepare(`SELECT count(DISTINCT a.material_version_id) AS n FROM analysis a
      JOIN material_version m USING(material_version_id) JOIN candidate c USING(content_id)
      WHERE c.discovery_batch_id=? AND a.status='complete'`).get(batch.delivery_batch_id).n,
    decisions: fixture.store.db.prepare('SELECT count(*) AS n FROM decision d JOIN candidate c USING(candidate_id) WHERE c.discovery_batch_id=?').get(batch.delivery_batch_id).n,
    recommendations: fixture.store.db.prepare('SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=?').get(batch.delivery_batch_id).n,
    succeeded_recommendations: fixture.store.db.prepare("SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'").get(batch.delivery_batch_id).n,
    attempts: fixture.store.db.prepare('SELECT count(*) AS n FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=?')
      .get(batch.delivery_batch_id).n,
    succeeded_attempts: fixture.store.db.prepare(`SELECT count(*) AS n FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=? AND a.status='succeeded'`).get(batch.delivery_batch_id).n,
    cancelled_attempts: fixture.store.db.prepare(`SELECT count(*) AS n FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=? AND a.status='cancelled_before_dispatch'`).get(batch.delivery_batch_id).n,
  };
  assert.deepEqual(finalCounts, { candidates: 20, materials: 20, analyses: 20, decisions: 20,
    recommendations: 20, succeeded_recommendations: 20, attempts: 21, succeeded_attempts: 20, cancelled_attempts: 1 });
  const finalSuccesses = snapshotSuccessfulBatch(fixture.store, batch.delivery_batch_id);
  assert.equal(finalSuccesses.length, 20);
  for (const prior of first19) {
    const after = finalSuccesses.find(row => row.source_content_id === prior.source_content_id);
    for (const key of ['material_version_id', 'body_hash', 'analysis_id', 'input_hash', 'analysis_output_hash',
      'recommendation_id', 'decision_id', 'delivery_attempt_id', 'payload_hash', 'build_ref', 'build_hash', 'checkpoint_hash']) {
      assert.equal(after[key], prior[key], `${key} changed for previously completed ${prior.source_content_id}`);
    }
  }
  const attemptCounts = fixture.store.db.prepare(`SELECT recommendation_id,count(*) AS n FROM delivery_attempt a
    JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? GROUP BY recommendation_id`).all(batch.delivery_batch_id);
  assert.equal(attemptCounts.length, 20);
  assert.equal(attemptCounts.reduce((sum, row) => sum + row.n, 0), 21);
  const sendRowsAfter = readFileSync(sendLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(sendRowsAfter.length, 20);
  assert.equal(new Set(sendRowsAfter.map(row => row.recommendation_id)).size, 20);
  assert.equal(new Set(sendRowsAfter.map(row => row.message_id)).size, 20);
  assert.equal(fixture.calls.filter(call => call.stage === 'collection.cli').length, 0);
  assert.equal(fixture.calls.filter(call => call.stage.startsWith('analysis.model')).length, 0);
  assert.equal(fixture.calls.filter(call => call.stage === 'candidates.model').length, 0);
  assert.equal(fixture.calls.filter(call => call.stage === 'homefeed.reload' || call.stage === 'homefeed.evaluate').length, 0);

  const replay = await orchestrator.continueBatch({ batchId: batch.delivery_batch_id, commandId,
    confirmedStoppedRunId: marker.run_id, evidenceRef: proofPath, explicitRequest: true });
  assert.equal(replay.status, 'duplicate_command');
  assert.equal(readFileSync(sendLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length, 20);
  const persistenceAudit = fixture.auditRetained(batch.delivery_batch_id);
  assert.deepEqual(persistenceAudit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(persistenceAudit.foreign_key_violations, []);
  assert.deepEqual(persistenceAudit.bad_checkpoint_files, []);
  await fixture.writeEvidence({ scenario: 'I08-full-entry-crash-continue', synthetic_only: true,
    child_exit: childResult, marker, marker_hash: markerHash, proof, proof_path: proofPath,
    batch_id: batch.delivery_batch_id, before: beforeBatchCounts, after: finalCounts,
    recovered, ordinary, continued, resumed, replay, first19_fingerprints: first19,
    final_fingerprints: finalSuccesses, child_call_counts: ['collection', 'analysis', 'selection'].map(stage =>
      [stage, callRowsBefore.filter(row => row.stage === stage).length]), send_log_before: sendRowsBefore,
    send_log_after: sendRowsAfter, persistence_audit: persistenceAudit, root: fixture.root, database_path: fixture.dbPath });
});
