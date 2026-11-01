import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/storage.mjs';
import { saveContent, saveMaterialVersion } from '../src/storage.mjs';
import { createHomefeed } from '../src/homefeed.mjs';
import { createCandidates, evaluate } from '../src/candidates.mjs';
import { createAnalyzer } from '../src/analysis.mjs';

const candidate = { candidate_id: 'candidate-1', content_id: 'content-new', source_content_id: 'note-new' };
const analysis = { analysis_id: 'analysis-1', direct_evidence: [
  { source: 'body', index: null, quote: '新增步骤：先校验输入，再生成结果。' },
] };
const baseline = { coverage: { state: 'partial', material_count: 1, missing_count: 2, input_complete: true }, items: [
  { content_id: 'content-old', material_version_id: 'material-old', body: '旧方法直接生成结果。', direct_evidence: [] },
] };
const preference = { preference_version: 'preference-1', hypotheses: [{ claim: '关注有可核查步骤的 AI 工作流。' }], explicit_instructions: [] };
const proposal = {
  relevance: { state: 'matched', evidence_index: 0, evidence_quote: '新增步骤：先校验输入，再生成结果。', hypothesis_indexes: [0], explicit_request_quote: null },
  gain_state: 'gain',
  compared_candidate_refs: [0],
  compared_material_ids: ['material-old'],
  comparisons: [{
    baseline_material_id: 'material-old', candidate_evidence_ref: 0,
    candidate_quote: '新增步骤：先校验输入，再生成结果。',
    baseline_quote: '旧方法直接生成结果。', relationship: 'adds', added_kind: 'steps',
    explanation: '候选新增输入校验步骤。',
  }],
  explicit_instruction_assessment: [],
};
const activeStrategy = { strategy_version: '010-v1', state: 'active' };

async function runnerFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-run-'));
  const store = openStore(join(dir, 'state.sqlite'));
  const owner = 'owner';
  const homefeed = createHomefeed({ store, root: join(dir, 'private'), owner, now: () => '2026-10-23T04:00:00.000Z' });
  const batch = homefeed.beginBatch({ kind: 'daily_follow' });
  const sourceId = 'b'.repeat(24);
  await homefeed.recordPage(batch.batch_id, { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T04:00:00Z', page_state: 'ready',
    observations: [{ content_id: sourceId, complete_source_url: `https://www.xiaohongshu.com/explore/${sourceId}?xsec_token=private-token` }], anchor_id: sourceId, advanced: true, read_method: 'test' });
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });
  return { dir, store, owner, batch, sourceId };
}

test('有明确新增步骤且引用实际候选和完整基线时eligible', () => {
  assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal }).result, 'eligible');
});

test('相关性允许所选证据连续原文片段，增量比较仍绑定整条证据', () => {
  const run = value => evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal: value });
  const quoted = { ...proposal, relevance: { ...proposal.relevance, evidence_quote: '先校验输入' } };
  assert.equal(run(quoted).result, 'eligible');
  for (const quote of [' ', '先校验輸入', '先校验输入再生成']) {
    assert.equal(run({ ...quoted, relevance: { ...quoted.relevance, evidence_quote: quote } }).reason, 'candidate_relevance_reference_invalid');
  }
  assert.equal(run({ ...quoted, relevance: { ...quoted.relevance, evidence_index: 9 } }).reason, 'candidate_relevance_reference_invalid');
  assert.equal(run({ ...quoted, comparisons: [{ ...proposal.comparisons[0], candidate_quote: '先校验输入' }] }).result, 'hold');
});

test('没有变化的基线引用只能判no_gain并reject', () => {
  const result = evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal: {
    ...proposal, gain_state: 'no_gain', comparisons: [{ ...proposal.comparisons[0], relationship: 'equivalent', added_kind: null }],
  } });
  assert.equal(result.result, 'reject');
  assert.equal(result.reason, 'no_information_gain');
});

test('引用不存在或未比较全部实际基线时hold', () => {
  for (const bad of [
    { ...proposal, comparisons: [{ ...proposal.comparisons[0], candidate_evidence_ref: 9 }] },
    { ...proposal, comparisons: [] },
    { ...proposal, comparisons: [{ ...proposal.comparisons[0], baseline_material_id: 'fabricated' }] },
    { ...proposal, compared_candidate_refs: [] },
    { ...proposal, compared_material_ids: [] },
  ]) {
    assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal: bad }).result, 'hold');
  }
});

