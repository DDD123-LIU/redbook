// 2026-10-24 Codex：隔离 SQLite 与合成事件，不访问账号或发送消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, saveContent } from '../src/storage.mjs';
import { readVerifiedPreference } from '../src/preference.mjs';
import { createFeedback, parseFeedbackText } from '../src/feedback.mjs';

const at = '2026-10-24T02:00:00.000Z';
test('人工仅追加3条，主动10及其他数量不误触发',()=>{
  for(const text of ['再来3条',' 再来 3 条 '])assert.deepEqual(parseFeedbackText(text),{kind:'request',request_type:'additional_follow',target:3});
  for(const text of ['推荐10条','推送10条','推荐20条','推荐10条\n再来3条','请推荐10条'])assert.equal(parseFeedbackText(text).kind,'invalid');
});
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = () => randomUUID();
const event = (f, text, extra = {}) => ({
  event_id: uuid(), message_id: `incoming-${uuid()}`, chat_ref: f.chatRef, sender_ref: f.senderRef,
  app_ref: f.appRef, created_at: at, received_at: at, text, ...extra,
});
const insert = (store, table, row) => {
  const keys = Object.keys(row);
  return store.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
};

async function fixture(t, { recommendations = 1, sameContent = false, categories=[] } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'redbook-feedback-'));
  const root = join(base, 'private');
  await mkdir(root);
  const store = openStore(join(base, 'state.sqlite'));
  let storeClosed = false;
  t.after(() => { if (!storeClosed) store.close(); return rm(base, { recursive: true, force: true }); });
  const owner = 'owner-test', appRef = 'app-test', chatRef = 'chat-test', senderRef = 'sender-test';
  const prefs = uuid(), strategy = uuid(), baseline = uuid();
  insert(store, 'preference_version', { preference_version: prefs, explicit_instructions_json: '["初始偏好"]', supporting_content_ids_json: '[]', hypotheses_json: '[]', confidence: 1, counterexamples_json: '[]', created_at: at });
  insert(store, 'strategy_version', { strategy_version: strategy, rule_diff_json: '{}', preference_version: prefs, effective_at: at, created_at: at });
  insert(store, 'baseline_version', { baseline_version: baseline, material_version_ids_json: '[]', coverage_description: 'synthetic', created_at: at });
  const sharedSourceId = `source-${uuid()}`;
  const items = [];
  for (let n = 1; n <= recommendations; n++) {
    const sourceId = sameContent ? sharedSourceId : `source-${uuid()}`;
    saveContent(store, { platform: 'synthetic', content_id: sourceId, source_url_ref: 'synthetic://source', source_state: 'unknown', last_observed_at: at });
    const cid = store.db.prepare('SELECT content_id FROM content WHERE platform=? AND source_content_id=?').get('synthetic', sourceId).content_id;
    const bid = uuid(), material = uuid(), analysis = uuid(), candidate = uuid(), decision = uuid(), recommendation = uuid();
    insert(store, 'batch', { delivery_batch_id: bid, owner, kind: 'daily_follow', business_day: `2026-10-${String(20 + n).padStart(2, '0')}`, target: 20, created_at: at, status: 'completed' });
    insert(store, 'material_version', { material_version_id: material, content_id: cid, body_ref: 'synthetic://body', body_hash: hash('body'), ordered_images_json: '[]', media_kind: 'text', fetched_at: at, material_hash: hash(`material-${n}`), completeness: 'complete', fetch_status: 'succeeded' });
    insert(store, 'analysis', { analysis_id: analysis, material_version_id: material, input_hash: hash('analysis-input'), prompt_version: 'test-v1', model_requested: 'synthetic', output_ref: 'synthetic://analysis', completion_evidence: 'synthetic://receipt', status: 'complete', created_at: at });
    insert(store, 'candidate', { candidate_id: candidate, content_id: cid, discovery_batch_id: bid, source: 'homefeed', discovered_at: at, source_evidence_ref: 'synthetic://candidate', eligibility_state: 'eligible' });
    insert(store, 'decision', { decision_id: decision, candidate_id: candidate, analysis_id: analysis, baseline_version: baseline, preference_version: prefs, strategy_version: strategy, category: categories[n-1]??'follow', relevance: 'matched', gain_state: 'gain', result: 'eligible', created_at: at });
    insert(store, 'recommendation', { recommendation_id: recommendation, content_id: cid, delivery_batch_id: bid, decision_id: decision, category: categories[n-1]??'follow', actual_preference_version: prefs, actual_strategy_version: strategy, state: 'succeeded', created_at: at, first_success_at: at });
    const item = { recommendation_id: recommendation, delivery_batch_id: bid, ordinal: 1, status: 'succeeded', payload: { msg_type: 'post', content: '{}' }, payload_hash: hash(`payload-${n}`) };
    const raw = `${JSON.stringify(item)}\n`, ref = join(root, `display-${n}.json`);
    await writeFile(ref, raw, { flag: 'wx' });
    insert(store, 'checkpoint', { checkpoint_id: uuid(), owner, run_id: `display-${n}`, generation: 1, delivery_batch_id: bid, stage: `display-build:${recommendation}`, succeeded_refs_json: JSON.stringify([{ ref, hash: hash(raw) }]), output_hash: hash(raw), committed_at: at });
    if (n === 1 || !sameContent) {
      insert(store, 'delivered_content', { owner, platform: 'synthetic', source_content_id: sourceId, recommendation_id: recommendation, first_success_at: at });
    }
    insert(store, 'delivery_attempt', { delivery_attempt_id: uuid(), recommendation_id: recommendation, target_ref: chatRef, payload_hash: hash(`payload-${n}`), intent_at: at, dispatched_at: at, returned_at: at, message_id: `sent-${n}`, status: 'succeeded', verification_evidence_refs_json: JSON.stringify([`synthetic:verified-${n}`]), created_at: at });
    items.push({ bid, recommendation, sourceId, contentId: cid, messageId: `sent-${n}`, ordinal: 1 });
  }
  const sent = [];
  const lookupCalls = [];
  let nextSend = { status: 'succeeded', message_id: 'receipt-1', evidence: 'synthetic:receipt' };
  let nextLookup = { status: 'unknown', evidence: 'synthetic:no-match' };
  const transport = {
    async send(payload) { sent.push(payload); return nextSend; },
    async lookup(query) { lookupCalls.push(query); return nextLookup; },
  };
  const create = () => createFeedback({ store, root, owner, appRef, chatRef, senderRef, transport, now: () => at });
  return { base, root, store, owner, appRef, chatRef, senderRef, items, sent, lookupCalls, transport, create, close() { if (!storeClosed) { store.close(); storeClosed = true; } }, setNextSend(value) { nextSend = value; }, setNextLookup(value) { nextLookup = value; } };
}

