// 2026-10-31 Codex：停用独立主动批，保留历史查询，不访问平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFeedbackText} from '../src/feedback.mjs';
import {createHomefeed} from '../src/homefeed.mjs';
import {openStore} from '../src/storage.mjs';
import * as worker from '../.codex/task016-auto-worker.mjs';
test('只保留再来3条，不创建主动10或20请求',()=>{
 assert.deepEqual(parseFeedbackText('再来3条'),{kind:'request',request_type:'additional_follow',target:3});
 for(const text of ['推荐10条','推送10条','再来10条','推荐20条','推荐3条'])assert.equal(parseFeedbackText(text).kind,'invalid');
});
test('禁止新主动批，历史10和20原值可查询但不能执行',async t=>{
 const root=mkdtempSync(join(tmpdir(),'manual-disabled-')),store=openStore(join(root,'state.sqlite'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const hf=createHomefeed({store,root,owner:'TASK012-synthetic'});
 for(const target of [10,20]){
  const command='old'+target;
  store.db.prepare("INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,updated_at) VALUES(?,?,?,'manual_follow','2026-10-30',?,'2026-10-30T04:00:00Z','pending','2026-10-30T04:00:00Z')").run(command,'TASK012-synthetic',command,target);
  assert.equal(hf.beginBatch({kind:'manual_follow',commandId:command,explicitRequest:true}).target,target);
  await assert.rejects(worker.executeRecommendationRounds({request:{request_type:'manual_follow',target,provenance:{command_id:command}},root,databasePath:join(root,'state.sqlite'),guard:async()=>{},run:async()=>assert.fail('disabled entry')}),/manual.*disabled/);
 }
 assert.throws(()=>hf.beginBatch({kind:'manual_follow',commandId:'new',explicitRequest:true}),/manual.*disabled/);
 assert.equal(store.db.prepare('SELECT count(*) n FROM batch').get().n,2);
});
test('监听及执行入口不接管历史主动批，只保留追加3',()=>{
 for(const target of [10,20]){
  assert.equal(worker.isCurrentFollowRequest({request_type:'manual_follow',target}),false);
  assert.throws(()=>worker.executeAdditional({request_type:'manual_follow',target}),/unsupported current/);
 }
 assert.equal(worker.isCurrentFollowRequest({request_type:'additional_follow',target:3}),true);
});
