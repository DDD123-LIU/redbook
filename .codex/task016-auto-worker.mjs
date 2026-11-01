// 2026-10-28 Codex：每个已验证飞书事件只执行一次有限追加，不定时采集。
import {readFileSync,writeFileSync,mkdirSync,appendFileSync,openSync,closeSync,unlinkSync,existsSync,renameSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {readQuota,getActiveQuotaPause,quotaPauseExpiresAt} from './task016-live-quota.mjs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {runRecommendationRounds,saveRuntimeJson} from './task016-runtime.mjs';
const workspace=resolve('.');
export function persistQuotaPause({reason,command,root=resolve('.codex/private'),handoff=resolve('.codex/TASK-016-HANDOFF.md'),now=new Date()}){
 const at=now.toISOString(),expires_at=quotaPauseExpiresAt(at),note=`\n${at} Codex 额度暂停：${reason}；command=${command}。仅到当日24点有效（${expires_at}）；当日提前恢复须新的继续授权，次日重新核额度。\n`;
 writeFileSync(handoff,note+'\n'+(existsSync(handoff)?readFileSync(handoff,'utf8'):''));
 const pauseRef=join(root,'task016-quota-paused.json'),lock=pauseRef+'.write.lock',handle=openSync(lock,'wx');
 try{
  if(getActiveQuotaPause({pauseRef,now}))return;
  if(existsSync(pauseRef))renameSync(pauseRef,pauseRef+`.expired-${randomUUID()}.json`);
  writeFileSync(pauseRef,JSON.stringify({at,expires_at,reason,command}),{flag:'wx'});
 }finally{closeSync(handle);unlinkSync(lock);}
}
// 使用标准库独占创建，覆盖整个请求而非只覆盖某个上传步骤；异常遗留由人工核实恢复。
export async function withRequestLease(root,command,run){
 mkdirSync(root,{recursive:true});const path=join(root,'active-request.lock');let handle;
 try{handle=openSync(path,'wx');}catch(e){if(e.code==='EEXIST')throw Error('another active or unresolved recommendation request');throw e;}
 try{writeFileSync(handle,JSON.stringify({pid:process.pid,command,started_at:new Date().toISOString()}));return await run();}
 finally{closeSync(handle);unlinkSync(path);}
}
export function dailyRequest(now=new Date(),{authorizedOneOffAt=null,dailyTarget=20}={}){
 if(![10,20].includes(dailyTarget))throw Error('invalid daily target');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 const day=`${parts.year}-${parts.month}-${parts.day}`;
 if(authorizedOneOffAt!==null){
  const legacy=authorizedOneOffAt==='2026-10-29T06:05:00+08:00',at=Date.parse(authorizedOneOffAt);
  if(typeof authorizedOneOffAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(authorizedOneOffAt)||!Number.isFinite(at)||(!legacy&&dailyTarget!==10))throw Error('invalid one-off authorization timestamp or target');
  if(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at))!==day)throw Error('authorized one-off day expired or not started');
  if(now.getTime()<at)throw Error('one-off not due');
 }else if(Number(parts.hour)*60+Number(parts.minute)<675)throw Error('daily recommendation is not due before Shanghai 11:15');
 const key=authorizedOneOffAt?`one-off:${authorizedOneOffAt}`:`daily${dailyTarget===10?'10':''}:${day}`;
 return {request_type:'daily_follow',target:dailyTarget,business_day:day,provenance:{command_id:createHash('sha256').update(`TASK012-synthetic:${key}`).digest('hex'),source:'native_schedule',...(authorizedOneOffAt?{trigger_type:'user_authorized_one_off',authorized_start_at:authorizedOneOffAt}:{})}};
}
// 新入口不自动接管历史20条请求；旧事件及批次保留原值待单独核实。
export function isCurrentFollowRequest(request){return request?.request_type==='additional_follow'&&request.target===3;}
export function executeAdditional(request){if(!isCurrentFollowRequest(request))throw Error('unsupported current follow request');return withRequestLease(resolve('.codex/private/task016-auto'),request.provenance?.command_id,()=>executeRequest(request));}
export function executeDaily(options={}){const request=dailyRequest(new Date(),options);return withRequestLease(resolve('.codex/private/task016-auto'),request.provenance.command_id,()=>executeRequest(request));}
// 三入口共用筛选恢复；是否可重试由selector的持久证据判定，不在此盲删started。
export async function executeSelection({dir,kind,run,guard,target,recover=false}){
 const native=join(dir,`selection-${kind}.json`),args=[resolve('.codex/task016-select-real-20261028.mjs'),kind];
 if(existsSync(native))return JSON.parse(readFileSync(native,'utf8'));
 try{await run(process.execPath,args,dir,target,{selectionRecover:recover});}
 catch(error){
  if(recover||!existsSync(join(dir,`selection-${kind}-started.json`)))throw error;
  await guard();await run(process.execPath,args,dir,target,{selectionRecover:true});
 }
 return JSON.parse(readFileSync(native,'utf8'));
}
async function executeRequest(request){
 const command=request.provenance?.command_id;
 const kind=request.request_type==='daily_follow'&&[10,20].includes(request.target)&&request.provenance.source==='native_schedule'?'daily':request.request_type==='additional_follow'&&request.target===3?'additional':null;
 if(!/^[a-f0-9]{64}$/.test(command)||!kind)throw Error('invalid verified request');
 const session=JSON.parse(readFileSync(resolve('.codex/private/task016-browser-session.json'),'utf8'));
 if(!Number.isInteger(session.spaceId)||session.spaceId<1||session.pageLabel!=='p1')throw Error('verified browser session required');
 const root=resolve('.codex/private/task016-auto',command);mkdirSync(root,{recursive:true});
 if(existsSync(join(root,'completed-result.json')))return JSON.parse(readFileSync(join(root,'completed-result.json'),'utf8'));
 if(existsSync(join(root,'request.json'))){
  const prior=JSON.parse(readFileSync(join(root,'request.json'),'utf8'));
  if(prior.runtime_version!==2||prior.provenance.command_id!==command)throw Error('prior request is unresolved; inspect original intents and receipts');
 }else writeFileSync(join(root,'request.json'),JSON.stringify({...request,runtime_version:2},null,2),{flag:'wx'});
 let active=null,monitoring=false,quotaError=null,guardFlight=null,quotaStarted=false;
 const quotaCache=join(root,'quota.json');
 const checkpoint=reason=>{
  const note=`\n${new Date().toISOString()} Codex 自动追加暂停：${reason}；command=${command}；证据=${root}。先核实际进程、批次和回执，不自动重试。\n`;
  const handoff=resolve('.codex/TASK-016-HANDOFF.md');writeFileSync(handoff,note+'\n'+readFileSync(handoff,'utf8'));writeFileSync(join(root,'stopped.json'),JSON.stringify({at:new Date().toISOString(),reason}));
 };
 const pauseRef=resolve('.codex/private/task016-quota-paused.json');
 const checkQuota=async()=>{
  if(quotaError)throw quotaError;
  if(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())!==request.business_day&&kind==='daily')throw Error('business day expired');
  if(getActiveQuotaPause({pauseRef}))throw Error('quota pause requires a new user continue authorization today');
  try{const q=await readQuota({cachePath:quotaCache,force:!quotaStarted});quotaStarted=true;if(q.fiveHourRemaining<4||q.weeklyRemaining<2)throw Error('quota below user threshold');}
  catch(error){persistQuotaPause({reason:error.message,command});writeFileSync(join(root,'stopped.json'),JSON.stringify({at:new Date().toISOString(),reason:error.message}));throw error;}
 };
 // 30秒仅检查本地到期时间，阶段与子进程共用动态缓存，不再每次远端查询。
 const guard=()=>guardFlight??=(checkQuota().finally(()=>{guardFlight=null;}));
 const run=(exe,args,stageRoot=root,remaining=request.target,{selectionRecover=false}={})=>new Promise((accept,reject)=>{
  active=spawn(exe,args,{cwd:workspace,windowsHide:true,env:{...process.env,TASK016_QUOTA_CACHE:quotaCache,TASK016_RUN_ROOT:stageRoot,TASK016_EVENT_ID:request.event_id,TASK016_TARGET:String(request.target),TASK016_SELECTION_RECOVER:selectionRecover?'1':'0',TASK016_WITH_IMAGES:'1',TASK016_MAX_SEND:String(remaining),TASK016_BUSINESS_DAY:kind==='daily'?request.business_day:''},stdio:['ignore','pipe','pipe']});
  active.stdout.on('data',b=>appendFileSync(join(root,'execution.log'),b));active.stderr.on('data',b=>appendFileSync(join(root,'execution.log'),b));
  active.on('error',reject);active.on('exit',code=>{active=null;code===0&&!quotaError?accept():reject(quotaError??Error(`stage exit ${code}`));});
 });
 const watch=setInterval(async()=>{if(monitoring)return;monitoring=true;try{await guard();}catch(e){quotaError=e;checkpoint(e.message);if(active?.pid)spawn('taskkill',['/PID',String(active.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}finally{monitoring=false;}},30000);
 try{
  await guard();
  const db=new DatabaseSync(resolve('.codex/private/task013-production/state.sqlite'),{readOnly:true});
  try{const slot=db.prepare('SELECT * FROM execution_slot').get();if(!['idle','stopped'].includes(slot.state)||slot.run_id||slot.owner)throw Error('another collection or delivery run owns the slot');if(db.prepare("SELECT count(*) n FROM delivery_attempt WHERE status IN ('intent','unknown')").get().n)throw Error('unresolved delivery intent or unknown');}finally{db.close();}
  if(kind==='daily'){
   const result=await executeRecommendationRounds({request,root,guard,run});
   clearInterval(watch);if(guardFlight)await guardFlight;if(quotaError)throw quotaError;
   if(['target_reached','content_insufficient'].includes(result.reason))saveRuntimeJson(join(root,'completed-result.json'),result);
   return result;
  }
  const oldRoot=resolve('.codex/private/task016-trial-20261028').replaceAll('\\','/');
  for(const [name,source] of [['observe','.codex/task016-homefeed-observe-20261028.mjs'],['bodies','.codex/task016-read-homefeed-bodies-20261028.mjs']]){
   writeFileSync(join(root,`${name}.mjs`),readFileSync(source,'utf8').replaceAll(oldRoot,root.replaceAll('\\','/')));
  }
  // 本次实际受控空间由启动时核验；不自动认领用户正在操作的空间。
  for(const name of ['observe','bodies']){const path=join(root,`${name}.mjs`);writeFileSync(path,readFileSync(path,'utf8').replaceAll('taskSpace(1)',`taskSpace(${session.spaceId})`));}
  const bootstrap=join(root,'browser.mjs');writeFileSync(bootstrap,`const t=await taskSpace(${session.spaceId});await t.page('p1').goto('https://www.xiaohongshu.com/explore');await t.page('p1').waitForSelector('section.note-item');await import(${JSON.stringify('file:///'+join(root,'observe.mjs').replaceAll('\\','/'))});await import(${JSON.stringify('file:///'+join(root,'bodies.mjs').replaceAll('\\','/'))});`);
  await run('C:/Users/YOUR_USER/.local/share/ego/active_version_dir/ego-browser.exe',['nodejs','-e',`await import(${JSON.stringify('file:///'+bootstrap.replaceAll('\\','/'))})`]);
  const bodies=JSON.parse(readFileSync(join(root,'homepage-bodies.json'),'utf8'));if(bodies.stopped)throw Object.assign(Error(bodies.stopped.reason||bodies.stopped.kind||'platform barrier'),{kind:bodies.stopped.kind});
  await guard();await executeSelection({dir:root,kind,run,guard,target:request.target});
  await guard();await run(process.execPath,[resolve('.codex/task016-push-real-20261028.mjs'),kind]);
  await run(process.execPath,[resolve('.codex/task016-feishu-readonly-20261028.mjs'),kind==='daily'?'--daily-readback':kind==='manual'?'--manual-readback':'--additional-readback']);
  const readback=JSON.parse(readFileSync(join(root,kind==='additional'?'exact-additional-readback.json':'exact-readback.json'),'utf8'));if(readback.results.some(x=>x.status!=='succeeded'))throw Error('message readback uncertain');
  const pushed=JSON.parse(readFileSync(join(root,`push-${kind}.json`),'utf8')),actual=pushed.sent.filter(x=>x.result.status==='succeeded').length;
  if(pushed.error)throw Error(pushed.error);
  const total=kind==='daily'?pushed.total_confirmed:actual;
  const completed={status:total===request.target?'succeeded':'partial',requested:request.target,actual,total_confirmed:total,batch_id:pushed.batch_id,evidence_root:root};
  writeFileSync(join(root,'completed-result.json'),JSON.stringify(completed,null,2),{flag:'wx'});return completed;
 }catch(e){checkpoint(e.message);throw e;}finally{clearInterval(watch);if(guardFlight)try{await guardFlight;}catch{}}
}

// 复用原浏览器读取、筛选、展示与回读，每轮单独目录但主库仍是当日唯一批次。
export async function executeRecommendationRounds({request,root,guard,run,databasePath=resolve('.codex/private/task013-production/state.sqlite'),sessionRef=resolve('.codex/private/task016-browser-session.json')}){
 if(request.request_type==='manual_follow')throw Error('manual recommendations disabled');
 const read=p=>JSON.parse(readFileSync(p,'utf8'));
 const kind='daily';
 function query(fn){const db=new DatabaseSync(databasePath,{readOnly:true});try{return fn(db);}finally{db.close();}}
 const batch=()=>{const value=query(db=>db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=? ORDER BY created_at DESC LIMIT 1").get('TASK012-synthetic',request.business_day));if(value&&value.target!==request.target)throw Error('existing daily batch target differs; preserve historical batch');return value;};
 const confirmed=async()=>{const b=batch();return b?query(db=>db.prepare("SELECT count(DISTINCT r.recommendation_id) n FROM recommendation r JOIN delivery_attempt a USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='succeeded'").get(b.delivery_batch_id).n):0;};
 const browserModuleUrl=pathToFileURL(resolve('.codex/task016-browser-round.mjs')).href;
 const select=(dir,recover=false)=>executeSelection({dir,kind,run,guard,target:request.target,recover});
 const result=await runRecommendationRounds({root,target:request.target,guard,confirmed,
  collect:async(round,seen,dir)=>{
   const session=read(sessionRef);
   const exclude=[...seen,...query(db=>db.prepare('SELECT source_content_id FROM delivered_content WHERE owner=?').all('TASK012-synthetic').map(x=>x.source_content_id))];
   const browser=join(dir,'browser.mjs');
   writeFileSync(browser,`const {collectBrowserRound}=await import(${JSON.stringify(browserModuleUrl)});try{await collectBrowserRound(${JSON.stringify({root:dir,spaceId:session.spaceId,sessionRef,round,exclude,workspace})});}catch(e){const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(join(dir,'browser-error.json'))},JSON.stringify({at:new Date().toISOString(),kind:e.kind??'browser_failed',message:e.message}));throw e;}`);
   try{await run('C:/Users/YOUR_USER/.local/share/ego/active_version_dir/ego-browser.exe',['nodejs','-e',`await import(${JSON.stringify(pathToFileURL(browser).href)})`],dir);}catch(error){
    const ref=join(dir,'browser-error.json');if(existsSync(ref)){const evidence=read(ref);error.kind=evidence.kind;error.message=evidence.message;}throw error;
   }
   const bodies=read(join(dir,'homepage-bodies.json')),observed=read(join(dir,'homefeed-observed.json'));
   return {...bodies,discovered_ids:observed.discovered_ids??observed.items.map(x=>new URL(x.urls.find(u=>u.includes('xsec_token='))).pathname.split('/').at(-1)),exhausted:observed.exhausted===true};
  },
  select:async(items,dir)=>select(dir),
  push:async(selection,dir,remaining)=>{await run(process.execPath,[resolve('.codex/task016-push-real-20261028.mjs'),kind],dir,remaining);return read(join(dir,`push-${kind}.json`));},
  readback:async(push,dir)=>{if(!push.sent.length)return {results:[]};await run(process.execPath,[resolve('.codex/task016-feishu-readonly-20261028.mjs'),`--${kind}-readback`],dir);return read(join(dir,'exact-readback.json'));},
  recover:async(stage,dir)=>{if(stage==='selection')return select(dir,true);const file=join(dir,`push-${kind}.json`);if(!existsSync(file))return null;const value=read(file);if(value.pending||value.error||value.failed?.length)throw Error('unresolved native receipt');return value;}
 });
 return {...result,actual:result.counts.sent,batch_id:batch()?.delivery_batch_id??null,evidence_root:root};
}
