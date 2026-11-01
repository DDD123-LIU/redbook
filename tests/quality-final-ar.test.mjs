import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createDelivery } from '../src/delivery.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const { createQuality } = await import('../src/quality.mjs').catch(() => ({}));

const inclusionStart = '2026-10-27T00:00:00.000Z';
const inclusionEnd = '2026-10-27T01:40:00.000Z';
const registeredAt = '2026-10-26T00:00:00.000Z';
const cutoffOffset = 48 * 60 * 60 * 1000;
const scenarioResults = [];



function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function addSuccessfulRecommendation(f, index, { category = 'follow', dispatchedAt, strategyVersion = f.versions.strategy_version,
  materialContext = null, decisionCreatedAt = dispatchedAt } = {}) {
  const db = f.store.db;
  const recommendationId = randomUUID();
  const contentId = materialContext?.contentId ?? randomUUID();
  const sourceContentId = materialContext?.sourceContentId ?? `synthetic-${index}-${randomUUID()}`;
  const materialId = materialContext?.materialId ?? randomUUID();
  const candidateId = materialContext?.candidateId ?? randomUUID();
  const analysisId = materialContext?.analysisId ?? randomUUID();
  const decisionId = randomUUID();
  const attemptId = randomUUID();
  const successAt = new Date(Date.parse(dispatchedAt) + 1000).toISOString();
  const checkpointHash = `synthetic-dispatch-${attemptId}`;

  if (!materialContext) {
    insert(db, 'content', {
      content_id: contentId, platform: 'xiaohongshu', source_content_id: sourceContentId,
      source_state: 'available', last_observed_at: dispatchedAt, created_at: dispatchedAt,
    });
    insert(db, 'material_version', {
      material_version_id: materialId, content_id: contentId, media_kind: 'text', fetched_at: dispatchedAt,
      material_hash: `material-${materialId}`, completeness: 'complete', fetch_status: 'succeeded',
    });
    insert(db, 'analysis', {
      analysis_id: analysisId, material_version_id: materialId, input_hash: `input-${analysisId}`,
      prompt_version: 'synthetic', model_requested: 'synthetic', status: 'complete', created_at: dispatchedAt,
    });
    insert(db, 'candidate', {
      candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId,
      source: 'homefeed', discovered_at: dispatchedAt, source_evidence_ref: `synthetic:candidate:${index}`,
      eligibility_state: 'eligible',
    });
  }
  insert(db, 'decision', {
    decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId,
    baseline_version: f.versions.baseline_version, preference_version: f.versions.preference_version,
    strategy_version: strategyVersion, category, relevance: 'matched', gain_state: 'gain',
    result: 'eligible', created_at: decisionCreatedAt,
  });
  insert(db, 'recommendation', {
    recommendation_id: recommendationId, content_id: contentId, delivery_batch_id: f.batchId,
    decision_id: decisionId, category, actual_preference_version: f.versions.preference_version,
    actual_strategy_version: strategyVersion, state: 'succeeded', first_success_at: successAt,
    revision: 1, created_at: dispatchedAt, updated_at: successAt,
  });
  insert(db, 'entity_state_history', {
    entity_type: 'recommendation', entity_id: recommendationId, old_state: 'pending', new_state: 'succeeded',
    revision: 1, changed_at: successAt,
  });
  insert(db, 'delivery_attempt', {
    delivery_attempt_id: attemptId, recommendation_id: recommendationId, target_ref: 'synthetic-chat',
    payload_hash: `payload-${attemptId}`, intent_at: dispatchedAt, dispatched_at: dispatchedAt,
    returned_at: successAt, message_id: `synthetic-message-${index}`, status: 'succeeded',
    verification_evidence_refs_json: JSON.stringify([`synthetic:receipt:${index}`]),
    created_at: successAt, updated_at: successAt,
  });
  insert(db, 'delivered_content', {
    owner: f.owner, platform: 'xiaohongshu', source_content_id: sourceContentId,
    recommendation_id: recommendationId, first_success_at: successAt,
  });
  insert(db, 'checkpoint', {
    checkpoint_id: randomUUID(), owner: f.owner, run_id: 'synthetic-quality-run', generation: 0,
    delivery_batch_id: f.batchId, stage: `delivery-attempt:${attemptId}`,
    succeeded_refs_json: JSON.stringify([{ ref: `synthetic:dispatch:${attemptId}`, hash: checkpointHash }]),
    output_hash: checkpointHash, committed_at: dispatchedAt,
  });
  return { recommendationId, contentId, sourceContentId, attemptId, dispatchedAt, successAt,
    candidateId, analysisId, materialId, decisionId };
}