test('追加3保存原事件并生成不同稳定command，重放不新增请求',async t=>{
  const f=await fixture(t),feedback=f.create(),first=event(f,'再来3条'),second=event(f,'再来3条');
  assert.equal((await feedback.applyFeedback(first)).request_type,'additional_follow');
  assert.equal((await feedback.applyFeedback(second)).target,3);
  assert.equal((await feedback.applyFeedback(first)).status,'duplicate');
  const pending=(await feedback.pendingRequests()).filter(x=>x.request_type==='additional_follow');
  assert.equal(pending.length,2);assert.notEqual(pending[0].provenance.command_id,pending[1].provenance.command_id);
  const again=await feedback.pendingRequests({eventId:first.event_id});
  assert.equal(again.length,1);assert.equal(again[0].provenance.request_text,'再来3条');
  assert.equal(again[0].provenance.owner,f.owner);assert.equal(again[0].target,3);
});

test('跨任务私有目录的真实推荐凭据可解析，并恢复原未匹配评价', async t => {
  const f=await fixture(t),badRoot=join(f.base,'legacy-feedback');await mkdir(badRoot);
  const original=event(f,`${f.items[0].recommendation} 赞`);
  const wrong=createFeedback({...f,root:badRoot,now:()=>at});
  assert.equal((await wrong.applyFeedback(original)).status,'clarification_required');
  const corrected=createFeedback({...f,root:f.base,now:()=>at});
  assert.equal((await corrected.reprocessUnresolved(original.event_id)).status,'saved');
  assert.equal(f.store.db.prepare('SELECT value FROM feedback_current').get().value,'like');
  await corrected.reprocessUnresolved(original.event_id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_current').get().n,1);
});

test('纯文本解析区分评价、更正、查询和后续请求', () => {
  assert.equal(parseFeedbackText('1赞').value,'like');
  assert.equal(parseFeedbackText('查询1').kind,'query');
  assert.deepEqual(parseFeedbackText('550e8400-e29b-41d4-a716-446655440000 赞'), {
    kind: 'feedback', value: 'like', selector: { kind: 'recommendation', value: '550e8400-e29b-41d4-a716-446655440000' },
  });
  assert.equal(parseFeedbackText('更正 batch-1/03 踩').kind, 'correction');
  assert.deepEqual(parseFeedbackText('更正 550e8400-e29b-41d4-a716-446655440000 踩 修订1'), {
    kind: 'correction', value: 'dislike', expected_revision: 1,
    selector: { kind: 'recommendation', value: '550e8400-e29b-41d4-a716-446655440000' },
  });
  assert.equal(parseFeedbackText('更正 550e8400-e29b-41d4-a716-446655440000 踩').expected_revision, undefined);
  assert.equal(parseFeedbackText('查询 消息:message-1').kind, 'query');
  assert.deepEqual(parseFeedbackText('再来3条'), { kind: 'request', request_type: 'additional_follow', target: 3 });
  assert.deepEqual(parseFeedbackText('探索3条'), { kind: 'request', request_type: 'explore', target: 3 });
  assert.equal(parseFeedbackText('修改偏好：少看硬件新闻').kind, 'preference');
  assert.deepEqual(parseFeedbackText('删除偏好：娱乐新闻'), { kind: 'preference', operation: { kind: 'remove', instruction: '娱乐新闻' } });
  assert.deepEqual(parseFeedbackText('替换偏好：硬件 => 软件'), { kind: 'preference', operation: { kind: 'replace', old_instruction: '硬件', instruction: '软件' } });
});

test('关注探索按实际内容类别和版本查询，各保留唯一当前评价',async t=>{
 const f=await fixture(t,{recommendations:2,categories:['follow','explore']}),api=f.create();
 await api.applyFeedback(event(f,`${f.items[0].recommendation} 赞`));await api.applyFeedback(event(f,`${f.items[1].recommendation} 看过`));
 assert.equal(api.queryFeedback(f.items[0].recommendation).category,'follow');assert.equal(api.queryFeedback(f.items[1].recommendation).category,'explore');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_current').get().n,2);assert(api.queryFeedback(f.items[1].recommendation).actual_strategy_version);
});

test('追加及探索固定3条；看过改为赞须明确修订而非保存失败', async t => {
  const f=await fixture(t),api=f.create(),id=f.items[0].recommendation;
  for(const text of ['再来9条','探索20条'])assert.equal((await api.applyFeedback(event(f,text))).status,'clarification_required');
  assert.equal((await api.pendingRequests()).length,0);
  assert.equal((await api.applyFeedback(event(f,`${id} 看过`))).status,'saved');
  assert.equal((await api.applyFeedback(event(f,`${id} 赞`))).status,'clarification_required');
  assert.equal((await api.queryFeedback(id)).value,'seen');
  assert.equal((await api.applyFeedback(event(f,`更正 ${id} 赞 修订1`))).status,'saved');
  assert.equal((await api.queryFeedback(id)).value,'like');
});

test('旧解析失败以关联修订恢复；不覆盖原记录或重计已保存反馈',async t=>{
 const f=await fixture(t),api=f.create(),e=event(f,'旧解析器不支持的输入');await api.applyFeedback(e);
 const cp=f.store.db.prepare("SELECT checkpoint_id,succeeded_refs_json FROM checkpoint WHERE stage LIKE 'feedback-event:%'").get(),ref=JSON.parse(cp.succeeded_refs_json)[0].ref;
 const snapshot=JSON.parse(await readFile(ref,'utf8'));snapshot.text='1赞';const raw=JSON.stringify(snapshot);await writeFile(ref,raw);
 f.store.db.prepare('UPDATE checkpoint SET succeeded_refs_json=?,output_hash=? WHERE checkpoint_id=?').run(JSON.stringify([{ref,hash:hash(raw)}]),hash(raw),cp.checkpoint_id);
 assert.equal((await api.reprocessUnresolved(e.event_id)).status,'saved');assert.equal((await api.reprocessUnresolved(e.event_id)).status,'duplicate');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n,1);assert.equal(f.store.db.prepare('SELECT parse_state FROM feedback_event WHERE event_id=?').get(e.event_id).parse_state,'invalid');
});

