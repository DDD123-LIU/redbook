import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDelivery } from '../src/delivery.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const { createQuality } = await import('../src/quality.mjs').catch(() => ({}));

const registeredAt = new Date(Date.now() - 1000).toISOString();
const t0 = new Date(Date.now() + 1000).toISOString();
const includedUntil = new Date(Date.now() + 30_000).toISOString();
const dispatchedAt = new Date(Date.now() + 2000).toISOString();
const businessDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

test('quality模块公开createQuality入口', () => {
  assert.equal(typeof createQuality, 'function');
});

async function registeredSample(t) {
  const f = await deliveryFixture(t, { businessDay });
  let now = registeredAt;
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => now });
  const sampleId = randomUUID();
  quality.registerSample({
    sample_id: sampleId,
    purpose: 'initial',
    category: 'follow',
    included_from: t0,
    included_until: includedUntil,
    target_total: null,
    strategy_version: f.versions.strategy_version,
  });
  return { f, quality, sampleId, now: () => now, advance: value => { now = value; } };
}

function deliveryClient(env, transport) {
  const { f } = env;
  return createDelivery({
    store: f.store,
    root: `${f.root}/delivery`,
    owner: f.owner,
    targetRef: 'synthetic-chat',
    appRef: 'synthetic-app',
    now: env.now,
    currentVersions: f.currentVersions,
    transport,
  });
}

async function delivered(t) {
  const env = await registeredSample(t);
  env.advance(dispatchedAt);
  const delivery = deliveryClient(env, {
    async send() {
      return { status: 'succeeded', message_id: 'synthetic-message', evidence: 'synthetic:receipt' };
    },
    async lookup() {
      return { status: 'unknown' };
    },
  });
  const { f } = env;
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal(prepared.status, 'succeeded');
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'succeeded');
  return env;
}