function addUnrecommendedMaterial(f, { index, discoveredAt }) {
  const db = f.store.db;
  const contentId = randomUUID();
  const sourceContentId = `synthetic-rescreen-${index}-${randomUUID()}`;
  const materialId = randomUUID();
  const analysisId = randomUUID();
  const candidateId = randomUUID();
  insert(db, 'content', { content_id: contentId, platform: 'xiaohongshu', source_content_id: sourceContentId,
    source_state: 'available', last_observed_at: discoveredAt, created_at: discoveredAt });
  insert(db, 'material_version', { material_version_id: materialId, content_id: contentId, media_kind: 'text',
    fetched_at: discoveredAt, material_hash: `material-${materialId}`, completeness: 'complete', fetch_status: 'succeeded' });
  insert(db, 'analysis', { analysis_id: analysisId, material_version_id: materialId, input_hash: `input-${analysisId}`,
    prompt_version: 'synthetic', model_requested: 'synthetic', status: 'complete', created_at: discoveredAt });
  insert(db, 'candidate', { candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId,
    source: 'homefeed', discovered_at: discoveredAt, source_evidence_ref: `synthetic:rescreen:${index}`,
    eligibility_state: 'eligible' });
  return { contentId, sourceContentId, materialId, analysisId, candidateId };
}

function addAttemptOutcome(f, { category = 'follow', status, dispatchedAt }) {
  const member = addPendingRecommendation(f, { category, dispatchedAt });
  const db = f.store.db;
  const attemptId = randomUUID();
  const checkpointHash = `synthetic-${status}-${attemptId}`;
  insert(db, 'delivery_attempt', {
    delivery_attempt_id: attemptId, recommendation_id: member.recommendationId, target_ref: 'synthetic-chat',
    payload_hash: `payload-${attemptId}`, intent_at: dispatchedAt, dispatched_at: dispatchedAt,
    status, query_evidence_refs_json: JSON.stringify([`synthetic:${status}:${attemptId}`]),
    verification_evidence_refs_json: JSON.stringify([`synthetic:${status}:${attemptId}`]),
    created_at: dispatchedAt, updated_at: dispatchedAt,
  });
  insert(db, 'checkpoint', {
    checkpoint_id: randomUUID(), owner: f.owner, run_id: 'synthetic-quality-run', generation: 0,
    delivery_batch_id: f.batchId, stage: `delivery-attempt:${attemptId}`,
    succeeded_refs_json: JSON.stringify([{ ref: `synthetic:${status}:${attemptId}`, hash: checkpointHash }]),
    output_hash: checkpointHash, committed_at: dispatchedAt,
  });
  return { ...member, attemptId };
}

