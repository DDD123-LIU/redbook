import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTask013Host } from '../src/orchestration-host.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task013-host-'));
  const configPath = join(root, 'host.json');
  const config = {
    dbPath: join(root, 'state.sqlite'),
    root: join(root, 'artifacts'),
    owner: 'task013-host-test-owner',
    appRef: 'task013-test-app',
    targetRef: 'task013-test-target',
    taskSpaceId: 14,
    pageLabel: 'p2',
  };
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = { label: 'p2', async url() { return 'https://www.xiaohongshu.com/explore'; } };
  const task = { spaceId: 14, ownership: 'agent', async pages() { return [page]; } };
  return { root, configPath, config, page, task, taskSpace: async id => id === 14 ? task : null };
}

test('宿主配置要求绝对DB与产物路径', async t => {
  const f = await fixture(t);
  f.config.root = 'relative-artifacts';
  await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'periodic', taskSpace: f.taskSpace }), /absolute/i);
});

test('TaskSpace必须用正整数ID，不能按名称解析以免新建空间', async t => {
  const f = await fixture(t);
  f.config.taskSpaceId = '14';
  await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'periodic', taskSpace: f.taskSpace }), /numeric id/i);
});

test('scheduled入口绑定配置中的原Page并复用同日blocked批次', async t => {
  const f = await fixture(t);
  const now = () => '2026-10-24T04:00:00.000Z';
  const first = await runTask013Host({ configPath: f.configPath, source: 'scheduled', taskSpace: f.taskSpace, now });
  const second = await runTask013Host({ configPath: f.configPath, source: 'periodic', taskSpace: f.taskSpace, now });
  assert.equal(first.status, 'blocked');
  assert.match(first.reason, /runtime capabilities/i);
  assert.ok(first.batch_id);
  assert.equal(second.batch_id, first.batch_id);
  assert.equal(second.status, 'blocked');
});

test('Page标签缺失时不改绑或新建空间', async t => {
  const f = await fixture(t);
  f.task.pages = async () => [];
  const result = await runTask013Host({ configPath: f.configPath, source: 'manual_daily', taskSpace: f.taskSpace,
    now: () => '2026-10-24T04:00:00.000Z' });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /tab/i);
  const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(saved.taskSpaceId, 14);
  assert.equal(saved.pageLabel, 'p2');
});

test('同空间Page若不是小红书来源则阻塞', async t => {
  const f = await fixture(t);
  f.page.url = async () => 'https://example.com/';
  const result = await runTask013Host({ configPath: f.configPath, source: 'scheduled', taskSpace: f.taskSpace,
    now: () => '2026-10-24T04:00:00.000Z' });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /tab/i);
});

test('manual_daily来源仅执行每日入口且不能请求探索批次', async t => {
  const f = await fixture(t);
  const result = await runTask013Host({ configPath: f.configPath, source: 'manual_daily', taskSpace: f.taskSpace,
    invocation: { kind: 'explore', direction: 'ignored' }, now: () => '2026-10-24T03:00:00.000Z' });
  assert.equal(result.status, 'not_due');
  assert.equal(result.business_day, '2026-10-24');
});

test('recovery_startup仍只进入每日门控', async t => {
  const f = await fixture(t);
  const result = await runTask013Host({ configPath: f.configPath, source: 'recovery_startup', taskSpace: f.taskSpace,
    now: () => '2026-10-24T03:00:00.000Z' });
  assert.equal(result.status, 'not_due');
  assert.equal(result.business_day, '2026-10-24');
});

test('显式recover操作仍要求旧run身份和退出证据', async t => {
  const f = await fixture(t);
  let bound = false;
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'recover',
    invocation: { explicitRequest: true }, taskSpace: async () => { bound = true; return f.task; } }), /confirmedStoppedRunId.*evidenceRef/i);
  assert.equal(bound, false);
});

