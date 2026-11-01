// 2026-10-23 Codex：011只准备完整展示。发送、核实与反馈归012。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareInput, decodeImage as defaultDecodeImage } from './analysis.mjs';
import { readCurrentStrategy } from './quality.mjs';
import { verifyBodyTrialDecision } from './candidates.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
export const DISPLAY_VERSION = 'feishu-b-v1';
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const textRow = text => [{ tag: 'text', text }];
const filePath = ref => ref.startsWith('file:') ? ref.slice(5) : ref;
const parse = path => JSON.parse(readFileSync(path, 'utf8'));

function baseResult(rec, material) {
  return { entity_id: rec.recommendation_id ?? rec.decision_id ?? null, recommendation_id: rec.recommendation_id ?? null,
    delivery_batch_id: rec.delivery_batch_id ?? null, ordinal: rec.ordinal ?? null, category: rec.category ?? null,
    decision_id: rec.decision_id ?? null, content_id: rec.content_id ?? null, material_version_id: material?.material_version_id ?? rec.material_version_id ?? null,
    display_contract_version: DISPLAY_VERSION, evidence_refs: [], media: [], reasons: [], payload: null, payload_hash: null };
}

function blocked(rec, material, reasons, extra = {}) {
  return { ...baseResult(rec, material), status: 'blocked', display_state: 'display_blocked', reasons,
    error: { code: reasons[0], stage: 'display', retryable: false, observed_at: new Date().toISOString(), detail_ref: null }, ...extra };
}

// 2026-10-29真实同条6000正文+9图已发送/回读及Windows客户端核验；不是平台硬上限。
function capacity(bodyLength, imageCount, rows, bytes) {
  const reasons = [];
  if (bytes > 30000) reasons.push('post_request_size_exceeded');
  const known = imageCount <= 9 && bodyLength <= 6000;
  if (!known || rows > 13) reasons.push('unverified_platform_combination');
  return reasons;
}

export function validateRequest(payload, { receive_id, uuid } = {}) {
  const bytes = Buffer.byteLength(JSON.stringify({ receive_id, msg_type: payload.msg_type, content: payload.content, uuid }), 'utf8');
  return { status: bytes <= 30000 ? 'succeeded' : 'blocked', display_state: bytes <= 30000 ? 'complete' : 'display_blocked', request_bytes: bytes, limit_bytes: 30000 };
}