function addPendingRecommendation(f, { category = 'follow', dispatchedAt }) {
  const db = f.store.db;
  const recommendationId = randomUUID();
  const contentId = randomUUID();
  const sourceContentId = `pending-${randomUUID()}`;
  const materialId = randomUUID();
  const candidateId = randomUUID();
  const analysisId = randomUUID();
  const decisionId = randomUUID();
  insert(db, 'content', {
    content_id: contentId, platform: 'xiaohongshu', source_content_id: sourceContentId,
    source_state: 'available', last_observed_at: dispatchedAt, created_at: dispatchedAt,
  });
  insert(db, 'material_version', {
    material_version_id: materialId, content_id: contentId, media_kind: 'text', fetched_at: dispatchedAt,
    material_hash: `material-${materialId}`, completeness: 'complete', fetch_status: 'succeeded',
  });
  insert(db, 'analysis', {
    analysis_id: analysisId, material_version_id: materialId, input_hash: `input-${analysisId}`,
    prompt_version: 'synthetic', model_requested: 'synthetic', status: 'complete', created_at: dispatchedAt,
  });
  insert(db, 'candidate', {
    candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId,
    source: 'homefeed', discovered_at: dispatchedAt, source_evidence_ref: `synthetic:candidate:${recommendationId}`,
    eligibility_state: 'eligible',
  });
  insert(db, 'decision', {
    decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId,
    baseline_version: f.versions.baseline_version, preference_version: f.versions.preference_version,
    strategy_version: f.versions.strategy_version, category, relevance: 'matched', gain_state: 'gain',
    result: 'eligible', created_at: dispatchedAt,
  });
  insert(db, 'recommendation', {
    recommendation_id: recommendationId, content_id: contentId, delivery_batch_id: f.batchId,
    decision_id: decisionId, category, actual_preference_version: f.versions.preference_version,
    actual_strategy_version: f.versions.strategy_version, state: 'pending', revision: 0,
    created_at: dispatchedAt, updated_at: dispatchedAt,
  });
  return { recommendationId, contentId, sourceContentId };
}

