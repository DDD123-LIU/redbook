// 2026-10-23 Codex：合成正文与隔离临时库，不访问账号，不发送消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openStore, saveContent, saveMaterialVersion } from '../src/storage.mjs';
import { decodeImage } from '../src/analysis.mjs';
import { createDisplay, formatMessage, validateRequest } from '../src/display.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const rec = { recommendation_id:'00000000-0000-4000-8000-000000000001',content_id:'content',delivery_batch_id:'batch',decision_id:'decision',category:'follow',ordinal:1,material_version_id:'material' };
const material = { material_version_id:'material',content_id:'content',source_content_id:'source',material_hash:sha('material'),body_hash:sha('body'),
  body:'原文\r\n\n<&> "引号" \\ 😀\n末尾。', fields:{title:'标题',author_name:'原作者'},media_kind:'text',completeness:'complete',
  source_url:'https://example.com/original?x=1&y=2',source_status:'unknown',images:[] };

test('普通正文、原URL、特殊字符及完整版本映射保留，构建不等于投递',()=>{
  const r=formatMessage(rec,material);
  assert.equal(r.status,'succeeded');assert.equal(r.payload.msg_type,'post');
  const p=JSON.parse(r.payload.content).zh_cn;
  assert.equal(p.content[1][0].text,material.body);
  assert.equal(p.content.at(-1)[0].href,material.source_url);
  assert(p.title.includes('batch')&&p.title.includes('01')&&p.title.includes(rec.recommendation_id));
  assert.equal(r.material_version_id,'material');assert.equal(r.source_status,'unknown');
  assert.equal(r.payload_hash,formatMessage(rec,material).payload_hash);
  assert(!r.message_id&&!r.first_success_at);
});

test('长正文完整保留；超出已验证结构、30KB或组件未知时阻塞而不拆分',()=>{
  const long={...material,body:'长正文段落。'.repeat(1000)};
  const r=formatMessage(rec,long);assert.equal(r.status,'succeeded');
  assert.equal(JSON.parse(r.payload.content).zh_cn.content[1][0].text,long.body);
  for(const body of ['字'.repeat(6001),'字'.repeat(20000)]){
    const blocked=formatMessage(rec,{...material,body});assert.equal(blocked.status,'blocked');assert.equal(blocked.payload,null);
    assert(blocked.metrics.body_utf16>6000);
  }
  const response=validateRequest({msg_type:'post',content:JSON.stringify({text:'x'.repeat(29950)})},{receive_id:'x'.repeat(100),uuid:'id'});
  assert.equal(response.status,'blocked');
});

test('缺失作者/正文/标题/原入口或不可访问来源不冒充完整',()=>{
  for(const change of [{fields:{title:'标题'}},{fields:{author_name:'作者'}},{body:''},{source_url:''},{source_status:'unavailable'}]){
    const r=formatMessage(rec,{...material,...change});assert.equal(r.status,'blocked');assert.equal(r.payload,null);assert(r.reasons.length);
  }
});

test('有序多图、视频封面及入口；媒体失败、乱序和缺失整篇阻塞',()=>{
  const images=[0,1,2].map(index=>({index,path:`image-${index}`,hash:sha(String(index)),image_key:`img_${index}`,status:'succeeded'}));
  const m={...material,media_kind:'image',images};
  const r=formatMessage(rec,m);assert.equal(r.status,'succeeded');
  assert.deepEqual(JSON.parse(r.payload.content).zh_cn.content.filter(row=>row[0].tag==='img').map(row=>row[0].image_key),images.map(x=>x.image_key));
  assert.deepEqual(r.media.map(x=>x.index),[0,1,2]);
  for(const images2 of [[images[1],images[0],images[2]],[images[0],images[2]],images.map((x,i)=>i===1?{...x,status:'failed'}:x)]){
    assert.equal(formatMessage(rec,{...m,images:images2}).status,'blocked');
  }
  const video=formatMessage(rec,{...material,media_kind:'video',completeness:'video_unread',images:[],cover:images[0]});
  assert.equal(video.status,'succeeded');assert.equal(video.video_read,false);
  assert(video.payload.content.includes('视频未读'));assert(video.payload.content.includes('观看入口'));
  assert.equal(formatMessage(rec,{...material,media_kind:'video',completeness:'video_unread'}).status,'blocked');
});