test('no_gain必须覆盖候选全部证据并逐一比较全部基线', () => {
  const twoEvidenceAnalysis = { ...analysis, direct_evidence: [...analysis.direct_evidence, { source: 'body', index: null, quote: '结果可以复查。' }] };
  assert.equal(evaluate({ candidate, analysis: twoEvidenceAnalysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal: {
    ...proposal, gain_state: 'no_gain', comparisons: [{ ...proposal.comparisons[0], relationship: 'equivalent', added_kind: null }],
  } }).result, 'hold');
});

test('不确定增量与未知相关性hold', () => {
  for (const bad of [
    { ...proposal, gain_state: 'undecidable' },
    { ...proposal, relevance: { ...proposal.relevance, state: 'unknown' } },
  ]) {
    assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'follow', proposal: bad }).result, 'hold');
  }
});

test('探索必须由显式请求触发，并引用请求原文', () => {
  assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'explore', explicitRequest: '请找一个新工具', direction: '探索一个新的图像工作流', proposal: {
    ...proposal,
    relevance: { state: 'matched', evidence_index: 0, evidence_quote: '新增步骤：先校验输入，再生成结果。', hypothesis_indexes: [], explicit_request_quote: '新的图像工作流' },
    explicit_instruction_assessment: [
      { instruction_quote: '请找一个新工具', relation: 'support', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote },
      { instruction_quote: '探索一个新的图像工作流', relation: 'support', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote },
    ],
  } }).result, 'eligible');
  const unrelated = { ...proposal, relevance: { state: 'mismatch', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote, hypothesis_indexes: [], explicit_request_quote: '新的图像工作流' },
    explicit_instruction_assessment: [
      { instruction_quote: '请找一个新工具', relation: 'support', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote },
      { instruction_quote: '探索一个新的图像工作流', relation: 'support', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote },
    ] };
  assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'explore', explicitRequest: '请找一个新工具', direction: '探索一个新的图像工作流', proposal: unrelated }).result, 'reject');
  assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: activeStrategy, category: 'explore', proposal }).result, 'hold');
});

test('strategy必须active且baseline输入完整标志必须明确', () => {
  assert.equal(evaluate({ candidate, analysis, baseline: { ...baseline, coverage: { state: 'complete' } }, preference, strategy: activeStrategy, category: 'follow', proposal }).result, 'hold');
  assert.equal(evaluate({ candidate, analysis, baseline, preference, strategy: { ...activeStrategy, state: 'inactive' }, category: 'follow', proposal }).result, 'hold');
});

test('验证每条候选证据与每份基线的唯一pair，任何等价对阻止gain', () => {
  const twoBaseline = { ...baseline, items: [...baseline.items, { content_id: 'c2', material_version_id: 'm2', body: '另一旧方法。', direct_evidence: [] }] };
  const pair = (baseline_material_id, relationship, baseline_quote) => ({ ...proposal.comparisons[0], baseline_material_id, relationship, baseline_quote, added_kind: relationship === 'equivalent' ? null : 'steps' });
  const incompleteCross = { ...proposal, compared_material_ids: ['material-old', 'm2'], comparisons: [pair('material-old', 'adds', '旧方法直接生成结果。'), pair('m2', 'adds', '另一旧方法。')] };
  assert.equal(evaluate({ candidate, analysis, baseline: twoBaseline, preference, strategy: activeStrategy, category: 'follow', proposal: incompleteCross }).result, 'eligible');
  const conflict = { ...incompleteCross, comparisons: [pair('material-old', 'adds', '旧方法直接生成结果。'), pair('m2', 'equivalent', '另一旧方法。')] };
  assert.equal(evaluate({ candidate, analysis, baseline: twoBaseline, preference, strategy: activeStrategy, category: 'follow', proposal: conflict }).result, 'hold');
});

