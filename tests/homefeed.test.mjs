import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { openStore } from '../src/storage.mjs';
import { createHomefeed } from '../src/homefeed.mjs';

const ID = 'a'.repeat(24);
test('每日定时可指定10条，新日批持久目标10；旧20批不静默改写',async t=>{
 const a=await fixture(t);const fresh=a.hf.beginBatch({kind:'daily_follow',target:10});assert.equal(fresh.target,10);assert.equal(a.hf.beginBatch({kind:'daily_follow',target:10}).batch_id,fresh.batch_id);
 const b=await fixture(t);const old=b.hf.beginBatch({kind:'daily_follow'});assert.equal(old.target,20);assert.throws(()=>b.hf.beginBatch({kind:'daily_follow',target:10}),/target/);assert.equal(b.store.db.prepare('SELECT target FROM batch WHERE delivery_batch_id=?').get(old.batch_id).target,20);
});
const url = (id = ID) => `https://www.xiaohongshu.com/explore/${id}?xsec_token=secret`;

test('正式多轮可明确扩展候选预算，200检查点后新增候选且重放不重复', async t => {
  const {root,store,hf}=await fixture(t);
  const batch=hf.beginBatch({kind:'daily_follow'});
  const page=(ids,at)=>({source_page:'https://www.xiaohongshu.com/explore',observed_at:at,page_state:'ready',observations:ids.map(content_id=>({content_id,complete_source_url:url(content_id)})),anchor_id:ids.at(-1),advanced:false,read_method:'test'});
  await hf.recordPage(batch.batch_id,page(Array.from({length:200},(_,i)=>i.toString(16).padStart(24,'0')),'2026-10-23T04:00:00Z'));
  const expanded=createHomefeed({store,root:join(root,'private'),owner:'owner',now:()=> '2026-10-23T04:01:00Z',candidateLimit:230});
  const next=page(['f'.repeat(24)],'2026-10-23T04:01:00Z');
  const saved=await expanded.recordPage(batch.batch_id,next);
  assert.equal(saved.unique_count,201);assert.equal(saved.stop_reason,null);
  await expanded.recordPage(batch.batch_id,next);
  assert.equal(store.db.prepare('SELECT count(*) n FROM candidate WHERE discovery_batch_id=?').get(batch.batch_id).n,201);
  assert.throws(()=>createHomefeed({store,root,owner:'owner',candidateLimit:0}),/candidateLimit/);
});

async function fixture(t, date = '2026-10-23T04:00:00.000Z') {
  const root = await mkdtemp(join(tmpdir(), 'homefeed-'));
  const store = openStore(join(root, 'state.sqlite'));
  const hf = createHomefeed({ store, root: join(root, 'private'), owner: 'owner', now: () => date });
  t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  return { root, store, hf };
}

