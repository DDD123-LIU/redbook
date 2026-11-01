import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDelivery } from '../src/delivery.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const { createQuality } = await import('../src/quality.mjs').catch(() => ({}));

const inclusionStart = '2026-10-27T00:00:00.000Z';
const inclusionEnd = '2026-10-27T01:40:00.000Z';
const registeredAt = '2026-10-26T00:00:00.000Z';
const cutoffOffset = 48 * 60 * 60 * 1000;
const scenarioResults = [];

after(async () => {
  const path = fileURLToPath(new URL('../.codex/task014-boundaries-results-20261026.json', import.meta.url));
  await writeFile(path, `${JSON.stringify({
    date: '2026-10-26', executor: 'Codex', syntheticOnly: true,
    runCommand: 'node --test tests/quality-boundaries.test.mjs', scenarios: scenarioResults,
  }, null, 2)}\n`, 'utf8');
});

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

test('质量统计模块公开 createQuality 入口', () => {
  assert.equal(typeof createQuality, 'function');
});

test('N=100、E=5 恰为 5% 时失败；E=4 通过且一致率 95% 边界包含', async t => {
  const equalMissing = await createTestContext(t);
  const fivePercent = addPopulation(equalMissing.f, 100);
  fivePercent.forEach((member, index) => {
    if (index < 95) saveFeedback(equalMissing.f, member, 'like', member.successAt, 1);
  });
  const equalAsOf = afterCutoff(fivePercent);
  equalMissing.setNow(equalAsOf);
  const equalResult = equalMissing.quality.calculate(equalMissing.sampleId, maxFeedbackRevision(equalMissing.f), equalAsOf);
  captureScenario('N100_E5', equalMissing.f, equalMissing.sampleId,
    { N: 100, L: 95, D: 0, E: 5 }, { qualification: 'failed', reason: 'missing_rate_is_exactly_5_percent' }, equalResult);
  assertMetrics(equalResult.metrics, { N: 100, L: 95, D: 0, E: 5, S: 0, U: 0, F: 0 });
  assert.equal(equalResult.qualification, 'failed');

  const pass = await createTestContext(t);
  const population = addPopulation(pass.f, 100);
  population.forEach((member, index) => {
    if (index < 96) saveFeedback(pass.f, member, index < 95 ? 'like' : 'dislike', member.successAt, 1);
  });
  const asOf = afterCutoff(population);
  pass.setNow(asOf);
  const result = pass.quality.calculate(pass.sampleId, maxFeedbackRevision(pass.f), asOf);
  captureScenario('N100_E4_L95_D1', pass.f, pass.sampleId,
    { N: 100, L: 95, D: 1, E: 4 }, { qualification: 'passed', reason: 'missing_below_5_and_agreement_exactly_95_percent' }, result);
  assertMetrics(result.metrics, { N: 100, L: 95, D: 1, E: 4, S: 0, U: 0, F: 0 });
  assert.equal(result.qualification, 'passed');
});

test('N=100、L=94、D=5 的 94% 一致率边界失败', async t => {
  const ctx = await createTestContext(t);
  const members = addPopulation(ctx.f, 100);
  members.forEach((member, index) => {
    if (index < 99) saveFeedback(ctx.f, member, index < 94 ? 'like' : 'dislike', member.successAt, 1);
  });
  const asOf = afterCutoff(members);
  ctx.setNow(asOf);
  const result = ctx.quality.calculate(ctx.sampleId, maxFeedbackRevision(ctx.f), asOf);
  captureScenario('N100_L94_D5', ctx.f, ctx.sampleId,
    { N: 100, L: 94, D: 5, E: 1 }, { qualification: 'failed', reason: 'agreement_below_95_percent' }, result);
  assertMetrics(result.metrics, { N: 100, L: 94, D: 5, E: 1, S: 0, U: 0, F: 0 });
  assert.equal(result.qualification, 'failed');
});

