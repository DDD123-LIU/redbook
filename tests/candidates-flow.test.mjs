import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, saveContent, saveMaterialVersion } from '../src/storage.mjs';
import { createHomefeed } from '../src/homefeed.mjs';
import { createCandidates } from '../src/candidates.mjs';
import { createAnalyzer } from '../src/analysis.mjs';
import { prepareExplicitPreference } from '../src/preference.mjs';
import { createQuality, readCurrentStrategy } from '../src/quality.mjs';

async function fixture(t, { count = 1, kind = 'daily_follow', analyzeCandidates = true, incompleteCandidate = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-flow-'));
  const store = openStore(join(dir, 'state.sqlite'));
  const owner = 'owner';
  const homefeed = createHomefeed({ store, root: join(dir, 'feed'), owner, now: () => '2026-10-23T04:00:00.000Z' });
  const batch = homefeed.beginBatch(kind === 'daily_follow' ? { kind } : { kind, explicitRequest: true, commandId: `cmd-${kind}` });
  const ids = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(24, '0'));
  if (count) await homefeed.recordPage(batch.batch_id, { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T04:00:00Z', page_state: 'ready',
    observations: ids.map((id, i) => ({ content_id: id, complete_source_url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=token-${i}` })), anchor_id: ids.at(-1), advanced: true, read_method: 'synthetic' });
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });

  const writeMaterial = async (contentId, key, body) => {
    const bodyRef = join(dir, `${key}.txt`);
    await writeFile(bodyRef, body);
    return saveMaterialVersion(store, { content_id: contentId, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete' }).entity_id;
  };
  const baselineContent = saveContent(store, { platform: 'xiaohongshu', content_id: 'f'.repeat(24), source_state: 'available' }).entity_id;
  const baselineMaterial = await writeMaterial(baselineContent, 'baseline', '旧流程：直接生成结果。');
  store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,total_count,total_known,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('baseline-batch', '2026-10-23', '2026-10-23', '{}', 1, 1, '[]', '2026-10-23');
  store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,observed_at,membership,evidence_ref,collected_at,coverage_ref) VALUES(?,?,?,?,?,?,?,?)`)
    .run('baseline-observation', 'baseline-batch', baselineContent, '2026-10-23T04:00:00Z', 'present', 'test:baseline', '2026-10-23T04:00:00Z', null);

  const candidateMaterials = [];
  const contentRows = store.db.prepare('SELECT content_id,source_content_id FROM content WHERE source_content_id=?');
  for (let i = 0; i < ids.length; i++) {
    const row = contentRows.get(ids[i]);
    const bodyRef = join(dir, `candidate-${i}.txt`);
    const body = `新增步骤${i + 1}：先验证素材，再生成结果。`;
    await writeFile(bodyRef, body);
    const materialInput = { content_id: row.content_id, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete' };
    if (incompleteCandidate && i === 0) Object.assign(materialInput, { media_kind: 'image', completeness: 'partial',
      ordered_images: [{ index: 0, path: join(dir, 'missing-image.png'), hash: 'a'.repeat(64) }] });
    candidateMaterials.push({ id: ids[i], contentId: row.content_id, bodyRef, body,
      materialId: saveMaterialVersion(store, materialInput).entity_id });
  }
  let preferenceOutput;
  const analyzerModel = async args => {
    if (args.kind === 'analysis') {
      const input = args.input;
      await writeFile(args.outputPath, JSON.stringify({ id: input.source_content_id, summary: '合成分析', images: [],
        direct_evidence: [{ source: 'body', index: null, quote: input.body }], inferences: [], actionable: ['新增步骤'], uncertainties: ['局部样本'], media_scope: input.media_scope }));
    } else {
      preferenceOutput = { hypotheses: [{ topic: '步骤', supporting_analysis_ids: args.input.analyses.map(x => x.analysis_id),
        claim: '关注可核查步骤', confidence: 'medium', alternatives: ['合成数据'], long_term: false }], counterexamples: [], limitations: ['合成局部样本'] };
      await writeFile(args.outputPath, JSON.stringify(preferenceOutput));
    }
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };
  const analyzer = createAnalyzer({ store, root: join(dir, 'analysis'), owner, model: analyzerModel });
  const baselineSeed = await analyzer.run({ batchKey: 'seed-baseline', materialIds: [baselineMaterial] });
  assert.equal(baselineSeed.status, 'succeeded', JSON.stringify({ baselineSeed, preferenceOutput }));
  if (analyzeCandidates && candidateMaterials.length) assert.equal((await analyzer.run({ batchKey: 'seed-candidate', materialIds: candidateMaterials.map(x => x.materialId), summarize: false })).status, 'succeeded');

  let selectionCalls = 0;
  let selectionBehavior = null;
  const selectionModel = async args => {
    selectionCalls++;
    const behavior = selectionBehavior?.(args, selectionCalls);
    if (behavior) return behavior;
    const quote = args.payload.candidate_analysis.direct_evidence[0].quote;
    const baseline = args.payload.baseline.items[0];
    const isExplore = args.payload.request.category === 'explore';
    const explicitRequest = args.payload.request.explicit_request;
    const instructions = [...(args.payload.preference.explicit_instructions ?? []), ...(explicitRequest ? [explicitRequest] : []), ...(isExplore ? [args.payload.request.direction] : [])];
    const proposal = { relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote,
      hypothesis_indexes: isExplore ? [] : [0], explicit_request_quote: isExplore ? args.payload.request.direction : null },
      gain_state: 'gain', compared_candidate_refs: [0], compared_material_ids: [baseline.material_version_id],
      comparisons: [{ baseline_material_id: baseline.material_version_id, candidate_evidence_ref: 0, candidate_quote: quote,
        baseline_quote: baseline.direct_evidence[0].quote, relationship: 'adds', added_kind: 'steps', explanation: '候选提供了可核查的新步骤。' }],
      explicit_instruction_assessment: instructions.map(instruction => ({ instruction_quote: instruction, relation: 'support', evidence_index: 0, evidence_quote: quote })) };
    await writeFile(args.outputPath, JSON.stringify(proposal));
    return { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
  };
  let ensureMaterialCalls = 0;
  const collector = {
    async claim() { return { owner, runId: randomUUID(), generation: 1 }; },
    async release() { return { status: 'succeeded' }; },
    async ensureMaterial(sourceId) {
      ensureMaterialCalls++;
      const item = candidateMaterials.find(value => value.id === sourceId);
      if (!item) throw new Error('unexpected synthetic source');
      const current = store.db.prepare("SELECT * FROM material_version WHERE content_id=? AND fetch_status='succeeded' ORDER BY fetched_at DESC,rowid DESC LIMIT 1").get(item.contentId);
      let valid = false;
      try { valid = createHash('sha256').update(await readFile(current.body_ref)).digest('hex') === current.body_hash; } catch { /* 文件缺失将走fixture修复。 */ }
      if (valid) return { status: 'duplicate', material_version_id: current.material_version_id };
      await writeFile(item.bodyRef, item.body);
      const materialId = saveMaterialVersion(store, { content_id: item.contentId, body_ref: item.bodyRef, body: item.body, media_kind: 'text', completeness: 'complete' }).entity_id;
      return { status: 'succeeded', material_version_id: materialId };
    },
  };
  const candidates = createCandidates({ store, root: join(dir, 'candidate-private'), owner, collector, analyzer, model: selectionModel, now: () => '2026-10-23T04:00:00.000Z' });
  return { dir, store, owner, batch, ids, candidateMaterials, baselineMaterial, analyzer, collector, candidates,
    get ensureMaterialCalls() { return ensureMaterialCalls; },
    get selectionCalls() { return selectionCalls; }, set selectionBehavior(value) { selectionBehavior = value; } };
}

test('人工偏好沿有效模型父版进入候选筛选，不要求伪造新模型完成回执', async t => {
  const f = await fixture(t);
  const event = { app_ref:'synthetic-app', chat_ref:'synthetic-chat', event_id:randomUUID(), text:'修改偏好：关注可核查步骤', created_at:'2026-10-23T04:01:00Z' };
  const prepared = prepareExplicitPreference({ store:f.store,root:f.dir,owner:f.owner,event,operation:{kind:'append',instruction:'关注可核查步骤'} });
  f.store.transaction(()=>{
    f.store.db.prepare("INSERT INTO feedback_event(app_ref,chat_ref,event_id,received_at,saved_at,parse_state,association_state) VALUES(?,?,?,?,?,'parsed','unmatched')").run(event.app_ref,event.chat_ref,event.event_id,event.created_at,event.created_at);
    prepared.publish();
  });
  const result = await f.candidates.run({batchId:f.batch.batch_id});
  assert.equal(result.eligible.length,1,JSON.stringify(result.held));
  assert.equal(result.versions.preference_version,prepared.preference_version);
  assert.equal(f.selectionCalls,1);
});

test('配额中断停止后续候选；精确恢复后复用已完成项，只重试未完成项', async t => {
  const f = await fixture(t, { count: 3 });
  f.selectionBehavior = (_args, call) => call === 2 ? { exitCode: 1, stdout: '{"type":"turn.failed"}', stderr: 'usage_limit_reached' } : null;
  const first = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(first.status, 'unknown');
  assert.equal(first.eligible.length, 1);
  assert.equal(f.selectionCalls, 2);
  const failed = first.held.find(x => x.reason === 'selection_not_verified');
  assert.ok(failed?.attempt_id && failed?.run_id);
  assert.ok(first.pending.some(x => x.reason === 'run_stopped'));
  const checkpoint = f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND delivery_batch_id=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, f.batch.batch_id, `candidates:${f.batch.batch_id}:${failed.candidate_id}`);
  const checkpointRef = JSON.parse(checkpoint.succeeded_refs_json)[0];
  const checkpointSnapshot = JSON.parse(await readFile(checkpointRef.snapshot_ref, 'utf8'));
  assert.equal(checkpointSnapshot.candidate_id, failed.candidate_id, JSON.stringify({ failed, checkpointSnapshot }));
  assert.equal(checkpointSnapshot.batch_id, f.batch.batch_id, JSON.stringify({ failed, checkpointSnapshot, batch: f.batch }));

  await f.candidates.recover({ batchId: f.batch.batch_id, candidateId: failed.candidate_id, attemptId: failed.attempt_id,
    confirmedStoppedRunId: failed.run_id, evidenceRef: 'process:quota-run-confirmed-stopped' });
  f.selectionBehavior = null;
  const resumed = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(resumed.eligible.length, 3);
  assert.equal(f.selectionCalls, 4, '第一个已完成项不得重跑，失败项只补一次，后续项正常处理');
});

test('偏好与active策略变化只重筛，不重跑已经核验的正文分析', async t => {
  const f = await fixture(t, { count: 1 });
  await f.candidates.run({ batchId: f.batch.batch_id });
  const analysesBefore = f.store.db.prepare('SELECT count(*) n FROM analysis').get().n;
  await f.analyzer.run({ batchKey: 'preference-change', materialIds: [f.baselineMaterial], explicitInstructions: ['优先步骤清楚的内容'] });
  const afterPreference = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(afterPreference.eligible.length, 1);
  f.store.db.prepare(`INSERT INTO strategy_version(strategy_version,parent_version,rule_diff_json,evidence_refs_json,preference_version,state,effective_at,created_at)
    VALUES('strategy-v2',?,'{}','[]',NULL,'active','2026-10-23','2026-10-23')`).run(afterPreference.versions.strategy_version);
  const afterStrategy = await f.candidates.run({ batchId: f.batch.batch_id, strategyVersion: 'strategy-v2' });
  assert.equal(afterStrategy.eligible.length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM analysis').get().n, analysesBefore);
  assert.equal(f.selectionCalls, 3, '旧decision按版本保留，新版本各重筛一次');
});

test('selection receipt在decision提交前中断后可恢复且不重复调用模型', async t => {
  const f = await fixture(t, { count: 1 });
  const original = f.store.transaction.bind(f.store);
  let afterModel = false;
  let transactionsAfterModel = 0;
  f.store.transaction = callback => {
    if (afterModel && ++transactionsAfterModel === 2) throw new Error('simulated interruption before decision commit');
    return original(callback);
  };
  f.selectionBehavior = () => { afterModel = true; return null; };
  let interrupted = false;
  // 模型输出已落盘；在selection成功checkpoint之后、decision事务之前模拟进程中断。
  try {
    await f.candidates.run({ batchId: f.batch.batch_id });
  } catch (error) {
    interrupted = /simulated interruption/.test(error.message);
  }
  f.store.transaction = original;
  assert.equal(interrupted, true);
  assert.equal(f.selectionCalls, 1);
  const resumed = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(resumed.eligible.length, 1);
  assert.equal(f.selectionCalls, 1);
});

test('selection返回后批次停止或策略失效时不提交decision', async t => {
  const f = await fixture(t, { count: 1 });
  f.selectionBehavior = () => { f.store.db.prepare('UPDATE batch SET stop_requested=1,revision=revision+1 WHERE delivery_batch_id=?').run(f.batch.batch_id); return null; };
  const stopped = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(stopped.status, 'blocked');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
});

test('decision事务内发现014策略头已切换时不提交旧结果', async t => {
  const f = await fixture(t, { count: 1 });
  const at = '2026-10-23T04:00:00.000Z';
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => at });
  const originalTransaction = f.store.transaction.bind(f.store);
  let armed = false;
  let postSelectionTransactions = 0;
  f.store.transaction = callback => {
    if (armed && ++postSelectionTransactions === 2) {
      armed = false;
      const current = readCurrentStrategy(f.store, f.owner, at);
      quality.activateStrategy({ strategy_version: randomUUID(), parent_version: current.strategy_version,
        rules: ['提交前切版'], rule_diff: { added: ['提交前切版'] }, evidence_refs: ['synthetic:decision-race'],
        preference_version: current.preference_version, incident_bindings: [] });
    }
    return originalTransaction(callback);
  };
  f.selectionBehavior = () => { armed = true; return null; };

  const result = await f.candidates.run({ batchId: f.batch.batch_id });

  assert.equal(postSelectionTransactions, 2);
  assert.equal(result.status, 'blocked');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM decision').get().n, 0);
  assert.ok(result.held.some(item => item.reason === 'candidate_context_changed_before_commit'));
});

test('claim后重读selection缓存，避免重复调用模型', async t => {
  const f = await fixture(t, { count: 1 });
  await f.candidates.run({ batchId: f.batch.batch_id });
  const prepare = f.store.db.prepare.bind(f.store.db);
  let hidden = true;
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (hidden && sql.includes('FROM decision d JOIN candidate c')) {
      hidden = false;
      return { all: () => [], get: statement.get.bind(statement), run: statement.run.bind(statement) };
    }
    return statement;
  };
  const result = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.eligible.length, 1);
  assert.equal(f.selectionCalls, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 1);
});

test('零候选和不足目标都明确报告缺额；旧closed日批不执行筛选', async t => {
  const empty = await fixture(t, { count: 0 });
  const noCandidates = await empty.candidates.run({ batchId: empty.batch.batch_id });
  assert.equal(noCandidates.status, 'partial');
  assert.ok(noCandidates.held.some(x => x.reason === 'no_stored_candidates'));

  const short = await fixture(t, { count: 1 });
  const result = await short.candidates.run({ batchId: short.batch.batch_id });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.shortfall, 19);
  short.store.db.prepare("UPDATE batch SET status='closed_day',revision=revision+1 WHERE delivery_batch_id=?").run(short.batch.batch_id);
  const calls = short.selectionCalls;
  const oldDay = await short.candidates.run({ batchId: short.batch.batch_id });
  assert.ok(oldDay.reasons.includes('batch_day_closed'), JSON.stringify(oldDay));
  assert.equal(short.selectionCalls, calls);
  assert.equal(short.store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'eligible');
});

