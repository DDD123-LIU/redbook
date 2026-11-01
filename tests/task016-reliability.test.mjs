// 2026-10-29 Codex：隔离运行补量和恢复，不访问浏览器、模型或飞书。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as runtime from '../.codex/task016-runtime.mjs';
import {collectBrowserRound} from '../.codex/task016-browser-round.mjs';

function setup(t,changes={}){
 const root=mkdtempSync(join(tmpdir(),'task016-reliable-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let total=5,seq=0;const calls=[];
 return {root,target:20,guard:async()=>{},confirmed:async()=>total,
 collect:async()=>({items:Array.from({length:5},()=>({source_id:String(++seq),status:'succeeded'})),exhausted:false}),
 select:async(items)=>{calls.push('select');return {decisions:items.map(x=>({source_id:x.source_id,status:'chosen'}))};},
 push:async(selection,dir,remaining)=>{calls.push('push');const sent=selection.decisions.slice(0,remaining).map(x=>({recommendation_id:x.source_id,result:{status:'succeeded'}}));total+=sent.length;return {sent,failed:[],total_confirmed:total};},
 readback:async(push)=>{calls.push('readback');return {results:push.sent.map(x=>({recommendation_id:x.recommendation_id,status:'succeeded'}))};},calls,...changes};
}
test('普通正文和评论提及验证码不影响正文外检测',()=>{
 assert.equal(runtime.classifyPlatformEvidence({outsideText:'首页 通知',contentText:'Muse读取验证码，安全验证教程',prompts:[]}),null);
 assert.equal(runtime.classifyPlatformEvidence({outsideText:'首页',prompts:['请完成安全验证']} ).kind,'verification');
 assert.equal(runtime.classifyPlatformEvidence({outsideText:'访问过于频繁',prompts:[]}).kind,'rate_limited');
 assert.equal(runtime.classifyPlatformEvidence({outsideText:'',prompts:['扫码登录']}).kind,'login_required');
});
test('每条实际发送前按上海业务日检查，跨午夜停止',()=>{
 runtime.assertDailySendDay('2026-10-29',new Date('2026-10-29T15:59:59Z'));
 assert.throws(()=>runtime.assertDailySendDay('2026-10-29',new Date('2026-10-29T16:00:00Z')),/expired/);
});
test('平台验证落等待本人操作，发现与已读计数分别保存',async t=>{
 const o=setup(t,{collect:async()=>({items:[{source_id:'1',status:'succeeded'}],discovered_ids:['1','2','3'],stopped:{kind:'verification'},exhausted:false})});
 await assert.rejects(()=>runtime.runRecommendationRounds(o),/verification/);
 const r=JSON.parse(readFileSync(join(o.root,'run-summary.json'),'utf8'));assert.equal(r.status,'awaiting_user');assert.equal(r.counts.discovered,3);assert.equal(r.counts.read,1);assert.equal(r.counts.sent,0);
});
test('未满继续三轮，达到当日20后终止，回读与发送一致',async t=>{
 const o=setup(t);const r=await runtime.runRecommendationRounds(o);assert.equal(r.reason,'target_reached');assert.equal(r.total_confirmed,20);assert.equal(r.counts.sent,15);assert.equal(r.counts.readback,15);assert.equal(o.calls.filter(x=>x==='push').length,3);
 await runtime.runRecommendationRounds(o);assert.equal(o.calls.filter(x=>x==='push').length,3);
});
test('第一轮仅选1条仍继续读取',async t=>{
 let n=0;const o=setup(t,{select:async items=>({decisions:items.slice(0,++n===1?1:5).map(x=>({source_id:x.source_id,status:'chosen'}))})});const r=await runtime.runRecommendationRounds(o);assert.equal(r.total_confirmed,20);assert(n>1);
});
test('发送后回读中断：重入只回读，不重采重筛重发',async t=>{
 const o=setup(t);let fail=true;const original=o.readback;o.readback=async(...args)=>{if(fail){fail=false;throw Error('network');}return original(...args);};
 await assert.rejects(()=>runtime.runRecommendationRounds(o),/network/);assert.equal(o.calls.filter(x=>x==='push').length,1);
 const r=await runtime.runRecommendationRounds(o);assert.equal(r.total_confirmed,20);assert.equal(o.calls.filter(x=>x==='push').length,3);
});
test('unknown回执停止，不进入下一轮或重发',async t=>{
 const o=setup(t,{readback:async p=>({results:p.sent.map(x=>({recommendation_id:x.recommendation_id,status:'unknown'}))})});await assert.rejects(()=>runtime.runRecommendationRounds(o),/readback/);await assert.rejects(()=>runtime.runRecommendationRounds(o),/readback/);assert.equal(o.calls.filter(x=>x==='push').length,1);
});
test('明确耗尽才内容不足；重复首页是执行停滞',async t=>{
 const a=setup(t,{collect:async()=>({items:[],exhausted:true})});assert.equal((await runtime.runRecommendationRounds(a)).reason,'content_insufficient');
 const b=setup(t,{collect:async()=>({items:[],exhausted:false})});const r=await runtime.runRecommendationRounds(b);assert.equal(r.reason,'feed_stalled');assert.equal(r.status,'execution_incomplete');
});
test('未入选缺字段只留痕：首轮选4后继续补量，第三步只核入选发送回读',async t=>{
 const o=setup(t);const collect=o.collect,select=o.select;let first=true,rounds=0;
 o.collect=async(...args)=>{rounds++;const c=await collect(...args);if(rounds===1)c.items.push({source_id:'missing-title',status:'incomplete'},{source_id:'missing-body',status:'incomplete'});return c;};
 o.select=async(items,...args)=>{assert(items.every(x=>x.status==='succeeded'));if(first){first=false;return select(items.slice(0,4),...args);}return select(items,...args);};
 const r=await runtime.runRecommendationRounds(o);assert.equal(r.reason,'target_reached');assert.equal(r.total_confirmed,20);assert.equal(r.counts.sent,15);assert.equal(r.counts.readback,15);assert(rounds>1);assert.deepEqual(r.skipped_incomplete_ids,['missing-title','missing-body']);
});
test('单篇失败不停止发现，明确耗尽时报告有效候选不足并保留缺失说明',async t=>{
 let round=0;const o=setup(t,{collect:async()=>++round===1?{items:[{source_id:'broken',status:'failed'}],exhausted:false}:{items:[],exhausted:true}});
 const r=await runtime.runRecommendationRounds(o);assert.equal(round,2);assert.equal(r.reason,'content_insufficient');assert.deepEqual(r.skipped_incomplete_ids,['broken']);assert.equal(r.counts.sent,0);
});
test('旧检查点因缺字段停止后可续，历史未入选缺失项不重采也不阻断',async t=>{
 const o=setup(t);writeFileSync(join(o.root,'round-state.json'),JSON.stringify({version:2,round:1,seen:[],read_failures:['old-missing'],discovered:['old-missing'],stalled:0,counts:{discovered:1,read:1,valid:0,selected:0,sent:0,readback:0}}));
 writeFileSync(join(o.root,'run-summary.json'),JSON.stringify({status:'execution_incomplete',reason:'candidate_read_failed'}));
 const collect=o.collect;o.collect=async(round,seen,...args)=>{assert(seen.has('old-missing'));assert(round>=1);return collect(round,seen,...args);};
 const r=await runtime.runRecommendationRounds(o);assert.equal(r.reason,'target_reached');assert.equal(r.total_confirmed,20);assert.deepEqual(r.skipped_incomplete_ids,['old-missing']);
});
test('最后一轮已达20但回读失败，不能越过未完成回读',async t=>{
 const o=setup(t);let failed=false;const back=o.readback;
 o.readback=async(...args)=>{if(o.calls.filter(x=>x==='push').length===3&&!failed){failed=true;throw Error('last readback offline');}return back(...args);};
 await assert.rejects(()=>runtime.runRecommendationRounds(o),/last readback/);
 const stopped=JSON.parse(readFileSync(join(o.root,'run-summary.json'),'utf8'));assert.equal(stopped.counts.sent,15);assert.equal(stopped.counts.readback,10);assert.equal(stopped.status,'execution_incomplete');
 const r=await runtime.runRecommendationRounds(o);assert.equal(r.reason,'target_reached');assert.equal(r.counts.readback,15);assert.equal(o.calls.filter(x=>x==='push').length,3);
});
test('生产浏览器脚本合成冒烟：正文验证码不误停、跳过旧候选、下一轮继续',async t=>{
 const root=mkdtempSync(join(tmpdir(),'task016-browser-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const keys=['taskSpace','listTaskSpaces','document','location','NodeFilter','getComputedStyle'],prior=Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const k of keys)if(prior[k])Object.defineProperty(globalThis,k,prior[k]);else delete globalThis[k];});
 let pageUrl='https://www.xiaohongshu.com/explore',scrolls=0,got=[],platformMessage='首页 通知',cardLimit=null;
 const ids=()=>Array.from({length:cardLimit??2+scrolls},(_,i)=>String(i+1)),url=id=>`https://www.xiaohongshu.com/explore/${id}?xsec_token=fixture`;
 const node=(text,content=false)=>({textContent:text,parentElement:{closest:()=>content?{}:null,getClientRects:()=>[{}]}});
 const doc={body:{},createTreeWalker:()=>{let i=0;const nodes=[node(platformMessage),node('Muse去邮箱读取验证码减少卡顿',true),node('评论提及扫码登录与安全验证',true)];return {nextNode:()=>nodes[i++]??null};},querySelectorAll:selector=>{
  if(selector==='section.note-item')return ids().map(id=>({innerText:'帖子'+id,querySelectorAll:()=>[{href:url(id)}]}));
  if(selector.includes('section.note-item a'))return ids().map(id=>({href:url(id)}));
  if(selector==='.note-slider-img img')return [{currentSrc:'https://image.test/1.jpg',closest:()=>null}];return [];
 },querySelector:selector=>selector==='#detail-title'?{innerText:'帖子正文'}:selector==='#detail-desc'?{innerText:'Muse去邮箱读取验证码减少卡顿'}:selector==='.interaction-container a.name'?{innerText:'作者'}:selector.startsWith('.note-slider-img')?{}:null};
 globalThis.document=doc;globalThis.NodeFilter={SHOW_TEXT:4};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
 let reloads=0,detailReloads=0,detailTimeout=true;
 const page={url:async()=>pageUrl,goto:async(u,options)=>{assert.equal(options?.waitUntil,'domcontentloaded');pageUrl=u;globalThis.location={href:u};got.push(u);if(u.includes('/2?')&&detailTimeout){detailTimeout=false;throw Error('page.goto timed out; navigation committed');}},reload:async options=>{assert.equal(options.waitUntil,'domcontentloaded');if(new URL(pageUrl).pathname!=='/explore'){detailReloads++;return;}reloads++;scrolls+=3;},evaluate:async(fn,arg)=>fn(arg),waitForSelector:async()=>{},press:async()=>{throw Error('must refresh instead of scrolling');},waitForFunction:async(fn,arg)=>{assert(fn(arg));}};
 globalThis.taskSpace=async()=>({spaceId:7,page:()=>page});globalThis.listTaskSpaces=async()=>[];
 const config={spaceId:7,sessionRef:join(root,'session.json'),workspace:process.cwd()};
 for(const round of [0,1]){const dir=join(root,String(round));mkdirSync(dir);await collectBrowserRound({...config,root:dir,round,exclude:round?['1','2']:['1']});const saved=JSON.parse(readFileSync(join(dir,'homepage-bodies.json'),'utf8'));assert.equal(saved.stopped,null);assert(saved.items.every(x=>x.status==='succeeded'));assert(!saved.items.some(x=>x.source_id==='1'));if(round)assert(saved.items.every(x=>!['1','2'].includes(x.source_id)));}
 assert(got.some(u=>u.includes('/5?')));assert.equal(reloads,2);assert.equal(detailReloads,1);
 platformMessage='安全验证';const blocked=join(root,'blocked');mkdirSync(blocked);await assert.rejects(()=>collectBrowserRound({...config,root:blocked,round:0,exclude:[]}),e=>e.kind==='verification');
 platformMessage='没有更多了';cardLimit=45;const capped=join(root,'capped');mkdirSync(capped);await collectBrowserRound({...config,root:capped,round:0,exclude:[]});const observed=JSON.parse(readFileSync(join(capped,'homefeed-observed.json'),'utf8'));assert.equal(observed.items.length,40);assert.equal(observed.exhausted,false);
 // 超时后仍是旧页不得刷新或读取；验证码不能被刷新恢复绕过。
 const normalGoto=page.goto,priorDetailReloads=detailReloads;platformMessage='首页';cardLimit=2;
 page.goto=async(u,options)=>{if(new URL(u).pathname==='/explore')return normalGoto(u,options);throw Error('page.goto timed out; navigation not committed');};
 const wrong=join(root,'wrong-page');mkdirSync(wrong);await collectBrowserRound({...config,root:wrong,round:0,exclude:[]});
 assert(JSON.parse(readFileSync(join(wrong,'homepage-bodies.json'),'utf8')).items.every(x=>x.status==='failed'));assert.equal(detailReloads,priorDetailReloads);
 page.goto=async(u,options)=>{await normalGoto(u,options);if(new URL(u).pathname!=='/explore'){platformMessage='安全验证';throw Error('page.goto timed out; navigation committed');}};
 const verify=join(root,'timeout-verification');mkdirSync(verify);await collectBrowserRound({...config,root:verify,round:0,exclude:[]});
 const stopped=JSON.parse(readFileSync(join(verify,'homepage-bodies.json'),'utf8'));assert.equal(stopped.stopped.kind,'verification');assert.equal(stopped.items.length,0);assert.equal(detailReloads,priorDetailReloads);
});
test('未完成模型只有started而无输出时不重复模型；已有原生输出可恢复',async t=>{
 const o=setup(t);let calls=0;const select=o.select;o.select=async(...args)=>{calls++;if(calls===1)throw Error('model process lost');return select(...args);};
 await assert.rejects(()=>runtime.runRecommendationRounds(o),/model process lost/);await assert.rejects(()=>runtime.runRecommendationRounds(o),/unresolved selection/);assert.equal(calls,1);
 o.recover=async stage=>stage==='selection'?{decisions:Array.from({length:5},(_,i)=>({source_id:String(i+1),status:'chosen'}))}:null;
 const r=await runtime.runRecommendationRounds(o);assert.equal(r.total_confirmed,20);assert.equal(calls,3);
});
