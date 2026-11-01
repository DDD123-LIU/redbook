// 2026-10-24 Codex：真实模块接口的隔离闭环；平台及事件由合成适配器提供。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';
import { createDelivery } from '../src/delivery.mjs';
import { createFeedback } from '../src/feedback.mjs';
import { createFeishuTransport } from '../src/feishu-adapter.mjs';
import { createFeishuListener } from '../src/feishu-listener.mjs';

test('构建→投递→真实handler接口→赞/查询/更正，保存后回执且重放不重复发送',async t=>{
 const f=await deliveryFixture(t),app='synthetic-app',chat='synthetic-chat',sender='synthetic-user',now=()=> '2026-10-23T04:01:00.000Z';
 const messages=[];let calls=0,lostReceipt=false;
 const client={im:{message:{async create({data}){
  calls++;
  if(data.msg_type==='text')assert(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n>0);
  const m={message_id:`message-${calls}`,chat_id:chat,msg_type:data.msg_type,body:{content:data.content},create_time:String(Date.parse(now())),sender:{sender_type:'app',id:app}};messages.push(m);
  if(lostReceipt){lostReceipt=false;throw Error('synthetic lost response');}
  return {code:0,data:{message_id:m.message_id}};
 },async get({path}){return {code:0,data:{items:messages.filter(x=>x.message_id===path.message_id)}};},async list(){return {code:0,data:{items:messages,has_more:false}};}}}};
 const transport=createFeishuTransport({client,targetRef:chat,appRef:app,root:f.root,now});
 const delivery=createDelivery({store:f.store,root:`${f.root}/delivery`,owner:f.owner,targetRef:chat,appRef:app,transport,now,currentVersions:f.currentVersions});
 const prepared=await delivery.prepareDelivery(f.recommendation,f.generation);assert.equal((await delivery.sendPrepared(prepared.attempt_id)).status,'succeeded');
 const feedback=createFeedback({store:f.store,root:f.root,owner:f.owner,appRef:app,chatRef:chat,senderRef:sender,transport,now});
 let dispatch;const Lark={EventDispatcher:class{register(handlers){dispatch=handlers['im.message.receive_v1'];return this;}}};
 const results=[];const listener=createFeishuListener({Lark,wsClient:{async start(){},close(){}},feedback,appRef:app,chatRef:chat,senderRef:sender,now,onResult:x=>results.push(x)});await listener.start();t.after(()=>listener.stop());
 const event=text=>({header:{app_id:app,event_id:randomUUID()},event:{sender:{sender_id:{open_id:sender},sender_type:'user'},message:{message_id:randomUUID(),chat_id:chat,chat_type:'p2p',message_type:'text',create_time:String(Date.parse(now())),content:JSON.stringify({text})}}});
 const like=event('1 赞'),likeResult=await dispatch(like);assert.equal(likeResult.receipt?.status,'succeeded',JSON.stringify(likeResult));
 assert.equal(f.store.db.prepare('SELECT value FROM feedback_current').get().value,'like');
 await dispatch(event('查询 1'));
 const correction=await dispatch(event('更正 1 踩 修订1'));assert.equal(correction.receipt?.status,'succeeded');
 assert.deepEqual({...f.store.db.prepare('SELECT value,revision FROM feedback_current').get()},{value:'dislike',revision:2});
 await dispatch(event('查询 1'));const before=calls;await dispatch(like);assert.equal(calls,before);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n,2);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,4);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE state='succeeded'").get().n,4);
 lostReceipt=true;await dispatch(event('查询 1'));
 const unknown=f.store.db.prepare("SELECT outbox_id FROM outbox WHERE state='unknown'").get();assert(unknown);
 const sentCount=calls;assert.equal((await feedback.reconcileReceipt(unknown.outbox_id)).status,'succeeded');assert.equal(calls,sentCount);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_history').get().n,2);
 assert(results.some(x=>x.business_status==='query'));
});
