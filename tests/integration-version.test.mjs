// 2026-10-26 Codex：版本切换经过真实质量许可接口；旧在途归账和未派发候选分开验证。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQuality, readCurrentStrategy } from '../src/quality.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

function switchStrategy(f) {
  const current = readCurrentStrategy(f.store, f.owner, f.now());
  const next = `task015-new-${randomUUID()}`;
  const quality = createQuality({ store: f.store, owner: f.owner, now: f.now });
  const result = quality.activateStrategy({ strategy_version: next, parent_version: current.strategy_version,
    rules: ['合成新版：优先核实新增步骤证据'], rule_diff: { added: ['合成新版：优先核实新增步骤证据'] },
    evidence_refs: ['synthetic:task015-version-integration'], preference_version: current.preference_version,
    incident_bindings: [] });
  assert.equal(result.status, 'succeeded');
  return { previous: current.strategy_version, next };
}

test('I11 筛选期间切策略阻断旧候选许可，新版重筛复用有效分析', async t => {
  const f = await createDailyIntegrationFixture(t);
  const selection = f.runtime.candidates.model;
  let switched;
  f.runtime.candidates.model = async args => {
    const result = await selection(args);
    if (!switched) switched = switchStrategy(f);
    return result;
  };
  const first = await f.run();
  assert.ok(switched);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 0);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  const analysesBefore = f.store.db.prepare("SELECT * FROM analysis WHERE status='complete' ORDER BY analysis_id").all();
  f.runtime.candidates.model = selection;
  const staleReentry = await f.run();
  assert.equal(staleReentry.status, 'recovery_required');
  assert.equal(staleReentry.reason, 'current strategy evidence is stale');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
  const configuredVersions = f.runtime.delivery.currentVersions;
  f.runtime.delivery.currentVersions = () => ({ ...configuredVersions(),
    strategy_version: readCurrentStrategy(f.store, f.owner, f.now()).strategy_version });
  const head = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  const slot = f.store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(JSON.parse(head.succeeded_refs_json)[0].orchestration.invocation_state, 'returned');
  assert.equal(slot.owner, null);
  const evidenceRef = join(f.root, 'version-reentry-returned-proof.json');
  await writeFile(evidenceRef, JSON.stringify({ invocation_returned: true, process_id: process.pid,
    run_id: staleReentry.run_id, checkpoint_id: head.checkpoint_id, output_hash: head.output_hash, slot }));
  const recovery = await f.makeOrchestrator().recoverCoordinator({ confirmedStoppedRunId: staleReentry.run_id, evidenceRef });
  assert.equal(recovery.status, 'recovered');
  const second = await f.run();
  assert.equal(second.batch_id, first.batch_id);
  assert.equal(second.delivered, 1);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM analysis WHERE status='complete' ORDER BY analysis_id").all(), analysesBefore);
  const rec = f.store.db.prepare('SELECT * FROM recommendation').get();
  const decision = f.store.db.prepare('SELECT * FROM decision').get();
  assert.equal(rec.actual_strategy_version, switched.next);
  assert.equal(decision.strategy_version, switched.next);
  assert.equal(f.calls.filter(x => x.stage === 'analysis.model:analysis').length, 1);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
  await f.writeEvidence({ scenario: 'I11-version-before-publish', switched, first, stale_reentry: staleReentry, recovery, second,
    recommendation_id: rec.recommendation_id, actual_strategy: rec.actual_strategy_version,
    decision_id: decision.decision_id, analysis_ids: analysesBefore.map(x => x.analysis_id), calls: f.calls });
});

test('I11 已claim的旧版在途切版后仍归原版本，探索重遇成功同ID不再发送', async t => {
  const f = await createDailyIntegrationFixture(t);
  const transport = f.runtime.delivery.transport;
  let switched;
  f.setTransport({
    async send(request) { switched = switchStrategy(f); return transport.send(request); },
    lookup: transport.lookup,
  });
  const first = await f.run();
  assert.equal(first.delivered, 1);
  const recBefore = f.store.db.prepare('SELECT * FROM recommendation').get();
  assert.equal(recBefore.actual_strategy_version, switched.previous);
  assert.equal(recBefore.state, 'succeeded');
  assert.equal(readCurrentStrategy(f.store, f.owner, f.now()).strategy_version, switched.next);
  const second = await f.runWith({ kind: 'explore', commandId: 'task015-explore-known-success',
    explicitRequest: true, requestText: '探索新的可核查步骤', direction: '可核查步骤' });
  assert.notEqual(second.batch_id, first.batch_id);
  assert.equal(second.delivered, 0);
  assert.equal(f.store.db.prepare('SELECT kind FROM batch WHERE delivery_batch_id=?').get(second.batch_id).kind, 'explore');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 1);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM recommendation').get(), recBefore);
  await f.writeEvidence({ scenario: 'I11-inflight-version-category-dedupe', switched, first, second,
    recommendation: recBefore, delivery_attempts: f.store.db.prepare('SELECT * FROM delivery_attempt').all(), calls: f.calls });
});