test('固定本人绑定；按首次成功内容归属，同值不同事件只留事件不重复历史', async t => {
  const f = await fixture(t);
  const api = f.create();
  const wrong = event(f, `${f.items[0].recommendation} 赞`, { sender_ref: 'other-sender' });
  assert.equal((await api.applyFeedback(wrong)).status, 'ignored');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 0);

  const first = event(f, `${f.items[0].recommendation} 赞`);
  const saved = await api.applyFeedback(first);
  assert.equal(saved.status, 'saved');
  assert.ok(saved.outbox_id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT recommendation_id FROM feedback_current').get().recommendation_id, f.items[0].recommendation);
  assert.equal(f.sent.length, 0, 'applyFeedback must not send its receipt');

  assert.equal((await api.applyFeedback(first)).status, 'duplicate');
  const repeated = event(f, `${f.items[0].recommendation} 赞`);
  assert.equal((await api.applyFeedback(repeated)).status, 'saved');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 2);
});

test('看过不会覆盖赞踩；改值必须引用当前修订且旧修订不能回滚', async t => {
  const f = await fixture(t), api = f.create(), item = f.items[0];
  await api.applyFeedback(event(f, `${item.recommendation} 赞`));
  const seen = await api.applyFeedback(event(f, `${item.recommendation} 看过`));
  assert.equal(seen.status, 'clarification_required');
  assert.equal((await api.queryFeedback(item.recommendation)).value, 'like');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 1);

  assert.equal((await api.applyFeedback(event(f, `更正 ${item.recommendation} 踩`))).status, 'clarification_required');
  const correction = event(f, `更正 ${item.recommendation} 踩 修订1`);
  assert.equal((await api.applyFeedback(correction)).status, 'saved');
  assert.equal((await api.queryFeedback(item.recommendation)).value, 'dislike');
  assert.equal((await api.applyFeedback(event(f, `更正 ${item.recommendation} 看过`), 1)).status, 'clarification_required');
  assert.equal((await api.queryFeedback(item.recommendation)).value, 'dislike');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 2);
});

