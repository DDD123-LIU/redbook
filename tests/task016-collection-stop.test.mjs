// 2026-11-01 Codex：执行生产collector/body脚本，Page完全合成，不访问真实账号。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectBrowserRound} from '../.codex/task016-browser-round.mjs';
import {runRecommendationRounds,recommendationNotice} from '../.codex/task016-runtime.mjs';
const read=path=>JSON.parse(readFileSync(path,'utf8'));

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'task016-collection-stop-')),prior=Object.getOwnPropertyDescriptor(globalThis,'taskSpace');
 t.after(()=>{if(prior)Object.defineProperty(globalThis,'taskSpace',prior);else delete globalThis.taskSpace;rmSync(root,{recursive:true,force:true});});
 let modes={},current='',barrier='',attempted=[];
 const page={goto:async url=>{current=new URL(url).pathname.split('/').at(-1);if(current!=='explore'){attempted.push(current);if(modes[current]==='navigation')throw Error('detail navigation failed');}},
  reload:async()=>{},url:async()=>`https://www.xiaohongshu.com/explore/${current}`,
  waitForSelector:async selector=>{if(selector==='#detail-desc'&&modes[current]==='body')throw Error('body selector timed out');},waitForFunction:async()=>{},
  evaluate:async fn=>fn.name==='platformEvidence'?{outsideText:barrier,prompts:[]}:{title:'标题',body:modes[current]==='incomplete'?'':'正文',author_name:'作者',image_candidates:[],video_present:modes[current]==='video'}};
 globalThis.taskSpace=async()=>({spaceId:7,page:()=>page});
 async function run(round,sequence,{seed=null,barrierText=''}={}){
  barrier=barrierText;attempted=[];modes=Object.fromEntries(sequence.map(([id,mode])=>[id,mode]));
  const dir=join(root,'rounds',String(round).padStart(4,'0'));mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'homefeed-observed.json'),JSON.stringify({items:sequence.map(([id])=>({urls:[`https://www.xiaohongshu.com/explore/${id}?xsec_token=test`]})),discovered_ids:sequence.map(([id])=>id)}));
  if(seed)writeFileSync(join(dir,'homepage-bodies.json'),JSON.stringify(seed));
  await collectBrowserRound({root:dir,round,spaceId:7,sessionRef:join(root,'session.json'),workspace:process.cwd(),exclude:[]});
  return {state:read(join(dir,'homepage-bodies.json')),attempted:[...attempted]};
 }
 return {root,run};
}
const failures=(start,n,mode='navigation')=>Array.from({length:n},(_,i)=>[String(start+i),mode]);

for(const mode of ['navigation','body'])test(`连续5篇${mode}异常自动停止，保存5条原因且不尝试第6篇`,async t=>{
 const o=setup(t),r=await o.run(0,failures(1,8,mode));
 assert.equal(r.state.stopped?.kind,'collection_execution_failed');assert.equal(r.state.items.length,5);assert.equal(r.attempted.length,5);
 assert.equal(r.state.stopped.failures.length,5);assert(r.state.stopped.failures.every(x=>x.phase===mode&&x.reason));
});

test('4次异常后读取成功清零；缺字段和视频不被视为执行异常',async t=>{
 const o=setup(t),sequence=[...failures(1,4),['5','success'],...failures(6,4),['10','incomplete'],...failures(11,4),['15','video']];
 const {state,attempted}=await o.run(0,sequence);assert.equal(state.stopped,null);assert.equal(attempted.length,15);assert.deepEqual(state.read_error_streak,[]);
 assert.equal(state.items.find(x=>x.source_id==='10').status,'incomplete');assert.equal(state.items.find(x=>x.source_id==='15').status,'unsupported_video');
});

test('同请求跨轮继承4次异常，第5次停止；已保存来源不重新计数',async t=>{
 const o=setup(t),first=await o.run(0,failures(1,4));assert.equal(first.state.stopped,null);
 const second=await o.run(1,failures(5,3));assert.equal(second.state.stopped?.kind,'collection_execution_failed');assert.deepEqual(second.attempted,['5']);
 const seed={items:failures(1,4).map(([source_id])=>({source_id,status:'failed'})),stopped:null,read_error_streak:failures(1,4).map(([source_id])=>({source_id,phase:'navigation',reason:'previous failure'}))};
 const resumed=await o.run(2,failures(1,7),{seed});assert.deepEqual(resumed.attempted,['5']);assert.equal(resumed.state.items.length,5);
});

test('登录/验证/限流第一时间停止，不等待5次',async t=>{
 const o=setup(t);
 for(const [i,barrierText,kind] of [[0,'扫码登录','login_required'],[1,'安全验证','verification'],[2,'访问过于频繁','rate_limited']]){
  await assert.rejects(()=>o.run(i,failures(1,8),{barrierText}),e=>e.kind===kind);
 }
});

test('第5篇停止材料已落盘但collection未提交时，重入复用原原因且不再读页面',async t=>{
 const o=setup(t),seed={items:failures(1,5).map(([source_id])=>({source_id,status:'failed'})),read_error_streak:failures(1,5).map(([source_id])=>({source_id,phase:'body',reason:'original body failure'})),
  stopped:{kind:'collection_execution_failed',reason:'连续5篇采集执行异常',failures:failures(1,5).map(([source_id])=>({source_id,phase:'body',reason:'original body failure'}))}};
 const resumed=await o.run(0,failures(1,8),{seed});assert.deepEqual(resumed.state,seed);assert.deepEqual(resumed.attempted,[]);
});

test('采集故障报告保留阶段原因，不进入筛选/发送，也不称内容不足',async t=>{
 const o=setup(t),receipt=join(o.root,'previous-push.json'),original='{"sent":[{"recommendation_id":"already-sent"}]}';writeFileSync(receipt,original);
 const options={root:o.root,target:10,guard:async()=>{},confirmed:async()=>2,
  collect:async()=>(await o.run(0,failures(1,8))).state,select:async()=>assert.fail('must not select'),push:async()=>assert.fail('must not send'),readback:async()=>assert.fail('must not readback')};
 await assert.rejects(()=>runRecommendationRounds(options),e=>e.kind==='collection_execution_failed');
 const result=read(join(o.root,'run-summary.json'));assert.equal(result.status,'execution_incomplete');assert.equal(result.reason,'collection_execution_failed');assert.equal(result.collection_failure.failures.length,5);assert.equal(result.counts.read,5);
 assert.equal(readFileSync(receipt,'utf8'),original);assert.equal(result.total_confirmed,2);
 const notice=recommendationNotice({status:result.status,result});assert.match(notice,/采集.*异常/);assert.match(notice,/detail navigation failed/);assert.doesNotMatch(notice,/耗尽|不足/);
});
