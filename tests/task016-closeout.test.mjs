// 2026-10-30 Codex：最终启动时限与主动批多轮接线的隔离验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import * as runtime from '../.codex/task016-runtime.mjs';
import * as worker from '../.codex/task016-auto-worker.mjs';

test('11:30包含边界，迟到仍可执行但启动验收失败',()=>{
 assert.equal(runtime.dailyStartTiming(new Date('2026-10-30T03:30:00Z')).startup_on_time,true);
 const late=runtime.dailyStartTiming(new Date('2026-10-30T03:30:00.001Z'));
 assert.equal(late.startup_on_time,false);assert.equal(late.start_delay_ms,900001);
 assert.equal(late.scheduled_at,'2026-10-30T11:15:00+08:00');
});

test('通知区分真实耗尽、故障及等待本人，不把部分发送一概称内容不足',()=>{
 assert.match(runtime.recommendationNotice({status:'partial',result:{reason:'content_insufficient',requested:20,total_confirmed:8,actual:8}}),/候选已耗尽/);
 assert.match(runtime.recommendationNotice({status:'execution_incomplete',result:{reason:'feed_stalled',requested:20,total_confirmed:8}}),/feed_stalled/);
 assert.doesNotMatch(runtime.recommendationNotice({status:'failed',error:{message:'network'}}),/内容不足/);
 assert.match(runtime.recommendationNotice({status:'awaiting_user',result:{reason:'verification'}}),/本人/);
});

test('筛选失败只进入持证据恢复一次；恢复失败不循环，恢复前仍查额度',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'selection-route-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let calls=0,guards=0;const opts={dir,kind:'additional',target:3,guard:async()=>{guards++;},run:async(exe,args,path,target,mode)=>{calls++;if(calls===1){writeFileSync(join(dir,'selection-additional-started.json'),'{}');assert.equal(mode.selectionRecover,false);throw Error('model exited');}assert.equal(mode.selectionRecover,true);throw Error('state unknown');}};
 await assert.rejects(()=>worker.executeSelection(opts),/state unknown/);assert.equal(calls,2);assert.equal(guards,1);
 calls=0;await assert.rejects(()=>worker.executeSelection({...opts,recover:true,run:async()=>{calls++;throw Error('unknown');}}),/unknown/);assert.equal(calls,1);
});

for(const target of [10,20])test(`日批${target}复用多轮执行，独立command计数，不拿历史主动批抵扣且末轮回读`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-rounds-'));
 const databasePath=join(root,'state.sqlite'),sessionRef=join(root,'session.json');writeFileSync(sessionRef,JSON.stringify({spaceId:1,pageLabel:'p1'}));
 const db=new DatabaseSync(databasePath);t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 db.exec('CREATE TABLE batch(delivery_batch_id TEXT,owner TEXT,kind TEXT,business_day TEXT,created_at TEXT,command_id TEXT,target INTEGER); CREATE TABLE recommendation(recommendation_id TEXT,delivery_batch_id TEXT); CREATE TABLE delivery_attempt(recommendation_id TEXT,status TEXT); CREATE TABLE delivered_content(owner TEXT,source_content_id TEXT);');
 db.prepare('INSERT INTO batch VALUES(?,?,?,?,?,?,?)').run('history','TASK012-synthetic','manual_follow','2026-10-30','0',null,20);
 db.prepare('INSERT INTO batch VALUES(?,?,?,?,?,?,?)').run('daily','TASK012-synthetic','daily_follow','2026-10-30','0','request-A',target);
 for(let i=0;i<20;i++){db.prepare('INSERT INTO recommendation VALUES(?,?)').run('history-'+i,'history');db.prepare('INSERT INTO delivery_attempt VALUES(?,?)').run('history-'+i,'succeeded');}
 let round=0,sent=0,backs=0;const limits=[];
 const save=(dir,name,data)=>writeFileSync(join(dir,name),JSON.stringify(data));
 const result=await worker.executeRecommendationRounds({request:{request_type:'daily_follow',target,business_day:'2026-10-30',event_id:'event-A',provenance:{command_id:'request-A'}},root,databasePath,sessionRef,guard:async()=>{},run:async(exe,args,dir,remaining)=>{
  if(exe.includes('ego-browser')){round++;save(dir,'homepage-bodies.json',{items:[{source_id:'source-'+round,status:'succeeded'}]});save(dir,'homefeed-observed.json',{items:[],discovered_ids:['source-'+round],exhausted:false});}
  else if(args[0].includes('select-real')){assert.equal(args[1],'daily');save(dir,'selection-daily.json',{decisions:[{source_id:'source-'+round,status:'chosen'}]});}
  else if(args[0].includes('push-real')){assert.equal(args[1],'daily');limits.push(remaining);const items=[];for(let i=0;i<Math.min(7,remaining);i++){const id='manual-'+sent++;db.prepare('INSERT INTO recommendation VALUES(?,?)').run(id,'daily');db.prepare('INSERT INTO delivery_attempt VALUES(?,?)').run(id,'succeeded');items.push({recommendation_id:id,result:{status:'succeeded'}});}save(dir,'push-daily.json',{sent:items,failed:[],total_confirmed:sent});}
  else{assert(args.includes('--daily-readback'));const pushed=JSON.parse(readFileSync(join(dir,'push-daily.json'),'utf8'));backs+=pushed.sent.length;save(dir,'exact-readback.json',{results:pushed.sent.map(x=>({recommendation_id:x.recommendation_id,status:'succeeded'}))});}
 }});
 assert.equal(result.total_confirmed,target);assert.equal(result.batch_id,'daily');assert.equal(round,Math.ceil(target/7));assert.equal(backs,target);assert.deepEqual(limits,target===10?[10,3]:[20,13,6]);
 await worker.executeRecommendationRounds({request:{request_type:'daily_follow',target,business_day:'2026-10-30',provenance:{command_id:'request-A'}},root,databasePath,sessionRef,guard:async()=>{},run:async()=>assert.fail('completed request replayed')});
});
