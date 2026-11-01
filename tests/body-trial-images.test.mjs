// 2026-10-28 Codex：真实PNG字节，隔离模型和上传器，无外发。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openStore,saveContent,saveMaterialVersion} from '../src/storage.mjs';
import {prepareExternalBodyPreference} from '../src/preference.mjs';
import {createBodyTrialSelector,prepareBodyTrialDecision} from '../src/candidates.mjs';
import {createDisplay} from '../src/display.mjs';
import {createDelivery} from '../src/delivery.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KwAAAABJRU5ErkJggg==','base64');
async function fixture(t,{body='实际正文两图保持原文',imageCount=2}={}){
 const root=mkdtempSync(join(tmpdir(),'body-images-')),store=openStore(join(root,'db'));t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const save=(name,value)=>{const ref=join(root,name);writeFileSync(ref,Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));return ref;};
 const oldBody=save('old-body','旧正文'),old=saveContent(store,{platform:'xiaohongshu',content_id:'old'}).entity_id,oldMaterial=saveMaterialVersion(store,{content_id:old,body_ref:oldBody,body_hash:sha(readFileSync(oldBody)),ordered_images:[],media_kind:'text',completeness:'complete'}).entity_id;
 const profileRef=save('profile',{scope:{images_seen:0},findings:[{theme:'工程',interpretation:'参考',confidence:'高',long_term:false,evidence:[{note_id:'old',quote:'旧正文',location:'正文'}]}],limitations:['正文']});
 const ledgerRef=save('ledger',JSON.stringify({note_id:'old','原文短证据':'旧正文','证据位置':'正文',long_term:false,image_seen:false})+'\n');
 const acceptanceRef=save('acceptance',{kind:'human_acceptance',accepted:true,profile_hash:sha(readFileSync(profileRef)),ledger_hash:sha(readFileSync(ledgerRef)),source:{text:'接受',recorded_at:'now',chat_ref:'chat'},model_source:{interface:'ChatGPT',model:'GPT6',observed:'unknown'}});
 const pref=prepareExternalBodyPreference({store,root,owner:'o',profileRef,ledgerRef,acceptanceRef,materials:{old:oldMaterial}});pref.publish();
 const at='2026-10-28T07:00:00.000Z';store.db.prepare("INSERT INTO strategy_version(strategy_version,preference_version,rule_diff_json,state,effective_at,created_at) VALUES('s',?,?,'active',?,?)").run(pref.preference_version,JSON.stringify({rules:['正文筛选带图']}),at,at);
 store.db.prepare("INSERT INTO batch(delivery_batch_id,owner,kind,business_day,target,status,created_at) VALUES('b','o','daily_follow','2026-10-28',20,'pending',?)").run(at);
 const sourceId='new',cid=saveContent(store,{platform:'xiaohongshu',content_id:sourceId}).entity_id,bodyRef=save('new-body',{title:'真实标题',description:body,author_name:'真实作者'}),images=Array.from({length:imageCount},(_,index)=>({index,path:save(`image-${index}.png`,png),hash:sha(png)}));
 const material=saveMaterialVersion(store,{content_id:cid,body_ref:bodyRef,body_hash:sha(readFileSync(bodyRef)),ordered_images:images,media_kind:'image',completeness:'complete'}).entity_id;
 const source=save('source',{observations:[{content_id:sourceId,complete_source_url:'https://www.xiaohongshu.com/explore/new?xsec_token=test'}]});store.db.prepare("INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,eligibility_state) VALUES('c',?,'b','homefeed',?,?,'hold')").run(cid,at,`file:${source}`);
 let modelCalls=0;const selector=createBodyTrialSelector({store,root,owner:'o',model:async input=>{modelCalls++;writeFileSync(input.outputPath,JSON.stringify({decisions:[{source_id:sourceId,status:'chosen',quote:'实际正文',hypothesis_indexes:[0],reason:'工程参考'}]}));return {exitCode:0,stdout:'{"type":"turn.completed"}'};}});
 const selection=await selector.select({candidates:[{source_id:sourceId,title:'真实标题',body}]});const registered=prepareBodyTrialDecision({store,owner:'o',batchId:'b',candidateId:'c',materialVersionId:material,selectionRefs:selection.refs,now:()=>at}).publish();
 return {root,store,images,body,registered,modelCalls:()=>modelCalls,create:(uploadImage,options={})=>createDisplay({store,owner:'o',root:join(root,'display'),appRef:'test-app',now:()=>at,allowTextFallback:false,decodeImage:async path=>{assert.deepEqual(readFileSync(path).subarray(0,8),png.subarray(0,8));return {width:1,height:1,format:'png'};},uploadImage,...options})};
}
test('正文筛选两图按序上传/展示，未读标注，重建不重传不再调用模型',async t=>{
 const f=await fixture(t),uploaded=[];const d=f.create(async path=>{uploaded.push(path);return {image_key:`img-${uploaded.length}`};});
 const built=await d.buildBatch('b',[f.registered]);assert.equal(built.items[0].status,'succeeded');assert.deepEqual(uploaded,f.images.map(x=>x.path));
 const post=JSON.parse(built.items[0].payload.content).zh_cn;assert.equal(post.content[1][0].text,f.body);assert.match(built.items[0].payload.content,/图片未/);assert.deepEqual(post.content.filter(r=>r[0].tag==='img').map(r=>r[0].image_key),['img-1','img-2']);
 for(const mapped of built.items[0].mapping.media)assert.equal(post.content[mapped.row][0].image_key,mapped.image_key);
 await d.buildBatch('b',[f.registered]);assert.equal(uploaded.length,2);assert.equal(f.modelCalls(),1);
});
test('显式严格模式仍阻断missing/hash图片，正文优先路径另测',async t=>{
 const f=await fixture(t);let calls=0;const d=f.create(async()=>{calls++;return {image_key:'never'};});
 rmSync(f.images[0].path);assert.equal((await d.buildBatch('b',[f.registered])).items[0].status,'blocked');assert.equal(calls,0);
 writeFileSync(f.images[0].path,Buffer.from('bad hash'));assert.equal((await d.buildBatch('b',[f.registered])).items[0].status,'blocked');assert.equal(calls,0);assert.equal(f.modelCalls(),1);
});
test('严格模式上传unknown保持阻断和原attempt，重建不重传该图片',async t=>{
 const f=await fixture(t);let calls=0;const d=f.create(async()=>{calls++;return {};});
 assert.equal((await d.buildBatch('b',[f.registered])).items[0].status,'blocked');const first=calls;
 assert.equal((await d.buildBatch('b',[f.registered])).items[0].status,'blocked');assert.equal(calls,first);assert.equal(f.modelCalls(),1);
});

