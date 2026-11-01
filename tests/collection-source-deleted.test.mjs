import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createCollector } from '../src/collection.mjs';
import { openStore, saveContent } from '../src/storage.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const summary = '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZcAAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');

// 恢复最初两种批次入口回归；后补旧成功保护和删除证据负例不得覆盖这两项。
const sourceId = 'd15a00000000000000000001';
const url = `https://www.xiaohongshu.com/explore/${sourceId}?xsec_token=synthetic-delete`;
const timestamp = '2026-10-26T03:15:00.000Z';
for (const withCollectionBatch of [false, true]) {
  test(`可靠删除在${withCollectionBatch ? '真实收藏批' : '无收藏批的候选'}入口一致归账`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'task015-deleted-regression-'));
    const store = openStore(join(root, 'state.sqlite'));
    const collector = createCollector({ store, root: join(root, 'collection'), owner: 'task015-deleted-test', now: () => timestamp,
      cli: async ({ outputDir }) => {
        await mkdir(outputDir, { recursive: true });
        const path = join(outputDir, 'reliable-deletion.json');
        await writeFile(path, JSON.stringify({ source_content_id: sourceId, reliable_deleted: true, synthetic_only: true }));
        return { exitCode: 1, stdout: '', stderr: '', reliableSourceDeleted: true, sourceDeletedEvidenceRef: path };
      } });
    const token = await collector.claim();
    t.after(async () => {
      await collector.release(token);
      store.close();
      console.log(`[task015 deleted fixture] root=${root}`);
    });
    if (withCollectionBatch) {
      await collector.recordDiscovery('task015-deleted-collection', { token,
        observations: [{ content_id: sourceId, complete_source_url: url, membership: 'present', observed_at: timestamp }],
        source_page: 'https://www.xiaohongshu.com/user/profile/ffffffffffffffffffffffff/collect',
        sub_tab: 'collected', read_method: 'synthetic', source_kind: 'live_page', observed_at: timestamp,
        coverage: { state: 'partial', stop_reason: 'page_limit', scope: 'visible-page' } });
    } else saveContent(store, { platform: 'xiaohongshu', content_id: sourceId, source_state: 'available' });
    const result = await collector.ensureMaterial(sourceId, url, { token });
    assert.equal(result.status, 'source_deleted');
    const row = store.db.prepare(`SELECT c.source_state,m.fetch_status,m.completeness,m.evidence_refs_json
      FROM content c JOIN material_version m USING(content_id) WHERE c.source_content_id=?`).get(sourceId);
    assert.equal(row.source_state, 'source_deleted');
    assert.equal(row.fetch_status, 'failed');
    assert.equal(row.completeness, 'unknown');
    const receiptPath = JSON.parse(row.evidence_refs_json)[0];
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.status, 'source_deleted');
    assert.equal(receipt.batch_id, withCollectionBatch ? 'task015-deleted-collection' : null);
    const run = JSON.parse(await readFile(join(root, 'collection', 'runs', token.runId, 'run.json'), 'utf8'));
    assert.equal(run.state, 'source_deleted');
    if (withCollectionBatch) {
      const cp = store.db.prepare("SELECT pending_ids_json,failed_refs_json FROM checkpoint WHERE stage LIKE 'collection:task015-deleted-collection:material:%' ORDER BY rowid DESC LIMIT 1").get();
      assert.deepEqual(JSON.parse(cp.pending_ids_json), []);
      assert.deepEqual(JSON.parse(cp.failed_refs_json), [receiptPath]);
    }
    await writeFile(join(process.cwd(), '.codex', `task015-deleted-regression-${withCollectionBatch}-${Date.now()}.json`),
      JSON.stringify({ root, synthetic_only: true, with_collection_batch: withCollectionBatch, result, row,
        receipt_path: receiptPath, run_state: run.state }, null, 2));
  });
}