async function fixture(t,count=3,kind='image',imageBytes=null){
  const dir=await mkdtemp(join(tmpdir(),'display-')); const db=join(dir,'state.sqlite');let store=openStore(db);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const insert=(table,data)=>{const keys=Object.keys(data);return store.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(data));};
  const at='2026-10-23T04:00:00Z',bid=randomUUID();
  insert('batch',{delivery_batch_id:bid,owner:'owner',kind:'daily_follow',business_day:'2026-10-23',target:20,status:'pending',created_at:at});
  const pref=randomUUID(),strategy=randomUUID(),baseline=randomUUID();
  insert('preference_version',{preference_version:pref,created_at:at});
  insert('strategy_version',{strategy_version:strategy,rule_diff_json:JSON.stringify({rules:['synthetic display fixture']}),preference_version:pref,state:'active',effective_at:at,created_at:at});
  insert('baseline_version',{baseline_version:baseline,material_version_ids_json:'[]',coverage_description:'synthetic',created_at:at});
  const decisions=[];
  for(let i=0;i<count;i++){
    const cid=saveContent(store,{platform:'xiaohongshu',content_id:String(i).padStart(24,'0'),source_state:'available'}).entity_id;
    const body=JSON.stringify({title:`合成标题${i}`,description:`合成原文${i}\n第二行`,author_name:'合成作者'}),bodyRef=join(dir,`body-${i}.json`);
    await writeFile(bodyRef,body);const img=join(dir,`image-${i}.png`);await writeFile(img,imageBytes??`fake-decoded-fixture-${i}`);
    const imageHash=sha(await readFile(img));
    const mid=saveMaterialVersion(store,{content_id:cid,body_ref:bodyRef,body,media_kind:kind,completeness:kind==='video'?'video_unread':'complete',ordered_images:[{index:0,path:img,hash:imageHash}],...(kind==='video'?{cover_ref:img,cover_hash:imageHash}:{})}).entity_id;
    const aid=randomUUID(),candidate=randomUUID(),did=randomUUID();
    insert('analysis',{analysis_id:aid,material_version_id:mid,input_hash:sha(body),prompt_version:'synthetic',model_requested:'synthetic',output_ref:'synthetic:analysis',completion_evidence:'synthetic:completed',status:'complete',created_at:at});
    const sourceRef=join(dir,`source-${i}.json`);await writeFile(sourceRef,JSON.stringify({observations:[{content_id:String(i).padStart(24,'0'),complete_source_url:`https://www.xiaohongshu.com/explore/${String(i).padStart(24,'0')}?xsec_token=synthetic-${i}`}]}));
    insert('candidate',{candidate_id:candidate,content_id:cid,discovery_batch_id:bid,source:'homefeed',discovered_at:at,source_evidence_ref:`file:${sourceRef}`,eligibility_state:'eligible'});
    insert('decision',{decision_id:did,candidate_id:candidate,analysis_id:aid,baseline_version:baseline,preference_version:pref,strategy_version:strategy,category:'follow',relevance:'matched',gain_state:'gain',result:'eligible',created_at:at});
    decisions.push({decision_id:did,candidate_id:candidate,content_id:cid,material_version_id:mid,path:img});
  }
  let calls=0,failIndex=-1,inspector=async()=>({width:120,height:240,format:'png'}),uploader=null,appRef='synthetic-app';
  // 原严格图文契约保留为底层媒体恢复回归；产品默认正文优先由下例独立覆盖。
  const options=()=>({store,root:join(dir,'display'),owner:'owner',appRef,allowTextFallback:false,decodeImage:inspector,uploadImage:async()=>{const n=calls++;if(uploader)return uploader(n);if(n===failIndex)return {code:123};return {image_key:`img_${n}`};}});
  return {dir,db,bid,decisions,get store(){return store;},get calls(){return calls;},failOn(n){failIndex=n;},setInspector(fn){inspector=fn;},setUploader(fn){uploader=fn;},setApp(value){appRef=value;},create:(overrides={})=>createDisplay({...options(),...overrides}),reopen(){store.close();store=openStore(db);return createDisplay(options());}};
}

