// 2026-10-31 Codex：假时钟及隔离文件验证，不访问额度服务或业务平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import * as quota from '../.codex/task016-live-quota.mjs';

test('最快观测速度决定查询间隔，两种额度取早并限制30秒至10分钟',()=>{
 assert.equal(typeof quota.quotaIntervalMs,'function');
 assert.equal(quota.quotaIntervalMs({fiveHourRemaining:100,weeklyRemaining:100}),600000);
 assert.ok(Math.abs(quota.quotaIntervalMs({fiveHourRemaining:93,weeklyRemaining:20})-582390)<1);
 assert.equal(quota.quotaIntervalMs({fiveHourRemaining:4,weeklyRemaining:2}),30000);
 assert.ok(quota.quotaIntervalMs({fiveHourRemaining:10,weeklyRemaining:100})<60000);
 assert.throws(()=>quota.quotaIntervalMs({fiveHourRemaining:NaN,weeklyRemaining:20}));
});
test('启动强制刷新，阶段共用缓存，截止边界只刷新一次',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'quota-interval-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let time=Date.parse('2026-10-31T00:00:00Z'),calls=0;
 const options={cachePath:join(dir,'quota.json'),now:()=>time,resolveExecutable:()=> 'fixture',readOnce:async()=>{calls++;return {observed_at:new Date(time).toISOString(),fiveHourRemaining:99,weeklyRemaining:100};}};
 await quota.readQuota({...options,force:true});
 await Promise.all([quota.readQuota(options),quota.readQuota(options)]);assert.equal(calls,1);
 time+=599999;await quota.readQuota(options);assert.equal(calls,1);
 time++;await Promise.all([quota.readQuota(options),quota.readQuota(options)]);assert.equal(calls,2);
 await quota.readQuota({...options,force:true});assert.equal(calls,3);
 const cached=JSON.parse(readFileSync(options.cachePath,'utf8'));assert.equal(cached.fiveHourRemaining,99);
});
test('到期查询失败不能回退旧高额度，低额度原样返回供停止',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'quota-interval-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let time=Date.parse('2026-10-31T00:00:00Z');
 const options={cachePath:join(dir,'quota.json'),now:()=>time,resolveExecutable:()=> 'fixture',onDiagnostic:()=>{},readOnce:async()=>({observed_at:new Date(time).toISOString(),fiveHourRemaining:99,weeklyRemaining:100})};
 await quota.readQuota(options);time+=600000;
 await assert.rejects(quota.readQuota({...options,readOnce:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}),/denied/);
 const q=await quota.readQuota({...options,readOnce:async()=>({observed_at:new Date(time).toISOString(),fiveHourRemaining:3,weeklyRemaining:1})});assert.equal(q.fiveHourRemaining,3);
});
test('独立子进程通过环境路径共享缓存，并发仅查询一次',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'quota-process-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const cachePath=join(dir,'quota.json'),countPath=join(dir,'calls.txt');
 const code=`import {readQuota} from ${JSON.stringify(new URL('../.codex/task016-live-quota.mjs',import.meta.url).href)};
 import {appendFileSync} from 'node:fs';
 const q=await readQuota({resolveExecutable:()=> 'fixture',readOnce:async()=>{appendFileSync(${JSON.stringify(countPath)},'query\\n');await new Promise(r=>setTimeout(r,200));return {observed_at:new Date().toISOString(),fiveHourRemaining:93,weeklyRemaining:20};}});console.log(JSON.stringify(q));`;
 const run=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TASK016_QUOTA_CACHE:cachePath},windowsHide:true});let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',exit=>exit===0?resolve(JSON.parse(out)):reject(Error(err)));
 });
 const results=await Promise.all([run(),run()]);assert.deepEqual(results[0],results[1]);
 assert.equal(readFileSync(countPath,'utf8'),'query\n');await run();assert.equal(readFileSync(countPath,'utf8'),'query\n');
});
test('未来或损坏缓存强制重读，不把无法校验的读数当有效',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'quota-invalid-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {writeFileSync}=await import('node:fs');const cachePath=join(dir,'quota.json');let calls=0;
 const options={cachePath,resolveExecutable:()=> 'fixture',readOnce:async()=>{calls++;return {observed_at:new Date().toISOString(),fiveHourRemaining:90,weeklyRemaining:20};}};
 writeFileSync(cachePath,JSON.stringify({observed_at:new Date(Date.now()+3600000).toISOString(),fiveHourRemaining:99,weeklyRemaining:100}));await quota.readQuota(options);
 writeFileSync(cachePath,'{broken');await quota.readQuota(options);assert.equal(calls,2);
});