async function writeSuccessfulMaterial(outputDir, { sourceId, sourceUrl, body }) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), body);
  await writeFile(join(outputDir, 'note_1.png'), png);
  const db = new DatabaseSync(join(outputDir, 'ExploreData.db'));
  db.exec(`CREATE TABLE explore_data (
    "采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,
    "发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,
    "点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,
    "下载地址" TEXT,"动图地址" TEXT)`);
  db.prepare('INSERT INTO explore_data VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    '2026-10-26T03:15:00.000Z', sourceId, '图文', '保留原材料', body, '',
    '2026-10-26T03:15:00.000Z', '2026-10-26T03:15:00.000Z', 0, 0, 0, 0,
    '合成作者', 'synthetic-author', '', sourceUrl, 'https://img.invalid/cover.png', '');
  db.close();
}

function makeCollector(f, cli) {
  return createCollector({ store: f.store, root: f.runtime.collection.root, owner: f.owner,
    now: f.now, cli });
}

function observation(f) {
  return { content_id: f.candidateId,
    complete_source_url: `https://www.xiaohongshu.com/explore/${f.candidateId}?xsec_token=synthetic-task015`,
    membership: 'present', observed_at: f.now(), media_kind: 'image' };
}

async function discoverCandidate(f, collector, token) {
  return collector.recordDiscovery(`task015-deletion-${randomUUID()}`, {
    observations: [observation(f)], source_page: 'https://www.xiaohongshu.com/explore',
    sub_tab: 'explore', read_method: 'synthetic_live_page', source_kind: 'live_page',
    observed_at: f.now(), coverage: { state: 'partial', stop_reason: 'page_limit', scope: 'one synthetic page' }, token,
  });
}

function analyzerFor(f) {
  f.runtime.analysis.model = async args => {
    const input = args.input;
    const output = args.kind === 'analysis'
      ? { id: input.source_content_id, summary: '本地合成材料检查',
        images: input.images.map(image => ({ index: image.index, description: '一张合成像素图', readability: 'readable' })),
        direct_evidence: [{ source: 'body', index: null, quote: input.body },
          ...input.images.map(image => ({ source: 'image', index: image.index, quote: `图片${image.index + 1}为合成像素图。` }))],
        inferences: [], actionable: ['核对原始材料'], uncertainties: ['合成样本'], media_scope: input.media_scope }
      : { hypotheses: [{ topic: '材料核对', supporting_analysis_ids: args.input.analyses.map(item => item.analysis_id),
        claim: '保留材料原序', confidence: 'medium', alternatives: ['合成样本'], long_term: false }],
        counterexamples: [], limitations: ['本地合成'] };
    await writeFile(args.outputPath, JSON.stringify(output));
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };
  f.runtime.candidates.model = async args => {
    const evidence = args.payload.candidate_analysis.direct_evidence;
    const baseline = args.payload.baseline.items[0];
    const quote = evidence[0].quote;
    await writeFile(args.outputPath, JSON.stringify({
      relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote,
        hypothesis_indexes: [0], explicit_request_quote: null },
      gain_state: 'gain', compared_candidate_refs: evidence.map((_, index) => index),
      compared_material_ids: [baseline.material_version_id],
      comparisons: evidence.map((item, index) => ({ baseline_material_id: baseline.material_version_id,
        candidate_evidence_ref: index, candidate_quote: item.quote, baseline_quote: baseline.direct_evidence[0].quote,
        relationship: 'adds', added_kind: 'steps', explanation: '此处用于验证已成功材料刷新时保留旧版本。' })),
      explicit_instruction_assessment: [],
    }));
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };
  f.runtime.display.uploadImage = async (_path, intent) => ({ image_key: `synthetic-image-${intent.index}` });
}

async function materialFileHashes(material) {
  const images = JSON.parse(material.ordered_images_json);
  return {
    body_hash: sha(await readFile(material.body_ref)),
    image_hashes: await Promise.all(images.map(async image => sha(await readFile(image.path)))),
    image_indexes: images.map(image => image.index),
  };
}