test('分析失败和候选媒体不完整均hold且不产生decision', async t => {
  const failed = await fixture(t, { count: 1, analyzeCandidates: false });
  const originalRun = failed.analyzer.run.bind(failed.analyzer);
  failed.analyzer.run = async options => options.materialIds.includes(failed.candidateMaterials[0].materialId)
    ? { status: 'failed' } : originalRun(options);
  const analysisFailure = await failed.candidates.run({ batchId: failed.batch.batch_id });
  assert.ok(analysisFailure.held.some(x => x.reason === 'analysis_failed'));
  assert.equal(failed.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);

  const incomplete = await fixture(t, { count: 1, incompleteCandidate: true });
  const result = await incomplete.candidates.run({ batchId: incomplete.batch.batch_id });
  assert.ok(result.held.some(x => x.reason === 'candidate_media_input_incomplete'));
  assert.equal(incomplete.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
});

test('媒体hold与checkpoint事务持久化；重启读取原因和报告且不新增采集/分析attempt', async t => {
  const f = await fixture(t, { count: 1, incompleteCandidate: true });
  const materialId = f.candidateMaterials[0].materialId;
  let candidateAnalysisCalls = 0;
  const originalRun = f.analyzer.run.bind(f.analyzer);
  f.analyzer.run = async options => {
    if (options.materialIds.includes(materialId)) candidateAnalysisCalls++;
    return originalRun(options);
  };
  const first = await f.candidates.run({ batchId: f.batch.batch_id });
  const firstHold = first.held.find(item => item.reason === 'candidate_media_input_incomplete');
  assert.ok(firstHold?.hold_ref);
  assert.equal(f.store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'hold');
  const savedHold = JSON.parse(await readFile(firstHold.hold_ref, 'utf8'));
  assert.equal(savedHold.phase, 'analysis_held');
  assert.equal(savedHold.batch_id, f.batch.batch_id);
  assert.equal(savedHold.candidate_id, firstHold.candidate_id);
  assert.equal(savedHold.reason, firstHold.reason);
  assert.equal(savedHold.material_version_id, materialId);
  assert.equal(typeof savedHold.analysis_id, 'string');
  assert.ok(savedHold.analysis_output_ref);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  const report = JSON.parse(await readFile(first.report_ref, 'utf8'));
  assert.equal(report.held[0].reason, 'candidate_media_input_incomplete');
  const batchCheckpoint = f.store.db.prepare('SELECT succeeded_refs_json,output_hash FROM checkpoint WHERE owner=? AND delivery_batch_id=? AND stage=? ORDER BY rowid DESC LIMIT 1')
    .get(f.owner, f.batch.batch_id, `candidates:${f.batch.batch_id}`);
  const reportRef = JSON.parse(batchCheckpoint.succeeded_refs_json)[0];
  assert.equal(createHash('sha256').update(await readFile(reportRef.snapshot_ref)).digest('hex'), batchCheckpoint.output_hash);
  const collectCalls = f.ensureMaterialCalls;
  const analysisCalls = candidateAnalysisCalls;

  const resumed = await f.candidates.run({ batchId: f.batch.batch_id });
  const resumedHold = resumed.held.find(item => item.reason === 'candidate_media_input_incomplete');
  assert.ok(resumedHold?.hold_ref);
  assert.equal(await readFile(resumedHold.hold_ref, 'utf8'), await readFile(firstHold.hold_ref, 'utf8'));
  assert.equal(f.ensureMaterialCalls, collectCalls);
  assert.equal(candidateAnalysisCalls, analysisCalls);
  assert.equal(f.selectionCalls, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.ok(await readFile(resumed.report_ref, 'utf8'));
});

test('材料hash损坏时先触发精确修复并复用匹配的分析缓存', async t => {
  const f = await fixture(t, { count: 1 });
  const original = f.candidateMaterials[0];
  await import('node:fs/promises').then(fs => fs.rm(original.bodyRef));
  const before = f.store.db.prepare('SELECT count(*) n FROM analysis').get().n;
  const result = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.eligible.length, 1);
  const newest = f.store.db.prepare("SELECT material_version_id,body_hash FROM material_version WHERE content_id=? AND fetch_status='succeeded' ORDER BY fetched_at DESC,rowid DESC LIMIT 1").get(original.contentId);
  assert.equal(newest.material_version_id, original.materialId);
  assert.equal(createHash('sha256').update(await readFile(original.bodyRef)).digest('hex'), newest.body_hash);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM analysis').get().n, before);
});

test('基线按修复根去重并选用同根有效修复版本', async t => {
  const f = await fixture(t, { count: 1 });
  const root = f.store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(f.baselineMaterial);
  const repairRef = join(f.dir, 'baseline-repair.txt');
  await writeFile(repairRef, '旧流程：直接生成结果。');
  const repair = saveMaterialVersion(f.store, { content_id: root.content_id, body_ref: repairRef, body: '旧流程：直接生成结果。',
    media_kind: 'text', completeness: 'complete', repair_of_material_version_id: f.baselineMaterial });
  assert.equal(repair.status, 'succeeded');
  assert.equal((await f.analyzer.run({ batchKey: 'seed-baseline-repair', materialIds: [repair.entity_id], summarize: false })).status, 'succeeded');
  await import('node:fs/promises').then(fs => fs.rm(root.body_ref));

  const result = await f.candidates.run({ batchId: f.batch.batch_id });
  assert.equal(result.eligible.length, 1, JSON.stringify(result));
  const roots = f.store.db.prepare(`SELECT count(*) n FROM material_version WHERE content_id=? AND repair_of_material_version_id IS NULL AND fetch_status='succeeded'`).get(root.content_id);
  assert.equal(roots.n, 1);
  const baseline = f.store.db.prepare('SELECT material_version_ids_json,coverage_description FROM baseline_version ORDER BY rowid DESC LIMIT 1').get();
  assert.deepEqual(JSON.parse(baseline.material_version_ids_json), [repair.entity_id]);
  const coverage = JSON.parse(baseline.coverage_description).coverage;
  assert.equal(coverage.observed_material_count, 1);
  assert.equal(coverage.input_complete, true);
  assert.deepEqual(coverage.missing_material_ids, []);
  assert.ok(await readFile(repairRef, 'utf8'));
});

test('explore需显式请求且隔离关注类别；损坏selection input/output不能命中缓存', async t => {
  const explore = await fixture(t, { count: 1, kind: 'explore' });
  await assert.rejects(explore.candidates.run({ batchId: explore.batch.batch_id }), /explicit request and direction/);
  const explicit = await explore.candidates.run({ batchId: explore.batch.batch_id, explicitRequest: '请找一个不同图像工作流工具', direction: '新图像工作流' });
  assert.equal(explicit.eligible.length, 1);
  assert.equal(explicit.request_type, 'explore');
  assert.equal(explore.store.db.prepare("SELECT count(*) n FROM decision WHERE category='follow'").get().n, 0);

  const normal = await fixture(t, { count: 1 });
  await normal.candidates.run({ batchId: normal.batch.batch_id });
  const refs = JSON.parse(normal.store.db.prepare('SELECT comparison_refs_json FROM decision').get().comparison_refs_json);
  const inputRef = refs.find(x => x.endsWith('input.json'));
  const outputRef = refs.find(x => x.endsWith('output.json'));
  await writeFile(inputRef, '{}');
  await normal.candidates.run({ batchId: normal.batch.batch_id });
  assert.equal(normal.selectionCalls, 2);
  const newest = normal.store.db.prepare('SELECT comparison_refs_json FROM decision ORDER BY rowid DESC LIMIT 1').get();
  const freshOutput = JSON.parse(newest.comparison_refs_json).find(x => x.endsWith('output.json'));
  await writeFile(freshOutput, '{}');
  await normal.candidates.run({ batchId: normal.batch.batch_id });
  assert.equal(normal.selectionCalls, 3);
  assert.ok(await readFile(outputRef, 'utf8'));
});

test('先eligible后偏好失效、策略inactive或来源证据损坏会持久hold且重启不调用外部阶段', async t => {
  const cases = [
    ['current_preference_unverified', async f => { f.analyzer.currentPreference = async () => null; }],
    ['strategy_inactive', async () => ({ strategyVersion: 'unconfigured-inactive-version' })],
    ['source_evidence_invalid', async f => {
      const candidate = f.store.db.prepare('SELECT source_evidence_ref FROM candidate WHERE discovery_batch_id=?').get(f.batch.batch_id);
      const path = candidate.source_evidence_ref.startsWith('file:') ? candidate.source_evidence_ref.slice(5) : candidate.source_evidence_ref;
      await import('node:fs/promises').then(fs => fs.rm(path));
    }],
  ];
  for (const [reason, invalidate] of cases) {
    const f = await fixture(t, { count: 1 });
    const first = await f.candidates.run({ batchId: f.batch.batch_id });
    assert.equal(first.eligible.length, 1);
    const decisionsBefore = f.store.db.prepare('SELECT count(*) n FROM decision').get().n;
    const externalCalls = { selection: f.selectionCalls, collection: f.ensureMaterialCalls };
    const runOptions = await invalidate(f) ?? {};

    const held = await f.candidates.run({ batchId: f.batch.batch_id, ...runOptions });
    const item = held.held.find(entry => entry.reason === reason);
    assert.ok(item?.outcome_ref, JSON.stringify(held));
    assert.equal(f.store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'hold');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, decisionsBefore, '历史decision保持不变');
    const outcome = JSON.parse(await readFile(item.outcome_ref, 'utf8'));
    assert.equal(outcome.phase, 'candidate_outcome');
    assert.equal(outcome.outcome, 'hold');
    assert.equal(outcome.reason, reason);
    assert.equal(outcome.candidate_id, item.candidate_id);
    assert.equal(outcome.batch_id, f.batch.batch_id);
    assert.ok(outcome.versions);
    const checkpoint = f.store.db.prepare('SELECT succeeded_refs_json,output_hash FROM checkpoint WHERE owner=? AND delivery_batch_id=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(f.owner, f.batch.batch_id, `candidates-outcome:${f.batch.batch_id}:${item.candidate_id}`);
    const ref = JSON.parse(checkpoint.succeeded_refs_json)[0];
    assert.equal(createHash('sha256').update(await readFile(ref.snapshot_ref)).digest('hex'), checkpoint.output_hash);

    const resumed = await f.candidates.run({ batchId: f.batch.batch_id, ...runOptions });
    assert.ok(resumed.held.some(entry => entry.reason === reason));
    assert.equal(f.selectionCalls, externalCalls.selection);
    assert.equal(f.ensureMaterialCalls, externalCalls.collection);
    assert.equal(f.store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'hold');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, decisionsBefore);
  }
});

test('maxCandidates以processing_limit报告全部未处理项；提高上限后复用完成项并续作', async t => {
  const f = await fixture(t, { count: 10 });
  const first = await f.candidates.run({ batchId: f.batch.batch_id, maxCandidates: 2 });
  assert.equal(first.eligible.length, 2);
  assert.equal(first.pending.length, 8);
  assert.ok(first.pending.every(item => item.reason === 'processing_limit'));
  assert.equal(f.selectionCalls, 2);

  const resumed = await f.candidates.run({ batchId: f.batch.batch_id, maxCandidates: 10 });
  assert.equal(resumed.eligible.length, 10);
  assert.equal(resumed.pending.length, 0);
  assert.equal(f.selectionCalls, 10, '已完成的前两项复用decision，只对其余八项筛选');
  assert.equal(f.ensureMaterialCalls, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 10);
});
