// 2026-10-30 Codex：隔离模拟版本清理，不调用模型或平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as quota from '../.codex/task016-live-quota.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'codex-discovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const add=(name,time)=>{const folder=join(root,name);mkdirSync(folder);const path=join(folder,'codex.exe');writeFileSync(path,'fixture');utimesSync(path,time,time);return path;};return {root,add};}
test('旧版本被清理后再次定位新版本，不缓存已删除目录',t=>{
 const {root,add}=fixture(t),old=add('old',1000),options={env:{},binRoot:root,probe:()=>true};
 assert.equal(quota.resolveCodexExecutable(options),old);
 rmSync(join(root,'old'),{recursive:true});const current=add('current',2000);
 assert.equal(quota.resolveCodexExecutable(options),current);
});
test('多个残留版本按时间验证，最新不可运行则回退可运行版本',t=>{
 const {root,add}=fixture(t),older=add('older',1000),newer=add('newer',2000),seen=[];
 const executable=quota.resolveCodexExecutable({env:{},binRoot:root,probe:p=>{seen.push(p);return p===older;}});
 assert.equal(executable,older);assert.deepEqual(seen,[newer,older]);
});
test('显式配置优先且失效时明确报错，不悄悄换程序',t=>{
 const {root,add}=fixture(t),explicit=add('explicit',1000);add('newer',2000);
 assert.equal(quota.resolveCodexExecutable({env:{TASK016_CODEX_EXECUTABLE:explicit},binRoot:root,probe:()=>true}),explicit);
 assert.throws(()=>quota.resolveCodexExecutable({env:{TASK016_CODEX_EXECUTABLE:join(root,'removed.exe')},binRoot:root,probe:()=>true}),/configured Codex executable/);
});
test('空目录或全部无效时明确报找不到可运行程序',t=>{
 const {root,add}=fixture(t);
 assert.throws(()=>quota.resolveCodexExecutable({env:{},binRoot:root,probe:()=>true}),/no runnable Codex executable/);
 add('broken',1000);assert.throws(()=>quota.resolveCodexExecutable({env:{},binRoot:root,probe:()=>false}),/no runnable Codex executable/);
});
test('短暂版本探测超时复核一次，并保留超时诊断',t=>{
 const {root,add}=fixture(t),path=add('current',1000),events=[];let calls=0;
 assert.equal(quota.resolveCodexExecutable({env:{},binRoot:root,onDiagnostic:x=>events.push(x),probe:()=>++calls===1?{status:null,error:{code:'ETIMEDOUT'},signal:'SIGTERM'}:{status:0,stdout:'codex-cli test'}}),path);
 assert.equal(calls,2);assert.equal(events[0].code,'ETIMEDOUT');assert.equal(events[0].timedOut,true);assert.equal(events[0].path,path);
});
test('持续版本探测失败最多两次，错误包含具体退出信息',t=>{
 const {root,add}=fixture(t),path=add('current',1000);let calls=0;
 assert.throws(()=>quota.resolveCodexExecutable({env:{},binRoot:root,onDiagnostic:()=>{},probe:()=>{calls++;return {status:7,signal:null};}}),error=>error.message.includes('exit=7')&&error.message.includes(path));
 assert.equal(calls,2);
});
// 模拟真实逐行初始化/额度协议，不调用模型、账号或平台。
function serverFactory(replies){let calls=0;return {get calls(){return calls;},spawn(){
 const reply=replies[calls++],child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 child.stdin.on('data',chunk=>{const m=JSON.parse(String(chunk));if(m.id===1)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:1,result:{}})+'\n'));if(m.id===2)queueMicrotask(()=>{if(reply==='exit')child.emit('exit',9,null);else child.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:reply},secondary:{usedPercent:50}}}})+'\n');});});return child;
}};}
test('额度服务短暂退出后只读复核成功，记录退出码',async()=>{
 const server=serverFactory(['exit',25]),events=[];
 const q=await quota.readQuota({resolveExecutable:()=> 'fixture',spawnProcess:()=>server.spawn(),onDiagnostic:x=>events.push(x),sleep:async()=>{}});
 assert.equal(q.fiveHourRemaining,75);assert.equal(server.calls,2);assert.equal(events[0].exitCode,9);
});
test('可靠的真实低额度立即返回，不通过复核掩盖低额度',async()=>{
 const server=serverFactory([97,0]);const q=await quota.readQuota({resolveExecutable:()=> 'fixture',spawnProcess:()=>server.spawn(),onDiagnostic:()=>{},sleep:async()=>{}});
 assert.equal(q.fiveHourRemaining,3);assert.equal(server.calls,1);
});
test('持续不可靠额度最多三轮后失败',async()=>{
 const server=serverFactory([null,null,null]);
 await assert.rejects(quota.readQuota({resolveExecutable:()=> 'fixture',spawnProcess:()=>server.spawn(),onDiagnostic:()=>{},sleep:async()=>{}}),/quota response unreliable/);assert.equal(server.calls,3);
});
test('额度服务超时保留超时信息并终止三次子进程',async()=>{
 let calls=0,kills=0;const events=[];
 await assert.rejects(quota.readQuota({resolveExecutable:()=> 'fixture',timeoutMs:5,sleep:async()=>{},onDiagnostic:x=>events.push(x),spawnProcess:()=>{
  calls++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{kills++;};return child;
 }}),/quota read timeout/);
 assert.equal(calls,3);assert.equal(kills,3);assert.equal(events.length,3);assert.ok(events.every(x=>x.timedOut&&x.code==='ETIMEDOUT'));
});
test('程序确实缺失时不反复启动，也不回退显式配置',t=>{
 const {root,add}=fixture(t);add('installed',1000);let calls=0;const events=[];
 assert.throws(()=>quota.resolveCodexExecutable({env:{TASK016_CODEX_EXECUTABLE:join(root,'missing.exe')},binRoot:root,probe:()=>{calls++;return true;},onDiagnostic:x=>events.push(x)}),/ENOENT/);
 assert.equal(calls,0);assert.equal(events[0].stage,'stat');
});