export function formatMessage(rec, material) {
  const reasons = [];
  const bodyTrial=material?.body_trial===true;
  const fields = material?.fields;
  if (!UUID.test(rec?.recommendation_id ?? '') || !rec.delivery_batch_id || !Number.isInteger(rec.ordinal) || rec.ordinal < 1 || !['follow', 'explore'].includes(rec.category)) reasons.push('display_identity_invalid');
  if (!material || material.content_id !== rec.content_id || material.material_version_id !== rec.material_version_id) reasons.push('material_binding_invalid');
  if (typeof fields?.title !== 'string' || !fields.title.trim()) reasons.push('title_missing');
  if (typeof fields?.author_name !== 'string' || !fields.author_name.trim()) reasons.push('author_missing');
  if (typeof material?.body !== 'string' || !material.body.trim()) reasons.push('body_missing');
  let sourceUrl;
  try { sourceUrl = new URL(material.source_url); if (!['https:', 'http:'].includes(sourceUrl.protocol)) throw Error(); } catch { reasons.push('source_url_missing_or_invalid'); }
  if (!['available', 'unknown'].includes(material?.source_status)) reasons.push('source_unavailable');
  const video = material?.media_kind === 'video';
  if (!bodyTrial && (!['text','image','video'].includes(material?.media_kind) || material?.completeness !== (video ? 'video_unread' : 'complete'))) reasons.push('material_incomplete');
  const images = material?.images ?? [];
  if (!Array.isArray(images) || images.some((x,i) => !Number.isInteger(x.index) || (i === 0 ? ![0,1].includes(x.index) : x.index !== images[i-1].index + 1))) reasons.push('image_order_invalid');
  if (material?.media_kind === 'image' && !images.length) reasons.push('images_missing');
  const media = [...images, ...(video && material?.cover ? [{ ...material.cover, role: 'cover' }] : [])];
  if (video && !material?.cover) reasons.push('video_cover_missing');
  if (media.some(x => x.status !== 'succeeded' || typeof x.image_key !== 'string' || !x.image_key)) reasons.push('media_unavailable',...media.map(x=>x.reason).filter(Boolean));
  if (reasons.length) return blocked(rec, material, [...new Set(reasons)], { media });
  const title = `${rec.delivery_batch_id} / ${String(rec.ordinal).padStart(2, '0')} [${rec.recommendation_id}]｜${fields.title}`;
  const rows = [textRow(`作者：${fields.author_name}`), textRow(material.body),
    ...(bodyTrial?[textRow('正文试用：图片未由筛选模型阅读；未承诺全库信息新意。')]:[]),
    ...(material.media_fallback_reason?[textRow(`图片未附：${material.media_fallback_reason.includes('unverified_platform_combination')?'超出当前已验证的图文组合范围':'本次图片获取、完整性检查或上传未完成'}；已保留完整正文。`)]:[]),
    ...(material.media_fallback_original_kind==='video'?[textRow('视频未读：本次仅发送原正文和原文入口。')]:[]),
    ...images.map(x => [{ tag: 'img', image_key: x.image_key }]),
    ...(video ? [textRow('视频未读：仅展示原正文、封面及观看入口。'), [{ tag:'img', image_key:material.cover.image_key }]] : []),
    [{ tag: 'a', text: video ? '原文 / 观看入口' : '原文入口', href: material.source_url }]];
  const payload = { msg_type:'post', content:JSON.stringify({ zh_cn:{ title, content:rows } }) };
  const metrics = { body_utf16:material.body.length, body_utf8:Buffer.byteLength(material.body), image_count:media.length, component_count:rows.length,
    content_bytes:Buffer.byteLength(payload.content), payload_bytes:Buffer.byteLength(JSON.stringify(payload)) };
  const limits = capacity(metrics.body_utf16, metrics.image_count, rows.length, metrics.payload_bytes);
  if (limits.length) return blocked(rec, material, limits, { metrics, media });
  return { ...baseResult(rec, material), status:'succeeded', display_state:'complete', payload, payload_hash:digest(payload), media, metrics,
    material_hash:material.material_hash, body_hash:material.body_hash, source_status:material.source_status, video_read:false,
    ...(material.media_fallback_reason?{media_fallback:{kind:'text_only',reasons:material.media_fallback_reason}}:{}),
    mapping:{ title:'fields.title', author:'fields.author_name', body:{ ref:material.body_ref ?? null, row:1, utf16:material.body.length, text_hash:hash(material.body) },
      media:media.map((x,i)=>({ index:x.index,role:x.role??'image',path:x.path,hash:x.hash,image_key:x.image_key,row:2+i+(bodyTrial?1:0)+(video && x.role==='cover'?1:0) })),
      source_url:material.source_url }, actual_preference_version:rec.actual_preference_version, actual_strategy_version:rec.actual_strategy_version };
}