test('裸 ordinal 跨批次歧义时不写评价；消息引用在重启后按 event 去重', async t => {
  const f = await fixture(t, { recommendations: 2 });
  const item = f.items[1];
  const ambiguous = event(f, '1 赞');
  assert.equal((await f.create().applyFeedback(ambiguous)).status, 'clarification_required');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_current').get().n, 0);

  const ref = event(f, '赞', { parent_id: item.messageId });
  const api = f.create();
  const result = await api.applyFeedback(ref);
  assert.equal(result.status, 'saved');
  f.close();
  const reopened = openStore(join(f.base, 'state.sqlite'));
  const resumed = createFeedback({ store: reopened, root: f.root, owner: f.owner, appRef: f.appRef, chatRef: f.chatRef, senderRef: f.senderRef, transport: f.transport, now: () => at });
  assert.equal((await resumed.applyFeedback(ref)).status, 'duplicate');
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 2);
  reopened.close();
});

test('成功回执按事件独立 outbox 发送；unknown 只核实，不盲目重发', async t => {
  const f = await fixture(t), api = f.create(), result = await api.applyFeedback(event(f, `${f.items[0].recommendation} 赞`));
  assert.equal(f.sent.length, 0);
  f.setNextSend({ status: 'unknown', evidence: 'synthetic:timeout' });
  assert.equal((await api.sendReceipt(result.outbox_id)).status, 'unknown');
  assert.equal(f.sent.length, 1);
  assert.equal((await api.sendReceipt(result.outbox_id)).status, 'unknown');
  assert.equal(f.sent.length, 1);
  assert.equal((await api.reconcileReceipt(result.outbox_id)).status, 'unknown');
  assert.equal(f.sent.length, 1);
  assert.equal(f.lookupCalls.length, 1);
  assert.deepEqual(Object.keys(f.lookupCalls[0]).sort(), ['ended_at', 'message_id', 'outbox_id', 'payload', 'started_at', 'target_ref', 'uuid']);
  assert.match(JSON.parse(f.sent[0].content).text, new RegExp(result.outbox_id));
  assert.equal(f.store.db.prepare('SELECT value FROM feedback_current').get().value, 'like');
});