test('N=0、L+D=0 无法通过；样本未完成、目标缺失和未知投递都阻止通过', async t => {
  const empty = await createTestContext(t, { target: 0 });
  const emptyAsOf = new Date(Date.parse(inclusionEnd) + cutoffOffset + 1).toISOString();
  empty.setNow(emptyAsOf);
  const emptyResult = empty.quality.calculate(empty.sampleId, 0, emptyAsOf);
  captureScenario('N0_zero_denominator', empty.f, empty.sampleId,
    { N: 0, L: 0, D: 0, E: 0 }, { qualification: 'undetermined' }, emptyResult);
  assert.equal(emptyResult.metrics.N, 0);
  assert.notEqual(emptyResult.qualification, 'passed');

  const incomplete = await createTestContext(t, { target: 2 });
  const onlyMember = addPopulation(incomplete.f, 1);
  const incompleteAsOf = afterCutoff(onlyMember);
  incomplete.setNow(incompleteAsOf);
  const incompleteResult = incomplete.quality.calculate(incomplete.sampleId, 0, incompleteAsOf);
  captureScenario('sample_incomplete', incomplete.f, incomplete.sampleId,
    { target_total: 2, N: 1 }, { qualification: 'pending', reason: 'target_not_met' }, incompleteResult);
  assert.equal(incompleteResult.metrics.N, 1);
  assert.notEqual(incompleteResult.qualification, 'passed');

  const noVotes = await createTestContext(t, { target: 1 });
  const noVoteMembers = addPopulation(noVotes.f, 1);
  const noVoteAsOf = afterCutoff(noVoteMembers);
  noVotes.setNow(noVoteAsOf);
  const noVoteResult = noVotes.quality.calculate(noVotes.sampleId, 0, noVoteAsOf);
  captureScenario('positive_N_zero_like_dislike', noVotes.f, noVotes.sampleId,
    { N: 1, L: 0, D: 0, E: 1 }, { qualification: 'undetermined' }, noVoteResult);
  assert.equal(noVoteResult.metrics.N, 1);
  assert.equal(noVoteResult.metrics.L + noVoteResult.metrics.D, 0);
  assert.equal(noVoteResult.qualification, 'undetermined');

  const missingTarget = await createTestContext(t, { target: null, batchTarget: 1 });
  const one = addPopulation(missingTarget.f, 1);
  saveFeedback(missingTarget.f, one[0], 'like', one[0].successAt, 1);
  const missingAsOf = afterCutoff(one);
  missingTarget.setNow(missingAsOf);
  const missingResult = missingTarget.quality.calculate(missingTarget.sampleId, maxFeedbackRevision(missingTarget.f), missingAsOf);
  captureScenario('sample_target_missing', missingTarget.f, missingTarget.sampleId,
    { target_total: null, N: 1, L: 1 }, { qualification: 'pending', reason: 'target_total_unset' }, missingResult);
  assert.notEqual(missingResult.qualification, 'passed');
  assert.ok(missingResult.blockers.length > 0);

  const unknown = await createTestContext(t, { target: 1 });
  const unknownAt = inclusionStart;
  const success = addPopulation(unknown.f, 1)[0];
  saveFeedback(unknown.f, success, 'like', success.successAt, 1);
  addAttemptOutcome(unknown.f, { status: 'unknown', dispatchedAt: unknownAt });
  addAttemptOutcome(unknown.f, { status: 'failed', dispatchedAt: unknownAt });
  const unknownAsOf = afterCutoff([success]);
  unknown.setNow(unknownAsOf);
  const unknownResult = unknown.quality.calculate(unknown.sampleId, maxFeedbackRevision(unknown.f), unknownAsOf);
  captureScenario('unknown_and_failed_delivery', unknown.f, unknown.sampleId,
    { N: 1, L: 1, U: 1, F: 1 }, { qualification: 'pending', reason: 'unverified_delivery_blocks_pass' }, unknownResult);
  assert.equal(unknownResult.metrics.N, 1);
  assert.equal(unknownResult.metrics.L, 1);
  assert.equal(unknownResult.metrics.U, 1);
  assert.equal(unknownResult.metrics.F, 1);
  assert.notEqual(unknownResult.qualification, 'passed');
});

