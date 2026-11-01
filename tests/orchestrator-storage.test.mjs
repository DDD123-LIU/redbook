import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openStore } from '../src/storage.mjs';

const now = '2026-10-23T04:00:00.000Z';

async function fixture(t, { day = '2026-10-23', status = 'running', stopRequested = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task013-storage-'));
  const store = openStore(join(root, 'state.sqlite'));
  const owner = 'test-owner';
  const batchId = randomUUID();
  const runId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation,stop_requested)
    VALUES(?,?,'daily_follow',?,20,?,?,1,?)`).run(batchId, owner, day, now, status, stopRequested);
  const coordination = { owner, batchId, runId, batchGeneration: 1 };
  const orchestration = { owner, batchId, runId, batchGeneration: 1, active: true, process_id: process.pid,
    process_instance_id: 'storage-test-instance', process_started_at: now, invocation_state: 'executing', worker_refs: [] };
  const outputHash = createHash('sha256').update(JSON.stringify(orchestration)).digest('hex');
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), owner, runId, 1, batchId, JSON.stringify([runId]),
    JSON.stringify([{ orchestration }]), outputHash, now);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, owner, batchId, runId, coordination };
}

test('active global coordinator blocks stage work without its identity', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof store.assertCoordinator, 'function');
  assert.throws(() => store.assertCoordinator(undefined, { now }), /coordinator/i);
});

test('coordinator token must match the active head and running Shanghai daily batch', async t => {
  const { store, coordination } = await fixture(t);
  assert.doesNotThrow(() => store.assertCoordinator(coordination, { now }));
  assert.throws(() => store.assertCoordinator({ ...coordination, runId: randomUUID() }, { now }), /coordinator/i);
  assert.throws(() => store.assertCoordinator(coordination, { now: '2026-10-23T16:00:00.000Z' }), /business day|closed day/i);
});

test('stopped and closed batches permit accounting of already-dispatched results only', async t => {
  const stopped = await fixture(t, { stopRequested: 1 });
  assert.throws(() => stopped.store.assertCoordinator(stopped.coordination, { now }), /stop/i);
  assert.doesNotThrow(() => stopped.store.assertCoordinator(stopped.coordination, { now, accountingOnly: true }));

  const closed = await fixture(t, { status: 'closed_day' });
  assert.throws(() => closed.store.assertCoordinator(closed.coordination, { now }), /closed day|status/i);
  const replacementBatch = randomUUID();
  const replacementRun = randomUUID();
  closed.store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation)
    VALUES(?,?,'daily_follow','2026-10-24',20,?,'running',1)`).run(replacementBatch, 'next-owner', now);
  const replacementProof = { owner: 'next-owner', batchId: replacementBatch, runId: replacementRun, batchGeneration: 1,
    active: true, process_id: process.pid, process_instance_id: 'replacement-test-instance', process_started_at: now,
    invocation_state: 'executing', worker_refs: [] };
  const replacementHash = createHash('sha256').update(JSON.stringify(replacementProof)).digest('hex');
  closed.store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,1,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), 'next-owner', replacementRun, replacementBatch,
    JSON.stringify([replacementRun]), JSON.stringify([{ orchestration: replacementProof }]), replacementHash, now);
  assert.throws(() => closed.store.assertCoordinator(closed.coordination, { now }), /coordinator/i);
  assert.doesNotThrow(() => closed.store.assertCoordinator(closed.coordination, { now, accountingOnly: true }));
});

test('a hash-valid coordinator head without process proof fails closed', async t => {
  const { store, owner, batchId, runId, coordination } = await fixture(t);
  const incomplete = { owner, batchId, runId, batchGeneration: 1, active: true };
  const outputHash = createHash('sha256').update(JSON.stringify(incomplete)).digest('hex');
  store.db.prepare(`UPDATE checkpoint SET succeeded_refs_json=?,output_hash=? WHERE stage='orchestration:main'`)
    .run(JSON.stringify([{ orchestration: incomplete }]), outputHash);
  assert.throws(() => store.assertCoordinator(coordination, { now }), /coordinator head proof/i);
});

test('casSlot fences stage claim in its transaction and binds batch identity', async t => {
  const { store, coordination, batchId } = await fixture(t);
  const claim = (coordination, overrides = {}) => ({
    owner: coordination.owner, runId: 'worker-run', generation: 1, stopRequested: false,
    expectedOwner: null, expectedRunId: null, expectedGeneration: 0,
    expectedStopRequested: false, expectedState: 'idle', expectedRevision: 0,
    nextState: 'running', updatedAt: now, coordination, ...overrides
  });
  const ownerMismatch = await fixture(t);
  assert.throws(() => ownerMismatch.store.casSlot(claim(ownerMismatch.coordination, { owner: 'other-owner' })), /owner/i);
  const batchMismatch = await fixture(t);
  assert.throws(() => batchMismatch.store.casSlot(claim(batchMismatch.coordination, { batchId: randomUUID() })), /batch/i);
  assert.throws(() => store.casSlot(claim({ ...coordination, runId: randomUUID() })), /coordinator/i);
  assert.equal(store.db.prepare("SELECT state FROM execution_slot WHERE slot_key='main'").get().state, 'idle');
  const result = store.casSlot(claim(coordination));
  assert.equal(result.status, 'succeeded');
  assert.equal(store.db.prepare("SELECT batch_id FROM execution_slot WHERE slot_key='main'").get().batch_id, batchId);
});