test('追加保存请求；探索明确不支持且不入待执行队列', async t => {
  const f = await fixture(t), api = f.create();
  const additional = event(f, '再来3条');
  const explore = event(f, '探索3条');
  assert.equal((await api.applyFeedback(additional)).status, 'request_pending');
  const unsupported=await api.applyFeedback(explore);
  assert.equal(unsupported.status, 'unsupported');
  await api.sendReceipt(unsupported.outbox_id);
  assert.match(JSON.stringify(f.sent),/暂不支持/);
  assert.deepEqual((await api.pendingRequests()).map(x => x.request_type).sort(), ['additional_follow']);
});

test('没有已验证父版本时偏好指令只进入待处理，不发布版本', async t => {
  const f = await fixture(t), api = f.create();
  const result = await api.applyFeedback(event(f, '修改偏好：减少娱乐新闻'));
  assert.equal(result.status, 'preference_pending');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM preference_version').get().n, 1);
  assert.equal((await api.pendingRequests()).length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event WHERE saved_at IS NOT NULL').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT parse_state FROM feedback_event').get().parse_state, 'parsed');
});

test('有效父版上的显式偏好与已保存事件同事务发布并获得成功回执正文', async t => {
  const f = await fixture(t), prefs = f.store.db.prepare('SELECT preference_version FROM preference_version LIMIT 1').get().preference_version;
  const input = { explicit_instructions: ['初始偏好'], analyses: [] }, inputHash = hash(JSON.stringify(input));
  const inputRef = join(f.root, 'seed-input.json'), output = { hypotheses: [], counterexamples: [] }, outputRef = join(f.root, 'seed-output.json');
  await writeFile(inputRef, JSON.stringify({ ...input, input_hash: inputHash }));
  await writeFile(outputRef, JSON.stringify(output));
  const receipt = { exitCode: 0, stdout: '{"type":"turn.completed"}', kind: 'preference', input_hash: inputHash, input_ref: inputRef,
    input_file_hash: hash(await readFile(inputRef)), output_ref: outputRef, output_hash: hash(await readFile(outputRef)) };
  const receiptRef = join(f.root, 'seed-receipt.json'); await writeFile(receiptRef, JSON.stringify(receipt));
  const manifest = { preference_version: prefs, input, input_hash: inputHash, output_ref: outputRef, output_hash: receipt.output_hash,
    receipt_ref: receiptRef, receipt_hash: hash(await readFile(receiptRef)) };
  const manifestRef = join(f.root, 'seed-manifest.json'); await writeFile(manifestRef, JSON.stringify(manifest));
  const pointer = { preference_version: prefs, input_hash: inputHash, manifest_ref: manifestRef, manifest_hash: hash(await readFile(manifestRef)) };
  insert(f.store, 'checkpoint', { checkpoint_id: uuid(), owner: f.owner, run_id: 'parent-pref', generation: 0, stage: `preference-current:${f.owner}`, succeeded_refs_json: JSON.stringify([pointer]), committed_at: at });

  const result = await f.create().applyFeedback(event(f, '修改偏好：少看营销'));
  assert.equal(result.status, 'saved');
  assert.equal(readVerifiedPreference(f.store, f.owner).explicit_instructions.join(','), '初始偏好,少看营销');
  assert.equal(f.store.db.prepare('SELECT parse_state FROM feedback_event').get().parse_state, 'parsed');
  const outboxFile = JSON.parse(await readFile(join(f.root, 'feedback', `receipt-${result.outbox_id}.json`), 'utf8'));
  assert.match(JSON.parse(outboxFile.request.content).text, /偏好指令已生效/);
});