test('TASK011标准eligible默认正文优先，坏图不能阻塞完整正文和原入口',async t=>{
 const f=await fixture(t,1);await writeFile(f.decisions[0].path,'corrupt');
 const built=(await f.create({allowTextFallback:undefined}).buildBatch(f.bid,f.decisions)).items[0];
 assert.equal(built.status,'succeeded');assert.equal(f.calls,0);assert.equal(built.media_fallback.kind,'text_only');
 const post=JSON.parse(built.payload.content).zh_cn;assert.equal(post.content[1][0].text,'合成原文0\n第二行');assert.match(built.payload.content,/图片未附/);assert(post.content.at(-1)[0].href.includes('/explore/'));assert.equal(built.media.length,0);
});

test('视频封面缺失时默认发完整正文，仍明确视频未读',async t=>{
 const f=await fixture(t,1,'video');await writeFile(f.decisions[0].path,'corrupt');
 const item=(await f.create({allowTextFallback:undefined}).buildBatch(f.bid,f.decisions)).items[0];
 assert.equal(item.status,'succeeded');assert.match(item.payload.content,/图片未附/);assert.match(item.payload.content,/视频未读/);assert.equal(item.media.length,0);
});

test('三篇和20篇独立组织、批内唯一稳定编号、换顺序重入和重启复用',async t=>{
  const f=await fixture(t,20),d=f.create();
  const first=await d.buildBatch(f.bid,f.decisions.slice(0,3));assert.equal(first.items.length,3);assert(first.items.every(x=>x.status==='succeeded'));
  const second=await f.reopen().buildBatch(f.bid,[...f.decisions].reverse());assert.equal(second.items.length,20);
  assert.equal(new Set(second.items.map(x=>x.ordinal)).size,20);
  for(const prior of first.items){const next=second.items.find(x=>x.decision_id===prior.decision_id);assert.equal(next.recommendation_id,prior.recommendation_id);assert.equal(next.ordinal,prior.ordinal);assert.equal(next.payload_hash,prior.payload_hash);}
  assert.equal(f.calls,20);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivered_content').get().n,0);
});

test('中断恢复复用有效媒体；已知上传失败阻塞本篇，其他篇继续',async t=>{
  const f=await fixture(t,3);f.failOn(1);const first=await f.create().buildBatch(f.bid,f.decisions);
  assert.deepEqual(first.items.map(x=>x.status),['succeeded','blocked','succeeded']);assert.equal(f.calls,3);
  f.failOn(-1);const next=await f.reopen().buildBatch(f.bid,f.decisions);assert(next.items.every(x=>x.status==='succeeded'));assert.equal(f.calls,4);
});

test('损坏/缺图和图片尺寸/大小超界在上传前阻塞',async t=>{
  const f=await fixture(t,1);await writeFile(f.decisions[0].path,'corrupt');
  const r=await f.create().buildBatch(f.bid,f.decisions);assert.equal(r.items[0].status,'blocked');assert.equal(f.calls,0);
});

test('横竖尺寸原样保留，未知/超限尺寸拒绝，不自动压缩',async t=>{
  const f=await fixture(t,1);
  for(const size of [{width:1600,height:900,format:'png'},{width:600,height:1200,format:'png'}]){
    f.setInspector(async()=>size);const r=await f.create().buildBatch(f.bid,f.decisions);assert.equal(r.items[0].status,'succeeded');assert.equal(r.items[0].media[0].width,size.width);
  }
  for(const size of [{width:12001,height:900,format:'png'},{width:2001,height:2,format:'gif'},undefined]){
    f.setInspector(async()=>size);const r=await f.create().buildBatch(f.bid,f.decisions);assert.equal(r.items[0].status,'blocked');
  }
  assert.equal(f.calls,1);
});