test('显式指令逐条核验，正向指令可独立于历史hypothesis', () => {
  const withInstruction = { ...preference, explicit_instructions: ['请优先展示可复查步骤'] };
  const directed = { ...proposal, relevance: { ...proposal.relevance, hypothesis_indexes: [] }, explicit_instruction_assessment: [{ instruction_quote: '请优先展示可复查步骤', relation: 'support', evidence_index: 0, evidence_quote: analysis.direct_evidence[0].quote }] };
  assert.equal(evaluate({ candidate, analysis, baseline, preference: withInstruction, strategy: activeStrategy, category: 'follow', explicitRequest: '请优先展示可复查步骤', proposal: directed }).result, 'eligible');
  for (const relation of ['contradict', 'unknown']) {
    const result = evaluate({ candidate, analysis, baseline, preference: withInstruction, strategy: activeStrategy, category: 'follow', explicitRequest: '请优先展示可复查步骤', proposal: { ...directed, explicit_instruction_assessment: [{ ...directed.explicit_instruction_assessment[0], relation }] } });
    assert.equal(result.result, relation === 'contradict' ? 'reject' : 'hold');
  }
});

test('pipeline只消费已保存候选；已收藏同ID直接reject且不调用采集分析或模型', async t => {
  const f = await runnerFixture(t);
  const contentId = f.store.db.prepare('SELECT content_id FROM content WHERE source_content_id=?').get(f.sourceId).content_id;
  const collectionBatch = 'collection-test';
  f.store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_count,total_known,evidence_refs_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(collectionBatch, '2026-10-23', '2026-10-23', '{}', 1, 1, '[]', '2026-10-23');
  f.store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref,collected_at,coverage_ref)
    VALUES(?,?,?,?,?,?,?,?)`).run('observation-test', collectionBatch, contentId, '2026-10-23T04:00:00Z', 'present', 'test:evidence', '2026-10-23T04:00:00Z', null);
  let calls = 0;
  const collector = { async claim() { calls++; throw Error('must not collect'); }, async ensureMaterial() { calls++; }, async release() {} };
  const analyzer = { async currentPreference() { return null; }, async run() { calls++; } };
  const candidates = createCandidates({ store: f.store, root: join(f.dir, 'candidate-private'), owner: f.owner, collector, analyzer, model: async () => { calls++; }, now: () => '2026-10-23T04:00:00.000Z' });
  const result = await candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.excluded[0].reason, 'already_collected_or_delivered');
  assert.equal(calls, 0);
  assert.equal(f.store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'reject');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 0);
});

test('pipeline核验009有效材料与偏好、完成selection后复用decision且不写投递表', async t => {
  const f = await runnerFixture(t);
  let selectionCalls = 0;
  const model = async args => {
    if (args.kind === 'analysis') return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
    if (args.kind === 'preference') {
      return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
    }
    selectionCalls++;
    const candidateQuote = args.payload.candidate_analysis.direct_evidence[0].quote;
    const baselineItem = args.payload.baseline.items[0];
    const proposal = { relevance: { state: 'matched', evidence_index: 0, evidence_quote: candidateQuote, hypothesis_indexes: [0], explicit_request_quote: null },
      gain_state: 'gain', compared_candidate_refs: [0], compared_material_ids: [baselineItem.material_version_id],
      comparisons: [{ baseline_material_id: baselineItem.material_version_id, candidate_evidence_ref: 0, candidate_quote: candidateQuote, baseline_quote: '旧流程：直接生成结果。',
        relationship: 'adds', added_kind: 'steps', explanation: '候选新增了先检查再生成的具体步骤。' }], explicit_instruction_assessment: [] };
    await writeFile(args.outputPath, JSON.stringify(proposal));
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };
  const writeMaterial = async (contentId, key, body) => {
    const bodyRef = join(f.dir, `${key}.txt`);
    await writeFile(bodyRef, body);
    return saveMaterialVersion(f.store, { content_id: contentId, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete' }).entity_id;
  };
  const baselineContent = saveContent(f.store, { platform: 'xiaohongshu', content_id: 'c'.repeat(24), source_state: 'available' }).entity_id;
  const baselineMaterial = await writeMaterial(baselineContent, 'baseline', '旧流程：直接生成结果。');
  f.store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_count,total_known,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('baseline-batch', '2026-10-23', '2026-10-23', '{}', 1, 1, '[]', '2026-10-23');
  f.store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref,collected_at,coverage_ref) VALUES(?,?,?,?,?,?,?,?)`)
    .run('baseline-observation', 'baseline-batch', baselineContent, '2026-10-23T04:00:00Z', 'present', 'test:baseline', '2026-10-23T04:00:00Z', null);
  const candidateContent = f.store.db.prepare('SELECT content_id FROM content WHERE source_content_id=?').get(f.sourceId).content_id;
  const candidateMaterial = await writeMaterial(candidateContent, 'candidate', '新增步骤：先验证素材，再生成结果。');
  const analyzer = createAnalyzer({ store: f.store, root: join(f.dir, 'analysis'), owner: f.owner, model: async args => {
    if (args.kind === 'analysis') {
      const input = args.input;
      const output = { id: input.source_content_id, summary: '分析', images: [], direct_evidence: [{ source: 'body', index: null, quote: input.body }],
        inferences: [], actionable: ['实际步骤'], uncertainties: ['局部材料'], media_scope: input.media_scope };
      await writeFile(args.outputPath, JSON.stringify(output));
    } else {
      const output = { hypotheses: [{ topic: '流程', supporting_analysis_ids: args.input.analyses.map(item => item.analysis_id), claim: '关注有步骤的流程', confidence: 'medium', alternatives: ['偶然收藏'], long_term: false }], counterexamples: [], limitations: ['局部样本'] };
      await writeFile(args.outputPath, JSON.stringify(output));
    }
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  } });
  assert.equal((await analyzer.run({ batchKey: 'seed-baseline', materialIds: [baselineMaterial] })).status, 'succeeded');
  assert.equal((await analyzer.run({ batchKey: 'seed-candidate', materialIds: [candidateMaterial], summarize: false })).status, 'succeeded');
  const candidates = createCandidates({ store: f.store, root: join(f.dir, 'candidate-private'), owner: f.owner, collector: {}, analyzer, model, now: () => '2026-10-23T04:00:00.000Z' });
  const first = await candidates.run({ batchId: f.batch.batch_id });
  assert.equal(first.eligible.length, 1);
  assert.equal(selectionCalls, 1);
  const second = await candidates.run({ batchId: f.batch.batch_id });
  assert.equal(second.eligible.length, 1);
  assert.equal(selectionCalls, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 0);
});

