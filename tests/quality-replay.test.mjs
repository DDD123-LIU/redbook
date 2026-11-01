import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';
import { createQuality } from '../src/quality.mjs';

const includedFrom = '2026-10-27T00:00:00.000Z';
const includedUntil = '2026-10-27T01:40:00.000Z';
const registeredAt = '2026-10-26T00:00:00.000Z';
const cutoffOffset = 48 * 60 * 60 * 1000;

function insert(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function addSuccessfulRecommendation(f, index, dispatchedAt) {
  const db = f.store.db;
  const recommendationId = randomUUID();
  const contentId = randomUUID();
  const sourceContentId = `synthetic-${index}-${recommendationId}`;
  const materialId = randomUUID();
  const candidateId = randomUUID();
  const analysisId = randomUUID();
  const decisionId = randomUUID();
  const attemptId = randomUUID();
  const successAt = new Date(Date.parse(dispatchedAt) + 1000).toISOString();
  const checkpointHash = `synthetic-dispatch-${attemptId}`;

  insert(db, 'content', { content_id: contentId, platform: 'xiaohongshu', source_content_id: sourceContentId,
    source_state: 'available', last_observed_at: dispatchedAt, created_at: dispatchedAt });
  insert(db, 'material_version', { material_version_id: materialId, content_id: contentId, media_kind: 'text',
    fetched_at: dispatchedAt, material_hash: `material-${materialId}`, completeness: 'complete', fetch_status: 'succeeded' });
  insert(db, 'analysis', { analysis_id: analysisId, material_version_id: materialId, input_hash: `input-${analysisId}`,
    prompt_version: 'synthetic', model_requested: 'synthetic', status: 'complete', created_at: dispatchedAt });
  insert(db, 'candidate', { candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId,
    source: 'homefeed', discovered_at: dispatchedAt, source_evidence_ref: `synthetic:candidate:${index}`,
    eligibility_state: 'eligible' });
  insert(db, 'decision', { decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId,
    baseline_version: f.versions.baseline_version, preference_version: f.versions.preference_version,
    strategy_version: f.versions.strategy_version, category: 'follow', relevance: 'matched', gain_state: 'gain',
    result: 'eligible', created_at: dispatchedAt });
  insert(db, 'recommendation', { recommendation_id: recommendationId, content_id: contentId,
    delivery_batch_id: f.batchId, decision_id: decisionId, category: 'follow',
    actual_preference_version: f.versions.preference_version, actual_strategy_version: f.versions.strategy_version,
    state: 'succeeded', first_success_at: successAt, revision: 1, created_at: dispatchedAt, updated_at: successAt });
  insert(db, 'entity_state_history', { entity_type: 'recommendation', entity_id: recommendationId,
    old_state: 'pending', new_state: 'succeeded', revision: 1, changed_at: successAt });
  insert(db, 'delivery_attempt', { delivery_attempt_id: attemptId, recommendation_id: recommendationId,
    target_ref: 'synthetic-chat', payload_hash: `payload-${attemptId}`, intent_at: dispatchedAt,
    dispatched_at: dispatchedAt, returned_at: successAt, message_id: `synthetic-message-${index}`,
    status: 'succeeded', verification_evidence_refs_json: JSON.stringify([`synthetic:receipt:${index}`]),
    created_at: successAt, updated_at: successAt });
  insert(db, 'delivered_content', { owner: f.owner, platform: 'xiaohongshu', source_content_id: sourceContentId,
    recommendation_id: recommendationId, first_success_at: successAt });
  insert(db, 'checkpoint', { checkpoint_id: randomUUID(), owner: f.owner, run_id: 'synthetic-quality-run',
    generation: 0, delivery_batch_id: f.batchId, stage: `delivery-attempt:${attemptId}`,
    succeeded_refs_json: JSON.stringify([{ ref: `synthetic:dispatch:${attemptId}`, hash: checkpointHash }]),
    output_hash: checkpointHash, committed_at: dispatchedAt });
  return { recommendationId, contentId, sourceContentId, successAt };
}

function addUndispatchedIntent(f, dispatchedAt) {
  const db = f.store.db;
  const recommendationId = randomUUID();
  const contentId = randomUUID();
  const materialId = randomUUID();
  const candidateId = randomUUID();
  const analysisId = randomUUID();
  const decisionId = randomUUID();
  insert(db, 'content', { content_id: contentId, platform: 'xiaohongshu', source_content_id: `intent-${recommendationId}`,
    source_state: 'available', last_observed_at: dispatchedAt, created_at: dispatchedAt });
  insert(db, 'material_version', { material_version_id: materialId, content_id: contentId, media_kind: 'text',
    fetched_at: dispatchedAt, material_hash: `material-${materialId}`, completeness: 'complete', fetch_status: 'succeeded' });
  insert(db, 'analysis', { analysis_id: analysisId, material_version_id: materialId, input_hash: `input-${analysisId}`,
    prompt_version: 'synthetic', model_requested: 'synthetic', status: 'complete', created_at: dispatchedAt });
  insert(db, 'candidate', { candidate_id: candidateId, content_id: contentId, discovery_batch_id: f.batchId,
    source: 'homefeed', discovered_at: dispatchedAt, source_evidence_ref: `synthetic:candidate:${recommendationId}`,
    eligibility_state: 'eligible' });
  insert(db, 'decision', { decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId,
    baseline_version: f.versions.baseline_version, preference_version: f.versions.preference_version,
    strategy_version: f.versions.strategy_version, category: 'follow', relevance: 'matched', gain_state: 'gain',
    result: 'eligible', created_at: dispatchedAt });
  insert(db, 'recommendation', { recommendation_id: recommendationId, content_id: contentId,
    delivery_batch_id: f.batchId, decision_id: decisionId, category: 'follow',
    actual_preference_version: f.versions.preference_version, actual_strategy_version: f.versions.strategy_version,
    state: 'pending', revision: 0, created_at: dispatchedAt, updated_at: dispatchedAt });
  insert(db, 'delivery_attempt', { delivery_attempt_id: randomUUID(), recommendation_id: recommendationId,
    target_ref: 'synthetic-chat', payload_hash: 'synthetic-intent', intent_at: dispatchedAt,
    status: 'intent', created_at: dispatchedAt, updated_at: dispatchedAt });
}

function addLike(f, member) {
  const eventId = randomUUID();
  insert(f.store.db, 'feedback_event', { app_ref: 'synthetic-app', chat_ref: 'synthetic-chat', event_id: eventId,
    recommendation_id: member.recommendationId, content_id: member.contentId, value: 'like',
    received_at: member.successAt, saved_at: member.successAt, revision: 1,
    parse_state: 'parsed', association_state: 'matched' });
  insert(f.store.db, 'feedback_history', { owner: f.owner, app_ref: 'synthetic-app', chat_ref: 'synthetic-chat',
    platform: 'xiaohongshu', source_content_id: member.sourceContentId, content_id: member.contentId,
    recommendation_id: member.recommendationId, value: 'like', revision: 1, event_id: eventId,
    saved_at: member.successAt });
  return f.store.db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

function reports(f, sampleId) {
  return f.store.db.prepare('SELECT report_revision_id,snapshot_json FROM report_revision WHERE sample_id=? ORDER BY rowid')
    .all(sampleId).map(row => ({ ...row, snapshot: JSON.parse(row.snapshot_json) }));
}

async function context(t, { target = 1, includedUntil = '2026-10-27T01:40:00.000Z' } = {}) {
  const f = await deliveryFixture(t, { target: 2, businessDay: '2026-10-27' });
  let at = registeredAt;
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => at });
  const sampleId = randomUUID();
  const declaration = { sample_id: sampleId, purpose: 'initial', category: 'follow', included_from: includedFrom,
    included_until: includedUntil, target_total: target, strategy_version: f.versions.strategy_version };
  quality.registerSample(declaration);
  return { f, quality, sampleId, declaration, setNow: value => { at = value; } };
}

