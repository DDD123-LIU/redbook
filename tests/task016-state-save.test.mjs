// 2026-11-01 Codex：仅隔离临时目录注入文件系统故障，不访问账号或发送消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveRuntimeJson,runRecommendationRounds} from '../.codex/task016-runtime.mjs';

function setup(t){
 const root=fs.mkdtempSync(join(tmpdir(),'task016-state-save-')),delays=[],logs=[];
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});});
 t.mock.method(Atomics,'wait',(array,index,value,ms)=>{delays.push(ms);return 'timed-out';});
 t.mock.method(console,'error',line=>logs.push(JSON.parse(line)));
 return {root,delays,logs};
}
function fault(t,method,fn){const original=fs[method];t.mock.method(fs,method,(...args)=>fn(original,...args));syncBuiltinESMExports();}
const error=code=>Object.assign(Error('injected filesystem failure'),{code,syscall:'rename'});

test('临时替换失败三次后成功，100/300/1000毫秒退避，最终文件完整',t=>{
 const o=setup(t),path=join(o.root,'state.json');fs.writeFileSync(path,'{"old":true}');let calls=0;
 fault(t,'renameSync',(rename,from,to)=>{if(++calls<=3)throw error(calls===2?'EBUSY':'EPERM');return rename(from,to);});
 saveRuntimeJson(path,{next:true});
 assert.equal(calls,4);assert.deepEqual(o.delays,[100,300,1000]);assert.deepEqual(JSON.parse(fs.readFileSync(path)),{next:true});
 assert.equal(o.logs.length,3);assert.deepEqual(fs.readdirSync(o.root),['state.json']);
});

test('持续替换失败保留原文件及新临时文件，明确原因且不泄漏正文',t=>{
 const o=setup(t),path=join(o.root,'state.json');fs.writeFileSync(path,'{"old":true}');let calls=0,caught;
 fault(t,'renameSync',()=>{calls++;throw error('EPERM');});
 assert.throws(()=>saveRuntimeJson(path,{secret:'do-not-log'}),e=>{caught=e;return e.kind==='runtime_state_save_failed'&&/进度保存失败/.test(e.message);});
 assert.equal(calls,4);assert.deepEqual(o.delays,[100,300,1000]);assert.equal(caught.cause.code,'EPERM');
 assert.equal(caught.details.attempts,4);assert.equal(caught.details.phase,'rename');assert.equal(caught.details.path,path);
 assert.equal(fs.readFileSync(path,'utf8'),'{"old":true}');assert.deepEqual(JSON.parse(fs.readFileSync(caught.details.temp)),{secret:'do-not-log'});
 assert.equal(JSON.stringify(o.logs).includes('do-not-log'),false);
});

test('非临时替换错误立即停止，不删除目标或盲重试',t=>{
 const o=setup(t),path=join(o.root,'state.json');fs.writeFileSync(path,'original');let calls=0;
 fault(t,'renameSync',()=>{calls++;throw error('EACCES');});
 assert.throws(()=>saveRuntimeJson(path,{}),e=>e.kind==='runtime_state_save_failed'&&e.cause.code==='EACCES');
 assert.equal(calls,1);assert.deepEqual(o.delays,[]);assert.equal(fs.readFileSync(path,'utf8'),'original');
});

test('写入阶段失败立即停止，原文件不变且不进入替换',t=>{
 const o=setup(t),path=join(o.root,'state.json');fs.writeFileSync(path,'original');
 fault(t,'writeFileSync',()=>{throw error('ENOSPC');});
 fault(t,'renameSync',()=>assert.fail('write failure must not rename'));
 assert.throws(()=>saveRuntimeJson(path,{}),e=>e.kind==='runtime_state_save_failed'&&e.details.phase==='write'&&e.cause.code==='ENOSPC');
 assert.deepEqual(o.delays,[]);assert.equal(fs.readFileSync(path,'utf8'),'original');
});

test('摘要保存持续失败后停止补量，回执保留，恢复不重复发送',async t=>{
 const o=setup(t);let total=0,pushes=0,collects=0,summaryAttempts=0;
 const options={root:o.root,target:2,guard:async()=>{},confirmed:async()=>total,
  collect:async round=>{collects++;return {items:[{source_id:String(round),status:'succeeded'}]};},
  select:async items=>({decisions:items.map(x=>({...x,status:'chosen'}))}),
  push:async()=>{pushes++;total++;return {sent:[{recommendation_id:String(total),result:{status:'succeeded'}}],failed:[]};},
  readback:async p=>({results:p.sent.map(x=>({recommendation_id:x.recommendation_id,status:'succeeded'}))})};
 fault(t,'renameSync',(rename,from,to)=>{if(to===join(o.root,'run-summary.json')){summaryAttempts++;throw error('EPERM');}return rename(from,to);});
 await assert.rejects(()=>runRecommendationRounds(options),e=>e.kind==='runtime_state_save_failed');
 assert.equal(summaryAttempts,4);assert.equal(pushes,1);assert.equal(collects,1);
 const receipt=fs.readFileSync(join(o.root,'rounds','0000','push.json'),'utf8');
 t.mock.restoreAll();syncBuiltinESMExports();
 const result=await runRecommendationRounds(options);
 assert.equal(result.total_confirmed,2);assert.equal(pushes,2);assert.equal(collects,2);
 assert.equal(fs.readFileSync(join(o.root,'rounds','0000','push.json'),'utf8'),receipt);
 assert.equal(fs.readdirSync(o.root).filter(x=>x.endsWith('.tmp')).length,1);
});

test('补量流程遇到一次临时保存故障后自动继续，无人工恢复及重复发送',async t=>{
 const o=setup(t);let total=0,collects=0,failed=false;
 fault(t,'renameSync',(rename,from,to)=>{if(to===join(o.root,'run-summary.json')&&!failed){failed=true;throw error('EPERM');}return rename(from,to);});
 const result=await runRecommendationRounds({root:o.root,target:2,guard:async()=>{},confirmed:async()=>total,
  collect:async()=>{collects++;return {items:[{source_id:String(collects),status:'succeeded'}]};},
  select:async items=>({decisions:items.map(x=>({...x,status:'chosen'}))}),
  push:async()=>({sent:[{recommendation_id:String(++total),result:{status:'succeeded'}}],failed:[]}),
  readback:async p=>({results:p.sent.map(x=>({recommendation_id:x.recommendation_id,status:'succeeded'}))})});
 assert.equal(result.reason,'target_reached');assert.equal(total,2);assert.equal(collects,2);assert.deepEqual(o.delays,[100]);
 assert.equal(result.counts.sent,2);assert.equal(result.counts.readback,2);
});
