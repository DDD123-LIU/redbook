// 2026-10-29 Codex：只测本地互斥及日调度身份，不访问账号或模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {withRequestLease,dailyRequest,persistQuotaPause} from '../.codex/task016-auto-worker.mjs';
test('定时10目标贯通请求且身份与原20隔离',()=>{
 const now=new Date('2026-10-31T03:15:00Z'),old=dailyRequest(now),next=dailyRequest(now,{dailyTarget:10});assert.equal(next.target,10);assert.notEqual(next.provenance.command_id,old.provenance.command_id);assert.throws(()=>dailyRequest(now,{dailyTarget:11}),/target/);
});

test('明确授权的当日10条单次可提前启动，拒绝未到时/跨日/无时区及旧20新授权',()=>{
 const options={authorizedOneOffAt:'2026-11-02T00:10:00+08:00',dailyTarget:10},now=new Date('2026-11-01T16:10:00Z');
 const request=dailyRequest(now,options);assert.equal(request.target,10);assert.equal(request.business_day,'2026-11-02');assert.equal(request.provenance.trigger_type,'user_authorized_one_off');
 assert.equal(dailyRequest(new Date('2026-11-01T16:11:00Z'),options).provenance.command_id,request.provenance.command_id);
 assert.notEqual(dailyRequest(new Date('2026-11-02T03:15:00Z'),{dailyTarget:10}).provenance.command_id,request.provenance.command_id);
 assert.throws(()=>dailyRequest(new Date('2026-11-01T16:09:59Z'),options),/not due/);
 assert.throws(()=>dailyRequest(new Date('2026-11-02T16:10:00Z'),options),/day|expired/);
 assert.throws(()=>dailyRequest(now,{...options,authorizedOneOffAt:'2026-11-02T00:10:00'}),/authorization|timestamp/);
 assert.throws(()=>dailyRequest(now,{...options,dailyTarget:20}),/authorization|target/);
 assert.throws(()=>dailyRequest(now,{dailyTarget:10}),/11:15/);
});

test('三入口整请求互斥，已持有时第二请求不执行，结束后可执行',async t=>{
 const root=mkdtempSync(join(tmpdir(),'request-lease-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);let calls=0;
 const first=withRequestLease(root,'manual',async()=>{calls++;started();await hold;return 'first';});await ready;
 await assert.rejects(()=>withRequestLease(root,'daily',async()=>{calls++;}),/active|unresolved/);
 assert.equal(calls,1);release();assert.equal(await first,'first');
 assert.equal(await withRequestLease(root,'additional',async()=>{calls++;return 'second';}),'second');assert.equal(calls,2);
});
test('遗留请求锁不按死PID猜测自动删除，任务抛错后释放自己的锁',async t=>{
 const root=mkdtempSync(join(tmpdir(),'request-orphan-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'active-request.lock'),JSON.stringify({pid:99999999,command:'unknown'}));
 await assert.rejects(()=>withRequestLease(root,'new',async()=>assert.fail()),/active|unresolved/);
 rmSync(join(root,'active-request.lock'));
 await assert.rejects(()=>withRequestLease(root,'failed',async()=>{throw Error('stage failed');}),/stage failed/);
 assert.equal(await withRequestLease(root,'after',async()=>true),true);
});
test('独立Node进程不能进入另一入口已持有的整请求',async t=>{
 const root=mkdtempSync(join(tmpdir(),'request-process-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const module=new URL('../.codex/task016-auto-worker.mjs',import.meta.url).href;
 await withRequestLease(root,'parent',async()=>{
  const code=`const {withRequestLease}=await import(${JSON.stringify(module)});try{await withRequestLease(${JSON.stringify(root)},'child',async()=>process.exit(99));process.exit(98);}catch(e){process.exit(/active|unresolved/.test(e.message)?0:97);}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{windowsHide:true,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 });
});
test('上海每日11:15门槛、同日稳定身份、午夜跨日不追旧日',()=>{
 assert.throws(()=>dailyRequest(new Date('2026-10-29T03:14:59Z')),/11:15/);
 const a=dailyRequest(new Date('2026-10-29T03:15:00Z')),b=dailyRequest(new Date('2026-10-29T15:59:59Z'));
 assert.equal(a.provenance.command_id,b.provenance.command_id);assert.equal(a.target,20);assert.equal(a.request_type,'daily_follow');assert.equal(a.provenance.source,'native_schedule');
 assert.throws(()=>dailyRequest(new Date('2026-10-29T16:00:00Z')),/11:15/);
 const next=dailyRequest(new Date('2026-10-30T03:15:00Z'));assert.notEqual(a.provenance.command_id,next.provenance.command_id);
});
test('低额度先保存交接再写暂停凭据，已有暂停不覆盖；交接失败不得假称已暂停',t=>{
 const root=mkdtempSync(join(tmpdir(),'quota-checkpoint-')),handoff=join(root,'handoff.md');t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(handoff,'old handoff');persistQuotaPause({root,handoff,reason:'low quota',command:'first'});
 assert.match(readFileSync(handoff,'utf8'),/low quota/);assert.match(readFileSync(handoff,'utf8'),/old handoff/);
 assert.equal(JSON.parse(readFileSync(join(root,'task016-quota-paused.json'))).command,'first');
 persistQuotaPause({root,handoff,reason:'still paused',command:'second'});assert.equal(JSON.parse(readFileSync(join(root,'task016-quota-paused.json'))).command,'first');
 rmSync(join(root,'task016-quota-paused.json'));assert.throws(()=>persistQuotaPause({root,handoff:join(root,'absent','handoff'),reason:'blocked',command:'third'}));assert.equal(existsSync(join(root,'task016-quota-paused.json')),false);
});
test('用户授权今早06:05单次：不提前、不跨日，单次与11:15执行记录分开而业务日相同',()=>{
 const options={authorizedOneOffAt:'2026-10-29T06:05:00+08:00'};
 assert.throws(()=>dailyRequest(new Date('2026-10-28T22:04:59Z'),options),/not due|06:05/);
 const early=dailyRequest(new Date('2026-10-28T22:05:00Z'),options),late=dailyRequest(new Date('2026-10-29T03:15:00Z'));
 assert.equal(early.business_day,late.business_day);assert.equal(early.target,20);assert.notEqual(early.provenance.command_id,late.provenance.command_id);
 assert.equal(dailyRequest(new Date('2026-10-28T22:06:00Z'),options).provenance.command_id,early.provenance.command_id);
 assert.throws(()=>dailyRequest(new Date('2026-10-30T03:15:00Z'),options),/expired|day/);
});