test('seen 只作为 E 子集；关注与探索样本的成员和指标完全隔离', async t => {
  const ctx = await createTestContext(t, { target: 2, category: 'follow' });
  const exploreSampleId = randomUUID();
  ctx.quality.registerSample({
    sample_id: exploreSampleId, purpose: 'initial', category: 'explore', included_from: inclusionStart,
    included_until: inclusionEnd, target_total: 3, strategy_version: ctx.f.versions.strategy_version,
  });
  const followMembers = addPopulation(ctx.f, 2, { category: 'follow' });
  saveFeedback(ctx.f, followMembers[0], 'seen', followMembers[0].successAt, 1);
  saveFeedback(ctx.f, followMembers[1], 'like', followMembers[1].successAt, 1);
  const exploreMembers = addPopulation(ctx.f, 3, { category: 'explore' });
  exploreMembers.forEach(member => saveFeedback(ctx.f, member, 'dislike', member.successAt, 1));
  const asOf = afterCutoff([...followMembers, ...exploreMembers]);
  ctx.setNow(asOf);
  const watermark = maxFeedbackRevision(ctx.f);
  const followResult = ctx.quality.calculate(ctx.sampleId, watermark, asOf);
  captureScenario('follow_seen_subset', ctx.f, ctx.sampleId,
    { N: 2, L: 1, D: 0, E: 1, S: 1 }, { category: 'follow', E: 1, S: 1 }, followResult);
  assertMetrics(followResult.metrics, { N: 2, L: 1, D: 0, E: 1, S: 1, U: 0, F: 0 });
  const exploreResult = ctx.quality.calculate(exploreSampleId, watermark, asOf);
  captureScenario('explore_isolated', ctx.f, exploreSampleId,
    { category: 'explore', N: 3, L: 0, D: 3 }, { N: 3, qualification: 'failed' }, exploreResult);
  assertMetrics(exploreResult.metrics, { N: 3, L: 0, D: 3, E: 0, S: 0, U: 0, F: 0 });
  assert.equal(exploreResult.qualification, 'failed');
  assert.equal(followResult.metrics.N, 2);
});

test('重复同值不扩有效历史，更正按当前版本计数并按截止前后 1ms 重建', async t => {
  const ctx = await createTestContext(t, { target: 1 });
  const [member] = addPopulation(ctx.f, 1);
  const cutoff = new Date(Date.parse(member.successAt) + cutoffOffset).toISOString();
  const first = saveFeedback(ctx.f, member, 'like', cutoff, 1);
  const historyCount = ctx.f.store.db.prepare('SELECT count(*) AS n FROM feedback_history').get().n;
  const savedEvent = ctx.f.store.db.prepare(`SELECT * FROM feedback_event WHERE event_id=(
    SELECT event_id FROM feedback_history WHERE feedback_history_id=?
  )`).get(first);
  assert.throws(() => insert(ctx.f.store.db, 'feedback_event', savedEvent), /UNIQUE constraint failed/);
  assert.equal(ctx.f.store.db.prepare('SELECT count(*) AS n FROM feedback_history').get().n, historyCount);
  // 第二个同值事件只保留原有效评价，不追加当前评价历史。
  insert(ctx.f.store.db, 'feedback_event', {
    app_ref: 'synthetic-app', chat_ref: 'synthetic-chat', event_id: randomUUID(),
    recommendation_id: member.recommendationId, content_id: member.contentId, value: 'like',
    received_at: cutoff, saved_at: cutoff, revision: 2, parse_state: 'parsed', association_state: 'matched',
  });
  assert.equal(ctx.f.store.db.prepare('SELECT count(*) AS n FROM feedback_history').get().n, historyCount);
  const atCutoff = new Date(Date.parse(cutoff) + 1).toISOString();
  ctx.setNow(atCutoff);
  const firstResult = ctx.quality.calculate(ctx.sampleId, first, atCutoff);
  captureScenario('feedback_saved_at_cutoff_included', ctx.f, ctx.sampleId,
    { saved_at: cutoff, event_revision: first }, { cutoff_L: 1 }, firstResult);
  assert.equal(firstResult.metrics.L, 1);
  assert.ok(reports(ctx.f, ctx.sampleId).some(report => report.snapshot.view === 'cutoff'));

  const correctionAt = new Date(Date.parse(cutoff) + 1).toISOString();
  saveFeedback(ctx.f, member, 'dislike', correctionAt, 2);
  const afterLateCorrection = new Date(Date.parse(correctionAt) + 1).toISOString();
  ctx.setNow(afterLateCorrection);
  const corrected = ctx.quality.calculate(ctx.sampleId, maxFeedbackRevision(ctx.f), afterLateCorrection);
  captureScenario('late_correction_after_cutoff', ctx.f, ctx.sampleId,
    { saved_at: correctionAt, event_revision: maxFeedbackRevision(ctx.f) },
    { current_L: 0, current_D: 1, original_cutoff_L: 1 }, corrected);
  assert.equal(corrected.metrics.L, 0);
  assert.equal(corrected.metrics.D, 1);
  assert.ok(reports(ctx.f, ctx.sampleId).length > 2);
  assert.equal(reports(ctx.f, ctx.sampleId).filter(report => report.snapshot.view === 'cutoff')[0].snapshot.metrics.L, 1);
});