test('上传结果未知不盲重试，换应用不复用旧key',async t=>{
  const f=await fixture(t,1);f.setUploader(async()=>{throw Error('simulated connection lost');});
  const r=await f.create().buildBatch(f.bid,f.decisions);assert.equal(r.items[0].status,'blocked');assert.equal(f.calls,1);
  const repeat=await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(repeat.items[0].status,'blocked');assert.equal(f.calls,1);
  f.setApp('another-app');f.setUploader(async n=>({image_key:`img_${n}`}));
  const other=await f.create().buildBatch(f.bid,f.decisions);assert.equal(other.items[0].status,'succeeded');assert.equal(f.calls,2);
});

test('拒绝伪eligible、错误批次与损坏编号检查点，不污染发送状态',async t=>{
  const f=await fixture(t,1),d=f.create();
  const bad=await d.buildBatch(f.bid,[{...f.decisions[0],decision_id:randomUUID()}]);assert.equal(bad.items[0].status,'blocked');assert.equal(f.calls,0);
  await assert.rejects(d.buildBatch(randomUUID(),f.decisions));
  await d.buildBatch(f.bid,f.decisions);
  const cp=f.store.db.prepare("SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1").get(`display-manifest:${f.bid}`);
  const ref=JSON.parse(cp.succeeded_refs_json)[0];await writeFile(ref.ref,'{}');
  await assert.rejects(f.reopen().buildBatch(f.bid,f.decisions),/manifest|checkpoint|hash/);
});

test('平台响应缺key的unknown也必须保持不重传',async t=>{
  const f=await fixture(t,1);f.setUploader(async()=>({code:0}));
  await f.create().buildBatch(f.bid,f.decisions);await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(f.calls,1);
});

test('视频封面即使已在材料图片数组中也只展示一次',async t=>{
  const f=await fixture(t,1,'video');const r=await f.create().buildBatch(f.bid,f.decisions);
  assert.equal(r.items[0].status,'succeeded');
  assert.equal(JSON.parse(r.items[0].payload.content).zh_cn.content.filter(row=>row[0].tag==='img').length,1);
});

test('编号保留后DB失败仍复用原UUID和ordinal，不产生第二身份',async t=>{
  const f=await fixture(t,1);
  f.store.db.exec("CREATE TRIGGER inject_rec BEFORE INSERT ON recommendation BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  await assert.rejects(f.create().buildBatch(f.bid,f.decisions),/synthetic rollback/);
  const fs=await import('node:fs/promises');const folder=join(f.dir,'display',`batch-${sha(f.bid)}`);
  const reserved=JSON.parse(await readFile(join(folder,(await fs.readdir(folder)).find(x=>x.endsWith('.reservation.json'))),'utf8')).entry;
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n,0);
  f.store.db.exec('DROP TRIGGER inject_rec');const next=await f.reopen().buildBatch(f.bid,f.decisions);
  assert.equal(next.items[0].recommendation_id,reserved.recommendation_id);assert.equal(next.items[0].ordinal,reserved.ordinal);assert.equal(f.calls,1);
});

test('上传成功回执已落盘但checkpoint失败时精确补归账，无新上传',async t=>{
  const f=await fixture(t,1);
  f.setUploader(async n=>{f.store.db.exec("CREATE TRIGGER inject_cp BEFORE INSERT ON checkpoint WHEN NEW.stage LIKE 'display-media:%' BEGIN SELECT RAISE(ABORT,'receipt checkpoint failure'); END");return {image_key:`img_${n}`};});
  const first=await f.create().buildBatch(f.bid,f.decisions);assert.equal(first.items[0].status,'blocked');
  f.store.db.exec('DROP TRIGGER inject_cp');const second=await f.reopen().buildBatch(f.bid,f.decisions);
  assert.equal(second.items[0].status,'succeeded');assert.equal(f.calls,1);
});

test('默认解码器返回实际PNG尺寸，损坏文件拒绝',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'display-decode-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const image=join(dir,'one.png');
  await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64'));
  const info=await decodeImage(image);assert.equal(info.width,1);assert.equal(info.height,1);
  await writeFile(image,'bad');await assert.rejects(decodeImage(image));
});

