// 日期：2026-10-21。Codex。合成页面适配契约，不冒充真实Edge证据。
import assert from 'node:assert/strict';
import { discoverFavorites, runFavorites } from '../src/edge-favorites.mjs';

const id = 'a'.repeat(24);
let saved = 0;
const events = [];
const collector = {
  assertCurrent() { events.push('guard'); },
  recordDiscovery(batch, input) {
    events.push('persist'); saved += input.observations.length;
    return { status: 'succeeded', observed_ids: input.observations.map(x => x.content_id), cumulative_unique: saved,
      next_checkpoint: { source_page: input.source_page, anchor_id: input.anchor_id, observed_ids: [id] }, state: 'partial' };
  },
};
const tab = { playwright: {
  async evaluate() { events.push('read'); return { source_page: 'https://www.xiaohongshu.com/user/profile/test?tab=fav',
    observed_at: new Date().toISOString(), page_state: 'ready', observations: [{content_id:id, complete_source_url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic`}], anchor_id:id, dom_count:1 }; },
  locator() { return { async press() { events.push('scroll'); } }; },
} };
const result = await discoverFavorites(collector, tab, 'synthetic-batch', { token:{}, maxItems:1 });
assert.equal(result.observed_ids.length, 1);
assert.equal(result.status, 'succeeded');
assert.equal(result.entity_id, 'synthetic-batch');
assert(Array.isArray(result.evidence_refs));
assert.equal(saved, 1);
assert(events.indexOf('persist') > events.indexOf('read'));
assert(!events.includes('scroll'));
const blocked = await discoverFavorites(collector, {playwright:{async evaluate(){return {page_state:'access_blocked',observations:[],source_page:'synthetic',observed_at:new Date().toISOString()};}}}, 'blocked', {token:{}});
assert.equal(blocked.state, 'blocked');
assert.equal(saved, 1);
await assert.rejects(discoverFavorites(collector, tab, 'bad', {maxItems:0}), /positive/);
const wrongAccount = await discoverFavorites(collector, tab, 'old', {checkpoint:{source_page:'https://www.xiaohongshu.com/user/profile/other?tab=fav'}});
assert.equal(wrongAccount.state, 'blocked');
assert.equal(saved, 1);
const order = [];
let readIndex = 0;
const asyncCollector = {
  assertCurrent(){},
  async claim(){return {};},
  async release(){order.push('release');},
  async resume(){order.push('resume');return {};},
  async recordDiscovery(_batch,input){
    await new Promise(resolve => setTimeout(resolve, 5)); order.push('persist');
    return {next_checkpoint:{},coverage:input.coverage};
  },
};
const asyncTab = {playwright:{
  async evaluate(){return {source_page:'https://www.xiaohongshu.com/user/profile/test?tab=fav',observed_at:new Date().toISOString(),page_state:'ready',
    observations:[{content_id:String(++readIndex).repeat(24)}],anchor_id:String(readIndex).repeat(24)};},
  locator(){return {first(){return this;},async press(){assert.equal(order.at(-1),'persist');order.push('scroll');}};},
}};
await runFavorites({collector:asyncCollector,tab:asyncTab,collectionBatchId:'async',maxItems:2,maxBatches:2,advance:true});
assert.deepEqual(order,['persist','scroll','persist','resume','release']);
const failedScroll = {...asyncTab,playwright:{...asyncTab.playwright,locator(){return {first(){return this;},async press(){throw Error('synthetic disconnect');}};}}};
const failed = await discoverFavorites(asyncCollector,failedScroll,'scrollfail',{maxItems:2,maxBatches:2,advance:true});
assert.equal(failed.coverage.stop_reason,'browser_scroll_failed');
assert.equal(failed.state,'unknown');
const disconnected = await discoverFavorites(asyncCollector,{playwright:{async evaluate(){throw Error('synthetic timeout');}}},'readfail',{checkpoint:{source_page:'https://www.xiaohongshu.com/user/profile/test?tab=fav',anchor_id:id}});
assert.equal(disconnected.next_checkpoint.anchor_id,id);
assert.equal(disconnected.state,'unknown');
const stalled = await discoverFavorites(asyncCollector,{playwright:{async evaluate(){return {source_page:'https://www.xiaohongshu.com/user/profile/test?tab=fav',page_state:'ready',observations:[]};}}},'stalled');
assert.equal(stalled.coverage.stop_reason,'no_new_in_dom_window');
assert.equal(stalled.coverage.complete,false);
console.log('edge adapter: 8 synthetic checks passed');