test('私有事件文件写入失败不留业务行，修复目录后同event可重试', async t => {
  const f = await fixture(t), api = f.create(), incoming = event(f, `${f.items[0].recommendation} 赞`);
  await writeFile(join(f.root, 'feedback'), 'blocked');
  assert.equal((await api.applyFeedback(incoming)).status, 'save_failed');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n, 0);
  await rm(join(f.root, 'feedback'));
  assert.equal((await api.applyFeedback(incoming)).status, 'saved');
});

test('迟到反馈不能覆盖较新的事件；重复竞争事件返回duplicate', async t => {
  const f = await fixture(t), api = f.create(), item = f.items[0];
  const newer = { ...event(f, `${item.recommendation} 赞`), created_at: '2026-10-24T03:00:00.000Z' };
  assert.equal((await api.applyFeedback(newer)).status, 'saved');
  const older = { ...event(f, `更正 ${item.recommendation} 踩 修订1`), created_at: '2026-10-24T01:00:00.000Z' };
  assert.equal((await api.applyFeedback(older)).status, 'clarification_required');
  assert.equal((await api.applyFeedback(newer)).status, 'duplicate');
  assert.equal((await api.queryFeedback(item.recommendation)).value, 'like');
});

test('重复推荐UUID和后续消息ID解析到canonical first-success记录', async t => {
  const f = await fixture(t, { recommendations: 2, sameContent: true }), api = f.create();
  assert.equal((await api.applyFeedback(event(f, `${f.items[1].recommendation} 赞`))).status, 'saved');
  assert.equal((await api.applyFeedback(event(f, `查询 ${f.items[1].bid}/1`))).status, 'query');
  assert.equal((await api.applyFeedback(event(f, `更正 ${f.items[1].bid}/1 踩 修订1`))).status, 'saved');
  assert.equal(f.store.db.prepare('SELECT recommendation_id FROM feedback_current').get().recommendation_id, f.items[0].recommendation);
});

test('并发不同事件不能互相覆盖当前值，后到事务澄清而保留首个提交', async t => {
  const f = await fixture(t), api = f.create(), item = f.items[0];
  const [like, dislike] = await Promise.all([
    api.applyFeedback(event(f, `${item.recommendation} 赞`)),
    api.applyFeedback(event(f, `${item.recommendation} 踩`)),
  ]);
  assert.deepEqual([like.status, dislike.status], ['saved', 'clarification_required']);
  assert.equal((await api.queryFeedback(item.recommendation)).value, 'like');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n, 1);
});