test('delivery_attempt intent即使recommendation仍pending也会hold且不改投递状态', async t => {
  const f = await runnerFixture(t);
  const candidateRow = f.store.db.prepare('SELECT * FROM candidate').get();
  const contentId = candidateRow.content_id;
  const bodyRef = join(f.dir, 'intent-body.txt');
  await writeFile(bodyRef, '待验证内容');
  const materialId = saveMaterialVersion(f.store, { content_id: contentId, body_ref: bodyRef, body: '待验证内容', media_kind: 'text', completeness: 'complete' }).entity_id;
  f.store.db.prepare(`INSERT INTO preference_version(preference_version,explicit_instructions_json,supporting_content_ids_json,hypotheses_json,counterexamples_json,created_at)
    VALUES('pref-intent','[]','[]','[]','[]','2026-10-23')`).run();
  f.store.db.prepare(`INSERT INTO strategy_version(strategy_version,rule_diff_json,evidence_refs_json,state,effective_at,created_at)
    VALUES('strategy-intent','{}','[]','active','2026-10-23','2026-10-23')`).run();
  f.store.db.prepare(`INSERT INTO baseline_version(baseline_version,material_version_ids_json,coverage_description,created_at) VALUES('baseline-intent','[]','{}','2026-10-23')`).run();
  f.store.db.prepare(`INSERT INTO analysis(analysis_id,material_version_id,input_hash,prompt_version,model_requested,status,created_at)
    VALUES('analysis-intent',?,'input','analysis-v1.1','test','partial','2026-10-23')`).run(materialId);
  f.store.db.prepare(`INSERT INTO decision(decision_id,candidate_id,analysis_id,baseline_version,preference_version,strategy_version,category,relevance,gain_state,result,created_at)
    VALUES('decision-intent',?,'analysis-intent','baseline-intent','pref-intent','strategy-intent','follow','matched','gain','eligible','2026-10-23')`).run(candidateRow.candidate_id);
  f.store.db.prepare(`INSERT INTO recommendation(recommendation_id,content_id,delivery_batch_id,decision_id,category,actual_preference_version,actual_strategy_version,state,created_at,updated_at)
    VALUES('recommendation-intent',?,?,'decision-intent','follow','pref-intent','strategy-intent','pending','2026-10-23','2026-10-23')`).run(contentId, f.batch.batch_id);
  f.store.db.prepare(`INSERT INTO delivery_attempt(delivery_attempt_id,recommendation_id,target_ref,payload_hash,intent_at,status,created_at,updated_at)
    VALUES('attempt-intent','recommendation-intent','private-target','${'a'.repeat(64)}','2026-10-23','intent','2026-10-23','2026-10-23')`).run();
  let modelCalls = 0;
  const candidates = createCandidates({ store: f.store, root: join(f.dir, 'candidate-private'), owner: f.owner,
    collector: {}, analyzer: { async currentPreference() { return null; }, async run() { throw Error('must not analyze'); } }, model: async () => { modelCalls++; }, now: () => '2026-10-23T04:00:00.000Z' });
  const result = await candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.held[0].reason, 'delivery_intent_or_unknown');
  assert.equal(modelCalls, 0);
  assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get('recommendation-intent').state, 'pending');
  assert.equal(f.store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get('attempt-intent').status, 'intent');
});