test('unknown 在旧截止前核实会推进活动截止；旧截止后 1ms 核实保留原截止报告', async t => {
  for (const reconcileAfterCutoff of [false, true]) {
    const includedUntil = '2026-10-27T00:05:00.000Z';
    const ctx = await createTestContext(t, { target: 2, includedUntil });
    const known = addSuccessfulRecommendation(ctx.f, 10, {
      category: 'follow', dispatchedAt: '2026-10-27T00:02:00.000Z',
    });
    const unknown = await dispatchUnknown(ctx, '2026-10-27T00:01:00.000Z');
    const closeAt = new Date(Date.parse(includedUntil) + 60_000).toISOString();
    ctx.setNow(closeAt);
    const beforeResolution = ctx.quality.calculate(ctx.sampleId, 0, closeAt);
    captureScenario(reconcileAfterCutoff ? 'reconcile_after_cutoff_initial' : 'reconcile_before_cutoff_initial',
      ctx.f, ctx.sampleId, { as_of: closeAt, U: 1 }, { N: 1, U: 1 }, beforeResolution);
    assert.equal(beforeResolution.metrics.N, 1);
    assert.equal(beforeResolution.metrics.U, 1);
    const oldCutoff = new Date(Date.parse(known.successAt) + cutoffOffset).toISOString();
    const resolvedAt = reconcileAfterCutoff
      ? new Date(Date.parse(oldCutoff) + 1).toISOString()
      : new Date(Date.parse(known.successAt) + 24 * 60 * 60 * 1000).toISOString();
    const confirmedAt = await unknown.reconcileAt(resolvedAt);
    assert.equal(confirmedAt, resolvedAt);
    ctx.setNow(resolvedAt);
    const revised = ctx.quality.calculate(ctx.sampleId, 0, resolvedAt);
    const snapshots = reports(ctx.f, ctx.sampleId).map(report => report.snapshot);
    const activeCutoff = new Date(Date.parse(confirmedAt) + cutoffOffset).toISOString();
    captureScenario(reconcileAfterCutoff ? 'reconcile_after_cutoff_plus_1ms' : 'reconcile_before_cutoff',
      ctx.f, ctx.sampleId, { confirmed_at: confirmedAt, prior_cutoff: oldCutoff },
      { current_N: 2, current_U: 0, current_cutoff: activeCutoff }, revised);
    assert.equal(revised.metrics.N, 2);
    assert.equal(revised.metrics.U, 0);
    assert.ok(snapshots.some(snapshot => snapshot.view === 'current' && snapshot.cutoff_at === activeCutoff));
    if (reconcileAfterCutoff) {
      const original = snapshots.find(snapshot => snapshot.view === 'cutoff');
      assert.ok(original);
      assert.equal(original.cutoff_at, oldCutoff);
      assert.equal(original.metrics.N, 1);
      assert.equal(original.metrics.U, 1);
      assert.equal(snapshots.at(-1).view, 'current');
    } else {
      assert.equal(revised.blockers.includes('observation_window_open'), true);
      assert.equal(snapshots.some(snapshot => snapshot.view === 'cutoff'), false);
    }
  }
});