export function createDisplay({ store, root, owner, appRef, client, uploadImage, decodeImage = defaultDecodeImage, coordination = null, allowTextFallback = true, now = () => new Date().toISOString() }) {
  if (!store?.db || !root || !owner || !appRef) throw new TypeError('store, private root, owner and appRef are required');
  coordination = coordination ? Object.freeze({ ...coordination }) : null;
  if (coordination && coordination.owner !== owner) throw new Error('display coordinator owner mismatch');
  root = resolve(root); mkdirSync(root,{recursive:true});
  const at = () => new Date(now()).toISOString();
  function assertCoordinator(batchId = coordination?.batchId) {
    if (coordination && (coordination.owner !== owner || coordination.batchId !== batchId)) throw Error('display coordinator owner or batch mismatch');
    store.assertCoordinator(coordination, { now: at() });
  }
  function sameCoordinator(left, right) {
    if (left == null || right == null) return left == null && right == null;
    return ['owner', 'batchId', 'runId', 'batchGeneration'].every(key => left[key] === right[key]);
  }
  const appHash = hash(appRef);
  const slot = () => store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  const cas = (current,next,batchId=coordination?.batchId) => {const claiming=next.state==='running';return store.casSlot({expectedOwner:current.owner,expectedRunId:current.run_id,expectedGeneration:current.generation,expectedStopRequested:Boolean(current.stop_requested),expectedState:current.state,expectedRevision:current.revision,
    owner:next.owner,runId:next.runId,generation:next.generation,batchId:claiming?batchId:null,coordination:claiming?coordination:undefined,stopRequested:next.stopRequested??Boolean(current.stop_requested),nextState:next.state,updatedAt:at()});};
  function assertToken(token, { accountingOnly = false, accountingCoordination = coordination } = {}) {
    if (accountingOnly) {
      store.assertCoordinator(accountingCoordination, { accountingOnly: true });
      return slot();
    }
    assertCoordinator();
    const current=slot();
    if(current.owner!==owner || current.run_id!==token.runId || current.generation!==token.generation || current.stop_requested || current.state!=='running') throw Error('display execution slot changed or stopped');
    return current;
  }
  function saveFile(path, value) {
    const raw=JSON.stringify(value)+'\n';writeFileSync(path,raw,{flag:'wx'});return {ref:path,hash:hash(raw)};
  }
  function checkpoint(stage,batchId,value,token,{accountingOnly=false,accountingCoordination=coordination}={}) {
    if (accountingOnly && accountingCoordination && (accountingCoordination.owner !== owner || accountingCoordination.batchId !== batchId)) throw Error('display coordinator owner or batch mismatch');
    if (accountingOnly && (!value?.attempt_id || value.run_id !== token.runId || value.generation !== token.generation
      || !sameCoordinator(value.coordination ?? null, accountingCoordination))) throw Error('display late receipt identity mismatch');
    if (!accountingOnly) assertCoordinator(batchId);
    assertToken(token,{accountingOnly,accountingCoordination});
    const ref=saveFile(join(root,`${randomUUID()}.json`),value);
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(),owner,token.runId,token.generation,batchId,stage,JSON.stringify([ref]),value.input_hash??null,ref.hash,at());
    return ref;
  }
  function latest(stage) {
    const cp=store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner,stage);
    if(!cp)return null;
    const ref=JSON.parse(cp.succeeded_refs_json)[0];
    if(!ref || hash(readFileSync(ref.ref))!==ref.hash || ref.hash!==cp.output_hash)throw Error('display checkpoint hash mismatch');
    return parse(ref.ref);
  }
  function decision(batchId, id, requireCurrent = true) {
    const row=store.db.prepare(`SELECT d.*,c.content_id,c.discovery_batch_id,c.source_evidence_ref,c.eligibility_state,co.platform,co.source_content_id,co.source_state,co.author_name,
      a.material_version_id,a.status analysis_status FROM decision d JOIN candidate c USING(candidate_id) JOIN content co USING(content_id) JOIN analysis a USING(analysis_id) WHERE d.decision_id=?`).get(id);
    const trial=row&&requireCurrent?verifyBodyTrialDecision(store,owner,row):null;
    // 历史编号仅核对不可变关联；当前请求仍须通过最新资格，反馈不会追溯阻断已发项。
    if(!row || row.discovery_batch_id!==batchId || requireCurrent && !trial && (row.result!=='eligible' || row.eligibility_state!=='eligible' || row.analysis_status!=='complete'))throw Error('eligible_decision_binding_invalid');
    row.body_trial=Boolean(trial);
    return row;
  }
  function reserve(batchId, requested, token) {
    assertCoordinator(batchId);
    const folder=join(root,`batch-${hash(batchId)}`);mkdirSync(folder,{recursive:true});
    return store.transaction(()=>{
      assertCoordinator(batchId);
      const previous=latest(`display-manifest:${batchId}`);
      const entries=previous?.entries??[];
      // 编号保留文件先于数据库提交。崩溃遗留只按确切文件的hash和关联恢复。
      for(const name of readdirSync(folder).filter(x=>x.endsWith('.reservation.json'))){
        const saved=parse(join(folder,name));
        if(saved.hash!==digest(saved.entry) || saved.entry.delivery_batch_id!==batchId || saved.entry.owner!==owner || !UUID.test(saved.entry.recommendation_id))throw Error('display reservation integrity invalid');
        if(!entries.some(x=>x.recommendation_id===saved.entry.recommendation_id))entries.push(saved.entry);
      }
      if(new Set(entries.map(x=>x.ordinal)).size!==entries.length || entries.some(x=>!Number.isInteger(x.ordinal)||x.ordinal<1))throw Error('display reservation ordinal conflict');
      const errors=[];
      const currentStrategy=readCurrentStrategy(store,owner,at());
      for(const request of requested){
        try{
          const row=decision(batchId,request.decision_id);
          if(row.strategy_version!==currentStrategy.strategy_version)throw Error('strategy_version_not_current');
          if(request.content_id && request.content_id!==row.content_id || request.candidate_id && request.candidate_id!==row.candidate_id)throw Error('eligible_reference_mismatch');
          let entry=entries.find(x=>x.content_id===row.content_id);
          if(entry && entry.decision_id!==row.decision_id)throw Error('reserved_decision_changed');
          if(!entry){
            const existing=store.db.prepare('SELECT * FROM recommendation WHERE delivery_batch_id=? AND content_id=?').all(batchId,row.content_id);
            if(existing.length>1 || existing[0] && existing[0].decision_id!==row.decision_id)throw Error('recommendation_binding_conflict');
            entry={owner,delivery_batch_id:batchId,ordinal:Math.max(0,...entries.map(x=>x.ordinal))+1,recommendation_id:existing[0]?.recommendation_id??randomUUID(),content_id:row.content_id,decision_id:row.decision_id,candidate_id:row.candidate_id,
              material_version_id:row.material_version_id,category:row.category,actual_preference_version:row.preference_version,actual_strategy_version:row.strategy_version};
            saveFile(join(folder,`${hash(row.content_id)}.reservation.json`),{entry,hash:digest(entry)});entries.push(entry);
          }
        }catch(error){errors.push({decision_id:request.decision_id,reason:error.message});}
      }
      for(const entry of entries){
        const row=decision(batchId,entry.decision_id,false);
        if(row.content_id!==entry.content_id || row.material_version_id!==entry.material_version_id || row.preference_version!==entry.actual_preference_version || row.strategy_version!==entry.actual_strategy_version || row.category!==entry.category)throw Error('reservation decision binding mismatch');
        const existing=store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(entry.recommendation_id);
        if(existing){if(existing.decision_id!==entry.decision_id || existing.delivery_batch_id!==batchId || existing.content_id!==entry.content_id)throw Error('existing recommendation binding mismatch');}
        else if(requested.some(x=>x.decision_id===entry.decision_id)&&!errors.some(x=>x.decision_id===entry.decision_id))store.db.prepare(`INSERT INTO recommendation(recommendation_id,content_id,delivery_batch_id,decision_id,category,actual_preference_version,actual_strategy_version,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)`)
          .run(entry.recommendation_id,entry.content_id,batchId,entry.decision_id,entry.category,entry.actual_preference_version,entry.actual_strategy_version,at());
      }
      checkpoint(`display-manifest:${batchId}`,batchId,{entries},token);
      return {entries,errors};
    });
  }
  async function loadMaterial(entry) {
    const prepared=await prepareInput(store,entry.material_version_id,{decodeImage});
    const row=store.db.prepare('SELECT * FROM material_version WHERE material_version_id=?').get(entry.material_version_id);
    const d=decision(entry.delivery_batch_id,entry.decision_id);
    const page=parse(filePath(d.source_evidence_ref));
    const observations=page.observations?.filter(x=>x.content_id.toLowerCase()===d.source_content_id.toLowerCase());
    if(observations?.length!==1)throw Error('source_evidence_binding_invalid');
    const url=observations[0].complete_source_url;
    const parsed=new URL(url);
    if(d.platform==='xiaohongshu' && (!['xiaohongshu.com','www.xiaohongshu.com'].includes(parsed.hostname) || !parsed.pathname.endsWith(`/${d.source_content_id}`)))throw Error('source_url_identity_invalid');
    const declared=JSON.parse(row.ordered_images_json);
    const coverInImages=row.media_kind==='video'?declared.find(x=>x.path===row.cover_ref&&x.hash===row.cover_hash):null;
    const images=declared.filter(x=>x!==coverInImages).map(x=>({...x,status:prepared.images.find(i=>i.index===x.index&&i.path===x.path)?.state==='attached'?'pending':'invalid'}));
    const cover=row.media_kind==='video'&&row.cover_ref?{index:coverInImages?.index??(declared.length?declared.at(-1).index+1:0),path:row.cover_ref,hash:row.cover_hash,role:'cover',status:prepared.images.find(i=>i.path===row.cover_ref)?.state==='attached'?'pending':'invalid'}:null;
    const fields=d.body_trial&&prepared.fields&&!prepared.fields.author_name?.trim()?{...prepared.fields,author_name:d.author_name}:prepared.fields;
    return {...prepared,fields,images,cover,body_trial:d.body_trial,source_url:url,source_status:['available','unknown'].includes(d.source_state)?d.source_state:'unavailable'};
  }
  async function inspectMedia(media) {
    if(media.status==='invalid')throw Error('media_missing_corrupt_or_undecodable');
    const bytes=await readFile(media.path);
    if(hash(bytes)!==media.hash)throw Error('media_hash_mismatch');
    if(!bytes.length || bytes.length>10000000)throw Error('image_size_exceeded');
    const size=await decodeImage(media.path);
    if(!Number.isInteger(size?.width)||!Number.isInteger(size?.height)||size.width<1||size.height<1)throw Error('image_dimensions_unknown');
    const limit=size.format==='gif'?2000:12000;
    if(size.width>limit||size.height>limit)throw Error('image_dimensions_exceeded');
    return {...media,...size,bytes:bytes.length};
  }
  async function prepareMedia(media,entry,token) {
    const key=`display-media:${appHash}:${entry.material_version_id}:${media.role??'image'}:${media.index}:${media.hash}`;
    let prior=latest(key);
    if(prior && (prior.app_hash!==appHash||prior.media_hash!==media.hash||prior.material_version_id!==entry.material_version_id||prior.index!==media.index))throw Error('media_receipt_binding_invalid');
    if(prior?.state==='intent'){
      // 只读取该intent预先绑定的回执。不扫描其他尝试，也不盲重传。
      if(existsSync(prior.receipt_path)){
        try { const bytes=readFileSync(prior.receipt_path),receipt=JSON.parse(bytes.toString('utf8'));
          const fields=['attempt_id','run_id','generation','batch_id','input_hash','app_hash','material_version_id','index','media_hash','receipt_path'];
          const knownResult=receipt.state==='succeeded'&&typeof receipt.image_key==='string'&&receipt.image_key.length>0 || receipt.state==='failed'&&Number.isInteger(receipt.platform_code)&&receipt.platform_code!==0;
          if(fields.every(field=>receipt[field]===prior[field])&&sameCoordinator(receipt.coordination??null,prior.coordination??null)&&knownResult){
          prior={...receipt,receipt_hash:hash(bytes)};checkpoint(key,prior.batch_id,prior,
            {runId:prior.run_id,generation:prior.generation},{accountingOnly:true,accountingCoordination:prior.coordination});
        }}catch{ /* 不完整回执仍为unknown。 */ }
      }
      if(prior.state==='intent')return {...media,status:'unknown',reason:'upload_unknown_reconciliation_required',attempt_id:prior.attempt_id};
    }
    if(prior?.state==='succeeded' && prior.image_key){
      let receipt;
      try{
        const bytes=readFileSync(prior.receipt_path);receipt=JSON.parse(bytes.toString('utf8'));
        if(prior.receipt_hash && hash(bytes)!==prior.receipt_hash)throw Error();
        const fields=['attempt_id','input_hash','app_hash','material_version_id','index','media_hash','image_key','state','receipt_path'];
        if(fields.some(field=>receipt[field]!==prior[field]))throw Error();
      }catch{throw Error('successful_media_receipt_missing_or_corrupt');}
      return {...media,status:'succeeded',image_key:prior.image_key,receipt_ref:prior.receipt_path,attempt_id:prior.attempt_id};
    }
    if(prior?.state==='unknown')return {...media,status:'unknown',reason:'upload_unknown_reconciliation_required',attempt_id:prior.attempt_id};
    if(!uploadImage&&!client?.im?.image?.create)return {...media,status:'blocked',reason:'image_uploader_unavailable'};
    assertToken(token);
    const attemptId=randomUUID();
    const intent={state:'intent',attempt_id:attemptId,run_id:token.runId,generation:token.generation,batch_id:entry.delivery_batch_id,coordination,
      app_hash:appHash,material_version_id:entry.material_version_id,index:media.index,media_hash:media.hash,receipt_path:join(root,`media-${attemptId}.json`)};
    intent.input_hash=digest(intent);checkpoint(key,entry.delivery_batch_id,intent,token);
    let response;
    try{
      if(uploadImage)response=await uploadImage(media.path,{...intent});
      else if(client?.im?.image?.create){
        const bytes=await readFile(media.path);
        if(hash(bytes)!==media.hash)throw Error('media changed before upload');
        response=await client.im.image.create({data:{image_type:'message',image:bytes}});
      }
      else throw Error('image uploader unavailable');
    }catch{
      return {...media,status:'unknown',reason:'upload_unknown_reconciliation_required',attempt_id:attemptId};
    }
    const imageKey=response?.image_key??response?.data?.image_key;
    const succeeded=(response?.code===undefined||response.code===0)&&typeof imageKey==='string'&&imageKey.length>0;
    const definiteFailure=Number.isInteger(response?.code)&&response.code!==0;
    const receipt={...intent,state:succeeded?'succeeded':definiteFailure?'failed':'unknown',image_key:succeeded?imageKey:null,platform_code:response?.code??null};
    const savedReceipt=saveFile(intent.receipt_path,receipt);checkpoint(key,entry.delivery_batch_id,{...receipt,receipt_hash:savedReceipt.hash},token,{accountingOnly:true});
    assertToken(token);
    return {...media,status:receipt.state,reason:succeeded?null:definiteFailure?'image_upload_failed':'upload_unknown_reconciliation_required',image_key:receipt.image_key,receipt_ref:intent.receipt_path,attempt_id:attemptId};
  }
  async function buildBatch(batchId, requested) {
    assertCoordinator(batchId);
    const batch=store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId,owner);
    if(!batch || batch.status==='closed_day')throw Error('display batch missing or closed');
    if(!Array.isArray(requested)||new Set(requested.map(x=>x.decision_id)).size!==requested.length)throw Error('unique eligible decision references required');
    if(!requested.length)return {status:'blocked',entity_id:batchId,delivery_batch_id:batchId,display_contract_version:DISPLAY_VERSION,items:[],reasons:['no_eligible_input'],shortfall:batch.target,evidence_refs:[]};
    const current=slot();
    if(!['idle','stopped'].includes(current.state)||current.owner!==null||current.run_id!==null||current.stop_requested)throw Error('execution slot busy; explicit recovery required');
    const token={owner,runId:randomUUID(),generation:current.generation+1};
    saveFile(join(root,`run-${token.runId}.json`),{run_id:token.runId,process_id:process.pid,generation:token.generation});
    if(cas(current,{...token,state:'running'}).status!=='succeeded')throw Error('display slot claim rejected');
    try{
      const {entries,errors}=reserve(batchId,requested,token),items=[];
      for(const request of requested){
        const error=errors.find(x=>x.decision_id===request.decision_id);
        const entry=entries.find(x=>x.decision_id===request.decision_id);
        if(error){items.push(blocked({...request,delivery_batch_id:batchId},null,[error.reason]));continue;}
        assertToken(token);let result,material;
        try{
          material=await loadMaterial(entry);
          const originals=[...material.images,...(material.cover?[material.cover]:[])];
          // 所有媒体和容量先验证，再上传。任何缺图都不能变成部分成功payload。
          const inspected=[];for(const media of originals)inspected.push(await inspectMedia(media));
          const preflight={...material,images:inspected.filter(x=>x.role!=='cover').map(x=>({...x,status:'succeeded',image_key:'preflight'})),cover:material.cover?{...inspected.find(x=>x.role==='cover'),status:'succeeded',image_key:'preflight'}:null};
          result=formatMessage(entry,preflight);
          if(result.status!=='succeeded')result.media=inspected;
          if(result.status==='succeeded'){
            const uploaded=[];
            for(const media of inspected)uploaded.push(await prepareMedia(media,entry,token));
            result=formatMessage(entry,{...material,images:uploaded.filter(x=>x.role!=='cover'),cover:uploaded.find(x=>x.role==='cover')??null});
          }
        }catch(error){result=blocked(entry,null,[error.message]);}
        // 用户明确选择正文优先；仍核验原decision和完整正文，不重试未知图片或降级来源/正文错误。
        if(result.status!=='succeeded'&&allowTextFallback&&material){
          const reasons=result.reasons;
          const fallback=formatMessage(entry,{...material,images:[],cover:null,media_kind:'text',completeness:'complete',media_fallback_reason:reasons,media_fallback_original_kind:material.media_kind});
          if(fallback.status==='succeeded')result=fallback;
        }
        const proof=checkpoint(`display-build:${entry.recommendation_id}`,batchId,{...result,input_hash:digest({entry,app_hash:appHash,version:DISPLAY_VERSION})},token);
        result.evidence_refs=[proof.ref];result.build_ref=proof.ref;result.build_hash=proof.hash;items.push(result);
      }
      return {status:items.every(x=>x.status==='succeeded')?'succeeded':'partial',entity_id:batchId,delivery_batch_id:batchId,display_contract_version:DISPLAY_VERSION,items,evidence_refs:items.flatMap(x=>x.evidence_refs)};
    }finally{
      const currentSlot=slot();if(currentSlot.owner===owner&&currentSlot.run_id===token.runId&&currentSlot.generation===token.generation)cas(currentSlot,{owner:null,runId:null,generation:token.generation,state:'stopped'});
    }
  }
  function recover({confirmedStoppedRunId,evidenceRef}) {
    const current=slot();
    if(!evidenceRef||current.owner!==owner||current.run_id!==confirmedStoppedRunId)throw Error('exact stopped display run and evidence required');
    const run=parse(join(root,`run-${confirmedStoppedRunId}.json`));
    if(run.run_id!==confirmedStoppedRunId||!Number.isInteger(run.process_id))throw Error('old process identity missing');
    try{process.kill(run.process_id,0);throw Error('old process still present');}catch(error){if(error.code!=='ESRCH')throw error;}
    const result=cas(current,{owner:null,runId:null,generation:current.generation,state:'stopped'});
    if(result.status!=='succeeded')throw Error('display recovery CAS rejected');
    saveFile(join(root,`recovery-${randomUUID()}.json`),{run_id:confirmedStoppedRunId,evidence_ref:evidenceRef,recovered_at:at()});return result;
  }
  function invalidateMedia({batchId,materialVersionId,index,role='image',mediaHash,expectedAttemptId,evidenceRef}) {
    // 调用方须先取得该key确已失效的证据；unknown不允许借此变成可重传。
    if(!batchId||!materialVersionId||!Number.isInteger(index)||!mediaHash||!expectedAttemptId||!evidenceRef)throw TypeError('exact media identity and invalidity evidence required');
    if(!store.db.prepare('SELECT 1 FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId,owner))throw Error('media batch owner mismatch');
    const current=slot();
    if(!['idle','stopped'].includes(current.state)||current.owner!==null||current.run_id!==null||current.stop_requested)throw Error('execution slot busy');
    const token={owner,runId:randomUUID(),generation:current.generation+1};
    saveFile(join(root,`run-${token.runId}.json`),{run_id:token.runId,process_id:process.pid,generation:token.generation});
    if(cas(current,{...token,state:'running'}).status!=='succeeded')throw Error('media invalidation claim rejected');
    try{
      const key=`display-media:${appHash}:${materialVersionId}:${role}:${index}:${mediaHash}`;
      const prior=latest(key);
      if(prior?.state!=='succeeded'||prior.attempt_id!==expectedAttemptId||prior.media_hash!==mediaHash)throw Error('successful media receipt does not match invalidation');
      const proof=checkpoint(key,batchId,{...prior,state:'failed',invalidated_receipt:true,invalidity_evidence_ref:evidenceRef},token);
      return {status:'succeeded',entity_id:expectedAttemptId,evidence_refs:[proof.ref]};
    }finally{const owned=slot();if(owned.owner===owner&&owned.run_id===token.runId)cas(owned,{owner:null,runId:null,generation:token.generation,state:'stopped'});}
  }
  return {buildBatch,recover,invalidateMedia};
}