test('独立进程保存反馈后退出，重启只发送已保存的回执', async t => {
  const f = await fixture(t), incoming = event(f, `${f.items[0].recommendation} 赞`);
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/storage.mjs')).href;
  const feedbackUrl = pathToFileURL(join(process.cwd(), 'src/feedback.mjs')).href;
  const script = `import {openStore} from ${JSON.stringify(storeUrl)}; import {createFeedback} from ${JSON.stringify(feedbackUrl)};
    const store=openStore(${JSON.stringify(join(f.base, 'state.sqlite'))});
    const api=createFeedback({store,root:${JSON.stringify(f.root)},owner:${JSON.stringify(f.owner)},appRef:${JSON.stringify(f.appRef)},chatRef:${JSON.stringify(f.chatRef)},senderRef:${JSON.stringify(f.senderRef)},transport:{send:async()=>{throw Error('apply must not send')},lookup:async()=>({status:'unknown'})},now:()=>${JSON.stringify(at)}});
    const result=await api.applyFeedback(${JSON.stringify(incoming)}); store.close(); process.exit(result.status==='saved'?0:1);`;
  f.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const store = openStore(join(f.base, 'state.sqlite'));
  const outboxId = store.db.prepare('SELECT outbox_id FROM outbox WHERE kind=\'feedback_receipt\'').get().outbox_id;
  let sends = 0;
  const api = createFeedback({ store, root: f.root, owner: f.owner, appRef: f.appRef, chatRef: f.chatRef, senderRef: f.senderRef,
    transport: { async send() { sends++; return { status: 'succeeded', message_id: 'after-restart', evidence: 'synthetic' }; }, async lookup() { return { status: 'unknown' }; } }, now: () => at });
  assert.equal((await api.sendReceipt(outboxId)).status, 'succeeded');
  assert.equal(sends, 1);
  store.close();
});

test('已绑定outbox结果hash损坏不绕过校验，保持unknown并查询', async t => {
  const f=await fixture(t),api=f.create();f.setNextSend({status:'unknown'});
  const saved=await api.applyFeedback(event(f,`${f.items[0].recommendation} 赞`));await api.sendReceipt(saved.outbox_id);
  const cp=f.store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1').get(`feedback-receipt-result:${saved.outbox_id}`);
  const ref=JSON.parse(cp.succeeded_refs_json)[0].ref,result=JSON.parse(await readFile(ref,'utf8'));await writeFile(ref,JSON.stringify({...result,status:'succeeded',message_id:null,evidence:null}));
  assert.equal((await api.reconcileReceipt(saved.outbox_id)).status,'unknown');assert.equal(f.lookupCalls.length,1);
  assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(saved.outbox_id).state,'unknown');
});

test('数据库历史succeeded但结果checkpoint坏hash或丢失时不声称已核实且不重发', async t => {
  for (const damage of ['hash', 'missing']) {
    const f=await fixture(t),api=f.create(),saved=await api.applyFeedback(event(f,`${f.items[0].recommendation} 赞`));
    assert.equal((await api.sendReceipt(saved.outbox_id)).status,'succeeded');
    const cp=f.store.db.prepare('SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1').get(`feedback-receipt-result:${saved.outbox_id}`);
    if(damage==='hash'){
      const ref=JSON.parse(cp.succeeded_refs_json)[0].ref;
      await writeFile(ref,JSON.stringify({outbox_id:saved.outbox_id,status:'succeeded',message_id:'tampered'}));
    }else f.store.db.prepare('DELETE FROM checkpoint WHERE checkpoint_id=?').run(cp.checkpoint_id);
    f.setNextLookup({status:'unknown',reason:'no_matching_receipt',evidence:'synthetic:lookup-empty'});
    assert.equal((await api.reconcileReceipt(saved.outbox_id)).status,'evidence_unverifiable');
    assert.equal((await api.sendReceipt(saved.outbox_id)).status,'evidence_unverifiable');
    assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(saved.outbox_id).state,'succeeded');
    assert.equal(f.sent.length,1);
    assert.equal(f.lookupCalls.length,2);
  }
});