test('calculate 幂等、失败事务回滚，且关闭重开后可从持久报告重算', async t => {
  const ctx = await createTestContext(t, { target: 1 });
  const [member] = addPopulation(ctx.f, 1);
  saveFeedback(ctx.f, member, 'like', member.successAt, 1);
  const asOf = afterCutoff([member]);
  ctx.setNow(asOf);
  const watermark = maxFeedbackRevision(ctx.f);
  ctx.f.store.db.exec(`CREATE TRIGGER fail_quality_report BEFORE INSERT ON report_revision
    BEGIN SELECT RAISE(ABORT, 'synthetic report write failure'); END`);
  assert.throws(() => ctx.quality.calculate(ctx.sampleId, watermark, asOf), /synthetic report write failure/);
  assert.equal(ctx.f.store.db.prepare('SELECT count(*) AS n FROM sample_member WHERE sample_id=?').get(ctx.sampleId).n, 0);
  assert.equal(reports(ctx.f, ctx.sampleId).length, 0);
  ctx.f.store.db.exec('DROP TRIGGER fail_quality_report');

  const first = ctx.quality.calculate(ctx.sampleId, watermark, asOf);
  const before = reports(ctx.f, ctx.sampleId);
  const repeat = ctx.quality.calculate(ctx.sampleId, watermark, asOf);
  assert.equal(repeat.status, 'succeeded');
  assert.deepEqual(repeat.metrics, first.metrics);
  assert.deepEqual(reports(ctx.f, ctx.sampleId), before);
  const savedSnapshot = before[0].snapshot_json;

  ctx.f.reopen();
  const reopenedQuality = createQuality({ store: ctx.f.store, owner: ctx.f.owner, now: () => asOf });
  const reopened = reopenedQuality.calculate(ctx.sampleId, watermark, asOf);
  captureScenario('sqlite_reopen_recompute', ctx.f, ctx.sampleId,
    { event_revision: watermark, as_of: asOf }, { N: 1, report_ids_unchanged: true }, reopened);
  assert.equal(reopened.metrics.N, 1);
  assert.deepEqual(reports(ctx.f, ctx.sampleId), before);
  assert.equal(reports(ctx.f, ctx.sampleId)[0].snapshot_json, savedSnapshot);
});

test('恢复样本只纳入新策略成功推荐，旧策略成功不进入恢复分母', async t => {
  const ctx = await createTestContext(t, { target: 2 });
  const initial = addPopulation(ctx.f, 2);
  saveFeedback(ctx.f, initial[0], 'like', initial[0].successAt, 1);
  saveFeedback(ctx.f, initial[1], 'dislike', initial[1].successAt, 1);
  const initialAsOf = afterCutoff(initial);
  ctx.setNow(initialAsOf);
  const initialReport = ctx.quality.calculate(ctx.sampleId, maxFeedbackRevision(ctx.f), initialAsOf);
  assert.equal(initialReport.qualification, 'failed');
  const cutoffReport = reports(ctx.f, ctx.sampleId).find(report => report.snapshot.view === 'cutoff');
  assert.ok(cutoffReport);
  const incident = ctx.quality.openIncident({ report_revision_id: cutoffReport.report_revision_id });
  assert.equal(incident.status, 'succeeded');

  const newStrategy = randomUUID();
  const activation = ctx.quality.activateStrategy({
    strategy_version: newStrategy,
    parent_version: ctx.f.versions.strategy_version,
    rules: { synthetic_filter: 'recovery-v2' },
    rule_diff: { reason: 'synthetic recovery boundary' },
    evidence_refs: ['synthetic:recovery-screening'],
    preference_version: ctx.f.versions.preference_version,
    incident_bindings: [{ canonical_root: incident.canonical_root }],
  });
  assert.equal(activation.status, 'succeeded');
  const recoveryStart = '2026-10-30T00:00:00.000Z';
  const recoveryEnd = '2026-10-30T00:05:00.000Z';
  const sampleId = randomUUID();
  ctx.quality.registerSample({
    sample_id: sampleId, purpose: 'recovery', category: 'follow', incident_id: incident.incident_id,
    included_from: recoveryStart, included_until: recoveryEnd, target_total: 1, strategy_version: newStrategy,
  });
  const old = addSuccessfulRecommendation(ctx.f, 20, {
    category: 'follow', dispatchedAt: recoveryStart, strategyVersion: ctx.f.versions.strategy_version,
  });
  const current = addSuccessfulRecommendation(ctx.f, 21, {
    category: 'follow', dispatchedAt: new Date(Date.parse(recoveryStart) + 60_000).toISOString(),
    strategyVersion: newStrategy,
  });
  saveFeedback(ctx.f, old, 'dislike', old.successAt, 1);
  saveFeedback(ctx.f, current, 'like', current.successAt, 1);
  const asOf = afterCutoff([current]);
  ctx.setNow(asOf);
  const result = ctx.quality.calculate(sampleId, maxFeedbackRevision(ctx.f), asOf);
  captureScenario('recovery_strategy_isolation', ctx.f, sampleId,
    { initial_cutoff_report_id: cutoffReport.report_revision_id, strategy_version: newStrategy,
      recommendation_ids: [old.recommendationId, current.recommendationId] },
    { N: 1, L: 1, qualification: 'passed', included_recommendation_ids: [current.recommendationId] }, result);
  assertMetrics(result.metrics, { N: 1, L: 1, D: 0, E: 0, U: 0, F: 0 });
  assert.equal(result.qualification, 'passed');
  const latest = reports(ctx.f, sampleId).at(-1).snapshot;
  assert.deepEqual(latest.members.map(member => member.recommendation_id), [current.recommendationId]);
});