test('source_deleted刷新不覆盖已成功材料、推荐和发送尝试', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzerFor(f);
  const sourceUrl = observation(f).complete_source_url;
  f.runtime.collection.cli = async ({ outputDir, sourceContentId, url }) => {
    await writeSuccessfulMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url,
      body: '新增步骤：先保存合成正文，再核对后续版本。' });
    return { exitCode: 0, stdout: summary, stderr: '' };
  };
  const first = await f.run();
  assert.equal(first.delivered, 1, JSON.stringify(first));
  const candidate = f.store.db.prepare(`SELECT k.content_id,k.candidate_id FROM candidate k
    JOIN content c USING(content_id) WHERE k.discovery_batch_id=? AND c.source_content_id=?`).get(first.batch_id, f.candidateId);
  const oldMaterial = f.store.db.prepare(`SELECT * FROM material_version WHERE content_id=? AND fetch_status='succeeded'
    ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(candidate.content_id);
  assert.ok(oldMaterial?.body_ref);
  assert.equal(JSON.parse(oldMaterial.ordered_images_json).length, 1);
  const oldFileHashes = await materialFileHashes(oldMaterial);
  const recommendationBefore = f.store.db.prepare('SELECT * FROM recommendation WHERE content_id=?').get(candidate.content_id);
  const attemptBefore = f.store.db.prepare('SELECT * FROM delivery_attempt WHERE recommendation_id=?').get(recommendationBefore.recommendation_id);
  const oldRowsBefore = f.store.db.prepare('SELECT * FROM material_version WHERE content_id=? ORDER BY rowid').all(candidate.content_id);
  assert.equal(oldRowsBefore.length, 1);

  const collector = makeCollector(f, async ({ outputDir }) => {
    await mkdir(outputDir, { recursive: true });
    const proof = join(outputDir, 'source-deleted.json');
    await writeFile(proof, JSON.stringify({ synthetic: true, source_deleted: true }));
    return { exitCode: 1, stdout: '', stderr: '', reliableSourceDeleted: true, sourceDeletedEvidenceRef: proof };
  });
  const token = await collector.claim();
  let refresh;
  try { refresh = await collector.ensureMaterial(f.candidateId, sourceUrl, { token, refresh: true }); }
  finally { await collector.release(token); }

  const receiptPath = join(f.runtime.collection.root, 'attempts', refresh.attempt_id, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const oldRowsAfter = f.store.db.prepare('SELECT * FROM material_version WHERE content_id=? ORDER BY rowid').all(candidate.content_id);
  const oldMaterialAfter = f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(oldMaterial.material_version_id);
  const newFailure = f.store.db.prepare(`SELECT * FROM material_version WHERE content_id=? AND material_version_id<>?
    ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(candidate.content_id, oldMaterial.material_version_id);
  const source = f.store.db.prepare('SELECT source_state FROM content WHERE content_id=?').get(candidate.content_id);
  const hashesAfter = await materialFileHashes(oldMaterialAfter);
  const recommendationAfter = f.store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(recommendationBefore.recommendation_id);
  const attemptAfter = f.store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptBefore.delivery_attempt_id);
  const evidence = { scenario: 'reliable_source_deleted_preserves_success', batch_id: first.batch_id,
    content_id: candidate.content_id, candidate_id: candidate.candidate_id,
    recommendation_id: recommendationBefore.recommendation_id, delivery_attempt_id: attemptBefore.delivery_attempt_id,
    old_material_id: oldMaterial.material_version_id, refresh_attempt_id: refresh.attempt_id,
    source_state: source.source_state, old_file_hashes_before: oldFileHashes, old_file_hashes_after: hashesAfter,
    old_material_rows_before: oldRowsBefore, old_material_rows_after: oldRowsAfter,
    new_material: newFailure, receipt_path: receiptPath, receipt, counts: {
      recommendations: f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n,
      delivery_attempts: f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n,
    }, preserved_recommendation: recommendationBefore.recommendation_id === recommendationAfter.recommendation_id,
    preserved_attempt: attemptBefore.delivery_attempt_id === attemptAfter.delivery_attempt_id,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(refresh.status, 'source_deleted');
  assert.equal(receipt.status, 'source_deleted');
  assert.equal(receipt.source_content_id, f.candidateId);
  assert.deepEqual(JSON.parse(await readFile(receipt.source_deleted_evidence_ref, 'utf8')),
    { synthetic: true, source_deleted: true });
  assert.equal(source.source_state, 'source_deleted');
  assert.equal(oldRowsAfter.length, oldRowsBefore.length + 1);
  assert.deepEqual(oldRowsAfter.find(row => row.material_version_id === oldMaterial.material_version_id), oldRowsBefore[0]);
  assert.deepEqual(hashesAfter, oldFileHashes);
  assert.equal(newFailure.fetch_status, 'failed');
  assert.equal(newFailure.completeness, 'unknown');
  assert.deepEqual(recommendationAfter, recommendationBefore);
  assert.deepEqual(attemptAfter, attemptBefore);
  assert.equal(f.calls.filter(call => call.stage === 'delivery.send').length, 1);
});