function saveFeedback(f, { value, revision, savedAt, correctionOf = null }) {
  const eventId = randomUUID();
  const db = f.store.db;
  db.prepare(`INSERT INTO feedback_event(
    app_ref,chat_ref,event_id,recommendation_id,content_id,value,received_at,saved_at,revision,
    correction_of_event_id,parse_state,association_state
  ) VALUES('synthetic-app','synthetic-chat',?,?,?,?,?,?,?,?,'parsed','matched')`).run(
    eventId,
    f.recommendation.recommendation_id,
    f.contentId,
    value,
    savedAt,
    savedAt,
    revision,
    correctionOf,
  );
  const previous = db.prepare('SELECT revision FROM feedback_current WHERE recommendation_id=?')
    .get(f.recommendation.recommendation_id);
  if (!previous) {
    db.prepare(`INSERT INTO feedback_current(
      owner,app_ref,chat_ref,platform,source_content_id,content_id,recommendation_id,value,revision,event_id,saved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.owner, 'synthetic-app', 'synthetic-chat', 'xiaohongshu', f.sourceContentId, f.contentId,
      f.recommendation.recommendation_id, value, revision, eventId, savedAt,
    );
  } else {
    db.prepare(`UPDATE feedback_current SET value=?,revision=?,event_id=?,saved_at=?
      WHERE recommendation_id=?`).run(value, revision, eventId, savedAt, f.recommendation.recommendation_id);
  }
  return db.prepare('SELECT max(feedback_history_id) AS id FROM feedback_history').get().id;
}

function reports(f, sampleId) {
  return f.store.db.prepare(`SELECT report_revision_id,snapshot_json FROM report_revision
    WHERE sample_id=? ORDER BY rowid`).all(sampleId).map(row => ({
    report_revision_id: row.report_revision_id,
    snapshot: JSON.parse(row.snapshot_json),
  }));
}

function successConfirmedAt(f) {
  return f.store.db.prepare(`SELECT changed_at FROM delivery_attempt_history
    WHERE delivery_attempt_id=(SELECT delivery_attempt_id FROM delivery_attempt WHERE recommendation_id=?)
      AND new_status='succeeded' ORDER BY history_id LIMIT 1`).get(f.recommendation.recommendation_id)?.changed_at;
}

function originalCutoff(f) {
  return new Date(Math.max(Date.parse(includedUntil), Date.parse(successConfirmedAt(f))) + 48 * 60 * 60 * 1000).toISOString();
}

test('calculate按成功唯一推荐和请求的反馈高水位形成可复算快照', async t => {
  const { f, quality, sampleId, advance } = await delivered(t);
  const feedbackSavedAt = new Date(Date.parse(successConfirmedAt(f)) + 1000).toISOString();
  const eventRevision = saveFeedback(f, {
    value: 'like', revision: 1, savedAt: feedbackSavedAt,
  });

  const asOf = new Date(Date.parse(originalCutoff(f)) + 60_000).toISOString();
  advance(asOf);
  quality.calculate(sampleId, eventRevision, asOf);

  const snapshots = reports(f, sampleId).map(({ snapshot }) => snapshot);
  assert(snapshots.length > 0);
  const snapshot = snapshots.find(value => value.event_revision === eventRevision);
  assert(snapshot);
  assert.equal(snapshot.metrics.N, 1);
  assert.equal(snapshot.metrics.L, 1);
  assert.equal(snapshot.metrics.D, 0);
  assert.equal(snapshot.metrics.E, 0);
  assert.equal(snapshot.metrics.S, 0);
  assert.equal(snapshot.metrics.U, 0);
  assert.equal(snapshot.metrics.F, 0);
});

test('迟到更正追加报告修订，不改写原截止报告', async t => {
  const { f, quality, sampleId, advance } = await delivered(t);
  const feedbackSavedAt = new Date(Date.parse(successConfirmedAt(f)) + 1000).toISOString();
  const firstWatermark = saveFeedback(f, {
    value: 'like', revision: 1, savedAt: feedbackSavedAt,
  });
  const cutoff = originalCutoff(f);
  const firstAsOf = new Date(Date.parse(cutoff) + 60_000).toISOString();
  advance(firstAsOf);
  quality.calculate(sampleId, firstWatermark, firstAsOf);
  const before = reports(f, sampleId);
  assert(before.length > 0);

  const correctionAt = new Date(Date.parse(cutoff) + 120_000).toISOString();
  advance(correctionAt);
  const secondWatermark = saveFeedback(f, {
    value: 'dislike', revision: 2, savedAt: correctionAt,
    correctionOf: f.store.db.prepare('SELECT event_id FROM feedback_current WHERE recommendation_id=?')
      .get(f.recommendation.recommendation_id).event_id,
  });
  const secondAsOf = new Date(Date.parse(correctionAt) + 60_000).toISOString();
  advance(secondAsOf);
  quality.calculate(sampleId, secondWatermark, secondAsOf);

  const after = reports(f, sampleId);
  assert(after.length > before.length);
  for (const old of before) {
    assert.deepEqual(after.find(row => row.report_revision_id === old.report_revision_id), old);
  }
  assert(after.some(row => row.snapshot.event_revision === secondWatermark
    && row.snapshot.metrics.D === 1 && row.snapshot.metrics.L === 0));
});

test('反馈高水位不变时的unknown补核也生成新快照', async t => {
  const env = await registeredSample(t);
  const { f, quality, sampleId, advance } = env;
  advance(dispatchedAt);
  const delivery = deliveryClient(env, {
      async send() {
        return { status: 'unknown', evidence: ['synthetic:send-result-unknown'] };
      },
      async lookup() {
        return { status: 'succeeded', message_id: 'synthetic-recovered-message', evidence: ['synthetic:readback'] };
      },
  });
  const prepared = await delivery.prepareDelivery(f.recommendation, f.generation);
  assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status, 'unknown');

  let firstAsOf = new Date(Date.now() + 5000).toISOString();
  advance(firstAsOf);
  quality.calculate(sampleId, 0, firstAsOf);
  const before = reports(f, sampleId);
  assert(before.length > 0);
  advance(new Date(Date.now() + 10_000).toISOString());
  assert.equal((await delivery.reconcileDelivery(prepared.attempt_id)).status, 'succeeded');
  const secondAsOf = new Date(Date.now() + 30_000).toISOString();
  advance(secondAsOf);
  quality.calculate(sampleId, 0, secondAsOf);

  const after = reports(f, sampleId);
  assert(after.length > before.length);
  for (const old of before) {
    assert.deepEqual(after.find(row => row.report_revision_id === old.report_revision_id), old);
  }
  assert(after.some(row => row.snapshot.event_revision === 0
    && row.snapshot.metrics.N === 1 && row.snapshot.metrics.U === 0));
});