test('实平台已验6000字加9图范围，纯格式保持全文和九图顺序',async t=>{
  const f=await fixture(t,1);const materialId=f.decisions[0].material_version_id;
  const row=f.store.db.prepare('SELECT body_ref FROM material_version WHERE material_version_id=?').get(materialId);
  // 纯构建验证组合；集成路径仍绑定原正文hash，不能通过换正文绕过完整性。
  for(const length of [1,744,745,5999,6000])for(const count of [0,1,3,9]){
   const m={...material,body:'长'.repeat(length),media_kind:count?'image':'text',images:Array.from({length:count},(_,index)=>({index,path:'synthetic',hash:sha('image'),image_key:`img-${index}`,status:'succeeded'}))};
   const result=formatMessage(rec,m);assert.equal(result.status,'succeeded',`${length}/${count}`);assert.equal(JSON.parse(result.payload.content).zh_cn.content[1][0].text,m.body);assert.equal(result.media.length,count);
  }
  assert(row.body_ref);
});

test('已保留的一篇变成hold时不阻塞其他独立条目',async t=>{
  const f=await fixture(t,2);await f.create().buildBatch(f.bid,f.decisions);
  f.store.db.prepare("UPDATE candidate SET eligibility_state='hold' WHERE candidate_id=?").run(f.decisions[0].candidate_id);
  const next=await f.reopen().buildBatch(f.bid,f.decisions);assert.deepEqual(next.items.map(x=>x.status),['blocked','succeeded']);assert.equal(f.calls,2);
});

test('有确切失效证据时只刷新指定成功媒体，不重做整批',async t=>{
  const f=await fixture(t,3),display=f.create();const first=await display.buildBatch(f.bid,f.decisions),item=first.items[1],media=item.media[0];
  assert.equal(typeof display.invalidateMedia,'function');
  const input={batchId:f.bid,materialVersionId:item.material_version_id,index:media.index,mediaHash:media.hash,expectedAttemptId:media.attempt_id,evidenceRef:'synthetic:confirmed-invalid-key'};
  assert.throws(()=>display.invalidateMedia({...input,expectedAttemptId:'wrong'}));
  assert.equal(display.invalidateMedia(input).status,'succeeded');
  const next=await f.reopen().buildBatch(f.bid,f.decisions);assert(next.items.every(x=>x.status==='succeeded'));assert.equal(f.calls,4);
  assert.equal(next.items[0].payload_hash,first.items[0].payload_hash);assert.equal(next.items[2].payload_hash,first.items[2].payload_hash);
});

test('构建途中停止后保留stop意图，不再上传后项或误清标志',async t=>{
  const f=await fixture(t,3);f.setUploader(async n=>{
    const s=f.store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    const r=f.store.casSlot({owner:s.owner,runId:s.run_id,generation:s.generation,stopRequested:true,expectedOwner:s.owner,expectedRunId:s.run_id,expectedGeneration:s.generation,expectedStopRequested:false,expectedState:s.state,expectedRevision:s.revision,nextState:'stopping'});
    assert.equal(r.status,'succeeded');return {image_key:`img_${n}`};
  });
  await assert.rejects(f.create().buildBatch(f.bid,f.decisions),/stopped|slot/);
  const s=f.store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();assert.equal(s.state,'stopped');assert.equal(s.stop_requested,1);assert.equal(f.calls,1);
});

test('成功媒体的原始回执丢失或损坏时阻断，不能仅凭checkpoint重用或重传',async t=>{
  const f=await fixture(t,1);const r=await f.create().buildBatch(f.bid,f.decisions);
  const path=r.items[0].media[0].receipt_ref,original=await readFile(path);
  for(const content of ['{}',null]){
    if(content===null)await rm(path);else await writeFile(path,content);
    const next=await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(next.items[0].status,'blocked');assert.equal(f.calls,1);
    await writeFile(path,original);
  }
  const recovered=await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(recovered.items[0].status,'succeeded');assert.equal(f.calls,1);
});

