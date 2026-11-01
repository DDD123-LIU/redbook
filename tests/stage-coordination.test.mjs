import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createHomefeed } from '../src/homefeed.mjs';
import { createCollector } from '../src/collection.mjs';
import { createAnalyzer } from '../src/analysis.mjs';
import { createCandidates } from '../src/candidates.mjs';
import { createDisplay } from '../src/display.mjs';
import { createDelivery } from '../src/delivery.mjs';
import { openStore, saveContent, saveMaterialVersion } from '../src/storage.mjs';

const now = '2026-10-23T04:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stage-coordination-'));
  const store = openStore(join(root, 'state.sqlite'));
  const owner = 'stage-owner';
  const batchId = randomUUID();
  store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,created_at,status,generation,stop_requested)
    VALUES(?,?,'daily_follow','2026-10-23',20,?,'running',1,0)`).run(batchId, owner, now);
  const proof = { owner, batchId, runId: 'coordinator-run', batchGeneration: 1, active: true,
    process_id: process.pid, process_instance_id: 'stage-test-instance', process_started_at: now,
    invocation_state: 'executing', worker_refs: [] };
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,output_hash,committed_at)
    VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?)`).run(randomUUID(), owner, 'coordinator-run', 1, batchId,
    JSON.stringify(['coordinator-run']), JSON.stringify([{ orchestration: proof }]), sha(JSON.stringify(proof)), now);
  const coordination = { owner, batchId, runId: 'coordinator-run', batchGeneration: 1 };
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, owner, batchId, coordination };
}

async function displayFixture(t) {
  const f = await fixture(t);
  const insert = (table, row) => {
    const columns = Object.keys(row);
    f.store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  };
  const sourceContentId = '0123456789abcdef01234567';
  const contentId = saveContent(f.store, { platform: 'xiaohongshu', content_id: sourceContentId, source_state: 'available' }).entity_id;
  const body = JSON.stringify({ title: '合成标题', description: '合成正文', author_name: '合成作者' });
  const bodyRef = join(f.root, 'body.json');
  await writeFile(bodyRef, body);
  const images = [];
  for (let index = 0; index < 2; index++) {
    const path = join(f.root, `image-${index}.png`);
    const bytes = Buffer.from(`synthetic-image-${index}`);
    await writeFile(path, bytes);
    images.push({ index, path, hash: sha(bytes) });
  }
  const materialId = saveMaterialVersion(f.store, { content_id: contentId, body_ref: bodyRef, body,
    media_kind: 'image', completeness: 'complete', fetched_at: now, ordered_images: images }).entity_id;
  const preference = randomUUID(), strategy = randomUUID(), baseline = randomUUID();
  insert('preference_version', { preference_version: preference, created_at: now });
  insert('strategy_version', { strategy_version: strategy, rule_diff_json: '{}', preference_version: preference, state: 'active', effective_at: now, created_at: now });
  insert('baseline_version', { baseline_version: baseline, material_version_ids_json: JSON.stringify([materialId]),
    coverage_description: JSON.stringify({ coverage: { input_complete: true }, material_ids: [materialId] }), created_at: now });
  const analysisId = randomUUID(), candidateId = randomUUID(), decisionId = randomUUID();
  const sourceRef = join(f.root, 'source.json');
  await writeFile(sourceRef, JSON.stringify({ observations: [{ content_id: sourceContentId,
    complete_source_url: `https://www.xiaohongshu.com/explore/${sourceContentId}?xsec_token=synthetic` }] }));
  insert('analysis', { analysis_id: analysisId, material_version_id: materialId, input_hash: sha(body), prompt_version: 'synthetic',
    model_requested: 'synthetic', output_ref: 'synthetic:analysis', completion_evidence: 'synthetic:complete', status: 'complete', created_at: now });
  insert('candidate', { candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId, source: 'homefeed',
    discovered_at: now, source_evidence_ref: `file:${sourceRef}`, eligibility_state: 'eligible' });
  insert('decision', { decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId, baseline_version: baseline,
    preference_version: preference, strategy_version: strategy, category: 'follow', relevance: 'matched', gain_state: 'gain', result: 'eligible', created_at: now });
  return { ...f, decision: { decision_id: decisionId, candidate_id: candidateId, content_id: contentId }, images };
}