test('追加3新事件独立、原事件重放同批，且不占用每日20', async t => {
  const {hf,store}=await fixture(t);
  assert.throws(()=>hf.beginBatch({kind:'additional_follow',commandId:'missing'}),/explicitRequest/);
  const daily=hf.beginBatch({kind:'daily_follow'});
  const first=hf.beginBatch({kind:'additional_follow',commandId:'manual1',explicitRequest:true});
  const second=hf.beginBatch({kind:'additional_follow',commandId:'manual2',explicitRequest:true});
  assert.equal(first.target,3);assert.equal(second.target,3);
  assert.notEqual(first.batch_id,second.batch_id);assert.notEqual(first.batch_id,daily.batch_id);
  assert.equal(hf.beginBatch({kind:'additional_follow',commandId:'manual1',explicitRequest:true}).batch_id,first.batch_id);
  assert.equal(hf.beginBatch({kind:'daily_follow'}).batch_id,daily.batch_id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM batch').get().n,3);
});

test('探索和追加请求必须显式指定，初始化不创建批次', async t => {
  const { store, hf } = await fixture(t);
  assert.equal(store.db.prepare('SELECT count(*) n FROM batch').get().n, 0);
  assert.throws(() => hf.beginBatch({ kind: 'explore' }), /explicitRequest|commandId/);
  assert.throws(() => hf.beginBatch({ kind: 'additional_follow', commandId: 'x' }), /explicitRequest/);
  assert.equal(hf.beginBatch({ kind: 'explore', commandId: 'e1', explicitRequest: true }).target, 3);
});

test('additional_follow命令跨重启重放返回原批次', async t => {
  const root = await mkdtemp(join(tmpdir(), 'homefeed-command-restart-'));
  const dbPath = join(root, 'state.sqlite');
  let store = openStore(dbPath);
  t.after(() => { store?.close(); return rm(root, { recursive: true, force: true }); });
  const first = createHomefeed({ store, root: join(root, 'private'), owner: 'owner' })
    .beginBatch({ kind: 'additional_follow', commandId: 'command-replay', explicitRequest: true, direction: '查找可复核的步骤' });
  store.close();
  store = openStore(dbPath);
  const replay = createHomefeed({ store, root: join(root, 'private'), owner: 'owner' })
    .beginBatch({ kind: 'additional_follow', commandId: 'command-replay', explicitRequest: true, direction: '查找可复核的步骤' });
  assert.equal(replay.batch_id, first.batch_id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM batch WHERE owner=? AND command_id=?').get('owner', 'command-replay').n, 1);
});

test('相同commandId的请求类型冲突时拒绝，不创建另一请求', async t => {
  const { hf, store } = await fixture(t);
  const original = hf.beginBatch({ kind: 'explore', commandId: 'command-stable', explicitRequest: true, direction: '探索方向甲' });
  assert.throws(() => hf.beginBatch({ kind: 'additional_follow', commandId: 'command-stable', explicitRequest: true, direction: '探索方向甲' }), /command|request|kind|conflict/i);
  const replay = hf.beginBatch({ kind: 'explore', commandId: 'command-stable', explicitRequest: true, direction: '探索方向甲' });
  assert.equal(replay.batch_id, original.batch_id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM batch WHERE owner=? AND command_id=?').get('owner', 'command-stable').n, 1);
});

test('仅接受首页来源，保存候选证据而不写收藏观察；重复 ID 仅计一次', async t => {
  const { root, store, hf } = await fixture(t);
  const batch = hf.beginBatch({ kind: 'daily_follow' });
  await assert.rejects(() => hf.recordPage(batch.batch_id, { source_page: `https://www.xiaohongshu.com/search_result?q=x`, observed_at: '2026-10-23T04:00:00Z', page_state: 'ready', observations: [], anchor_id: null, advanced: true, read_method: 'test' }), /home|source/i);
  const input = { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T04:00:00.000Z', page_state: 'ready', observations: [{ content_id: ID, complete_source_url: url(), author_name: 'author' }], anchor_id: ID, advanced: true, read_method: 'test' };
  const first = await hf.recordPage(batch.batch_id, input);
  const again = await hf.recordPage(batch.batch_id, { ...input, source_page: 'https://www.xiaohongshu.com/explore?cursor=2' });
  assert.equal(first.unique_count, 1);
  assert.equal(again.unique_count, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM collection_observation').get().n, 0);
  const candidate = store.db.prepare('SELECT * FROM candidate').get();
  assert.equal(candidate.source, 'homefeed');
  assert.match(await readFile(candidate.source_evidence_ref.replace(/^file:/, ''), 'utf8'), /xsec_token/);
  const checkpoint = store.db.prepare("SELECT * FROM checkpoint WHERE stage=?").get(`homefeed:${batch.batch_id}`);
  assert(checkpoint.output_hash);
  assert.equal(hf.state(batch.batch_id).observed_ids.length, 1);
});

test('日批按上海业务日唯一；跨日关闭旧批并保留候选与可见历史证据', async t => {
  const { store, hf } = await fixture(t, '2026-10-23T15:59:00.000Z');
  const old = hf.beginBatch({ kind: 'daily_follow' });
  await hf.recordPage(old.batch_id, { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T15:59:00Z', page_state: 'ready', observations: [{ content_id: ID, complete_source_url: url() }], anchor_id: ID, advanced: true, read_method: 'test' });
  assert.equal(hf.beginBatch({ kind: 'daily_follow' }).batch_id, old.batch_id);
  const next = createHomefeed({ store, root: 'private', owner: 'owner', now: () => '2026-10-23T16:01:00.000Z' }).beginBatch({ kind: 'daily_follow' });
  assert.notEqual(next.batch_id, old.batch_id);
  assert.equal(store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=?').get(old.batch_id).status, 'closed_day');
  assert.equal(store.db.prepare('SELECT count(*) n FROM candidate').get().n, 1);
  assert.equal(store.db.prepare('SELECT eligibility_state FROM candidate').get().eligibility_state, 'hold');
});

test('上海自然日中午不切日，午夜切换新日批', async t => {
  const { store, hf } = await fixture(t, '2026-10-23T03:59:00.000Z');
  const first = hf.beginBatch({ kind: 'daily_follow' });
  const atNoon = createHomefeed({ store, root: 'private', owner: 'owner', now: () => '2026-10-23T04:00:00.000Z' }).beginBatch({ kind: 'daily_follow' });
  assert.equal(atNoon.batch_id, first.batch_id);
  const midnight = createHomefeed({ store, root: 'private', owner: 'owner', now: () => '2026-10-23T16:00:00.000Z' }).beginBatch({ kind: 'daily_follow' });
  assert.notEqual(midnight.batch_id, first.batch_id);
});

test('来源错误不是页面结束；三次成功前进且零新增后停止', async t => {
  const { hf } = await fixture(t);
  const b = hf.beginBatch({ kind: 'daily_follow' });
  const page = { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T04:00:00Z', page_state: 'failed', observations: [], anchor_id: ID, advanced: false, read_method: 'test' };
  const failed = await hf.recordPage(b.batch_id, page);
  assert.equal(failed.stop_reason, null);
  for (let i = 1; i <= 3; i++) await hf.recordPage(b.batch_id, { ...page, page_state: 'ready', advanced: true, source_page: `${page.source_page}?p=${i}` });
  assert.equal(hf.state(b.batch_id).stop_reason, 'three_no_new_advances');
});

test('新增ID会重置连续停滞计数；无新、无新、有新、无新不会提前停止', async t => {
  const { hf } = await fixture(t);
  const b = hf.beginBatch({ kind: 'daily_follow' });
  const page = { source_page: 'https://www.xiaohongshu.com/explore', observed_at: '2026-10-23T04:00:00Z', page_state: 'ready', observations: [], anchor_id: ID, advanced: true, read_method: 'test' };
  await hf.recordPage(b.batch_id, page);
  await hf.recordPage(b.batch_id, { ...page, source_page: `${page.source_page}?p=2` });
  await hf.recordPage(b.batch_id, { ...page, source_page: `${page.source_page}?p=3`, observations: [{ content_id: ID, complete_source_url: url() }] });
  const last = await hf.recordPage(b.batch_id, { ...page, source_page: `${page.source_page}?p=4` });
  assert.equal(last.no_new_advances, 1);
  assert.equal(last.stop_reason, null);
});

test('相同页面重放不累计停滞次数，200唯一ID预算在存储重启后继续', async t => {
  const { root, store, hf } = await fixture(t);
  const b = hf.beginBatch({ kind: 'daily_follow' });
  const page = (ids, suffix = '') => ({ source_page: `https://www.xiaohongshu.com/explore${suffix}`, observed_at: '2026-10-23T04:00:00Z', page_state: 'ready', observations: ids.map(id => ({ content_id: id, complete_source_url: url(id) })), anchor_id: ids.at(-1), advanced: true, read_method: 'test' });
  const ids199 = Array.from({ length: 199 }, (_, i) => i.toString(16).padStart(24, '0'));
  await hf.recordPage(b.batch_id, page(ids199));
  const duplicate = await hf.recordPage(b.batch_id, page(ids199));
  assert.equal(duplicate.no_new_advances, 0);
  const reopened = openStore(join(root, 'state.sqlite'));
  const resumed = createHomefeed({ store: reopened, root: join(root, 'private'), owner: 'owner', now: () => '2026-10-23T04:01:00.000Z' });
  const result = await resumed.recordPage(b.batch_id, page([`f${'0'.repeat(23)}`, `e${'0'.repeat(23)}`], '?cursor=next'));
  assert.equal(result.unique_count, 200);
  assert.equal(result.stop_reason, 'unique_limit');
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM candidate WHERE discovery_batch_id=?').get(b.batch_id).n, 200);
  reopened.close();
});

test('刷新只使用调用方tab、首次刷新一次，并遵守单页和200条默认界限', async t => {
  const { hf } = await fixture(t);
  const b = hf.beginBatch({ kind: 'daily_follow' });
  let reloads = 0;
  const ids = [ID, 'b'.repeat(24), 'c'.repeat(24)];
  const cards = ids.map(id => ({
    querySelectorAll() { return [
      { getAttribute() { return `/explore/${id}`; } },
      { getAttribute() { return `/explore/${id}?xsec_token=visible-token`; } },
    ]; },
    querySelector(selector) { return selector === 'a.author' ? { textContent: 'author' } : null; },
  }));
  const document = {
    readyState: 'complete', body: { innerText: '卡片正文提到请先登录查看活动' },
    querySelectorAll(selector) { return selector === 'section.note-item' ? cards : []; },
    querySelector(selector) { return selector === 'section.note-item' ? cards[0] : null; },
  };
  let presses = 0;
  const tab = { page: { async reload() { reloads++; }, async press(selector, key) { assert.equal(selector, 'body'); assert.equal(key, 'PageDown'); presses++; }, async evaluate(callback, args) {
    return vm.runInNewContext(`(${callback.toString()})(args)`, { document, location: { href: 'https://www.xiaohongshu.com/explore', origin: 'https://www.xiaohongshu.com', pathname: '/explore' }, URL, args });
  } } };
  const first = await hf.refreshHomefeed(b.batch_id, tab, { maxItems: 2, maxPages: 3 });
  assert.equal(first.unique_count, 2);
  assert.equal(first.anchor_id, ids[1]);
  assert.equal(reloads, 1);
  const evidence = JSON.parse(await readFile(first.evidence_refs[0].replace(/^file:/, ''), 'utf8'));
  assert.equal(evidence.observations.length, 2);
  assert.equal(evidence.observations[0].complete_source_url, `https://www.xiaohongshu.com/explore/${ID}?xsec_token=visible-token`);
  assert.equal(evidence.observations[0].author_name, 'author');
  await hf.refreshHomefeed(b.batch_id, tab, { advance: true });
  assert.equal(reloads, 1);
  assert.equal(presses, 1);
});

test('卡片存在但登录弹窗提示设备登录超限时保留login_required且不采纳候选', async t => {
  const { hf, store } = await fixture(t);
  const batch = hf.beginBatch({ kind: 'daily_follow' });
  const card = {
    querySelectorAll() { return [
      { getAttribute() { return `/explore/${ID}`; } },
      { getAttribute() { return `/explore/${ID}?xsec_token=visible-token`; } },
    ]; },
    querySelector() { return null; },
  };
  const document = {
    readyState: 'complete', body: { innerText: '电脑设备登录超限，请重新登录' },
    querySelectorAll(selector) { return selector === 'section.note-item' ? [card] : []; },
    querySelector(selector) {
      if (selector === 'section.note-item') return card;
      if (selector.includes('[class*="login-container"]')) return { innerText: '电脑设备登录超限，请重新登录' };
      return null;
    },
  };
  const tab = { page: { async reload() {}, async evaluate(callback, args) {
    return vm.runInNewContext(`(${callback.toString()})(args)`, { document,
      location: { href: 'https://www.xiaohongshu.com/explore', origin: 'https://www.xiaohongshu.com', pathname: '/explore' }, URL, args });
  } } };

  const result = await hf.refreshHomefeed(batch.batch_id, tab);
  assert.equal(result.unique_count, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM candidate WHERE discovery_batch_id=?').get(batch.batch_id).n, 0);
  const evidence = JSON.parse(await readFile(result.evidence_refs[0].replace(/^file:/, ''), 'utf8'));
  assert.equal(evidence.page_state, 'login_required');
  assert.deepEqual(evidence.observations, []);
});

test('reload失败被持久记录，下一次调用会重试刷新而不把旧页计为已刷新', async t => {
  const { hf } = await fixture(t);
  const batch = hf.beginBatch({ kind: 'daily_follow' });
  let reloads = 0;
  const tab = { page: {
    async reload() { reloads++; if (reloads === 1) throw new Error('synthetic reload failure'); },
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', page_state: 'ready', observations: [{ content_id: ID, complete_source_url: url() }], anchor_id: ID }; },
  } };
  const failed = await hf.refreshHomefeed(batch.batch_id, tab);
  assert.equal(failed.refresh_state, 'failed');
  assert.equal(failed.unique_count, 0);
  const resumed = await hf.refreshHomefeed(batch.batch_id, tab);
  assert.equal(reloads, 2);
  assert.equal(resumed.refresh_state, 'succeeded');
  assert.equal(resumed.unique_count, 1);
});

test('恢复拒绝活进程；仅可用精确运行元数据恢复已退出子进程', async t => {
  const { root, store, hf } = await fixture(t);
  const batch = hf.beginBatch({ kind: 'daily_follow' });
  let unblock;
  const active = hf.refreshHomefeed(batch.batch_id, { page: { reload: () => new Promise(resolveReload => { unblock = resolveReload; }), async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', page_state: 'ready', observations: [], anchor_id: null }; } } });
  while (!unblock) await new Promise(resolveTick => setTimeout(resolveTick, 1));
  const activeRun = store.db.prepare("SELECT run_id FROM execution_slot WHERE slot_key='main'").get().run_id;
  assert.throws(() => hf.recover({ confirmedStoppedRunId: activeRun, evidenceRef: 'test:still-running' }), /active|alive/);
  unblock();
  await active;

  const storageUrl = pathToFileURL(resolve('src/storage.mjs')).href;
  const homefeedUrl = pathToFileURL(resolve('src/homefeed.mjs')).href;
  const dbPath = join(root, 'state.sqlite');
  const privateRoot = join(root, 'private');
  const script = `import {openStore} from ${JSON.stringify(storageUrl)}; import {createHomefeed} from ${JSON.stringify(homefeedUrl)}; const s=openStore(${JSON.stringify(dbPath)}); const h=createHomefeed({store:s,root:${JSON.stringify(privateRoot)},owner:'owner'}); h.refreshHomefeed(${JSON.stringify(batch.batch_id)},{page:{async reload(){},async evaluate(){console.log('claimed:'+s.db.prepare("SELECT run_id FROM execution_slot WHERE slot_key='main'").get().run_id);await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOutput = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { childOutput += chunk; });
  const childReady = await Promise.race([
    new Promise(resolveReady => child.stdout.once('data', resolveReady)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`child did not claim slot: ${childOutput}`)), 5000)),
    new Promise((_, reject) => child.once('close', code => reject(new Error(`child exited before claim (${code})`)))),
  ]);
  childOutput += String(childReady);
  const childRunId = childOutput.match(/claimed:([\w-]+)/)[1];
  child.kill();
  await once(child, 'close');
  const recovered = hf.recover({ confirmedStoppedRunId: childRunId, evidenceRef: 'test:child-exited' });
  assert.equal(recovered.status, 'recovered');
  assert.equal(store.db.prepare("SELECT state FROM execution_slot WHERE slot_key='main'").get().state, 'stopped');
});
