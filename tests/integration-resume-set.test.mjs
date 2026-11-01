import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const startedAt = '2026-10-26T03:15:00.000Z';
const candidates = [
  { id: 'a15a00000000000000000001', body: '新增步骤：先校验输入，再记录结果。' },
  { id: 'a15a00000000000000000002', body: '新增步骤：先检查权限，再保存结果。' },
];

async function writeCollectionOutput(outputDir, { sourceId, sourceUrl, body }) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), body);
  const db = new DatabaseSync(join(outputDir, 'ExploreData.db'));
  db.exec(`CREATE TABLE explore_data (
    "采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,
    "发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,
    "点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,
    "下载地址" TEXT,"动图地址" TEXT)`);
  db.prepare('INSERT INTO explore_data VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    startedAt, sourceId, '图文', '合成候选', body, '', startedAt, startedAt,
    0, 0, 0, 0, '合成作者', 'synthetic-author', '', sourceUrl, '', '');
  db.close();
}

test('I07 同批两候选遇analysis quota中断后只续未完成项', async t => {
  const fixture = await createDailyIntegrationFixture(t);
  const sourceUrl = candidate => `https://www.xiaohongshu.com/explore/${candidate.id}?xsec_token=synthetic-task015`;
  let pageIndex = 0;
  fixture.runtime.homefeed.options = { maxPages: 2, maxItems: 2, advance: true };
  fixture.tab.page.evaluate = async (_extract, options) => {
    fixture.calls.push({ stage: 'homefeed.evaluate', max_items: options.maxItems, seen_count: options.seenIds.length });
    const candidate = candidates[pageIndex++];
    const observations = candidate ? [{ content_id: candidate.id,
      complete_source_url: sourceUrl(candidate), author_name: '合成作者', media_kind: 'image' }] : [];
    return { source_page: 'https://www.xiaohongshu.com/explore', page_state: 'ready', observations,
      anchor_id: observations.at(-1)?.content_id ?? null };
  };
  fixture.tab.page.press = async () => {
    fixture.calls.push({ stage: 'homefeed.press' });
    fixture.setClock('2026-10-26T03:15:01.000Z');
  };

  const collected = new Map();
  fixture.runtime.collection.cli = async ({ outputDir, sourceContentId, url }) => {
    const candidate = candidates.find(item => item.id === sourceContentId);
    assert.ok(candidate, `unexpected source content id: ${sourceContentId}`);
    assert.equal(url, sourceUrl(candidate));
    collected.set(sourceContentId, (collected.get(sourceContentId) ?? 0) + 1);
    fixture.calls.push({ stage: 'collection.cli', content_id: sourceContentId });
    await writeCollectionOutput(outputDir, { sourceId: sourceContentId, sourceUrl: url, body: candidate.body });
    return { exitCode: 0, stdout: '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0', stderr: '' };
  };

  const originalAnalysisModel = fixture.runtime.analysis.model;
  const analysisCalls = new Map(candidates.map(candidate => [candidate.id, 0]));
  fixture.runtime.analysis.model = async args => {
    const sourceId = args.input.source_content_id;
    if (analysisCalls.has(sourceId)) analysisCalls.set(sourceId, analysisCalls.get(sourceId) + 1);
    fixture.calls.push({ stage: `analysis.wrapper:${sourceId}`, kind: args.kind });
    if (args.kind === 'analysis' && sourceId === candidates[1].id && analysisCalls.get(sourceId) === 1) {
      return { exitCode: 1, stdout: JSON.stringify({ type: 'error', message: 'usage_limit_reached' }), stderr: '' };
    }
    return originalAnalysisModel(args);
  };

  const selectionInputs = [];
  fixture.runtime.candidates.model = async args => {
    fixture.calls.push({ stage: 'candidates.model' });
    const quote = args.payload.candidate_analysis.direct_evidence[0].quote;
    const baselineItems = args.payload.baseline.items;
    selectionInputs.push({ candidate_id: args.payload.candidate.candidate_id,
      baseline_material_ids: baselineItems.map(item => item.material_version_id) });
    const output = { relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote,
      hypothesis_indexes: [0], explicit_request_quote: null }, gain_state: 'gain',
      compared_candidate_refs: [0], compared_material_ids: baselineItems.map(item => item.material_version_id),
      comparisons: baselineItems.map(item => ({ baseline_material_id: item.material_version_id,
        candidate_evidence_ref: 0, candidate_quote: quote, baseline_quote: item.direct_evidence[0].quote,
        relationship: 'adds', added_kind: 'steps', explanation: '合成候选记录了可核查的新步骤。' })),
      explicit_instruction_assessment: [] };
    await writeFile(args.outputPath, JSON.stringify(output));
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };

  const originalTransport = fixture.runtime.delivery.transport;
  const sends = [];
  const transport = {
    async send(request) {
      const record = { recommendation_id: request.uuid, receive_id: request.receive_id,
        payload_hash: createHash('sha256').update(JSON.stringify({ msg_type: request.msg_type, content: request.content })).digest('hex') };
      sends.push(record);
      const result = await originalTransport.send(request);
      record.message_id = `synthetic-${request.uuid}`;
      return { ...result, message_id: record.message_id };
    },
    async lookup(query) { return originalTransport.lookup(query); },
  };
  fixture.setTransport(transport);

  for (const table of ['candidate', 'decision', 'recommendation', 'delivery_attempt']) {
    assert.equal(fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} must start empty`);
  }

  const first = await fixture.run();
  const batchId = first.batch_id;
  const firstState = fixture.store.db.prepare(`SELECT b.business_day,b.target,b.status,
      (SELECT count(*) FROM recommendation r WHERE r.delivery_batch_id=b.delivery_batch_id AND r.state='succeeded') AS successes
    FROM batch b WHERE b.delivery_batch_id=?`).get(batchId);
  const materialIds = fixture.store.db.prepare(`SELECT c.source_content_id,m.material_version_id,m.body_hash
    FROM candidate ca JOIN content c USING(content_id) JOIN material_version m USING(content_id)
    WHERE ca.discovery_batch_id=? AND m.fetch_status='succeeded' ORDER BY c.source_content_id`).all(batchId);
  const candidateAnalyses = fixture.store.db.prepare(`SELECT c.source_content_id,a.analysis_id,a.material_version_id,a.input_hash,a.output_ref,a.status
    FROM candidate ca JOIN content c USING(content_id) JOIN material_version m USING(content_id)
    JOIN analysis a USING(material_version_id)
    WHERE ca.discovery_batch_id=? ORDER BY c.source_content_id,a.created_at,a.rowid`).all(batchId);
  const firstAnalysisA = candidateAnalyses.find(row => row.source_content_id === candidates[0].id && row.status === 'complete');
  const firstAnalysisAOutputHash = createHash('sha256').update(await readFile(firstAnalysisA.output_ref)).digest('hex');
  const firstCandidateOutcomes = fixture.store.db.prepare(`SELECT candidate_id,eligibility_state FROM candidate
    WHERE discovery_batch_id=? ORDER BY candidate_id`).all(batchId);
  const firstSucceeded = fixture.store.db.prepare(`SELECT c.source_content_id,r.recommendation_id,r.state,a.delivery_attempt_id,a.status,a.payload_hash
    FROM recommendation r JOIN content c USING(content_id) JOIN delivery_attempt a USING(recommendation_id)
    WHERE r.delivery_batch_id=? AND r.state='succeeded'`).all(batchId);

  const resumed = await fixture.run();
  const finalBatch = fixture.store.db.prepare('SELECT business_day,target,status FROM batch WHERE delivery_batch_id=?').get(batchId);
  const finalCandidates = fixture.store.db.prepare(`SELECT ca.candidate_id,c.source_content_id,ca.eligibility_state
    FROM candidate ca JOIN content c USING(content_id) WHERE ca.discovery_batch_id=? ORDER BY c.source_content_id`).all(batchId);
  const finalMaterials = fixture.store.db.prepare(`SELECT c.source_content_id,m.material_version_id,m.body_hash
    FROM candidate ca JOIN content c USING(content_id) JOIN material_version m USING(content_id)
    WHERE ca.discovery_batch_id=? AND m.fetch_status='succeeded' ORDER BY c.source_content_id`).all(batchId);
  const finalAnalyses = fixture.store.db.prepare(`SELECT c.source_content_id,a.analysis_id,a.material_version_id,a.input_hash,a.output_ref,a.status
    FROM candidate ca JOIN content c USING(content_id) JOIN material_version m USING(content_id)
    JOIN analysis a USING(material_version_id)
    WHERE ca.discovery_batch_id=? ORDER BY c.source_content_id,a.created_at,a.rowid`).all(batchId);
  const finalAnalysisA = finalAnalyses.find(row => row.source_content_id === candidates[0].id && row.status === 'complete');
  const finalAnalysisAOutputHash = createHash('sha256').update(await readFile(finalAnalysisA.output_ref)).digest('hex');
  const decisions = fixture.store.db.prepare(`SELECT c.source_content_id,d.decision_id,d.analysis_id,d.result,d.gain_state
    FROM decision d JOIN candidate ca USING(candidate_id) JOIN content c USING(content_id)
    WHERE ca.discovery_batch_id=? ORDER BY c.source_content_id`).all(batchId);
  const recommendations = fixture.store.db.prepare(`SELECT c.source_content_id,r.recommendation_id,r.state,r.decision_id
    FROM recommendation r JOIN content c USING(content_id) WHERE r.delivery_batch_id=? ORDER BY c.source_content_id`).all(batchId);
  const attempts = fixture.store.db.prepare(`SELECT c.source_content_id,a.delivery_attempt_id,a.recommendation_id,a.status,a.message_id,a.payload_hash
    FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) JOIN content c USING(content_id)
    WHERE r.delivery_batch_id=? ORDER BY c.source_content_id`).all(batchId);
  const candidateCheckpoints = fixture.store.db.prepare(`SELECT checkpoint_id,stage,output_hash,succeeded_refs_json
    FROM checkpoint WHERE delivery_batch_id=? AND stage LIKE 'candidates:%' ORDER BY rowid`).all(batchId);
  const causalRows = fixture.store.db.prepare(`SELECT count(*) AS n FROM candidate ca
    JOIN content c USING(content_id) JOIN decision d USING(candidate_id) JOIN analysis a USING(analysis_id)
    JOIN recommendation r USING(decision_id) JOIN delivery_attempt da USING(recommendation_id)
    WHERE ca.discovery_batch_id=?`).get(batchId).n;
  const verifiedCandidateRefs = [];
  for (const candidate of finalCandidates) {
    const checkpoint = candidateCheckpoints.filter(row => row.stage === `candidates:${batchId}:${candidate.candidate_id}`).at(-1);
    assert.ok(checkpoint, `candidate checkpoint missing for ${candidate.source_content_id}`);
    const reference = JSON.parse(checkpoint.succeeded_refs_json)[0];
    const bytes = await readFile(reference.snapshot_ref);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.hash);
    assert.equal(reference.hash, checkpoint.output_hash);
    const snapshot = JSON.parse(bytes.toString('utf8'));
    assert.equal(snapshot.batch_id, batchId);
    assert.equal(snapshot.candidate_id, candidate.candidate_id);
    verifiedCandidateRefs.push({ content_id: candidate.source_content_id,
      checkpoint_id: checkpoint.checkpoint_id, snapshot_ref: reference.snapshot_ref, snapshot_hash: reference.hash });
  }
  const persistenceAudit = fixture.auditRetained(batchId);
  const evidencePath = await fixture.writeEvidence({ scenario: 'I07-same-batch-analysis-quota-resume',
    first: { result: first, batch: firstState, outcomes: firstCandidateOutcomes, succeeded: firstSucceeded,
      candidate_analyses: candidateAnalyses, material_ids: materialIds },
    resumed, final_batch: finalBatch, candidates: finalCandidates, materials: finalMaterials,
    analyses: finalAnalyses, decisions, recommendations, attempts, candidate_checkpoints: candidateCheckpoints,
    first_analysis_a: { ...firstAnalysisA, output_hash: firstAnalysisAOutputHash },
    final_analysis_a: { ...finalAnalysisA, output_hash: finalAnalysisAOutputHash },
    collection_counts: Object.fromEntries(collected), analysis_calls: Object.fromEntries(analysisCalls), sends,
    selection_inputs: selectionInputs, verified_candidate_refs: verifiedCandidateRefs, dynamic_causal_rows: causalRows,
    calls: fixture.calls, persistence_audit: persistenceAudit, root: fixture.root });

  assert.equal(first.batch_id, batchId);
  assert.equal(firstState.business_day, '2026-10-26');
  assert.equal(firstState.target, 20);
  assert.equal(firstState.successes, 1);
  assert.equal(firstSucceeded.length, 1);
  assert.equal(firstSucceeded[0].source_content_id, candidates[0].id);
  assert.equal(firstSucceeded[0].status, 'succeeded');
  assert.ok(firstCandidateOutcomes.some(row => row.eligibility_state === 'hold'));
  assert.ok(candidateAnalyses.some(row => row.source_content_id === candidates[1].id && row.status === 'blocked'));
  assert.equal(resumed.batch_id, batchId);
  assert.equal(finalBatch.business_day, '2026-10-26');
  assert.equal(finalBatch.target, 20);
  assert.equal(finalCandidates.length, 2);
  assert.equal(finalMaterials.length, 2);
  assert.equal(decisions.length, 2);
  assert.equal(recommendations.length, 2);
  assert.ok(recommendations.every(row => row.state === 'succeeded'));
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(row => row.status === 'succeeded'));
  assert.equal(finalAnalyses.filter(row => row.status === 'complete').length, 2);
  assert.equal(finalAnalyses.filter(row => row.status === 'blocked').length, 1);
  assert.equal(analysisCalls.get(candidates[0].id), 1, 'A valid analysis must not be recomputed');
  assert.equal(analysisCalls.get(candidates[1].id), 2, 'B is blocked once and analyzed again after same-day resume');
  assert.equal(finalAnalysisA.analysis_id, firstAnalysisA.analysis_id);
  assert.equal(finalAnalysisA.input_hash, firstAnalysisA.input_hash);
  assert.equal(finalAnalysisA.output_ref, firstAnalysisA.output_ref);
  assert.equal(finalAnalysisAOutputHash, firstAnalysisAOutputHash);
  assert.equal(finalMaterials.find(row => row.source_content_id === candidates[0].id).body_hash,
    materialIds.find(row => row.source_content_id === candidates[0].id).body_hash);
  assert.deepEqual(Object.fromEntries(collected), { [candidates[0].id]: 1, [candidates[1].id]: 1 });
  assert.equal(sends.length, 2);
  assert.deepEqual([...new Set(sends.map(send => send.recommendation_id))].sort(),
    recommendations.map(row => row.recommendation_id).sort());
  assert.equal(new Set(sends.map(send => send.message_id)).size, 2);
  for (const prior of firstSucceeded) {
    const after = attempts.find(row => row.recommendation_id === prior.recommendation_id);
    assert.equal(after.delivery_attempt_id, prior.delivery_attempt_id, 'A attempt identity must remain stable');
    assert.equal(after.payload_hash, prior.payload_hash, 'A payload fingerprint must remain stable');
  }
  assert.ok(candidateCheckpoints.some(row => row.stage === `candidates:${batchId}`));
  for (const candidate of finalCandidates) assert.ok(candidateCheckpoints.some(row => row.stage === `candidates:${batchId}:${candidate.candidate_id}`));
  assert.deepEqual(persistenceAudit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(persistenceAudit.foreign_key_violations, []);
  assert.deepEqual(persistenceAudit.bad_checkpoint_files, []);
  assert.equal(causalRows, 2);
  assert.equal(persistenceAudit.causal_business_rows, 1,
    'the shared fixture audit is scoped to its original candidate; this case separately verifies both fresh candidates');
  assert.ok(evidencePath);
});