// 3轮及总预算使用假时钟验证，不能退化为嵌套即时重试。
function retryOptions(overrides={}){let time=0;const waits=[];return {waits,options:{resolveExecutable:()=> 'fixture',onDiagnostic:()=>{},now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;},...overrides},advance:ms=>{time+=ms;}};}
test('临时错误最多3轮，轮间等待且保留原错误',async()=>{
 const error=Object.assign(Error('temporary'),{code:'ETIMEDOUT'});let calls=0;const f=retryOptions({readOnce:async()=>{calls++;throw error;}});
 await assert.rejects(quota.readQuota(f.options),e=>e.cause===error);assert.equal(calls,3);assert.deepEqual(f.waits,[30000,30000]);
});
test('永久权限错误立即失败且不等待',async()=>{
 let calls=0;const f=retryOptions({readOnce:async()=>{calls++;throw Object.assign(Error('denied'),{code:'EACCES'});}});
 await assert.rejects(quota.readQuota(f.options),/denied/);assert.equal(calls,1);assert.deepEqual(f.waits,[]);
});
test('解析及探测耗时计入5分钟，剩余预算限制单轮超时',async()=>{
 const limits=[];let calls=0;const f=retryOptions();f.options.resolveExecutable=options=>{assert.equal(options.maxProbeAttempts,1);f.advance(250000);return 'fixture';};f.options.readOnce=async(p,s,timeout)=>{calls++;limits.push(timeout);f.advance(timeout);throw Object.assign(Error('deadline'),{code:'ETIMEDOUT'});};
 await assert.rejects(quota.readQuota(f.options),/deadline/);assert.equal(calls,1);assert.deepEqual(limits,[20000]);assert.deepEqual(f.waits,[]);
});
test('剩余10秒只允许10秒查询，预算到期停止',async()=>{
 const limits=[];const f=retryOptions({resolveExecutable:()=>{f.advance(290000);return 'fixture';},readOnce:async(p,s,timeout)=>{limits.push(timeout);f.advance(timeout);throw Object.assign(Error('deadline'),{code:'ETIMEDOUT'});}});
 await assert.rejects(quota.readQuota(f.options),/deadline/);assert.deepEqual(limits,[10000]);assert.deepEqual(f.waits,[]);
});
test('解析临时失败仅执行三轮，每轮只允许一次探测',async()=>{
 let calls=0;const f=retryOptions({resolveExecutable:options=>{assert.equal(options.maxProbeAttempts,1);calls++;throw Object.assign(Error('probe timeout'),{code:'ETIMEDOUT'});}});
 await assert.rejects(quota.readQuota(f.options),/probe timeout/);assert.equal(calls,3);assert.deepEqual(f.waits,[30000,30000]);
});
test('永久协议错误与认证错误不重试，临时服务错误可重试',()=>{
 for(const code of ['ENOENT','EACCES','EPERM','INVALID_VERSION',401,403,-32600,-32601,-32602,'UNKNOWN'])assert.equal(quota.isTransientQuotaError({code}),false);
 for(const code of ['ETIMEDOUT','ECONNRESET','SERVICE_EXIT',429,503,-32603])assert.equal(quota.isTransientQuotaError({code}),true);
});
