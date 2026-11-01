// 2026-10-26 Codex：额度及缺材料只在外部适配器注入，恢复仍走同一产品入口。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCollector } from '../src/collection.mjs';
import { createAnalyzer } from '../src/analysis.mjs';
import { createCandidates } from '../src/candidates.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const quota = { exitCode: 1, stdout: JSON.stringify({ type: 'error', message: 'usage_limit_reached' }), stderr: '' };
const count = (f, stage) => f.calls.filter(x => x.stage === stage).length;

test('I05 分析CLI额度阻断后同日同批只恢复未完成分析，成功材料不重采', async t => {
  const f = await createDailyIntegrationFixture(t);
  const model = f.runtime.analysis.model;
  let quotaCalls = 0;
  f.runtime.analysis.model = async () => { quotaCalls++; return quota; };
  const interrupted = await f.run();
  const candidate = f.store.db.prepare('SELECT * FROM candidate WHERE discovery_batch_id=?').get(interrupted.batch_id);
  const before = f.store.db.prepare('SELECT * FROM analysis WHERE material_version_id IN (SELECT material_version_id FROM material_version WHERE content_id=?)').get(candidate.content_id);
  assert.equal(before.status, 'blocked');
  assert.equal(count(f, 'delivery.send'), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
  assert.equal(quotaCalls, 1);
  assert.equal(count(f, 'collection.cli'), 1);
  f.runtime.analysis.model = model;
  const recovered = await f.run();
  assert.equal(recovered.batch_id, interrupted.batch_id);
  assert.equal(recovered.delivered, 1);
  assert.equal(count(f, 'collection.cli'), 1);
  assert.equal(count(f, 'analysis.model:analysis'), 1);
  assert.equal(count(f, 'delivery.send'), 1);
  const final = f.store.db.prepare("SELECT * FROM analysis WHERE material_version_id=? AND status='complete' ORDER BY rowid DESC LIMIT 1").get(before.material_version_id);
  assert.equal(final.status, 'complete');
  assert.equal(f.store.db.prepare('SELECT status FROM analysis WHERE analysis_id=?').get(before.analysis_id).status, 'blocked');
  await f.writeEvidence({ scenario: 'I05-analysis-quota', batch_id: recovered.batch_id,
    candidate_id: candidate.candidate_id, material_version_id: before.material_version_id,
    blocked_analysis_id: before.analysis_id, recovered_analysis_id: final.analysis_id,
    quota_calls: quotaCalls, calls: f.calls, interrupted, recovered });
});

test('I05 筛选CLI额度中断后同批复用有效分析，仅补筛选和发送', async t => {
  const f = await createDailyIntegrationFixture(t);
  const selection = f.runtime.candidates.model;
  let quotaCalls = 0;
  f.runtime.candidates.model = async () => { quotaCalls++; return quota; };
  const interrupted = await f.run();
  const candidate = f.store.db.prepare('SELECT * FROM candidate WHERE discovery_batch_id=?').get(interrupted.batch_id);
  const before = f.store.db.prepare(`SELECT a.* FROM analysis a JOIN material_version m USING(material_version_id) WHERE m.content_id=?`).get(candidate.content_id);
  assert.equal(before.status, 'complete');
  assert.equal(count(f, 'analysis.model:analysis'), 1);
  assert.equal(count(f, 'delivery.send'), 0);
  assert.equal(quotaCalls, 1);
  f.runtime.candidates.model = selection;
  const stillHeld = await f.run();
  assert.equal(stillHeld.delivered, 0, '普通重入不得越过已失败筛选的确切恢复门禁');
  assert.equal(count(f, 'analysis.model:analysis'), 1);
  const progressCheckpoint = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1')
    .get(`candidates:${interrupted.batch_id}:${candidate.candidate_id}`);
  const progressRef = JSON.parse(progressCheckpoint.succeeded_refs_json)[0].snapshot_ref;
  const progress = JSON.parse(await readFile(progressRef, 'utf8'));
  assert.equal(progress.phase, 'selection_failed');
  const evidenceRef = join(f.root, 'explicit-selection-recovery.json');
  await writeFile(evidenceRef, JSON.stringify({ synthetic_only: true, run_id: progress.selection_run,
    attempt_id: progress.attempt_id, completed_exit_code: 1, reason: 'quota restored after completed adapter call' }));
  const common = { store: f.store, owner: f.owner, now: f.now };
  const collector = createCollector({ ...f.runtime.collection, ...common });
  const analyzer = createAnalyzer({ ...f.runtime.analysis, ...common });
  const candidates = createCandidates({ ...f.runtime.candidates, ...common, collector, analyzer });
  const resolution = await candidates.recover({ batchId: interrupted.batch_id, candidateId: candidate.candidate_id,
    attemptId: progress.attempt_id, confirmedStoppedRunId: progress.selection_run, evidenceRef });
  assert.equal(resolution.status, 'succeeded');
  assert.equal(resolution.phase, 'selection_resolved_failed');
  const recovered = await f.run();
  assert.equal(recovered.batch_id, interrupted.batch_id);
  assert.equal(recovered.delivered, 1);
  assert.equal(count(f, 'analysis.model:analysis'), 1);
  assert.equal(count(f, 'collection.cli'), 1);
  assert.equal(count(f, 'delivery.send'), 1);
  const after = f.store.db.prepare('SELECT * FROM analysis WHERE analysis_id=?').get(before.analysis_id);
  assert.deepEqual(after, before);
  await f.writeEvidence({ scenario: 'I05-selection-quota-reuse', batch_id: recovered.batch_id,
    candidate_id: candidate.candidate_id, unchanged_analysis: before, quota_calls: quotaCalls,
    calls: f.calls, interrupted, ordinary_reentry: stillHeld, resolution, recovered });
});

test('I05 CLI声称成功却缺材料时保留unknown，不能进入分析或投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  let collectionCalls = 0;
  f.runtime.collection.cli = async () => {
    collectionCalls++;
    return { exitCode: 0, stdout: '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0', stderr: '' };
  };
  const result = await f.run();
  const material = f.store.db.prepare(`SELECT m.* FROM material_version m JOIN content c USING(content_id) WHERE c.source_content_id=?`).get(f.candidateId);
  assert.equal(material.fetch_status, 'unknown');
  assert.equal(collectionCalls, 1);
  assert.equal(count(f, 'analysis.model:analysis'), 0);
  assert.equal(count(f, 'delivery.send'), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
  await f.writeEvidence({ scenario: 'I05-missing-material', result, material, collection_calls: collectionCalls, calls: f.calls });
});