test('all six stage factories reject dispatch without the active coordinator identity', async t => {
  const f = await fixture(t);
  let externalCalls = 0;
  const homefeed = createHomefeed({ store: f.store, root: join(f.root, 'homefeed'), owner: f.owner, now: () => now });
  const collector = createCollector({ store: f.store, root: join(f.root, 'collection'), owner: f.owner, cli: async () => { externalCalls++; }, now: () => now });
  const analyzer = createAnalyzer({ store: f.store, root: join(f.root, 'analysis'), owner: f.owner, model: async () => { externalCalls++; }, now: () => now });
  const candidates = createCandidates({ store: f.store, root: join(f.root, 'candidates'), owner: f.owner,
    collector: { async claim() { externalCalls++; } },
    analyzer: { async currentPreference() { return null; }, async run() { externalCalls++; } },
    model: async () => { externalCalls++; }, now: () => now });
  const display = createDisplay({ store: f.store, root: join(f.root, 'display'), owner: f.owner, appRef: 'synthetic-app',
    uploadImage: async () => { externalCalls++; }, now: () => now });
  const delivery = createDelivery({ store: f.store, root: join(f.root, 'delivery'), owner: f.owner, targetRef: 'synthetic-chat',
    appRef: 'synthetic-app', transport: { async send() { externalCalls++; }, async lookup() { externalCalls++; } }, now: () => now });

  const outcomes = [];
  for (const [name, operation] of [
    ['homefeed', () => homefeed.refreshHomefeed(f.batchId, { async reload() { externalCalls++; }, async evaluate() { externalCalls++; } })],
    ['collection', () => collector.claim()],
    ['analysis', () => analyzer.run({ batchKey: f.batchId, materialIds: ['missing-material'] })],
    ['candidates', () => candidates.run({ batchId: f.batchId })],
    ['display', () => display.buildBatch(f.batchId, [{ decision_id: 'missing-decision' }])],
    ['delivery', () => delivery.prepareDelivery({ recommendation_id: 'missing-recommendation' })],
  ]) {
    try { await operation(); outcomes.push([name, null]); }
    catch (error) { outcomes.push([name, error]); }
  }
  for (const [name, error] of outcomes) assert.match(error?.message ?? '', /coordinator/i, `${name} did not reject with a coordinator guard`);
  assert.equal(externalCalls, 0);
});

