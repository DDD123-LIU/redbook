// 2026-10-28 Codex：通过官方app-server只读实时额度，不读取或输出凭证。
import {spawn,spawnSync} from 'node:child_process';
import {readdirSync,statSync,mkdirSync,appendFileSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
// 2026-10-31 Codex：额度暂停以UTC+8当日24点为界，兼容旧版仅at的记录。
export function quotaPauseExpiresAt(at){
 const ms=Date.parse(at);if(!Number.isFinite(ms))throw Error('quota pause timestamp invalid; inspect original record');
 return new Date((Math.floor((ms+28800000)/86400000)+1)*86400000-28800000).toISOString();
}
export function getActiveQuotaPause({pauseRef=resolve('.codex/private/task016-quota-paused.json'),now=new Date()}={}){
 if(!existsSync(pauseRef))return null;
 const pause=JSON.parse(readFileSync(pauseRef,'utf8')),expires=quotaPauseExpiresAt(pause.at);
 if(!Number.isFinite(now.getTime()))throw Error('quota pause check time invalid');
 // 过期文件只作审计，不再产生阻塞；下一次新暂停写入时归档。
 return now.getTime()<Date.parse(expires)?{...pause,expires_at:expires}:null;
}
// 只记白名单元数据，不保存凭证、额度协议原文或服务stderr。
function recordDiagnostic(event){
 try{const folder=fileURLToPath(new URL('./private/',import.meta.url));mkdirSync(folder,{recursive:true});appendFileSync(join(folder,'task016-quota-diagnostics.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');}
 catch(error){console.error(`quota diagnostic write failed (${error.code??'UNKNOWN'})`);}
}
// 版本目录可能被用户清理；每次调用重新发现，不缓存某个版本路径。
export function resolveCodexExecutable({env=process.env,binRoot=join(env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'OpenAI','Codex','bin'),onDiagnostic=recordDiagnostic,maxProbeAttempts=2,deadline=Infinity,now=Date.now,probe=(path,timeoutMs)=>{
 return spawnSync(path,['--version'],{windowsHide:true,encoding:'utf8',timeout:timeoutMs,stdio:['ignore','pipe','pipe']});
}}={}){
 const failures=[];
 const runnable=path=>{
  try{if(!statSync(path).isFile())throw Object.assign(Error('not a file'),{code:'NOT_FILE'});}
  catch(error){const event={stage:'stat',path,code:error.code??'UNKNOWN'};onDiagnostic(event);failures.push(event);return false;}
  for(let attempt=1;attempt<=maxProbeAttempts;attempt++){
   const start=now();let result;
   if(start>=deadline)throw Object.assign(Error('quota resolution budget exceeded'),{code:'ETIMEDOUT'});
   try{result=probe(path,Math.max(1,Math.min(5000,deadline-now())));}catch(error){result={error};}
   if(result===true||(result?.status===0&&/^codex-cli\s+\S+/m.test(result.stdout??'')))return true;
   const event={stage:'version',path,attempt,durationMs:now()-start,code:result?.error?.code??(result?.status===0?'INVALID_VERSION':'PROBE_FAILED'),exitCode:result?.status??null,signal:result?.signal??null,timedOut:result?.error?.code==='ETIMEDOUT'};
   failures.push(event);onDiagnostic(event);
   if(['ENOENT','EACCES','EPERM'].includes(event.code)||result===false)break;
  }
  return false;
 };
 const details=()=>failures.map(x=>`${x.path}: ${x.code} exit=${x.exitCode??'null'} signal=${x.signal??'null'} timeout=${x.timedOut??false}`).join('; ');
 if(env.TASK016_CODEX_EXECUTABLE!==undefined){
  const path=resolve(env.TASK016_CODEX_EXECUTABLE.trim());
  if(!env.TASK016_CODEX_EXECUTABLE.trim()||!runnable(path))throw Object.assign(Error(`configured Codex executable unavailable: ${path}; ${details()}`),{code:failures.at(-1)?.code??'ENOENT'});
  return path;
 }
 let directories=[];
 try{directories=readdirSync(binRoot,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name);}
 catch(error){onDiagnostic({stage:'directory',path:binRoot,code:error.code??'UNKNOWN'});if(error.code!=='ENOENT')throw Object.assign(Error(`cannot inspect Codex bin directory: ${binRoot} (${error.code})`),{code:error.code,cause:error});}
 const candidates=[join(binRoot,'codex.exe'),...directories.map(name=>join(binRoot,name,'codex.exe'))].flatMap(path=>{
  try{const stat=statSync(path);return stat.isFile()?[{path,mtime:stat.mtimeMs}]:[];}
  catch(error){if(error.code!=='ENOENT'){const event={stage:'stat',path,code:error.code??'UNKNOWN'};failures.push(event);onDiagnostic(event);}return [];}
 }).sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path));
 for(const item of candidates)if(runnable(item.path))return item.path;
 throw Object.assign(Error(`no runnable Codex executable found in ${binRoot}; ${details()||'no executable files found'}; check installation or TASK016_CODEX_EXECUTABLE`),{code:failures.find(x=>isTransientQuotaError(x))?.code??failures.at(-1)?.code??'ENOENT'});
}
// 只重试明确临时故障；未知协议、权限和配置错误直接暂停。
export function isTransientQuotaError(error){
 return ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE','EAI_AGAIN','ENETUNREACH','SERVICE_EXIT','UNRELIABLE_RESPONSE',-32603,-32000,429,500,502,503,504].includes(error?.code);
}
// 2026-10-31 Codex：按最快历史速度预测触线时间；满额耗时是外推，不是容量保证。
export function quotaIntervalMs(q){
 if(![q?.fiveHourRemaining,q?.weeklyRemaining].every(x=>Number.isFinite(x)&&x>=0&&x<=100))throw Error('quota response unreliable');
 const untilStop=Math.min((q.fiveHourRemaining-4)/100*67.40625*60000,(q.weeklyRemaining-2)/100*269.625*60000);
 return Math.max(30000,Math.min(600000,untilStop*0.2));
}
const quotaFlights=new Map();
// 缓存仅由执行器显式指定；人工诊断及任务启动仍可强制实时查询。
export async function readQuota({cachePath=process.env.TASK016_QUOTA_CACHE,force=false,...options}={}){
 if(!cachePath)return readQuotaFresh(options);
 cachePath=resolve(cachePath);
 if(quotaFlights.has(cachePath))return quotaFlights.get(cachePath);
 const pending=readCachedQuota(cachePath,force,options);
 quotaFlights.set(cachePath,pending);
 try{return await pending;}finally{quotaFlights.delete(cachePath);}
}
async function readCachedQuota(path,force,options){
 const now=options.now??Date.now;
 const cached=()=>{
  try{const q=JSON.parse(readFileSync(path,'utf8')),age=now()-Date.parse(q.observed_at);return Number.isFinite(age)&&age>=0&&age<quotaIntervalMs(q)?q:null;}catch{return null;}
 };
 let q;if(!force&&(q=cached()))return q;
 mkdirSync(dirname(path),{recursive:true});
 const lock=path+'.lock',deadline=Date.now()+300000;let handle;
 // 父子进程在同一请求中串行刷新；不删除无法确认归属的遗留锁。
 while(handle===undefined){
  try{handle=openSync(lock,'wx');}catch(error){
   if(error.code!=='EEXIST')throw error;
   if(Date.now()>=deadline)throw Error('quota cache refresh lock timeout; inspect original process');
   await new Promise(resolve=>setTimeout(resolve,100));
   if(!force&&(q=cached()))return q;
  }
 }
 try{
  if(!force&&(q=cached()))return q;
  q=await readQuotaFresh(options);quotaIntervalMs(q);
  // 原子替换避免发送子进程读取半份JSON；查询失败绝不回退过期缓存。
  const temp=path+`.${process.pid}.tmp`;
  try{writeFileSync(temp,JSON.stringify(q));renameSync(temp,path);}finally{try{unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return q;
 }finally{closeSync(handle);unlinkSync(lock);}
}
// 每轮重新发现程序，取消轮内探测重试；解析、探测、查询与等待共用5分钟预算。
async function readQuotaFresh({resolveExecutable=resolveCodexExecutable,spawnProcess=spawn,onDiagnostic=recordDiagnostic,timeoutMs=20000,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),readOnce=readQuotaOnce}={}){
 const deadline=now()+300000;let lastError;
 for(let attempt=1;attempt<=3;attempt++){
  const start=now();let executable;
  try{
   if(now()>=deadline)throw Object.assign(Error('quota retry budget exceeded'),{code:'ETIMEDOUT',cause:lastError});
   executable=resolveExecutable({maxProbeAttempts:1,deadline,now,onDiagnostic});
   if(now()>=deadline)throw Object.assign(Error('quota resolution budget exceeded'),{code:'ETIMEDOUT'});
   return await readOnce(executable,spawnProcess,Math.max(1,Math.min(timeoutMs,deadline-now())));
  }catch(error){
   const event={stage:'quota',path:executable,attempt,durationMs:now()-start,code:error.code??'QUOTA_FAILED',exitCode:error.exitCode??null,signal:error.signal??null,timedOut:error.code==='ETIMEDOUT'};
   onDiagnostic(event);lastError=Object.assign(Error(error.message+'; '+JSON.stringify(event),{cause:error}),{code:error.code});
   if(!isTransientQuotaError(error)||attempt===3||now()+30000>=deadline)throw lastError;
   await sleep(30000);
  }
 }
 throw lastError;
}
function readQuotaOnce(executable,spawnProcess,timeoutMs){return new Promise((resolve,reject)=>{
 const child=spawnProcess(executable,['app-server'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(result);};
 const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
 const timer=setTimeout(()=>finish(Object.assign(Error('quota read timeout'),{code:'ETIMEDOUT'})),timeoutMs);
 child.on('error',error=>finish(Object.assign(Error(`quota service unavailable (${error.code}) at ${executable}`),{code:error.code,cause:error})));child.stderr.resume();child.stdin.on('error',error=>finish(Object.assign(Error('quota stdin failed'),{code:error.code,cause:error})));
 child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}
  if(m.id===1){if(m.error)return finish(Object.assign(Error('quota initialize failed'),{code:m.error.code}));send({method:'initialized'});send({id:2,method:'account/rateLimits/read'});}
  if(m.id===2){if(m.error)return finish(Object.assign(Error('quota unavailable'),{code:m.error.code}));const buckets=m.result?.rateLimitsByLimitId??{};const b=buckets.codex??m.result?.rateLimits;
   if(![b?.primary?.usedPercent,b?.secondary?.usedPercent].every(x=>Number.isFinite(x)&&x>=0&&x<=100))return finish(Object.assign(Error('quota response unreliable'),{code:'UNRELIABLE_RESPONSE'}));
   finish(null,{observed_at:new Date().toISOString(),fiveHourRemaining:100-b.primary.usedPercent,weeklyRemaining:100-b.secondary.usedPercent});}
 }});
 child.on('exit',(exitCode,signal)=>{if(!done)finish(Object.assign(Error('quota service ended'),{code:'SERVICE_EXIT',exitCode,signal}));});
 send({id:1,method:'initialize',params:{clientInfo:{name:'task016-quota',version:'1.0.0'},capabilities:{}}});
});}
if(process.argv[1]?.endsWith('task016-live-quota.mjs'))readQuota().then(q=>console.log(JSON.stringify(q))).catch(e=>{console.error(e.message);process.exitCode=1;});
