// 2026-10-29 Codex：同日有限推荐闭环；只编排既有阶段，所有副作用由受互斥/额度保护的调用方执行。
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function saveRuntimeJson(path,value){
 // 每次保留独立临时文件；失败后不删原进度，也不让后续诊断覆盖失败材料。
 const temp=`${path}.${process.pid}.${randomUUID()}.tmp`,delays=[100,300,1000];
 const fail=(cause,phase,attempts)=>{
  const details={at:new Date().toISOString(),pid:process.pid,path,temp,phase,attempts,code:cause.code??'UNKNOWN',syscall:cause.syscall??phase};
  console.error(JSON.stringify({event:'runtime_state_save_failed',...details}));
  const error=new Error(`进度保存失败 runtime_state_save_failed：${details.code} ${phase}，尝试${attempts}次；目标=${path}；临时文件=${temp}`,{cause});
  error.kind='runtime_state_save_failed';error.details=details;throw error;
 };
 try{writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});}catch(error){fail(error,'write',1);}
 for(let attempt=0;;attempt++){
  try{renameSync(temp,path);return;}catch(error){
   if(!['EPERM','EBUSY'].includes(error.code)||attempt===delays.length)fail(error,'rename',attempt+1);
   console.error(JSON.stringify({event:'runtime_state_save_retry',at:new Date().toISOString(),pid:process.pid,path,temp,phase:'rename',code:error.code,attempts:attempt+1,delay_ms:delays[attempt]}));
   // 保持既有同步保存契约，最多等待1.4秒，不重跑采集或发送阶段。
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delays[attempt]);
  }
 }
}
export function assertDailySendDay(businessDay,now=new Date()){
 if(businessDay&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now)!==businessDay)throw Error('business day expired');
}

// 11:30包含边界；迟到只影响验收判定，不阻止当天执行。
export function dailyStartTiming(now=new Date()){
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);
 const scheduled_at=`${day}T11:15:00+08:00`,startup_deadline=`${day}T11:30:00+08:00`;
 return {scheduled_at,startup_deadline,started_at:now.toISOString(),start_delay_ms:now.getTime()-Date.parse(scheduled_at),startup_on_time:now.getTime()>=Date.parse(scheduled_at)&&now.getTime()<=Date.parse(startup_deadline)};
}

// 真实终止原因直接展示，不能将故障、等待本人或停滞说成内容耗尽。
export function recommendationNotice(record,summary=null){
 const result=record.result??summary??{},total=result.total_confirmed??result.actual,target=result.requested;
 const count=Number.isInteger(total)?`目标${target??20}条，累计成功${total}条。`:'';
 if(result.reason==='collection_execution_failed'){
  const failure=result.collection_failure,last=failure?.failures?.at(-1);
  return `推荐未完成：${count}连续5篇采集执行异常，已停止。${last?`${last.phase}：${last.reason}`:failure?.reason??''}`;
 }
 if(result.reason==='content_insufficient')return `推荐结束：${count}合格候选已耗尽，不凑数。`;
 if(record.status==='succeeded')return `推荐执行完成：${count}`;
 if(record.status==='awaiting_user')return `推荐暂停：${count}需要本人处理${result.reason??'登录或验证码'}。`;
 return `推荐未完成：${count}${result.reason??record.error?.message??(record.status==='quota_blocked'?'额度不足或无法可靠读取，已暂停':record.status)}。`;
}

export function classifyPlatformEvidence({outsideText='',prompts=[]}){
 const text=[outsideText,...prompts].join('\n');
 for(const [kind,pattern] of [['rate_limited',/访问过于频繁|访问频繁|操作频繁/],['verification',/安全验证|人机验证|验证码|拖动箭头/],['login_required',/扫码登录|请登录后|登录后继续/]]){
  const m=text.match(pattern);if(m)return {kind,match:m[0],context:text.slice(Math.max(0,m.index-40),m.index+80)};
 }
 return null;
}

// 传入Page.evaluate：仅检查可见的平台界面；用户正文、标题、作者和评论不是平台状态。
export function platformEvidence(){
 const visible=n=>{const s=getComputedStyle(n);return s.display!=='none'&&s.visibility!=='hidden'&&n.getClientRects().length>0;};
 const prompts=[...document.querySelectorAll('[role="dialog"],.login-container,.captcha-container,.verify-container,iframe[src*="captcha"],iframe[src*="verify"]')].filter(n=>visible(n)&&!n.closest('#detail-desc,#detail-title,.comments-container,section.note-item')).map(n=>n.innerText||(/captcha|verify/.test(n.getAttribute('src')||'')?'安全验证':''));
 // 平台文字只收集原DOM可见且不属于内容区的文本。
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),parts=[];
 let n;while((n=walker.nextNode())){const p=n.parentElement;if(p&&!p.closest('#detail-desc,#detail-title,.interaction-container,.comments-container,section.note-item,script,style')&&visible(p))parts.push(n.textContent);}
 return {outsideText:parts.join('\n'),prompts};
}