test('正文优先：图文组合未验证时完整发正文并标明未附图片，预检不上传',async t=>{
 const f=await fixture(t,{body:'实际正文'+ '完整内容'.repeat(250),imageCount:10});let calls=0;
 const d=f.create(async()=>{calls++;return {image_key:'unused'};},{allowTextFallback:true});
 const built=(await d.buildBatch('b',[f.registered])).items[0];assert.equal(built.status,'succeeded');
 const post=JSON.parse(built.payload.content).zh_cn;assert.equal(post.content[1][0].text,f.body);assert.equal(post.content.flat().filter(x=>x.tag==='img').length,0);assert.match(built.payload.content,/图片未附/);assert.equal(calls,0);assert.equal(f.modelCalls(),1);
 assert.deepEqual(built.media_fallback.reasons,['unverified_platform_combination']);
});
test('正文优先：缺图或未知上传都不挡正文，原未知图片仍不重传',async t=>{
 const f=await fixture(t);let calls=0;const d=f.create(async()=>{calls++;return {};},{allowTextFallback:true});
 const first=(await d.buildBatch('b',[f.registered])).items[0];assert.equal(first.status,'succeeded');assert.match(first.payload.content,/图片未附/);const count=calls;
 assert.equal((await d.buildBatch('b',[f.registered])).items[0].status,'succeeded');assert.equal(calls,count);
 rmSync(f.images[0].path);const missing=(await d.buildBatch('b',[f.registered])).items[0];assert.equal(missing.status,'succeeded');assert.match(missing.payload.content,/图片未附/);assert.equal(calls,count);
});