test('homefeed claims the phase slot with the matching coordinator and batch identity', async t => {
  const f = await fixture(t);
  let calls = 0;
  const homefeed = createHomefeed({ store: f.store, root: join(f.root, 'homefeed'), owner: f.owner,
    coordination: f.coordination, now: () => now });
  await homefeed.refreshHomefeed(f.batchId, {
    async reload() { calls++; },
    async evaluate() {
      calls++;
      return { source_page: 'https://www.xiaohongshu.com/', observations: [], anchor_id: null, page_state: 'login_required' };
    },
  });
  assert.equal(calls, 2);
  const slot = f.store.db.prepare("SELECT owner,run_id,state,batch_id FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(slot.owner, null);
  assert.equal(slot.run_id, null);
  assert.equal(slot.state, 'stopped');
  assert.equal(slot.batch_id, null);
});

test('homefeed stops before reading the next page after stop arrives during PageDown', async t => {
  const f = await fixture(t);
  let evaluations = 0;
  let advances = 0;
  const homefeed = createHomefeed({ store: f.store, root: join(f.root, 'homefeed'), owner: f.owner,
    coordination: f.coordination, now: () => now });
  await assert.rejects(homefeed.refreshHomefeed(f.batchId, {
    async reload() {},
    async evaluate() {
      evaluations++;
      return { source_page: 'https://www.xiaohongshu.com/explore', observations: [],
        anchor_id: 'a'.repeat(24), page_state: 'ready' };
    },
    async press() {
      advances++;
      f.store.db.prepare('UPDATE batch SET stop_requested=1 WHERE delivery_batch_id=?').run(f.batchId);
    },
  }, { maxPages: 2, advance: true }), /coordinator/i);
  assert.equal(evaluations, 1);
  assert.equal(advances, 1);
});

test('homefeed retains a page returned after stop without publishing candidates or reading another page', async t => {
  const f = await fixture(t);
  let evaluations = 0;
  let resolvePage;
  let markEvaluateStarted;
  const evaluateStarted = new Promise(resolve => { markEvaluateStarted = resolve; });
  const pageResult = new Promise(resolve => { resolvePage = resolve; });
  const homefeed = createHomefeed({ store: f.store, root: join(f.root, 'homefeed'), owner: f.owner,
    coordination: f.coordination, now: () => now });
  const refresh = homefeed.refreshHomefeed(f.batchId, {
    async reload() {},
    async evaluate() { evaluations++; markEvaluateStarted(); return pageResult; },
  }, { maxPages: 2 });
  await evaluateStarted;
  f.store.db.prepare('UPDATE batch SET stop_requested=1 WHERE delivery_batch_id=?').run(f.batchId);
  const sourceContentId = 'fedcba9876543210fedcba98';
  resolvePage({ source_page: 'https://www.xiaohongshu.com/explore', anchor_id: sourceContentId, page_state: 'ready', observations: [
    { content_id: sourceContentId, complete_source_url: `https://www.xiaohongshu.com/explore/${sourceContentId}?xsec_token=synthetic` },
  ] });
  await assert.rejects(refresh, /coordinator/i);
  assert.equal(evaluations, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM candidate WHERE discovery_batch_id=?').get(f.batchId).n, 0);
  const cp = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1").get(`homefeed-late:${f.batchId}`);
  assert.ok(cp, 'late homefeed page must be linked to its original phase run');
  const saved = JSON.parse(cp.succeeded_refs_json)[0];
  const bytes = await readFile(saved.slice(5));
  assert.equal(sha(bytes), cp.output_hash);
  assert.equal(JSON.parse(bytes.toString('utf8')).observations[0].content_id, sourceContentId);
});

test('display retains a late upload receipt after stop and blocks the next image upload', async t => {
  const f = await displayFixture(t);
  let calls = 0;
  let resolveUpload;
  let markUploadStarted;
  const uploadStarted = new Promise(resolve => { markUploadStarted = resolve; });
  const uploadResult = new Promise(resolve => { resolveUpload = resolve; });
  const display = createDisplay({ store: f.store, root: join(f.root, 'display'), owner: f.owner, appRef: 'synthetic-app',
    coordination: f.coordination, now: () => now, decodeImage: async () => ({ width: 120, height: 240, format: 'png' }),
    uploadImage: async () => { calls++; markUploadStarted(); return uploadResult; } });
  const build = display.buildBatch(f.batchId, [f.decision]);
  await uploadStarted;
  f.store.db.prepare('UPDATE batch SET stop_requested=1 WHERE delivery_batch_id=?').run(f.batchId);
  resolveUpload({ image_key: 'late-image-key' });
  await assert.rejects(build, /coordinator/i);
  assert.equal(calls, 1);
  const cp = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage LIKE 'display-media:%' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(cp, 'late media result must be checkpointed');
  const saved = JSON.parse(cp.succeeded_refs_json)[0];
  const checkpointBytes = await readFile(saved.ref);
  const receipt = JSON.parse(checkpointBytes.toString('utf8'));
  assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.image_key, 'late-image-key');
  assert.equal(receipt.run_id, cp.run_id);
  assert.equal(receipt.generation, cp.generation);
  assert.deepEqual(receipt.coordination, f.coordination);
  assert.equal(sha(checkpointBytes), saved.hash);
  assert.equal(cp.output_hash, saved.hash);
  const uploadReceipt = await readFile(receipt.receipt_path);
  assert.equal(receipt.receipt_hash, sha(uploadReceipt));
});