function watermark(f) {
  return f.store.db.prepare('SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history').get().id;
}

function afterCutoff(member) {
  return new Date(Date.parse(member.successAt) + cutoffOffset + 1).toISOString();
}

test('窗内成功样本不被窗外历史成功阻止通过', async t => {
  const ctx = await context(t);
  const inside = addSuccessfulRecommendation(ctx.f, 1, includedFrom);
  addSuccessfulRecommendation(ctx.f, 2, new Date(Date.parse(includedFrom) - 60_000).toISOString());
  addLike(ctx.f, inside);
  const asOf = afterCutoff(inside);
  ctx.setNow(asOf);

  const result = ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), asOf);
  const snapshot = reports(ctx.f, ctx.sampleId).at(-1).snapshot;
  assert.equal(result.metrics.N, 1);
  assert.equal(result.metrics.L, 1);
  assert.equal(result.metrics.U, 0);
  assert.equal(result.metrics.boundary_unknowns, 0);
  assert.equal(result.blockers.includes('boundary_unknown'), false);
  assert.equal(result.qualification, 'passed');
  assert.equal(snapshot.boundary_unknowns.length, 0);
});

test('从未 dispatch 的 intent 不作为样本 unknown 或边界阻塞', async t => {
  const ctx = await context(t);
  const inside = addSuccessfulRecommendation(ctx.f, 3, includedFrom);
  addLike(ctx.f, inside);
  addUndispatchedIntent(ctx.f, includedFrom);
  const asOf = afterCutoff(inside);
  ctx.setNow(asOf);

  const result = ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), asOf);
  const snapshot = reports(ctx.f, ctx.sampleId).at(-1).snapshot;
  assert.equal(result.metrics.N, 1);
  assert.equal(result.metrics.L, 1);
  assert.equal(result.metrics.U, 0);
  assert.equal(result.metrics.boundary_unknowns, 0);
  assert.equal(result.blockers.includes('boundary_unknown'), false);
  assert.equal(result.qualification, 'passed');
  assert.equal(snapshot.boundary_unknowns.length, 0);
});