test('同日续批保留已发送旧正文身份，反馈变化不能让旧资格阻断新候选',async t=>{
 const f=await fixture(t),d=f.create(async()=>({image_key:'old-image'}));
 const old=(await d.buildBatch('b',[f.registered])).items[0];
 const delivery=createDelivery({store:f.store,root:join(f.root,'delivery'),owner:'o',appRef:'test-app',targetRef:'test-chat',now:()=> '2026-10-28T07:00:00.000Z',transport:{send:async()=>({status:'succeeded',message_id:'old-sent',evidence:'synthetic:regression-receipt'}),lookup:async()=>({status:'succeeded',message_id:'old-sent',evidence:'synthetic:regression-receipt'})}});
 const intent=await delivery.prepareDelivery(old);assert.equal((await delivery.sendPrepared(intent.attempt_id)).status,'succeeded');
 const cid=f.store.db.prepare('SELECT content_id FROM recommendation WHERE recommendation_id=?').get(old.recommendation_id).content_id,at='2026-10-28T02:00:00Z';
 f.store.db.prepare("INSERT INTO feedback_event(app_ref,chat_ref,event_id,recommendation_id,content_id,value,received_at,saved_at,revision,parse_state,association_state) VALUES('test-app','test-chat','later-feedback',?,?,'like',?,?,1,'parsed','matched')").run(old.recommendation_id,cid,at,at);
 f.store.db.prepare("INSERT INTO feedback_current(owner,app_ref,chat_ref,platform,source_content_id,content_id,recommendation_id,value,revision,event_id,saved_at) VALUES('o','test-app','test-chat','xiaohongshu','new',?,?,'like',1,'later-feedback',?)").run(cid,old.recommendation_id,at);
 const second=saveContent(f.store,{platform:'xiaohongshu',content_id:'new2'}).entity_id,body='实际正文第二条',ref=join(f.root,'second-body.json'),source=join(f.root,'second-source.json');
 writeFileSync(ref,JSON.stringify({title:'第二条标题',description:body,author_name:'第二作者'}));writeFileSync(source,JSON.stringify({observations:[{content_id:'new2',complete_source_url:'https://www.xiaohongshu.com/explore/new2?xsec_token=test'}]}));
 const material=saveMaterialVersion(f.store,{content_id:second,body_ref:ref,body_hash:sha(readFileSync(ref)),ordered_images:[],media_kind:'text',completeness:'complete'}).entity_id;
 f.store.db.prepare("INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,eligibility_state) VALUES('c2',?,'b','homefeed',?,?,'hold')").run(second,at,`file:${source}`);
 const selector=createBodyTrialSelector({store:f.store,root:f.root,owner:'o',model:async input=>{writeFileSync(input.outputPath,JSON.stringify({decisions:[{source_id:'new2',status:'chosen',quote:'实际正文',hypothesis_indexes:[0],reason:'当前反馈后的新参考'}]}));return {exitCode:0,stdout:'{"type":"turn.completed"}'};}});
 const selected=await selector.select({candidates:[{source_id:'new2',title:'第二条标题',body}]});
 const next=prepareBodyTrialDecision({store:f.store,owner:'o',batchId:'b',candidateId:'c2',materialVersionId:material,selectionRefs:selected.refs}).publish();
 const built=await d.buildBatch('b',[next]);assert.equal(built.items.length,1);assert.equal(built.items[0].status,'succeeded');assert.equal(built.items[0].ordinal,2);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt WHERE recommendation_id=?').get(old.recommendation_id).n,1);
 assert.equal(f.store.db.prepare('SELECT state FROM recommendation WHERE recommendation_id=?').get(old.recommendation_id).state,'succeeded');
});