test('additional必须是显式manual_daily且带commandId与原请求文本', async t => {
  const f = await fixture(t);
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'periodic', operation: 'additional',
    invocation: { explicitRequest: true, commandId: 'c', requestText: '再来3条' }, taskSpace: f.taskSpace }), /manual_daily authorization/i);
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'additional',
    invocation: { explicitRequest: true, commandId: 'c' }, taskSpace: f.taskSpace }), /commandId and requestText/i);
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'additional',
    invocation: { explicitRequest: true, requestText: '再来3条' }, taskSpace: f.taskSpace }), /commandId and requestText/i);
});

test('host additional拒绝无反馈provenance且不建批；真实pending建3条批并幂等重放', async t => {
  const f = await fixture(t);
  const feedbackUrl = pathToFileURL(fileURLToPath(new URL('../src/feedback.mjs', import.meta.url))).href;
  await writeFile(join(f.root, 'runtime.mjs'), `import { createFeedback } from ${JSON.stringify(feedbackUrl)};
export async function createRuntime({ config, store, now }) {
  return { feedback: createFeedback({ store, root: config.root, owner: config.owner, appRef: config.appRef,
    chatRef: config.targetRef, senderRef: 'sender', now,
    transport: { async send(){ return {status:'succeeded',message_id:'unused'}; }, async lookup(){ return {status:'unknown'}; } } }) };
}`);
  f.config.runtimeModule = join(f.root, 'runtime.mjs');
  f.config.productionEnabled = true;
  await writeFile(f.configPath, JSON.stringify(f.config));
  const invocation = { explicitRequest: true, commandId: 'missing-request', requestText: '再来3条' };
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'additional',
    invocation, taskSpace: f.taskSpace, now: () => '2026-10-24T04:00:00.000Z' }), /not pending/i);
  const db = (await import('../src/storage.mjs')).openStore(f.config.dbPath);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM batch').get().n, 0);
  db.close();

  const hostStore = (await import('../src/storage.mjs')).openStore(f.config.dbPath);
  const { createFeedback } = await import('../src/feedback.mjs');
  const feedback = createFeedback({ store: hostStore, root: f.config.root, owner: f.config.owner, appRef: f.config.appRef,
    chatRef: f.config.targetRef, senderRef: 'sender', now: () => '2026-10-24T04:00:00.000Z',
    transport: { async send(){ return {status:'succeeded',message_id:'unused'}; }, async lookup(){ return {status:'unknown'}; } } });
  const event = { app_ref: f.config.appRef, chat_ref: f.config.targetRef, sender_ref: 'sender', event_id: 'event-1',
    message_id: 'message-1', created_at: '2026-10-24T04:00:00.000Z', received_at: '2026-10-24T04:00:00.000Z',
    source_message_type: 'text', text: '再来3条' };
  assert.equal((await feedback.applyFeedback(event)).status, 'request_pending');
  const [pending] = await feedback.pendingRequests({ eventId: event.event_id });
  hostStore.close();

  const actualInvocation = { explicitRequest: true, commandId: pending.provenance.command_id, requestText: pending.provenance.request_text };
  const first = await runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'additional',
    invocation: actualInvocation, taskSpace: f.taskSpace, now: () => '2026-10-24T04:00:00.000Z' });
  const second = await runTask013Host({ configPath: f.configPath, source: 'manual_daily', operation: 'additional',
    invocation: actualInvocation, taskSpace: f.taskSpace, now: () => '2026-10-24T04:00:00.000Z' });
  assert.equal(first.status, 'blocked');
  assert.match(first.reason, /runtime capabilities/i);
  assert.equal(first.batch_id, second.batch_id);
  const check = (await import('../src/storage.mjs')).openStore(f.config.dbPath);
  const rows = check.db.prepare('SELECT kind,target,command_id FROM batch').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ kind: 'additional_follow', target: 3, command_id: actualInvocation.commandId }]);
  check.close();
});

test('定时来源不能调用显式恢复操作', async t => {
  const f = await fixture(t);
  await assert.rejects(() => runTask013Host({ configPath: f.configPath, source: 'recovery_startup', operation: 'recover',
    invocation: { explicitRequest: true, confirmedStoppedRunId: 'old-run', evidenceRef: 'exit-proof' } }), /manual_daily authorization/i);
});