test('没有sourceDeletedEvidenceRef时不得把候选记为source_deleted', async t => {
  const f = await createDailyIntegrationFixture(t);
  const collector = makeCollector(f, async ({ outputDir }) => {
    await mkdir(outputDir, { recursive: true });
    return { exitCode: 1, stdout: '', stderr: '', reliableSourceDeleted: true };
  });
  const token = await collector.claim();
  let result;
  try {
    await discoverCandidate(f, collector, token);
    result = await collector.ensureMaterial(f.candidateId, observation(f).complete_source_url, { token });
  } finally { await collector.release(token); }
  const receipt = JSON.parse(await readFile(join(f.runtime.collection.root, 'attempts', result.attempt_id, 'receipt.json'), 'utf8'));
  const source = f.store.db.prepare(`SELECT c.source_state,m.fetch_status,m.completeness FROM content c
    LEFT JOIN material_version m USING(content_id)
    WHERE c.source_content_id=? ORDER BY m.rowid DESC LIMIT 1`).get(f.candidateId);
  const evidence = { scenario: 'missing_deletion_evidence_ref', attempt_id: result.attempt_id,
    receipt, source, result, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.source_deleted_evidence_ref, null);
  assert.equal(result.status, 'unknown');
  assert.equal(source.source_state, 'unknown');
  assert.equal(source.fetch_status, 'unknown');
  assert.equal(source.completeness, 'unknown');
});

test('普通404即使引用删除证据文件也不得推断source_deleted', async t => {
  const f = await createDailyIntegrationFixture(t);
  let untrustedPath;
  const collector = makeCollector(f, async ({ outputDir }) => {
    await mkdir(outputDir, { recursive: true });
    untrustedPath = join(outputDir, 'untrusted-404-evidence.json');
    await writeFile(untrustedPath, JSON.stringify({ synthetic: true, stderr: '404 not found' }));
    return { exitCode: 1, stdout: '', stderr: '404 not found', sourceDeletedEvidenceRef: untrustedPath };
  });
  const token = await collector.claim();
  let result;
  try {
    await discoverCandidate(f, collector, token);
    result = await collector.ensureMaterial(f.candidateId, observation(f).complete_source_url, { token });
  } finally { await collector.release(token); }
  const receipt = JSON.parse(await readFile(join(f.runtime.collection.root, 'attempts', result.attempt_id, 'receipt.json'), 'utf8'));
  const source = f.store.db.prepare(`SELECT c.source_state,m.fetch_status,m.completeness FROM content c
    LEFT JOIN material_version m USING(content_id)
    WHERE c.source_content_id=? ORDER BY m.rowid DESC LIMIT 1`).get(f.candidateId);
  const evidence = { scenario: 'ordinary_404_with_untrusted_ref', attempt_id: result.attempt_id,
    receipt, source, result, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.source_deleted_evidence_ref, untrustedPath);
  assert.deepEqual(JSON.parse(await readFile(receipt.source_deleted_evidence_ref, 'utf8')),
    { synthetic: true, stderr: '404 not found' });
  assert.equal(result.status, 'unknown');
  assert.equal(source.source_state, 'unknown');
  assert.equal(source.fetch_status, 'unknown');
  assert.equal(source.completeness, 'unknown');
});