test('intent补归账也检查回执材料版本和索引，不接受错绑成功',async t=>{
  const f=await fixture(t,1);f.setUploader(async()=>{
    f.store.db.exec("CREATE TRIGGER cp_fail BEFORE INSERT ON checkpoint WHEN NEW.stage LIKE 'display-media:%' BEGIN SELECT RAISE(ABORT,'synthetic receipt window'); END");return {image_key:'img_done'};
  });
  await f.create().buildBatch(f.bid,f.decisions);f.store.db.exec('DROP TRIGGER cp_fail');
  const cp=f.store.db.prepare("SELECT succeeded_refs_json FROM checkpoint WHERE stage LIKE 'display-media:%' ORDER BY rowid DESC LIMIT 1").get();
  const intent=JSON.parse(await readFile(JSON.parse(cp.succeeded_refs_json)[0].ref,'utf8'));
  const receipt=JSON.parse(await readFile(intent.receipt_path,'utf8'));receipt.index=99;receipt.material_version_id='wrong';await writeFile(intent.receipt_path,JSON.stringify(receipt));
  const next=await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(next.items[0].status,'blocked');assert.equal(f.calls,1);
});

test('明确失败回执落盘但checkpoint失败时补失败账，只重试该失败项',async t=>{
  const f=await fixture(t,1);f.setUploader(async()=>{
    f.store.db.exec("CREATE TRIGGER cp_failure BEFORE INSERT ON checkpoint WHEN NEW.stage LIKE 'display-media:%' BEGIN SELECT RAISE(ABORT,'failed receipt window'); END");return {code:123};
  });
  await f.create().buildBatch(f.bid,f.decisions);f.store.db.exec('DROP TRIGGER cp_failure');f.setUploader(async()=>({image_key:'img_recovered'}));
  const next=await f.reopen().buildBatch(f.bid,f.decisions);assert.equal(next.items[0].status,'succeeded');assert.equal(f.calls,2);
});

test('所有取得执行槽入口均先保存进程身份，涵盖定向失效',async t=>{
  const f=await fixture(t,1),cas=f.store.casSlot.bind(f.store),observed=[];
  f.store.casSlot=input=>{if(input.nextState==='running')observed.push(existsSync(join(f.dir,'display',`run-${input.runId}.json`)));return cas(input);};
  const display=f.create(),first=await display.buildBatch(f.bid,f.decisions),item=first.items[0],m=item.media[0];
  display.invalidateMedia({batchId:f.bid,materialVersionId:item.material_version_id,index:m.index,mediaHash:m.hash,expectedAttemptId:m.attempt_id,evidenceRef:'synthetic:expired'});
  assert.deepEqual(observed,[true,true]);
});

test('空eligible批次明确报告没有可构建内容及缺口，不误报成功',async t=>{
  const f=await fixture(t,1),result=await f.create().buildBatch(f.bid,[]);
  assert.equal(result.status,'blocked');assert.deepEqual(result.reasons,['no_eligible_input']);assert.equal(result.shortfall,20);assert.deepEqual(result.items,[]);
  assert.equal(f.calls,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n,0);
});

test('零字节及超过10MB的真实文件字节数在上传前阻断',async t=>{
  for(const size of [0,10000001]){
    const f=await fixture(t,1,'image',Buffer.alloc(size,1));const r=await f.create().buildBatch(f.bid,f.decisions);
    assert.equal(r.items[0].status,'blocked');assert(r.items[0].reasons.includes('image_size_exceeded'));assert.equal(f.calls,0);
  }
});

test('744字符九图保持顺序，十图和超长标题按明确容量阻断',()=>{
  const images=Array.from({length:9},(_,i)=>({index:i+1,path:`synthetic-${i}`,hash:sha(String(i)),image_key:`img_${i}`,status:'succeeded'}));
  const m={...material,body:'字'.repeat(744),media_kind:'image',images};
  const r=formatMessage(rec,m);assert.equal(r.status,'succeeded');assert.equal(r.media.length,9);
  assert.deepEqual(JSON.parse(r.payload.content).zh_cn.content.filter(x=>x[0].tag==='img').map(x=>x[0].image_key),images.map(x=>x.image_key));
  assert.equal(formatMessage(rec,{...m,images:[...images,{...images[0],index:10}]}).status,'blocked');
  const huge=formatMessage(rec,{...material,fields:{...material.fields,title:'字'.repeat(20000)}});assert.equal(huge.status,'blocked');assert(huge.reasons.includes('post_request_size_exceeded'));
});