test('同一样本声明重入幂等，但首次事后登记仍被拒绝', async t => {
  const ctx = await context(t);
  ctx.setNow(new Date(Date.parse(registeredAt) + 1).toISOString());
  assert.equal(ctx.quality.registerSample(ctx.declaration).status, 'duplicate');
  ctx.setNow(new Date(Date.parse(includedFrom) + 1).toISOString());
  assert.equal(ctx.quality.registerSample(ctx.declaration).status, 'duplicate');

  const lateDeclaration = { ...ctx.declaration, sample_id: randomUUID() };
  assert.throws(() => ctx.quality.registerSample(lateDeclaration), error =>
    error.code === 'quality_sample_must_be_pre_registered');
});

test('历史 as_of 追加 historical 报告且不回退 current 头，重算幂等', async t => {
  const ctx = await context(t);
  const member = addSuccessfulRecommendation(ctx.f, 4, includedFrom);
  addLike(ctx.f, member);
  const later = afterCutoff(member);
  ctx.setNow(later);
  ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), later);
  const currentBefore = reports(ctx.f, ctx.sampleId).filter(row => row.snapshot.view === 'current')
    .sort((a, b) => a.snapshot.as_of.localeCompare(b.snapshot.as_of)).at(-1);
  assert(currentBefore);

  const historical = new Date(Date.parse(member.successAt) + 1000).toISOString();
  const first = ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), historical);
  assert.equal(first.reports.at(-1).status, 'succeeded');
  assert(first.reports.at(-1).snapshot_hash);
  const historicalRow = reports(ctx.f, ctx.sampleId).find(row =>
    row.report_revision_id === first.reports.at(-1).report_revision_id);
  assert.equal(historicalRow.snapshot.view, 'historical');
  assert.equal(historicalRow.snapshot.as_of, historical);

  const countBeforeRepeat = reports(ctx.f, ctx.sampleId).length;
  const repeat = ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), historical);
  assert.equal(repeat.reports.at(-1).status, 'duplicate');
  assert.equal(repeat.reports.at(-1).report_revision_id, historicalRow.report_revision_id);
  assert.equal(reports(ctx.f, ctx.sampleId).length, countBeforeRepeat);
  const currentAfter = reports(ctx.f, ctx.sampleId).filter(row => row.snapshot.view === 'current')
    .sort((a, b) => a.snapshot.as_of.localeCompare(b.snapshot.as_of)).at(-1);
  assert.equal(currentAfter.report_revision_id, currentBefore.report_revision_id);
  assert.equal(currentAfter.snapshot.as_of, later);
});

test('纳入期未结束时，48小时观测截止不能通过或推进恢复', async t => {
  const ctx = await context(t, { includedUntil: '2026-11-05T00:00:00.000Z' });
  const member = addSuccessfulRecommendation(ctx.f, 5, includedFrom);
  addLike(ctx.f, member);
  const asOf = afterCutoff(member);
  ctx.setNow(asOf);

  const result = ctx.quality.calculate(ctx.sampleId, watermark(ctx.f), asOf);
  const snapshots = reports(ctx.f, ctx.sampleId);
  const cutoff = snapshots.find(row => row.snapshot.view === 'cutoff')?.snapshot;
  assert.equal(result.qualification, 'pending');
  assert.notEqual(cutoff?.qualification, 'passed');
  if (cutoff) assert.equal(cutoff.inclusion_closed, false);
  assert.equal(ctx.f.store.db.prepare('SELECT count(*) AS n FROM incident').get().n, 0);
  assert.equal(ctx.f.store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE stage LIKE 'quality:%:recovery-outcome:%'").get().n, 0);
});

test('质量账本的 checkpoint_id、owner 或 stage 被篡改后拒绝读取', async t => {
  for (const [field, expectedCode] of [
    ['checkpoint_id', 'quality_checkpoint_corrupt'],
    ['owner', 'quality_sample_not_found'],
    ['stage', 'quality_sample_not_found'],
  ]) {
    const ctx = await context(t);
    const stage = `quality:${ctx.f.owner}:sample:${ctx.sampleId}:declared`;
    if (field === 'checkpoint_id') {
      ctx.f.store.db.prepare('UPDATE checkpoint SET checkpoint_id=? WHERE owner=? AND stage=?')
        .run(randomUUID(), ctx.f.owner, stage);
    } else if (field === 'owner') {
      ctx.f.store.db.prepare('UPDATE checkpoint SET owner=? WHERE owner=? AND stage=?')
        .run('tampered-owner', ctx.f.owner, stage);
    } else {
      ctx.f.store.db.prepare('UPDATE checkpoint SET stage=? WHERE owner=? AND stage=?')
        .run(`${stage}:tampered`, ctx.f.owner, stage);
    }

    ctx.setNow(includedFrom);
    assert.throws(() => ctx.quality.calculate(ctx.sampleId, 0, includedFrom), error =>
      error.code === expectedCode, field);
  }
});