test('batch已请求停止时不运行候选分析或selection', async t => {
  const f = await runnerFixture(t);
  f.store.db.prepare("UPDATE batch SET stop_requested=1,revision=revision+1 WHERE delivery_batch_id=?").run(f.batch.batch_id);
  let modelCalls = 0;
  const candidates = createCandidates({ store: f.store, root: join(f.dir, 'candidate-private'), owner: f.owner, collector: {},
    analyzer: { async currentPreference() { throw Error('must not read preference after stop'); }, async run() { throw Error('must not analyze'); } }, model: async () => { modelCalls++; } });
  const result = await candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasons[0], 'batch_stop_requested');
  assert.equal(modelCalls, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
});

test('候选恢复只提交checkpoint绑定的原attempt和run，不重调ensureMaterial', async t => {
  const f = await runnerFixture(t);
  const row = f.store.db.prepare('SELECT * FROM candidate').get();
  const root = join(f.dir, 'candidate-private');
  const snapshotRef = join(root, 'recovery.json');
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });
  await writeFile(snapshotRef, JSON.stringify({ candidate_id: row.candidate_id, batch_id: f.batch.batch_id, phase: 'collecting', attempt_id: 'attempt-exact', original_run_id: 'run-exact', source_evidence_ref: row.source_evidence_ref }));
  const snapshotHash = createHash('sha256').update(await readFile(snapshotRef)).digest('hex');
  f.store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,output_hash,committed_at)
    VALUES('checkpoint-recovery','owner','run-coordinator',0,?,?,?,?,'2026-10-23')`).run(f.batch.batch_id, `candidates:${f.batch.batch_id}:${row.candidate_id}`, JSON.stringify([{ snapshot_ref: snapshotRef, hash: snapshotHash }]), snapshotHash);
  let committed = 0, ensureCalls = 0, received = null;
  const collector = {
    async claim() { return { owner: f.owner, runId: 'run-reconcile', generation: 2 }; },
    async recover() { throw Error('slot should be stopped'); },
    async commitReceipt(attemptId, input) { committed++; received = { attemptId, input }; return { status: 'succeeded', material_version_id: 'material-recovered', evidence_refs: ['file:receipt'] }; },
    async ensureMaterial() { ensureCalls++; throw Error('must not repeat source collection'); },
    async release() {},
  };
  const candidates = createCandidates({ store: f.store, root, owner: f.owner, collector, analyzer: { async currentPreference() { return null; }, async run() {} } });
  const result = await candidates.recover({ batchId: f.batch.batch_id, candidateId: row.candidate_id, attemptId: 'attempt-exact', confirmedStoppedRunId: 'run-exact', evidenceRef: 'process:verified-stopped' });
  assert.equal(result.status, 'succeeded');
  assert.equal(committed, 1);
  assert.equal(ensureCalls, 0);
  assert.equal(received.attemptId, 'attempt-exact');
  assert.equal(received.input.originalRunId, 'run-exact');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM collection_observation').get().n, 0);
});

test('selection额度失败只能精确resolve原attempt并保留失败receipt', async t => {
  const f = await runnerFixture(t);
  const row = f.store.db.prepare('SELECT * FROM candidate').get();
  const root = join(f.dir, 'candidate-private'), attempt = 'attempt-quota', run = 'run-quota';
  const attemptDir = join(root, 'candidates', f.batch.batch_id, row.candidate_id, attempt);
  await mkdir(attemptDir, { recursive: true });
  const receiptRef = join(attemptDir, 'receipt.json');
  await writeFile(receiptRef, JSON.stringify({ kind: 'selection', attempt_id: attempt, run_id: run, input_hash: 'a'.repeat(64), exitCode: 1, stderr: 'quota exhausted' }));
  const snapshot = { batch_id: f.batch.batch_id, candidate_id: row.candidate_id, attempt_id: attempt, attempt_dir: attemptDir,
    input_hash: 'a'.repeat(64), phase: 'selection_failed', selection_run: run, parent_pid: -1 };
  const snapshotRef = join(root, 'selection-failed.json');
  await writeFile(snapshotRef, JSON.stringify(snapshot));
  const hash = createHash('sha256').update(await readFile(snapshotRef)).digest('hex');
  f.store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,output_hash,committed_at)
    VALUES('checkpoint-selection-failed',?,'run-coordinator',0,?,?,?,?,'2026-10-23')`).run(f.owner, f.batch.batch_id,
    `candidates:${f.batch.batch_id}:${row.candidate_id}`, JSON.stringify([{ snapshot_ref: snapshotRef, hash }]), hash);
  const candidates = createCandidates({ store: f.store, root, owner: f.owner, collector: {}, analyzer: { async currentPreference() { return null; }, async run() {} } });
  const resolved = await candidates.recover({ batchId: f.batch.batch_id, candidateId: row.candidate_id, attemptId: attempt,
    confirmedStoppedRunId: run, evidenceRef: 'process:quota-failure-confirmed-stopped' });
  assert.equal(resolved.phase, 'selection_resolved_failed');
  assert.equal((await readFile(receiptRef, 'utf8')).includes('quota exhausted'), true);
  const latest = f.store.db.prepare("SELECT succeeded_refs_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1").get(`candidates:${f.batch.batch_id}:${row.candidate_id}`);
  const saved = JSON.parse(await readFile(JSON.parse(latest.succeeded_refs_json)[0].snapshot_ref, 'utf8'));
  assert.equal(saved.attempt_id, attempt);
  assert.equal(saved.phase, 'selection_resolved_failed');
});