function saveFeedback(f, member, value, savedAt, revision) {
  const db = f.store.db;
  const eventId = randomUUID();
  const event = {
    app_ref: 'synthetic-app', chat_ref: 'synthetic-chat', event_id: eventId,
    recommendation_id: member.recommendationId, content_id: member.contentId,
    value, received_at: savedAt, saved_at: savedAt, revision, parse_state: 'parsed', association_state: 'matched',
  };
  insert(db, 'feedback_event', event);
  insert(db, 'feedback_history', {
    owner: f.owner, app_ref: event.app_ref, chat_ref: event.chat_ref, platform: 'xiaohongshu',
    source_content_id: member.sourceContentId, content_id: member.contentId,
    recommendation_id: member.recommendationId, value, revision, event_id: eventId, saved_at: savedAt,
  });
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function reports(f, sampleId) {
  return f.store.db.prepare(`SELECT report_revision_id,parent_report_revision_id,event_revision,snapshot_json
    FROM report_revision WHERE sample_id=? ORDER BY rowid`).all(sampleId).map(row => ({
    ...row, snapshot: JSON.parse(row.snapshot_json),
  }));
}

function captureScenario(name, f, sampleId, input, expected, result) {
  const saved = reports(f, sampleId);
  scenarioResults.push({
    name, input, expected,
    actual: {
      metrics: result.metrics,
      qualification: result.qualification,
      blockers: result.blockers,
      report_revision_ids: saved.map(report => report.report_revision_id),
      report_views: saved.map(report => ({
        report_revision_id: report.report_revision_id,
        view: report.snapshot.view,
        metrics: report.snapshot.metrics,
        qualification: report.snapshot.qualification,
        cutoff_at: report.snapshot.cutoff_at,
      })),
    },
  });
}

function createTestContext(t, { target = 100, batchTarget = 1, category = 'follow', includedUntil = inclusionEnd } = {}) {
  return deliveryFixture(t, { target: batchTarget, businessDay: '2026-10-27' }).then(f => {
    let now = registeredAt;
    const quality = createQuality({ store: f.store, owner: f.owner, now: () => now });
    const sampleId = randomUUID();
    quality.registerSample({
      sample_id: sampleId, purpose: 'initial', category, included_from: inclusionStart,
      included_until: includedUntil, target_total: target, strategy_version: f.versions.strategy_version,
    });
    return { f, quality, sampleId, setNow: value => { now = value; } };
  });
}

function addPopulation(f, count, { category = 'follow', from = inclusionStart } = {}) {
  return Array.from({ length: count }, (_, index) => addSuccessfulRecommendation(f, index, {
    category, dispatchedAt: new Date(Date.parse(from) + index * 60_000).toISOString(),
  }));
}

function afterCutoff(members) {
  const lastSuccess = Math.max(...members.map(member => Date.parse(member.successAt)));
  return new Date(lastSuccess + cutoffOffset + 1).toISOString();
}

function maxFeedbackRevision(f) {
  return f.store.db.prepare('SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history').get().id;
}

function incidentHistory(f, canonicalRoot) {
  const rows = f.store.db.prepare(`SELECT succeeded_refs_json FROM checkpoint
    WHERE owner=? AND stage LIKE ? ORDER BY generation,rowid`).all(f.owner, `quality:${f.owner}:incident:${canonicalRoot}:%`);
  return rows.map(row => JSON.parse(row.succeeded_refs_json)[0].payload);
}

function nextIso(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function activateRecovery(quality, f, incident, strategyVersion, parentVersion, at) {
  return quality.activateStrategy({
    strategy_version: strategyVersion,
    parent_version: parentVersion,
    rules: { synthetic_filter: strategyVersion },
    rule_diff: { reason: 'synthetic recovery lifecycle boundary' },
    evidence_refs: [`synthetic:recovery:${strategyVersion}`],
    preference_version: f.versions.preference_version,
    incident_bindings: [{ canonical_root: incident.canonical_root }],
  });
}

async function dispatchUnknown(ctx, dispatchedAt) {
  let now = dispatchedAt;
  const f = ctx.f;
  const delivery = createDelivery({
    store: f.store, root: `${f.root}/quality-boundaries-delivery`, owner: f.owner,
    targetRef: 'synthetic-chat', appRef: 'synthetic-app', now: () => now,
    currentVersions: f.currentVersions,
    transport: {
      async send() { return { status: 'unknown', evidence: ['synthetic:send-unknown'] }; },
      async lookup() { return { status: 'succeeded', message_id: 'synthetic-reconciled-message', evidence: ['synthetic:readback'] }; },
    },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');
  return {
    attemptId: prepared.attempt_id,
    async reconcileAt(confirmedAt) {
      now = confirmedAt;
      assert.equal((await delivery.reconcileDelivery(prepared.attempt_id)).status, 'succeeded');
      return f.store.db.prepare('SELECT first_success_at FROM delivered_content WHERE recommendation_id=?')
        .get(f.recommendation.recommendation_id).first_success_at;
    },
  };
}

function assertMetrics(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `metrics.${key}`);
}

test('未关闭纳入期时不冻结正式截止、不推进incident或恢复结果',async t=>{
 const ctx=await createTestContext(t,{target:1,includedUntil:'2026-11-05T00:00:00.000Z'});
 const m=addSuccessfulRecommendation(ctx.f,1,{dispatchedAt:inclusionStart});saveFeedback(ctx.f,m,'like',m.successAt,1);
 const asOf=afterCutoff([m]);ctx.setNow(asOf);const result=ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),asOf);
 const snapshots=reports(ctx.f,ctx.sampleId).map(r=>r.snapshot);
 assert.equal(result.qualification,'pending');
 assert.equal(snapshots.some(snapshot=>snapshot.view==='cutoff'&&snapshot.qualification==='passed'),false);
 assert.equal(ctx.f.store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:incident:%'")
   .get(ctx.f.owner).n,0);
});
test('恢复样本排除旧策略的unknown派发',async t=>{
 const ctx=await createTestContext(t,{target:1});const initial=addPopulation(ctx.f,1);saveFeedback(ctx.f,initial[0],'dislike',initial[0].successAt,1);
 const initialAt=afterCutoff(initial);ctx.setNow(initialAt);ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),initialAt);
 const failReport=reports(ctx.f,ctx.sampleId).find(r=>r.snapshot.view==='cutoff');const incident=ctx.quality.openIncident({report_revision_id:failReport.report_revision_id});
 const activationAt=nextIso(initialAt,1000),strategy=randomUUID();ctx.setNow(activationAt);activateRecovery(ctx.quality,ctx.f,incident,strategy,ctx.f.versions.strategy_version,activationAt);
 const sid=randomUUID();ctx.quality.registerSample({sample_id:sid,purpose:'recovery',category:'follow',incident_id:incident.incident_id,included_from:activationAt,included_until:nextIso(activationAt,300000),target_total:1,strategy_version:strategy});
 const old=addAttemptOutcome(ctx.f,{status:'unknown',dispatchedAt:activationAt});
 const current=addSuccessfulRecommendation(ctx.f,2,{dispatchedAt:nextIso(activationAt,60000),strategyVersion:strategy});saveFeedback(ctx.f,current,'like',current.successAt,1);
 const asOf=afterCutoff([current]);ctx.setNow(asOf);const result=ctx.quality.calculate(sid,maxFeedbackRevision(ctx.f),asOf);
 assert.equal(result.metrics.N,1);assert.equal(result.metrics.U,0);assert.equal(result.qualification,'passed');
});
test('样本声明checkpoint主键被篡改时计算拒绝',async t=>{
 const ctx=await createTestContext(t,{target:1});const stage=`quality:${ctx.f.owner}:sample:${ctx.sampleId}:declared`;
 ctx.f.store.db.prepare('UPDATE checkpoint SET checkpoint_id=? WHERE owner=? AND stage=?').run(randomUUID(),ctx.f.owner,stage);
 ctx.setNow(inclusionStart);
 assert.throws(()=>ctx.quality.calculate(ctx.sampleId,0,inclusionStart),error=>error.code==='quality_checkpoint_corrupt');
});
test('恢复后迟到生成的旧失败报告不能创建新incident root',async t=>{
 const ctx=await createTestContext(t,{target:1});const initial=addPopulation(ctx.f,1);saveFeedback(ctx.f,initial[0],'dislike',initial[0].successAt,1);
 const initialAt=afterCutoff(initial);ctx.setNow(initialAt);ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),initialAt);
 const original=reports(ctx.f,ctx.sampleId).find(r=>r.snapshot.view==='cutoff');const incident=ctx.quality.openIncident({report_revision_id:original.report_revision_id});
 const activationAt=nextIso(initialAt,1000),strategy=randomUUID();ctx.setNow(activationAt);activateRecovery(ctx.quality,ctx.f,incident,strategy,ctx.f.versions.strategy_version,activationAt);
 const sid=randomUUID();ctx.quality.registerSample({sample_id:sid,purpose:'recovery',category:'follow',incident_id:incident.incident_id,included_from:activationAt,included_until:nextIso(activationAt,300000),target_total:1,strategy_version:strategy});
 const current=addSuccessfulRecommendation(ctx.f,22,{dispatchedAt:nextIso(activationAt,60000),strategyVersion:strategy});saveFeedback(ctx.f,current,'like',current.successAt,1);
 const resolvedAt=afterCutoff([current]);ctx.setNow(resolvedAt);ctx.quality.calculate(sid,maxFeedbackRevision(ctx.f),resolvedAt);assert.equal(incidentHistory(ctx.f,incident.canonical_root).at(-1).status,'resolved');
 const monitor=randomUUID();ctx.quality.registerMonitorSample({sample_id:monitor,category:'follow',target_total:1,as_of:initial[0].successAt});
 const materializedAt=nextIso(resolvedAt,1);ctx.setNow(materializedAt);ctx.quality.calculate(monitor,maxFeedbackRevision(ctx.f),materializedAt);
 const stale=reports(ctx.f,monitor).find(r=>r.snapshot.view==='cutoff');
 assert.throws(()=>ctx.quality.openIncident({report_revision_id:stale.report_revision_id}),
   error=>error.code==='quality_incident_report_not_new_failure');
});
test('纳入期内相隔超过48小时的成功只推进截止，不冻结正式报告',async t=>{
 const ctx=await createTestContext(t,{target:1,includedUntil:'2026-11-05T00:00:00.000Z'});
 const first=addSuccessfulRecommendation(ctx.f,31,{dispatchedAt:inclusionStart});
 saveFeedback(ctx.f,first,'like',first.successAt,1);
 const second=addSuccessfulRecommendation(ctx.f,32,{dispatchedAt:'2026-10-30T00:00:00.000Z'});
 saveFeedback(ctx.f,second,'like',second.successAt,1);
 const asOf=nextIso(second.successAt,1);
 ctx.setNow(asOf);
 const result=ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),asOf);
 const cutoffs=reports(ctx.f,ctx.sampleId).filter(report=>report.snapshot.view==='cutoff');
 assert.equal(result.qualification,'pending');
 assert.equal(cutoffs.length,0);
});
test('关闭后首次计算与期间渐进计算不把旧临时截止变成正式结论',async t=>{
 const includedUntil='2026-11-05T00:00:00.000Z';
 async function scenario(progressive){
  const ctx=await createTestContext(t,{target:1,includedUntil});
  const first=addSuccessfulRecommendation(ctx.f,41,{dispatchedAt:inclusionStart});
  saveFeedback(ctx.f,first,'like',first.successAt,1);
  const second=addSuccessfulRecommendation(ctx.f,42,{dispatchedAt:'2026-10-30T00:00:00.000Z'});
  saveFeedback(ctx.f,second,'like',second.successAt,1);
  saveFeedback(ctx.f,second,'dislike','2026-11-03T00:00:00.000Z',2);
  addAttemptOutcome(ctx.f,{category:'follow',status:'unknown',dispatchedAt:'2026-11-04T00:00:00.000Z'});
  const beforeClose=nextIso(second.successAt,1);
  if(progressive){
   ctx.setNow(beforeClose);
   ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),beforeClose);
  }
  const afterClose='2026-11-06T00:00:00.000Z';
  ctx.setNow(afterClose);
  const result=ctx.quality.calculate(ctx.sampleId,maxFeedbackRevision(ctx.f),afterClose);
  const formal=reports(ctx.f,ctx.sampleId).filter(report=>report.snapshot.view==='cutoff')
  .map(report=>({cutoff_at:report.snapshot.cutoff_at,qualification:report.snapshot.qualification,
    metrics:report.snapshot.metrics,inclusion_closed:report.snapshot.inclusion_closed,
    adopted_feedback:report.snapshot.adopted_feedback.map(row=>row.value).sort()}));
  const cutoff=reports(ctx.f,ctx.sampleId).find(report=>report.snapshot.view==='cutoff')?.snapshot;
  const secondFeedbackValue=cutoff?.adopted_feedback.find(row=>row.recommendation_id===second.recommendationId)?.value;
  return {result,formal,secondFeedbackValue};
 }
 const lateFirst=await scenario(false);
 const progressive=await scenario(true);
 assert.equal(lateFirst.formal.length,1);
 assert.equal(progressive.formal.length,1);
 assert.deepEqual(lateFirst.formal,progressive.formal);
 assert.equal(lateFirst.formal[0].cutoff_at,'2026-11-01T00:00:01.000Z');
 assert.equal(lateFirst.formal[0].inclusion_closed,true);
 assert.equal(lateFirst.formal[0].qualification,'pending');
 assert.equal(lateFirst.formal[0].metrics.U,1);
 assert.equal(lateFirst.formal[0].metrics.L,2);
 assert.equal(lateFirst.formal[0].metrics.D,0);
 assert.equal(lateFirst.formal[0].adopted_feedback.length,2);
 assert.equal(lateFirst.formal[0].adopted_feedback.filter(value=>value==='like').length,2);
 assert.equal(lateFirst.secondFeedbackValue,'like');
 assert.equal(progressive.secondFeedbackValue,'like');
 assert.equal(lateFirst.result.metrics.D,1);
 assert.equal(lateFirst.result.qualification,progressive.result.qualification);
});
