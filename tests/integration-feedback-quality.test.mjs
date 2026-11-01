// 2026-10-26 Codex：本轮完整入口生成推荐后，连接实际反馈、监听及质量模块；平台事件均为合成。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFeedback } from '../src/feedback.mjs';
import { createFeishuListener } from '../src/feishu-listener.mjs';
import { createFeishuTransport } from '../src/feishu-adapter.mjs';
import { createQuality } from '../src/quality.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

test('I10 新首页整链推荐接真实handler反馈更正及质量监测，旧报告保持不可变', async t => {
  const f = await createDailyIntegrationFixture(t);
  const outcome = await f.run();
  assert.equal(outcome.delivered, 1);
  const rec = f.store.db.prepare('SELECT * FROM recommendation WHERE delivery_batch_id=?').get(outcome.batch_id);
  assert.equal(rec.state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 0);
  let time = '2026-10-26T03:16:00.000Z';
  const now = () => time;
  const app = 'synthetic-app', chat = 'synthetic-target', sender = 'synthetic-feedback-user';
  const messages = [];
  let expectedSaved;
  const client = { im: { message: {
    async create({ data }) {
      assert.equal(data.msg_type, 'text');
      const savedEvent = f.store.db.prepare('SELECT * FROM feedback_event WHERE app_ref=? AND chat_ref=? AND event_id=?')
        .get(app, chat, expectedSaved.eventId);
      assert.ok(savedEvent?.saved_at, '本次事件必须先于其回执发送提交');
      assert.equal(savedEvent.recommendation_id, rec.recommendation_id);
      const savedCurrent = f.store.db.prepare('SELECT value,revision FROM feedback_current WHERE recommendation_id=?')
        .get(rec.recommendation_id);
      assert.deepEqual({ ...savedCurrent }, { value: expectedSaved.value, revision: expectedSaved.revision });
      if (expectedSaved.query) {
        assert.ok(JSON.parse(data.content).text.includes('当前评价：like，修订 1。'));
      }
      const message = { message_id: `feedback-receipt-${messages.length + 1}`, chat_id: chat,
        msg_type: data.msg_type, body: { content: data.content }, create_time: String(Date.parse(now())),
        sender: { sender_type: 'app', id: app } };
      messages.push(message);
      return { code: 0, data: { message_id: message.message_id } };
    },
    async get({ path }) { return { code: 0, data: { items: messages.filter(x => x.message_id === path.message_id) } }; },
    async list() { return { code: 0, data: { items: messages, has_more: false } }; },
  } } };
  const transport = createFeishuTransport({ client, targetRef: chat, appRef: app, root: f.root, now });
  const feedback = createFeedback({ store: f.store, root: f.root, owner: f.owner,
    appRef: app, chatRef: chat, senderRef: sender, transport, now });
  let dispatch;
  const Lark = { EventDispatcher: class {
    register(handlers) { dispatch = handlers['im.message.receive_v1']; return this; }
  } };
  const listener = createFeishuListener({ Lark, wsClient: { async start() {}, close() {} },
    feedback, appRef: app, chatRef: chat, senderRef: sender, now });
  await listener.start();
  t.after(() => listener.stop());
  const event = text => ({ header: { app_id: app, event_id: randomUUID() }, event: {
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: { message_id: randomUUID(), chat_id: chat, chat_type: 'p2p', message_type: 'text',
      create_time: String(Date.parse(now())), content: JSON.stringify({ text }) },
  } });
  const liked = event('1 赞');
  expectedSaved = { eventId: liked.header.event_id, value: 'like', revision: 1 };
  assert.equal((await dispatch(liked)).receipt?.status, 'succeeded');
  assert.deepEqual({ ...f.store.db.prepare('SELECT recommendation_id,value,revision FROM feedback_current').get() },
    { recommendation_id: rec.recommendation_id, value: 'like', revision: 1 });

  time = '2026-10-26T03:17:00.000Z';
  const quality = createQuality({ store: f.store, owner: f.owner, now });
  const sample = `task015-monitor-${randomUUID()}`;
  quality.registerMonitorSample({ sample_id: sample, category: 'follow', as_of: now() });
  const watermark = () => f.store.db.prepare('SELECT coalesce(max(feedback_history_id),0) n FROM feedback_history').get().n;
  const firstRevision = watermark();
  const firstReport = quality.calculate(sample, firstRevision, now());
  assert.equal(firstReport.status, 'succeeded');
  assert.deepEqual(firstReport.metrics, { N: 1, L: 1, D: 0, E: 0, S: 0, U: 0, F: 0, boundary_unknowns: 0 });
  const reports = () => f.store.db.prepare('SELECT * FROM report_revision WHERE sample_id=? ORDER BY rowid').all(sample);
  const originalReports = reports();
  assert.ok(originalReports.length > 0);
  assert.ok(originalReports.some(row => JSON.parse(row.snapshot_json).members
    .some(member => member.recommendation_id === rec.recommendation_id)));
  assert.equal(f.store.db.prepare('SELECT target_total FROM sample WHERE sample_id=?').get(sample).target_total, null,
    '监控样本不得擅定016试用目标');

  time = '2026-10-26T03:18:00.000Z';
  const queried = event('查询 1');
  expectedSaved = { eventId: queried.header.event_id, value: 'like', revision: 1, query: true };
  const queryResult = await dispatch(queried);
  assert.equal(queryResult.business_status, 'query');
  assert.equal(queryResult.receipt?.status, 'succeeded');
  const corrected = event('更正 1 踩 修订1');
  expectedSaved = { eventId: corrected.header.event_id, value: 'dislike', revision: 2 };
  assert.equal((await dispatch(corrected)).receipt?.status, 'succeeded');
  const beforeReplay = { history: watermark(), sends: messages.length,
    outbox: f.store.db.prepare('SELECT count(*) n FROM outbox').get().n };
  await dispatch(liked);
  assert.equal(messages.length, beforeReplay.sends);
  assert.equal(watermark(), beforeReplay.history);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n, beforeReplay.outbox);
  assert.deepEqual({ ...f.store.db.prepare('SELECT recommendation_id,value,revision FROM feedback_current').get() },
    { recommendation_id: rec.recommendation_id, value: 'dislike', revision: 2 });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 2);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE state='succeeded'").get().n, 3);
  const revised = quality.calculate(sample, watermark(), now());
  assert.equal(revised.status, 'succeeded');
  assert.deepEqual(revised.metrics, { N: 1, L: 0, D: 1, E: 0, S: 0, U: 0, F: 0, boundary_unknowns: 0 });
  const latestReports = reports();
  assert.ok(latestReports.length > originalReports.length);
  for (const original of originalReports) {
    assert.deepEqual(latestReports.find(row => row.report_revision_id === original.report_revision_id), original);
  }
  await f.writeEvidence({ scenario: 'I10', batch_id: outcome.batch_id, recommendation_id: rec.recommendation_id,
    sample_id: sample, first_feedback_watermark: firstRevision, corrected_feedback_watermark: watermark(),
    original_report_ids: originalReports.map(x => x.report_revision_id),
    report_ids: latestReports.map(x => x.report_revision_id), metrics: revised.metrics,
    qualification: revised.qualification, blockers: revised.blockers,
    feedback: f.store.db.prepare('SELECT recommendation_id,value,revision FROM feedback_current').all(),
    outbox: f.store.db.prepare('SELECT outbox_id,state FROM outbox').all(), receipt_count: messages.length,
    input_event_ids: [liked.header.event_id, queried.header.event_id, corrected.header.event_id],
    synthetic_only: true, real_quality_claim: false });
});