test('最新候选checkpoint损坏时不静默回退到更旧attempt', async t => {
  const f = await runnerFixture(t);
  const row = f.store.db.prepare('SELECT * FROM candidate').get();
  const root = join(f.dir, 'candidate-private'), oldRef = join(root, 'old.json'), brokenRef = join(root, 'broken.json');
  await mkdir(root, { recursive: true });
  await writeFile(oldRef, JSON.stringify({ batch_id: f.batch.batch_id, candidate_id: row.candidate_id, phase: 'selection_failed', attempt_id: 'old-attempt' }));
  await writeFile(brokenRef, JSON.stringify({ batch_id: f.batch.batch_id, candidate_id: row.candidate_id, phase: 'selection_failed', attempt_id: 'new-attempt' }));
  const oldHash = createHash('sha256').update(await readFile(oldRef)).digest('hex');
  const brokenHash = createHash('sha256').update(await readFile(brokenRef)).digest('hex');
  const insert = f.store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,output_hash,committed_at) VALUES(?,?,'run',0,?,?,?,?,'2026-10-23')`);
  insert.run('old-checkpoint', f.owner, f.batch.batch_id, `candidates:${f.batch.batch_id}:${row.candidate_id}`, JSON.stringify([{ snapshot_ref: oldRef, hash: oldHash }]), oldHash);
  insert.run('new-checkpoint', f.owner, f.batch.batch_id, `candidates:${f.batch.batch_id}:${row.candidate_id}`, JSON.stringify([{ snapshot_ref: brokenRef, hash: 'wrong-hash' }]), brokenHash);
  const candidates = createCandidates({ store: f.store, root, owner: f.owner, collector: {}, analyzer: { async currentPreference() { return null; }, async run() {} } });
  await assert.rejects(candidates.recover({ batchId: f.batch.batch_id, candidateId: row.candidate_id, attemptId: 'old-attempt',
    confirmedStoppedRunId: 'run', evidenceRef: 'process:stopped' }), /latest candidate checkpoint is unverifiable/);
});