export async function runRecommendationRounds({root,target,guard,confirmed,collect,select,push,readback,recover=async()=>null}){
 mkdirSync(root,{recursive:true});const stateRef=join(root,'round-state.json'),summaryRef=join(root,'run-summary.json');
 const state=existsSync(stateRef)?read(stateRef):{version:2,round:0,seen:[],discovered:[],stalled:0,counts:{discovered:0,read:0,valid:0,selected:0,sent:0,readback:0}};
 // 历史缺字段只作诊断，普通补量不再次消费这些未入选帖子。
 state.seen=[...new Set([...state.seen,...(state.read_failures??[])])];
 if(existsSync(summaryRef)&&['target_reached','content_insufficient'].includes(read(summaryRef).reason))return read(summaryRef);
 const report=async(status,reason,extra={})=>{
  const counts={...state.counts},dir=join(root,'rounds',String(state.round).padStart(4,'0'));
  const artifact=names=>{const p=names.map(n=>join(dir,n)).find(existsSync);return p?read(p):null;};
  const collection=artifact(['collection.json','homepage-bodies.json']),selection=artifact(['selection.json','selection-daily.json','selection-manual.json']),push=artifact(['push.json','push-daily.json','push-manual.json']),back=artifact(['readback.json','exact-readback.json']);
  const observed=artifact(['homefeed-observed.json']);
  if(collection){const items=collection.items.filter(x=>!state.seen.includes(x.source_id));const ids=collection.discovered_ids??observed?.discovered_ids??observed?.items.map(x=>new URL(x.urls.find(u=>u.includes('xsec_token='))).pathname.split('/').at(-1))??items.map(x=>x.source_id);counts.discovered=new Set([...(state.discovered??[]),...ids]).size;counts.read+=items.length;counts.valid+=items.filter(x=>x.status==='succeeded').length;}
  else if(observed)counts.discovered=new Set([...(state.discovered??[]),...(observed.discovered_ids??observed.items.map(x=>new URL(x.urls.find(u=>u.includes('xsec_token='))).pathname.split('/').at(-1)))]).size;
  if(selection)counts.selected+=selection.decisions.filter(x=>x.status==='chosen').length;
  if(push)counts.sent+=push.sent.filter(x=>x.result.status==='succeeded').length;
  if(back)counts.readback+=back.results.filter(x=>x.status==='succeeded').length;
  const result={at:new Date().toISOString(),status,reason,requested:target,total_confirmed:await confirmed(),counts,round:state.round,skipped_incomplete_ids:state.read_failures??[],...extra};saveRuntimeJson(summaryRef,result);return result;
 };
 const stage=async(dir,name,run)=>{
  await guard();const out=join(dir,name+'.json'),started=join(dir,name+'-started.json');if(existsSync(out))return read(out);
  if(existsSync(started)&&name!=='collection'){
   const recovered=await recover(name,dir);if(!recovered)throw Error(`unresolved ${name}; inspect original receipt`);saveRuntimeJson(out,recovered);return recovered;
  }
  saveRuntimeJson(started,{at:new Date().toISOString()});const result=await run();saveRuntimeJson(out,result);return result;
 };
 try{
  while(true){
   await guard();if(await confirmed()>=target&&!existsSync(join(root,'rounds',String(state.round).padStart(4,'0'),'collection-started.json')))return await report('succeeded','target_reached');
   const dir=join(root,'rounds',String(state.round).padStart(4,'0'));mkdirSync(dir,{recursive:true});
   const collection=await stage(dir,'collection',()=>collect(state.round,new Set(state.seen),dir));
   if(collection.stopped){const error=Error(collection.stopped.reason||collection.stopped.kind||'platform barrier');error.kind=collection.stopped.kind;error.collectionFailure=collection.stopped;throw error;}
   const seen=new Set(state.seen),items=collection.items.filter(x=>!seen.has(x.source_id));
   const valid=items.filter(x=>x.status==='succeeded');
   const selection=await stage(dir,'selection',()=>valid.length?select(valid,dir):{decisions:[]});
   const chosen=selection.decisions.filter(x=>x.status==='chosen');
   const delivery=await stage(dir,'push',async()=>chosen.length?push(selection,dir,Math.max(0,target-await confirmed())):{sent:[],failed:[],total_confirmed:await confirmed()});
   if(delivery.error||delivery.pending||delivery.failed?.length||delivery.sent.some(x=>x.result.status!=='succeeded'))throw Error(delivery.error||'delivery unresolved or failed');
   // 回读是只读操作，可安全重入，但每条必须对应相同推荐身份。
   await guard();const back=await readback(delivery,dir);
   if(back.results.length!==delivery.sent.length||new Set(back.results.map(x=>x.recommendation_id)).size!==delivery.sent.length||delivery.sent.some(x=>!back.results.some(b=>b.recommendation_id===x.recommendation_id&&b.status==='succeeded')))throw Error('readback uncertain');
   saveRuntimeJson(join(dir,'readback.json'),back);
   const discovered=collection.discovered_ids??items.map(x=>x.source_id);state.discovered??=[];state.discovered=[...new Set([...state.discovered,...discovered])];
   state.counts.discovered=state.discovered.length;state.counts.read+=items.length;state.counts.valid+=valid.length;state.counts.selected+=chosen.length;state.counts.sent+=delivery.sent.length;state.counts.readback+=back.results.length;
   const failed=new Set(state.read_failures??[]);
   for(const item of items)if(['failed','incomplete'].includes(item.status))failed.add(item.source_id);else failed.delete(item.source_id);
   state.read_failures=[...failed];
   state.seen.push(...items.map(x=>x.source_id));state.stalled=items.length?0:state.stalled+1;state.round++;
   saveRuntimeJson(stateRef,state);
   await report('running','continuing');
   if(await confirmed()>=target)return await report('succeeded','target_reached');
   if(collection.exhausted)return await report('partial','content_insufficient');
   if(state.stalled>=3)return await report('execution_incomplete','feed_stalled');
  }
 }catch(error){
  // 保存本身失败时交由worker记录停止，不再保存摘要掩盖原错误或重试整轮。
  if(error.kind!=='runtime_state_save_failed')await report(['verification','login_required'].includes(error.kind)?'awaiting_user':'execution_incomplete',error.kind||error.message,error.collectionFailure?{collection_failure:error.collectionFailure}:{});
  throw error;
 }
}