test('崩溃遗留intent的unknown核验结果CAS落盘并在SQLite重开后保留', async t => {
  const f=await fixture(t),saved=await f.create().applyFeedback(event(f,`${f.items[0].recommendation} 赞`));
  const marker=join(f.base,'sdk-call.marker'),storeUrl=pathToFileURL(join(process.cwd(),'src/storage.mjs')).href,feedbackUrl=pathToFileURL(join(process.cwd(),'src/feedback.mjs')).href;
  const script=`import {openStore} from ${JSON.stringify(storeUrl)};import {createFeedback} from ${JSON.stringify(feedbackUrl)};import {writeFileSync} from 'node:fs';
    const store=openStore(${JSON.stringify(join(f.base,'state.sqlite'))});const api=createFeedback({store,root:${JSON.stringify(f.root)},owner:${JSON.stringify(f.owner)},appRef:${JSON.stringify(f.appRef)},chatRef:${JSON.stringify(f.chatRef)},senderRef:${JSON.stringify(f.senderRef)},transport:{async send(){writeFileSync(${JSON.stringify(marker)},'SDK_CREATE_CALLED');process.exit(88)},async lookup(){return {status:'unknown'}}}});
    await api.sendReceipt(${JSON.stringify(saved.outbox_id)});process.exit(1);`;
  f.close();
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(child.status,88,child.stderr);assert.equal(await readFile(marker,'utf8'),'SDK_CREATE_CALLED');
  let store=openStore(join(f.base,'state.sqlite'));
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(saved.outbox_id).state,'intent');
  const api=createFeedback({store,root:f.root,owner:f.owner,appRef:f.appRef,chatRef:f.chatRef,senderRef:f.senderRef,
    transport:{async send(){throw Error('must not resend')},async lookup(){return {status:'unknown',reason:'zero_matches_or_forbidden',evidence:'synthetic:lookup-empty'}}},now:()=>at});
  assert.equal((await api.reconcileReceipt(saved.outbox_id)).status,'unknown');
  const cp=store.db.prepare('SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1').get(`feedback-receipt-result:${saved.outbox_id}`);
  const data=JSON.parse(await readFile(JSON.parse(cp.succeeded_refs_json)[0].ref,'utf8'));
  assert.equal(data.status,'unknown');assert.equal(data.reason,'zero_matches_or_forbidden');assert.equal(data.evidence,'synthetic:lookup-empty');
  store.close();store=openStore(join(f.base,'state.sqlite'));
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(saved.outbox_id).state,'unknown');
  store.close();
});

test('独立进程在outbox结果文件落盘后退出，重启核实后补账不重发', async t => {
  const f = await fixture(t), saved = await f.create().applyFeedback(event(f, `${f.items[0].recommendation} 赞`));
  const flag = join(f.base, 'sent.flag');
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/storage.mjs')).href;
  const feedbackUrl = pathToFileURL(join(process.cwd(), 'src/feedback.mjs')).href;
  const script = `import {openStore} from ${JSON.stringify(storeUrl)}; import {createFeedback} from ${JSON.stringify(feedbackUrl)}; import {writeFileSync} from 'node:fs';
    const store=openStore(${JSON.stringify(join(f.base, 'state.sqlite'))}); const tx=store.transaction.bind(store); let calls=0;
    store.transaction=(callback)=>{calls++;if(calls===2)process.exit(77);return tx(callback)};
    const api=createFeedback({store,root:${JSON.stringify(f.root)},owner:${JSON.stringify(f.owner)},appRef:${JSON.stringify(f.appRef)},chatRef:${JSON.stringify(f.chatRef)},senderRef:${JSON.stringify(f.senderRef)},transport:{async send(){writeFileSync(${JSON.stringify(flag)},'sent');return {status:'succeeded',message_id:'receipt-after-crash',evidence:'synthetic'}},async lookup(){return {status:'unknown'}}}});
    await api.sendReceipt(${JSON.stringify(saved.outbox_id)}); process.exit(1);`;
  f.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(await readFile(flag, 'utf8'), 'sent');
  const store = openStore(join(f.base, 'state.sqlite')); let sends = 0, lookups = 0;
  const api = createFeedback({ store, root: f.root, owner: f.owner, appRef: f.appRef, chatRef: f.chatRef, senderRef: f.senderRef,
    transport: { async send() { sends++; return { status: 'succeeded', message_id: 'must-not-resend' }; }, async lookup(query) { lookups++; assert.equal(query.message_id,'receipt-after-crash'); return { status: 'succeeded',message_id:'receipt-after-crash',evidence:'synthetic:verified-query' }; } }, now: () => at });
  assert.equal((await api.reconcileReceipt(saved.outbox_id)).status, 'succeeded');
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(saved.outbox_id).state, 'succeeded');
  assert.equal(sends, 0); assert.equal(lookups, 1);
  store.close();
});
