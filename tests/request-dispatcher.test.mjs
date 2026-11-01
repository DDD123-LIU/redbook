// 2026-10-28 Codex：隔离请求调度，不发送消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../src/storage.mjs';
import {createRequestDispatcher} from '../src/feishu-listener.mjs';

test('额度停止仅当天阻止新请求，午夜后重查额度但不重放旧请求',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dispatch-nextday-')),store=openStore(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let time='2026-10-31T15:59:00Z',low=true,calls=0;
 const requests=['a','b'].map(id=>({status:'request_pending',event_id:id,provenance:{owner:'o',event_id:id,command_id:id}}));
 const d=createRequestDispatcher({store,owner:'o',now:()=>time,feedback:{pendingRequests:async()=>requests},quotaProbe:async()=>({reliable:true,shortRemainingPercent:low?3:90,weeklyRemainingPercent:20}),execute:async()=>{calls++;return {status:'succeeded'};}});
 assert.equal((await d.enqueue(requests[0])).status,'quota_blocked');
 low=false;assert.equal((await d.enqueue(requests[1])).status,'stopped');
 time='2026-10-31T16:00:00Z';assert.equal((await d.enqueue(requests[1])).status,'succeeded');
 assert.equal((await d.enqueue(requests[0])).status,'quota_blocked');assert.equal(calls,1);
});
test('单队列、事件去重、重启和partial旧批次均不重复执行，stop等待',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dispatch-')),store=openStore(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const requests=['a','b','c'].map(id=>({status:'request_pending',event_id:id,target:3,provenance:{owner:'o',event_id:id,command_id:id}}));
 const feedback={pendingRequests:async()=>requests},quotaProbe=async()=>({reliable:true,shortRemainingPercent:98,weeklyRemainingPercent:84});
 let active=0,max=0,calls=0;const execute=async request=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return {status:'partial',command_id:request.provenance.command_id};};
 const args={store,owner:'o',feedback,execute,quotaProbe},d=createRequestDispatcher(args);
 const first=d.enqueue(requests[0]),duplicate=d.enqueue(requests[0]),second=d.enqueue(requests[1]);await d.stop();await Promise.all([first,duplicate,second]);assert.equal(calls,2);assert.equal(max,1);assert.equal((await d.enqueue(requests[2])).status,'stopped');
 const restarted=createRequestDispatcher(args);await restarted.enqueue(requests[0]);assert.equal(calls,2);
 store.db.prepare("INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,status,created_at) VALUES('existing','o','c','manual_follow','2026-10-28',3,'partial','now')").run();
 assert.equal((await restarted.enqueue(requests[2])).status,'existing_batch');assert.equal(calls,2);await restarted.drain();
});
test('不可靠或低额度停止，不自动重试失败和旧intent',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dispatch-quota-')),store=openStore(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const request={status:'request_pending',event_id:'q',provenance:{owner:'o',event_id:'q',command_id:'q'}};let calls=0;
 const args={store,owner:'o',feedback:{pendingRequests:async()=>[request]},execute:async()=>{calls++;throw Error('worker failed');},quotaProbe:async()=>({reliable:true,shortRemainingPercent:3.99,weeklyRemainingPercent:84})};
 assert.equal((await createRequestDispatcher(args).enqueue(request)).status,'quota_blocked');assert.equal(calls,0);
 assert.equal((await createRequestDispatcher({...args,quotaProbe:async()=>({reliable:true,shortRemainingPercent:98,weeklyRemainingPercent:84})}).enqueue(request)).status,'quota_blocked');assert.equal(calls,0);
 const next={...request,event_id:'fail',provenance:{...request.provenance,event_id:'fail',command_id:'fail'}};const good={...args,feedback:{pendingRequests:async()=>[next]},quotaProbe:async()=>({reliable:true,shortRemainingPercent:98,weeklyRemainingPercent:84})};
 assert.equal((await createRequestDispatcher(good).enqueue(next)).status,'failed');await createRequestDispatcher(good).enqueue(next);assert.equal(calls,1);
});
test('额度边界4/2允许；不可靠、周低额度及重启旧intent均不执行',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dispatch-boundary-')),store=openStore(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const request=id=>({status:'request_pending',event_id:id,provenance:{owner:'o',event_id:id,command_id:id}}),requests=['exact','unreliable','weekly','intent'].map(request);
 let calls=0;const args={store,owner:'o',feedback:{pendingRequests:async()=>requests},execute:async()=>{calls++;return {status:'succeeded'};}};
 assert.equal((await createRequestDispatcher({...args,quotaProbe:async()=>({reliable:true,shortRemainingPercent:4,weeklyRemainingPercent:2})}).enqueue(requests[0])).status,'succeeded');
 assert.equal((await createRequestDispatcher({...args,quotaProbe:async()=>({reliable:false})}).enqueue(requests[1])).status,'quota_blocked');
 assert.equal((await createRequestDispatcher({...args,quotaProbe:async()=>({reliable:true,shortRemainingPercent:94,weeklyRemainingPercent:1.99})}).enqueue(requests[2])).status,'quota_blocked');assert.equal(calls,1);
 let release,started;const gate=new Promise(r=>{release=r;}),start=new Promise(r=>{started=r;});
 const activeArgs={...args,quotaProbe:async()=>({reliable:true,shortRemainingPercent:94,weeklyRemainingPercent:83}),execute:async()=>{calls++;started();await gate;return {status:'partial'};}};
 const first=createRequestDispatcher(activeArgs).enqueue(requests[3]);await start;assert.equal((await createRequestDispatcher(activeArgs).enqueue(requests[3])).status,'unknown');assert.equal(calls,2);release();await first;
});
