import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createDelivery } from '../src/delivery.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

function runtime(f, transport) {
  return {
    collection: {}, analysis: {}, candidates: {}, display: {},
    delivery: { root: join(f.root, 'delivery'), transport, currentVersions: f.currentVersions },
  };
}

function delivery(f, transport) {
  return createDelivery({ store: f.store, root: join(f.root, 'delivery'), owner: f.owner, targetRef: 'synthetic-chat',
    appRef: 'synthetic-app', transport, currentVersions: f.currentVersions, now: () => '2026-10-23T04:01:00.000Z' });
}

const tab = { async reload() {}, async evaluate() { return []; } };

test('新批入口先取消旧批确证未派发intent，且不调用send', async t => {
  const f = await deliveryFixture(t);
  let sends = 0, lookups = 0;
  const transport = { async send() { sends++; return { status: 'unknown' }; }, async lookup() { lookups++; return { status: 'unknown' }; } };
  const oldDelivery = delivery(f, transport);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  const attemptBefore = f.store.db.prepare('SELECT r.delivery_batch_id,a.status,a.dispatched_at FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?').get(prepared.attempt_id);
  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime: runtime(f, transport), now: () => '2026-10-24T04:00:00.000Z' });

  await orchestrator.run({ kind: 'daily_follow', tab });

  const attemptAfter = f.store.db.prepare('SELECT r.delivery_batch_id,a.status,a.dispatched_at FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?').get(prepared.attempt_id);
  assert.equal(attemptBefore.status, 'intent');
  assert.equal(attemptBefore.dispatched_at, null);
  assert.equal(attemptAfter.delivery_batch_id, f.batchId);
  assert.equal(attemptAfter.status, 'cancelled_before_dispatch');
  assert.equal(attemptAfter.dispatched_at, null);
  assert.equal(sends, 0);
  assert.equal(lookups, 0);
});

test('跨日旧批unknown只核实原attempt并保留原批归属，不重复send', async t => {
  const f = await deliveryFixture(t);
  let sends = 0, lookups = 0;
  const transport = { async send() { sends++; return { status: 'unknown', evidence: 'synthetic-timeout' }; },
    async lookup() { lookups++; return { status: 'unknown', evidence: 'synthetic-still-unknown' }; } };
  const oldDelivery = delivery(f, transport);
  const prepared = await oldDelivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await oldDelivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  const orchestrator = createOrchestrator({ store: f.store, root: f.root, owner: f.owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-chat', runtime: runtime(f, transport), now: () => '2026-10-24T04:00:00.000Z' });

  const result = await orchestrator.run({ kind: 'daily_follow', tab });

  const attempt = f.store.db.prepare('SELECT r.delivery_batch_id,a.status,a.dispatched_at FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?').get(prepared.attempt_id);
  assert.ok(['blocked', 'recovery_required'].includes(result.status));
  assert.equal(attempt.delivery_batch_id, f.batchId);
  assert.equal(attempt.status, 'unknown');
  assert.ok(attempt.dispatched_at);
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM recommendation WHERE delivery_batch_id<>? AND content_id=?").get(f.batchId, f.contentId).n, 0);
});
