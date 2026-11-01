import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const waitFor = (promise, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })])
    .finally(() => clearTimeout(timer));
};

function deferred() {
  let resolveEntered;
  let release;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { entered, wait, resolveEntered, release };
}

test('I05 在途发送遇到stop后迟到成功仍记原attempt，日常重入不清stop，明确continue复用成功分析', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const gate = deferred();
  const adapterCalls = [];
  fixture.setTransport({
    async send(request) {
      adapterCalls.push({ type: 'send', uuid: request.uuid, receive_id: request.receive_id });
      gate.resolveEntered();
      await gate.wait;
      return { status: 'succeeded', message_id: 'synthetic-late-success', evidence: 'synthetic:late-success' };
    },
    async lookup(query) { adapterCalls.push({ type: 'lookup', attempt_id: query.attempt_id }); return { status: 'unknown' }; },
  });

  const firstPromise = fixture.run();
  let first;
  let stop;
  let continued;
  let resumed;
  try {
    await waitFor(gate.entered, 'full entry did not reach delivery send');
    const attempt = fixture.store.db.prepare(`SELECT a.*,r.delivery_batch_id,r.content_id
      FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=(SELECT delivery_batch_id FROM batch WHERE owner=? AND kind='daily_follow' ORDER BY rowid DESC LIMIT 1)`)
      .get(fixture.owner);
    assert.ok(attempt?.delivery_attempt_id);
    assert.ok(attempt.dispatched_at, 'stop must arrive after actual dispatch');
    assert.equal(attempt.status, 'intent');
    stop = await fixture.makeOrchestrator().requestStop({ batchId: attempt.delivery_batch_id });
    gate.release();
    first = await waitFor(firstPromise, 'stopped full entry did not return');

    const priorCalls = fixture.calls.length;
    const ordinary = await fixture.run();
    const ordinaryStages = fixture.calls.slice(priorCalls).map(call => call.stage);
    const afterStopAttempt = fixture.store.db.prepare('SELECT status,message_id FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(attempt.delivery_attempt_id);
    const afterStop = fixture.store.db.prepare('SELECT status,stop_requested FROM batch WHERE delivery_batch_id=?')
      .get(attempt.delivery_batch_id);
    const head = fixture.store.db.prepare(`SELECT run_id,generation FROM checkpoint
      WHERE delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(attempt.delivery_batch_id);
    const callsBeforeContinue = { collection: fixture.calls.filter(call => call.stage === 'collection.cli').length,
      analysis: fixture.calls.filter(call => call.stage === 'analysis.model:analysis').length,
      sends: adapterCalls.filter(call => call.type === 'send').length };
    const evidenceRef = await fixture.writeEvidence({ event: 'synthetic-observed-stop-and-return', batch_id: attempt.delivery_batch_id,
      run_id: head.run_id, attempt_id: attempt.delivery_attempt_id, dispatched_at: attempt.dispatched_at, stop, first });
    continued = await fixture.makeOrchestrator().continueBatch({ batchId: attempt.delivery_batch_id,
      commandId: 'task015-i05-explicit-continue', confirmedStoppedRunId: head.run_id, evidenceRef, explicitRequest: true });
    if (continued.status === 'continued') resumed = await fixture.runWith({ coordination: continued.coordination });
    const finalCounts = { collection: fixture.calls.filter(call => call.stage === 'collection.cli').length,
      analysis: fixture.calls.filter(call => call.stage === 'analysis.model:analysis').length,
      sends: adapterCalls.filter(call => call.type === 'send').length };
    await fixture.writeEvidence({ scenario: 'I05-stop-late-success-continue', first, ordinary, stop, continued, resumed,
      attempt_id: attempt.delivery_attempt_id, attempt_after_stop: afterStopAttempt, batch_after_stop: afterStop,
      prior_head: head, evidence_ref: evidenceRef, adapter_calls: adapterCalls, ordinary_stages: ordinaryStages,
      calls_before_continue: callsBeforeContinue,
      final_counts: finalCounts, root: fixture.root });

    assert.equal(stop.status, 'stop_requested');
    assert.equal(first.status, 'stopped');
    assert.equal(afterStopAttempt.status, 'succeeded');
    assert.equal(afterStopAttempt.message_id, 'synthetic-late-success');
    assert.equal(afterStop.status, 'stopped');
    assert.equal(afterStop.stop_requested, 1);
    assert.equal(ordinary.status, 'stopped');
    assert.deepEqual(ordinaryStages, [], 'ordinary same-day reentry must not start pipeline stages');
    assert.equal(continued.status, 'continued');
    assert.equal(resumed.batch_id, attempt.delivery_batch_id);
    assert.equal(finalCounts.collection, callsBeforeContinue.collection, 'successful material must not be collected again');
    assert.equal(finalCounts.analysis, callsBeforeContinue.analysis, 'valid completed analysis must not run again');
    assert.equal(finalCounts.sends, 1, 'the prior successful content must not be sent again on continue');
    assert.equal(adapterCalls.filter(call => call.type === 'send')[0].uuid, attempt.recommendation_id);
  } finally {
    gate.release();
    if (!first) await firstPromise.catch(() => {});
  }
});

test('I05b 在途发送遇到stop后迟到unknown留在原attempt，日常重入不重发', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const gate = deferred();
  const adapterCalls = [];
  fixture.setTransport({
    async send(request) {
      adapterCalls.push({ type: 'send', uuid: request.uuid });
      gate.resolveEntered();
      await gate.wait;
      return { status: 'unknown', reason: 'synthetic-late-unknown' };
    },
    async lookup(query) {
      adapterCalls.push({ type: 'lookup', attempt_id: query.attempt_id });
      return { status: 'unknown', reason: 'synthetic-no-confirmation' };
    },
  });

  const firstPromise = fixture.run();
  let first;
  try {
    await waitFor(gate.entered, 'full entry did not reach delivery send');
    const attempt = fixture.store.db.prepare(`SELECT a.*,r.delivery_batch_id
      FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=(SELECT delivery_batch_id FROM batch WHERE owner=? AND kind='daily_follow' ORDER BY rowid DESC LIMIT 1)`)
      .get(fixture.owner);
    assert.ok(attempt?.delivery_attempt_id);
    assert.ok(attempt.dispatched_at);
    assert.equal(attempt.status, 'intent');
    await fixture.makeOrchestrator().requestStop({ batchId: attempt.delivery_batch_id });
    gate.release();
    first = await waitFor(firstPromise, 'stopped full entry did not return');
    const persisted = fixture.store.db.prepare('SELECT status,revision,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(attempt.delivery_attempt_id);
    const ordinary = await fixture.run();
    const stagesAfterStop = fixture.calls.length;
    await fixture.writeEvidence({ scenario: 'I05b-stop-late-unknown', first, ordinary,
      attempt_id: attempt.delivery_attempt_id, persisted_attempt: persisted, adapter_calls: adapterCalls,
      total_synthetic_stages: stagesAfterStop, root: fixture.root });

    assert.equal(first.status, 'recovery_required');
    assert.equal(first.reason, 'delivery_worker_exit_unconfirmed');
    assert.equal(persisted.status, 'unknown');
    assert.ok(persisted.dispatched_at);
    assert.equal(ordinary.status, 'stopped');
    assert.equal(adapterCalls.filter(call => call.type === 'send').length, 1);
    assert.equal(adapterCalls.filter(call => call.type === 'lookup').length, 1);
    assert.equal(adapterCalls[0].uuid, attempt.recommendation_id);
  } finally {
    gate.release();
    if (!first) await firstPromise.catch(() => {});
  }
});

test('I06 上海午夜期间在途成功归旧批，新日从目标20重新开始且不重发旧成功ID', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  fixture.setClock('2026-10-26T15:59:59.000Z');
  const gate = deferred();
  const adapterCalls = [];
  fixture.setTransport({
    async send(request) {
      adapterCalls.push({ type: 'send', uuid: request.uuid, receive_id: request.receive_id });
      gate.resolveEntered();
      await gate.wait;
      return { status: 'succeeded', message_id: 'synthetic-midnight-late-success', evidence: 'synthetic:midnight-late-success' };
    },
    async lookup(query) { adapterCalls.push({ type: 'lookup', attempt_id: query.attempt_id }); return { status: 'unknown' }; },
  });
  const firstPromise = fixture.run();
  let oldBatchId;
  let first;
  let nextDay;
  try {
    await waitFor(gate.entered, 'full entry did not dispatch before midnight');
    const attempt = fixture.store.db.prepare(`SELECT a.*,r.delivery_batch_id,r.content_id,r.recommendation_id
      FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
      WHERE r.delivery_batch_id=(SELECT delivery_batch_id FROM batch WHERE owner=? AND kind='daily_follow' ORDER BY rowid DESC LIMIT 1)`)
      .get(fixture.owner);
    oldBatchId = attempt.delivery_batch_id;
    assert.ok(attempt.dispatched_at);
    assert.equal(attempt.dispatched_at, '2026-10-26T15:59:59.000Z');
    fixture.setClock('2026-10-26T16:00:00.000Z');
    gate.release();
    first = await waitFor(firstPromise, 'late send did not return after Shanghai midnight');
    const oldAttemptAfter = fixture.store.db.prepare('SELECT status,message_id,returned_at FROM delivery_attempt WHERE delivery_attempt_id=?')
      .get(attempt.delivery_attempt_id);
    const oldRecommendationAfter = fixture.store.db.prepare('SELECT first_success_at FROM recommendation WHERE recommendation_id=?')
      .get(attempt.recommendation_id);
    const oldBatchAfter = fixture.store.db.prepare('SELECT status,business_day,target FROM batch WHERE delivery_batch_id=?').get(oldBatchId);
    const successBeforeNewDay = fixture.store.db.prepare("SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
      .get(oldBatchId).n;
    fixture.setClock('2026-10-27T03:15:00.000Z');
    nextDay = await fixture.run();
    const newBatch = fixture.store.db.prepare('SELECT delivery_batch_id,business_day,target,status FROM batch WHERE delivery_batch_id=?')
      .get(nextDay.batch_id);
    const oldSuccesses = fixture.store.db.prepare("SELECT count(*) AS n FROM recommendation WHERE content_id=? AND state='succeeded'")
      .get(attempt.content_id).n;
    await fixture.writeEvidence({ scenario: 'I06-midnight-late-success', first, old_batch_id: oldBatchId,
      old_attempt: { attempt_id: attempt.delivery_attempt_id, recommendation_id: attempt.recommendation_id,
        status: oldAttemptAfter.status, message_id: oldAttemptAfter.message_id, dispatched_at: attempt.dispatched_at,
        returned_at: oldAttemptAfter.returned_at, first_success_at: oldRecommendationAfter.first_success_at },
      old_batch: oldBatchAfter, old_successes_before_next_day: successBeforeNewDay,
      next_day: nextDay, new_batch: newBatch, total_successful_recommendations_for_content: oldSuccesses,
      adapter_calls: adapterCalls, root: fixture.root });

    assert.equal(oldBatchAfter.status, 'closed_day');
    assert.equal(oldBatchAfter.business_day, '2026-10-26');
    assert.equal(oldBatchAfter.target, 20);
    assert.equal(oldAttemptAfter.status, 'succeeded');
    assert.equal(oldAttemptAfter.message_id, 'synthetic-midnight-late-success');
    assert.equal(oldAttemptAfter.returned_at, '2026-10-26T16:00:00.000Z');
    assert.equal(oldRecommendationAfter.first_success_at, '2026-10-26T16:00:00.000Z');
    assert.equal(successBeforeNewDay, 1, 'late success remains attributed to the original batch');
    assert.notEqual(nextDay.batch_id, oldBatchId);
    assert.equal(newBatch.business_day, '2026-10-27');
    assert.equal(newBatch.target, 20);
    assert.equal(oldSuccesses, 1, 'the next day must not create another successful recommendation for the old content');
    assert.equal(adapterCalls.filter(call => call.type === 'send').length, 1, 'new daily target must not resend the prior successful content');
    assert.equal(adapterCalls[0].uuid, attempt.recommendation_id);
  } finally {
    gate.release();
    if (!first) await firstPromise.catch(() => {});
  }
});