test('两轮恢复失败后耗尽；迟到好评不回写截止结论，重开数据库和新名称不能重置额度', async t => {
  const ctx = await createTestContext(t, { target: 2 });
  const initial = addPopulation(ctx.f, 2);
  saveFeedback(ctx.f, initial[0], 'like', initial[0].successAt, 1);
  saveFeedback(ctx.f, initial[1], 'dislike', initial[1].successAt, 1);
  const initialAsOf = afterCutoff(initial);
  ctx.setNow(initialAsOf);
  const initialReport = ctx.quality.calculate(ctx.sampleId, maxFeedbackRevision(ctx.f), initialAsOf);
  assert.equal(initialReport.qualification, 'failed');
  const initialCutoff = reports(ctx.f, ctx.sampleId).find(report => report.snapshot.view === 'cutoff');
  const originalInitialMembers = initialCutoff.snapshot.members.map(member => member.recommendation_id);
  const incident = ctx.quality.openIncident({ report_revision_id: initialCutoff.report_revision_id });

  const strategy1 = randomUUID();
  const activateAt1 = nextIso(initialAsOf, 60_000);
  const recoveryStart1 = nextIso(activateAt1, 1);
  ctx.setNow(activateAt1);
  assert.equal(activateRecovery(ctx.quality, ctx.f, incident, strategy1, ctx.f.versions.strategy_version, activateAt1).status, 'succeeded');
  const sample1 = randomUUID();
  ctx.quality.registerSample({ sample_id: sample1, purpose: 'recovery', category: 'follow',
    incident_id: incident.incident_id, included_from: recoveryStart1,
    included_until: nextIso(recoveryStart1, 5 * 60_000), target_total: 1, strategy_version: strategy1 });
  const firstRecoveryMember = addSuccessfulRecommendation(ctx.f, 'recovery-1', {
    category: 'follow', dispatchedAt: recoveryStart1, strategyVersion: strategy1,
  });
  const firstFeedbackRevision = saveFeedback(ctx.f, firstRecoveryMember, 'dislike', firstRecoveryMember.successAt, 1);
  const firstCutoffAt = afterCutoff([firstRecoveryMember]);
  ctx.setNow(firstCutoffAt);
  const firstOutcome = ctx.quality.calculate(sample1, firstFeedbackRevision, firstCutoffAt);
  assert.equal(firstOutcome.qualification, 'failed');
  assert.equal(incidentHistory(ctx.f, incident.canonical_root).at(-1).adjustment_index, 1);
  assert.equal(incidentHistory(ctx.f, incident.canonical_root).at(-1).status, 'open');

  const firstCutoffReport = reports(ctx.f, sample1).find(report => report.snapshot.view === 'cutoff');
  const lateLikeAt = nextIso(firstCutoffAt, 1);
  ctx.setNow(lateLikeAt);
  const lateWatermark = saveFeedback(ctx.f, firstRecoveryMember, 'like', lateLikeAt, 2);
  const lateCurrent = ctx.quality.calculate(sample1, lateWatermark, lateLikeAt);
  const preservedCutoff = reports(ctx.f, sample1).find(report => report.report_revision_id === firstCutoffReport.report_revision_id);
  assert.equal(lateCurrent.qualification, 'passed');
  assert.equal(preservedCutoff.snapshot.qualification, 'failed');
  assert.equal(incidentHistory(ctx.f, incident.canonical_root).at(-1).recovery_qualification, 'failed');

  const strategy2 = randomUUID();
  const activateAt2 = nextIso(lateLikeAt, 1);
  const recoveryStart2 = nextIso(activateAt2, 1);
  ctx.setNow(activateAt2);
  assert.equal(activateRecovery(ctx.quality, ctx.f, incident, strategy2, strategy1, activateAt2).status, 'succeeded');
  const sample2 = randomUUID();
  ctx.quality.registerSample({ sample_id: sample2, purpose: 'recovery', category: 'follow',
    incident_id: incident.incident_id, included_from: recoveryStart2,
    included_until: nextIso(recoveryStart2, 5 * 60_000), target_total: 1, strategy_version: strategy2 });
  const secondRecoveryMember = addSuccessfulRecommendation(ctx.f, 'recovery-2', {
    category: 'follow', dispatchedAt: recoveryStart2, strategyVersion: strategy2,
  });
  const secondFeedbackRevision = saveFeedback(ctx.f, secondRecoveryMember, 'dislike', secondRecoveryMember.successAt, 1);
  const secondCutoffAt = afterCutoff([secondRecoveryMember]);
  ctx.setNow(secondCutoffAt);
  const secondOutcome = ctx.quality.calculate(sample2, secondFeedbackRevision, secondCutoffAt);
  assert.equal(secondOutcome.qualification, 'failed');
  assert.equal(incidentHistory(ctx.f, incident.canonical_root).at(-1).adjustment_index, 2);
  assert.equal(incidentHistory(ctx.f, incident.canonical_root).at(-1).status, 'exhausted');

  const alternate = ctx.quality.openIncident({ report_revision_id: initialCutoff.report_revision_id });
  assert.equal(alternate.canonical_root, incident.canonical_root);
  assert.equal(alternate.incident_id, incident.incident_id);
  ctx.f.reopen();
  const reopenedQuality = createQuality({ store: ctx.f.store, owner: ctx.f.owner, now: () => secondCutoffAt });
  const strategy3 = randomUUID();
  assert.throws(() => activateRecovery(reopenedQuality, ctx.f, incident, strategy3, strategy2, secondCutoffAt),
    error => error.code === 'quality_incident_adjustment_limit');
  const finalHistory = incidentHistory(ctx.f, incident.canonical_root);
  assert.equal(finalHistory.at(-1).adjustment_index, 2);
  assert.equal(finalHistory.at(-1).status, 'exhausted');
  assert.deepEqual(reports(ctx.f, ctx.sampleId).find(report => report.report_revision_id === initialCutoff.report_revision_id)
    .snapshot.members.map(member => member.recommendation_id), originalInitialMembers);
  captureScenario('recovery_two_round_exhaustion', ctx.f, sample2,
    { initial_report: initialCutoff.report_revision_id, recovery_reports: [firstCutoffReport.report_revision_id,
      reports(ctx.f, sample2).find(report => report.snapshot.view === 'cutoff')?.report_revision_id],
      late_like_at: lateLikeAt, reopen_attempt: 'third activation rejected' },
    { first_cutoff: 'failed/open/index1', late_current: 'passed while frozen cutoff stays failed',
      second_cutoff: 'failed/exhausted/index2', third_activation: 'quality_incident_adjustment_limit',
      initial_members_unchanged: true }, secondOutcome);
});

