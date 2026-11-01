// 2026-10-28 Codex：本轮明确授权的真实正文试用，复用正式投递与反馈身份。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {backup} from 'node:sqlite';
import {openStore,saveMaterialVersion} from '../src/storage.mjs';
import {createHomefeed} from '../src/homefeed.mjs';
import {prepareBodyTrialDecision,verifyBodyTrialDecision} from '../src/candidates.mjs';
import {createDisplay} from '../src/display.mjs';
import {createDelivery} from '../src/delivery.mjs';
import {createFeishuTransport} from '../src/feishu-adapter.mjs';
import {createQuality,readCurrentStrategy} from '../src/quality.mjs';
import {readVerifiedPreference} from '../src/preference.mjs';
import {createFeedback} from '../src/feedback.mjs';
import {readQuota,getActiveQuotaPause} from './task016-live-quota.mjs';
import {prepareDisplayImages} from './task016-prepare-display-images.mjs';
import {assertDailySendDay} from './task016-runtime.mjs';
const root=resolve(process.env.TASK016_RUN_ROOT??'.codex/private/task016-trial-20261028'),owner='TASK012-synthetic',read=p=>JSON.parse(readFileSync(p,'utf8'));
const selectionKind=process.argv[2]??'real',resultRef=join(root,`push-${selectionKind}.json`);if(existsSync(resultRef))throw Error('existing push ledger; reconcile before any resume');
if(selectionKind==='manual')throw Error('manual recommendations disabled');
const selection=read(join(root,`selection-${selectionKind}.json`)),bodies=read(join(root,'homepage-bodies.json')),observed=read(join(root,'homefeed-observed.json'));
const store=openStore(resolve('.codex/private/task013-production/state.sqlite'));
const result={at:new Date().toISOString(),sent:[],failed:[],scope:selection.scope};
try{
 await backup(store.db,join(root,`before-push-${Date.now()}.sqlite`));
 const pref=readVerifiedPreference(store,owner);if(pref?.preference_version!==selection.preference_version)throw Error('preference changed');
 let strategy=readCurrentStrategy(store,owner);
 if(strategy.rules?.synthetic){
  const acceptance=join(root,'trial-scope-acceptance.json');writeFileSync(acceptance,JSON.stringify({at:new Date().toISOString(),human_decision:'先跑正文试用：按真实喜好筛选，排除同帖和明显重复；暂不承诺全库信息新意',model:'gpt-6.1-sol',reasoning:'medium',target:Number(process.env.TASK016_TARGET??20),scope:selection.scope}),{flag:'wx'});
  createQuality({store,owner}).activateStrategy({strategy_version:'TASK016-body-trial-20261028',parent_version:strategy.strategy_version,rules:{scope:'accepted_body_trial',relevance:true,exclude_collected:true,exclude_delivered:true,obvious_duplicates:true,noFullNovelty:true,imagesSeen:false},rule_diff:{replaces_synthetic:true,user_accepted_body_trial:true},evidence_refs:[acceptance],preference_version:pref.preference_version});
  strategy=readCurrentStrategy(store,owner);
 }
 const hf=createHomefeed({store,root,owner});let request=null;
 if(selectionKind==='additional'){
  const config=read('.codex/private/task013-production/runtime.json'),fixed=read(config.bindingPath);
  // 这里只读取原平台事件，不使用此依赖发送任何消息。
  const feedback=createFeedback({store,root:resolve('.codex/private'),owner,appRef:fixed.appRef,chatRef:fixed.chatRef,senderRef:fixed.senderRef,transport:{send:async()=>{throw Error('read-only request lookup');},lookup:async()=>{throw Error('read-only request lookup');}}});
  const pending=await feedback.pendingRequests({eventId:process.env.TASK016_EVENT_ID??'60f3b4d03e1e98558d2184dc4dbd3ec5'});
  const kind='additional_follow',target=3;
  request=pending.find(p=>p.request_type===kind&&p.target===target);
  if(!request)throw Error('verified platform request missing');
  writeFileSync(join(root,'additional-request.json'),JSON.stringify(request,null,2));
 }
 const batch=hf.beginBatch(request?{kind:request.request_type,commandId:request.provenance.command_id,explicitRequest:true}:{kind:'daily_follow',target:Number(process.env.TASK016_TARGET??20)});result.batch_id=batch.batch_id;
 const observations=observed.items.map(x=>{const url=x.urls.find(u=>u.includes('xsec_token='));return url?{content_id:new URL(url).pathname.split('/').at(-1),complete_source_url:url}:null;}).filter(Boolean);
 // 正式日批允许多轮发现，预算覆盖已入库候选及本轮实际观察，不能被旧200条日累计上限截断。
 const candidateCount=store.db.prepare('SELECT count(*) n FROM candidate WHERE discovery_batch_id=?').get(batch.batch_id).n;
 const registrar=selectionKind==='daily'?createHomefeed({store,root,owner,candidateLimit:Math.max(200,candidateCount+observations.length)}):hf;
 await registrar.recordPage(batch.batch_id,{source_page:'https://www.xiaohongshu.com/explore',observed_at:observed.at,page_state:'ready',observations,anchor_id:observations.at(-1)?.content_id??null,advanced:false,read_method:'ego.page.evaluate'});
 const requests=[];mkdirSync(join(root,'materials'),{recursive:true});
 const alreadySent=store.db.prepare("SELECT count(*) n FROM recommendation r JOIN delivery_attempt a USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='succeeded'").get(batch.batch_id).n;
 // 小批图文验收只限制本次实际发送数，不修改批次目标或模型决策。
 const maxSend=Number(process.env.TASK016_MAX_SEND??batch.target);
 if(!Number.isInteger(maxSend)||maxSend<1||maxSend>batch.target)throw Error('invalid finite send limit');
 // 已保存选择可以恢复，但全局成功来源必须在截取剩余名额前排除，不能重复占用名额。
 const deliveredSources=new Set(store.db.prepare('SELECT source_content_id FROM delivered_content WHERE owner=?').all(owner).map(x=>x.source_content_id));
 const unsentChoices=selection.decisions.filter(x=>x.status==='chosen'&&!deliveredSources.has(x.source_id));
 result.skipped_delivered_ids=selection.decisions.filter(x=>x.status==='chosen'&&deliveredSources.has(x.source_id)).map(x=>x.source_id);
 for(const chosen of unsentChoices.slice(0,Math.min(maxSend,Math.max(0,batch.target-alreadySent)))){
  try{
  const source=bodies.items.find(x=>x.source_id===chosen.source_id&&x.status==='succeeded');if(!source)throw Error('body missing');
  const candidate=store.db.prepare('SELECT ca.candidate_id,ca.content_id FROM candidate ca JOIN content co USING(content_id) WHERE discovery_batch_id=? AND source_content_id=?').get(batch.batch_id,source.source_id);
  if(!candidate)throw Error(`candidate not registered for selected source ${source.source_id}`);
  if(!source.author_name)throw Error('verified page author missing');
  store.db.prepare('UPDATE content SET author_name=? WHERE content_id=?').run(source.author_name,candidate.content_id);
  // 新首页记录默认unknown；正文试用保持标准资格hold，不标成完整eligible。
  store.db.prepare("UPDATE candidate SET eligibility_state='hold' WHERE candidate_id=? AND eligibility_state='unknown'").run(candidate.candidate_id);
  const bodyRef=join(root,'materials',source.source_id+'.json'),bytes=JSON.stringify({title:source.title,description:source.body,author_name:''});
  if(existsSync(bodyRef)){if(readFileSync(bodyRef,'utf8')!==bytes)throw Error('body artifact changed');}else writeFileSync(bodyRef,bytes,{flag:'wx'});
  const includeImages=process.env.TASK016_WITH_IMAGES==='1';
  let orderedImages=[],imageIssue=null;
  if(includeImages)try{orderedImages=await prepareDisplayImages(source,root);}catch(error){imageIssue={source_id:source.source_id,reason:error.message};writeFileSync(join(root,'materials',source.source_id+'-media-fallback.json'),JSON.stringify({at:new Date().toISOString(),...imageIssue}));}
  const material=saveMaterialVersion(store,{content_id:candidate.content_id,body:bytes,body_ref:bodyRef,ordered_images:orderedImages,media_kind:includeImages?'image':'unknown',completeness:includeImages&&!imageIssue?'complete':'partial',fetch_status:'succeeded',fetched_at:source.at});
  if(imageIssue)(result.image_fallbacks??=[]).push(imageIssue);
  const existing=store.db.prepare('SELECT * FROM decision WHERE candidate_id=? AND preference_version=? ORDER BY rowid DESC').all(candidate.candidate_id,pref.preference_version).find(d=>verifyBodyTrialDecision(store,owner,d));
  requests.push(existing?{decision_id:existing.decision_id,scope:'accepted_body_trial'}:prepareBodyTrialDecision({store,owner,batchId:batch.batch_id,candidateId:candidate.candidate_id,materialVersionId:material.entity_id,selectionRefs:selection.refs}).publish());
  }catch(error){result.failed.push({stage:'material_or_decision',source_id:chosen.source_id,reason:error.message});}
 }
 const require=createRequire(resolve('.codex/private/task013-production/runtime.mjs')),Lark=require('@larksuiteoapi/node-sdk'),axios=require('axios');
 const settings=read('.codex/private/task013-production/runtime.json'),binding=read(settings.bindingPath);
 const credentials=Object.fromEntries(settings.credentialFiles.flatMap(p=>readFileSync(p,'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>l.split(/=(.*)/s).slice(0,2))));
 if(binding.appRef!==credentials.FEISHU_APP_ID?.trim()||binding.chatRef!==credentials.FEISHU_CHAT_ID?.trim())throw Error('binding mismatch');
 const http=axios.create({timeout:30000});http.interceptors.response.use(r=>r.config['$return_headers']?{data:r.data,headers:r.headers}:r.data);
 const client=new Lark.Client({appId:binding.appRef,appSecret:credentials.FEISHU_APP_SECRET.trim(),domain:Lark.Domain.Feishu,httpInstance:http,logger:{trace(){},debug(){},info(){},warn(){},error(){}}});
 const display=createDisplay({store,root:join(root,'display'),owner,appRef:binding.appRef,client,allowTextFallback:true});
 const built=await display.buildBatch(batch.batch_id,requests);result.display_status=built.status;
 const transport=createFeishuTransport({client,targetRef:binding.chatRef,appRef:binding.appRef,root:settings.roots.transport});
 const delivery=createDelivery({store,root:join(root,'delivery'),owner,appRef:binding.appRef,targetRef:binding.chatRef,transport});
 for(const item of built.items){
  assertDailySendDay(process.env.TASK016_BUSINESS_DAY);
  if(getActiveQuotaPause())throw Error('persistent quota pause before dispatch');
  const quota=await readQuota();if(quota.fiveHourRemaining<4||quota.weeklyRemaining<2)throw Error('quota stop before dispatch');
  if(item.status!=='succeeded'){result.failed.push({stage:'display',reasons:item.reasons});continue;}
  const intent=await delivery.prepareDelivery(item);writeFileSync(resultRef,JSON.stringify({...result,pending:intent},null,2));
  if(!intent.attempt_id){result.failed.push({stage:'prepare',result:intent});continue;}
  assertDailySendDay(process.env.TASK016_BUSINESS_DAY);
  if(getActiveQuotaPause())throw Error('persistent quota pause before sendPrepared');
  const sent=await delivery.sendPrepared(intent.attempt_id);result.sent.push({recommendation_id:item.recommendation_id,attempt_id:intent.attempt_id,result:sent});
  writeFileSync(resultRef,JSON.stringify(result,null,2));if(sent.status!=='succeeded')break;
 }
 const confirmed=store.db.prepare("SELECT count(DISTINCT r.recommendation_id) n FROM recommendation r JOIN delivery_attempt a USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='succeeded'").get(batch.batch_id).n;
 result.total_confirmed=confirmed;
 store.db.prepare('UPDATE batch SET status=?,updated_at=?,revision=revision+1 WHERE delivery_batch_id=?').run(confirmed>=batch.target?'completed':'partial',new Date().toISOString(),batch.batch_id);
 writeFileSync(resultRef,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){result.error=e.message;writeFileSync(resultRef,JSON.stringify(result,null,2));throw e;}finally{store.close();}