test('按时通过的第一轮恢复在重复计算后保持 resolved；可重筛旧材料和分析，旧策略成功不混入', async t => {
  const ctx = await createTestContext(t, { target: 1 });
  const initial = addPopulation(ctx.f, 1);
  saveFeedback(ctx.f, initial[0], 'dislike', initial[0].successAt, 1);
  const initialAsOf = afterCutoff(initial);
  ctx.setNow(initialAsOf);
  ctx.quality.calculate(ctx.sampleId, maxFeedbackRevision(ctx.f), initialAsOf);
  const failedCutoff = reports(ctx.f, ctx.sampleId).find(report => report.snapshot.view === 'cutoff');
  const incident = ctx.quality.openIncident({ report_revision_id: failedCutoff.report_revision_id });

  const materialCreatedAt = nextIso(inclusionEnd, 60_000);
  const reusable = addUnrecommendedMaterial(ctx.f, { index: 1, discoveredAt: materialCreatedAt });
  const activationAt = nextIso(initialAsOf, 60_000);
  const recoveryStart = nextIso(activationAt, 1);
  const strategy = randomUUID();
  ctx.setNow(activationAt);
  assert.equal(activateRecovery(ctx.quality, ctx.f, incident, strategy, ctx.f.versions.strategy_version, activationAt).status, 'succeeded');
  const sampleId = randomUUID();
  ctx.quality.registerSample({ sample_id: sampleId, purpose: 'recovery', category: 'follow',
    incident_id: incident.incident_id, included_from: recoveryStart,
    included_until: nextIso(recoveryStart, 5 * 60_000), target_total: 1, strategy_version: strategy });

  const oldSuccessful = addSuccessfulRecommendation(ctx.f, 'old-success', {
    category: 'follow', dispatchedAt: recoveryStart, strategyVersion: ctx.f.versions.strategy_version,
  });
  const rescreened = addSuccessfulRecommendation(ctx.f, 'rescreened-old-material', {
    category: 'follow', dispatchedAt: nextIso(recoveryStart, 60_000), decisionCreatedAt: recoveryStart,
    strategyVersion: strategy, materialContext: reusable,
  });
  saveFeedback(ctx.f, oldSuccessful, 'dislike', oldSuccessful.successAt, 1);
  const feedbackRevision = saveFeedback(ctx.f, rescreened, 'like', rescreened.successAt, 1);
  const cutoffAt = afterCutoff([rescreened]);
  ctx.setNow(cutoffAt);
  const result = ctx.quality.calculate(sampleId, feedbackRevision, cutoffAt);
  assertMetrics(result.metrics, { N: 1, L: 1, D: 0, E: 0, U: 0, F: 0 });
  assert.equal(result.qualification, 'passed');
  const cutoffReport = reports(ctx.f, sampleId).find(report => report.snapshot.view === 'cutoff');
  assert.deepEqual(cutoffReport.snapshot.members.map(member => member.recommendation_id), [rescreened.recommendationId]);
  const attribution = ctx.f.store.db.prepare(`SELECT d.candidate_id,d.analysis_id,r.actual_strategy_version
    FROM recommendation r JOIN decision d USING(decision_id) WHERE r.recommendation_id=?`)
    .get(cutoffReport.snapshot.members[0].recommendation_id);
  assert.equal(attribution.candidate_id, reusable.candidateId);
  assert.equal(attribution.analysis_id, reusable.analysisId);
  assert.equal(attribution.actual_strategy_version, strategy);

  const before = incidentHistory(ctx.f, incident.canonical_root);
  assert.equal(before.at(-1).status, 'resolved');
  const duplicate = ctx.quality.calculate(sampleId, feedbackRevision, cutoffAt);
  assert.equal(duplicate.qualification, 'passed');
  assert.deepEqual(incidentHistory(ctx.f, incident.canonical_root), before);
  captureScenario('recovery_rescreen_legacy_material_and_resolved_idempotency', ctx.f, sampleId,
    { old_success_id: oldSuccessful.recommendationId, rescreened_id: rescreened.recommendationId,
      candidate_id: reusable.candidateId, analysis_id: reusable.analysisId },
    { N: 1, L: 1, old_success_excluded: true, old_candidate_analysis_reused: true,
      repeat_calculation: 'passed/resolved/idempotent' }, duplicate);
});
