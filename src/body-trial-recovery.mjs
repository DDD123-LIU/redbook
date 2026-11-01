import {mkdir,readFile,writeFile,readdir,unlink,rename} from 'node:fs/promises';
import {join,resolve,basename,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const withoutFeedback=payload=>{const copy={...payload};delete copy.current_feedback;return JSON.stringify(copy);};
function nativeLegacyProbe({outputPath,attemptId}){
  if(process.platform!=='win32')return null;
  // 只输出覆盖计数与命中进程元数据；命令行不离开原生查询。
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process -Filter "Name='codex.exe' OR Name='node.exe'" -ErrorAction Stop); $bad=0; $hits=@(); foreach($p in $all){ if([string]::IsNullOrWhiteSpace($p.CommandLine)){$bad++;continue}; if($p.CommandLine.IndexOf(${literal(outputPath)},[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $p.CommandLine.IndexOf(${literal(attemptId)},[StringComparison]::OrdinalIgnoreCase) -ge 0){$hits+=@{pid=[int]$p.ProcessId;parent_pid=[int]$p.ParentProcessId;name=$p.Name}} }; @{queried_at=[DateTime]::UtcNow.ToString('o');total=$all.Count;unreadable=$bad;matches=@($hits)} | ConvertTo-Json -Depth 5 -Compress`;
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}));
}
// 旧版无PID时只证明本机CLI已不在进程快照中，不声称远端计算完成。
export async function reconcileLegacyBodyTrial({attemptDir,inputHash,probeLegacy=nativeLegacyProbe}){
  try{
    attemptDir=resolve(attemptDir);
    for(const name of ['process.json','output.json','run-result.json','receipt.json']){try{await readFile(join(attemptDir,name));return {status:'unknown'};}catch(error){if(error.code!=='ENOENT')throw error;}}
    const input=await json(join(attemptDir,'input.json')),requestBytes=await readFile(join(attemptDir,'request.json')),request=JSON.parse(requestBytes);
    const args=request.args,attemptId=basename(attemptDir),outputPath=join(attemptDir,'output.json');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)||!inputHash||input?.input_hash!==inputHash||request.input_hash!==inputHash||request.tool!=='official-codex-cli'||!Array.isArray(args)||!args.every(x=>typeof x==='string')||args[0]!=='exec'||args.filter(x=>x==='--ephemeral').length!==1)return {status:'unknown'};
    for(const [flag,target] of [['-o',outputPath],['--output-schema',join(attemptDir,'schema.json')]]){const index=args.indexOf(flag);if(index<0||args.lastIndexOf(flag)!==index||!args[index+1]||!isAbsolute(args[index+1])||resolve(args[index+1]).toLowerCase()!==target.toLowerCase())return {status:'unknown'};}
    const coverage=await probeLegacy({outputPath,attemptId});
    if(!coverage||!Number.isInteger(coverage.total)||coverage.total<0||!Number.isInteger(coverage.unreadable)||coverage.unreadable<0||coverage.unreadable>coverage.total||!Array.isArray(coverage.matches)||coverage.matches.length>coverage.total||!Number.isFinite(Date.parse(coverage.queried_at))||Math.abs(Date.now()-Date.parse(coverage.queried_at))>60000)return {status:'unknown'};
    const proof={status:coverage.matches.length?'running':coverage.unreadable?'unknown':'stopped',scope:'local_cli_only',input_hash:inputHash,request_hash:hash(requestBytes),queried_at:coverage.queried_at,coverage:{names:['codex.exe','node.exe'],total:coverage.total,unreadable:coverage.unreadable,matches:coverage.matches.map(p=>({pid:p.pid,parent_pid:p.parent_pid,name:p.name}))}};
    if(proof.status==='stopped')await writeFile(join(attemptDir,'legacy-reconciliation.json'),JSON.stringify(proof)+'\n');
    return proof;
  }catch{return {status:'unknown'};}
}
async function json(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
// 进程存在只证明仍需等待；查询失败和缺失身份均不能证明原任务已终止。
export function probeBodyTrialProcess(info){
  if(!Number.isInteger(info?.pid)||info.pid<1)return 'unknown';
  try{process.kill(info.pid,0);return 'running';}catch(error){return error.code==='ESRCH'?'stopped':'unknown';}
}
function processIdentity(info){
  if(process.platform!=='win32'||!Number.isInteger(info.pid))return info;
  try{const birth=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter "ProcessId=${info.pid}" -ErrorAction Stop).CreationDate.ToUniversalTime().ToString('o')`],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();return {...info,birth};}catch{return {...info,identity_unknown:true};}
}

// 每个逻辑批只有一个持久入口与一次重试额度；锁中断时保守停止，保留全部证据。
export async function recoverBodyTrialModel({root,key,inputHash,payload,model,verify,validateOutput=()=>true,recover=false,waitMs=30000,pollMs=1000,probe=probeBodyTrialProcess,probeLegacy=nativeLegacyProbe,...request}){
  if(!/^[a-zA-Z0-9_-]+$/.test(key))throw Error('invalid recovery key');
  root=resolve(root);await mkdir(root,{recursive:true});
  const stateRef=join(root,`selection-${key}-recovery.json`),lockRef=`${stateRef}.lock`;
  await writeFile(lockRef,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
  try{
    let state=await json(stateRef);
    const save=async()=>{const temp=`${stateRef}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state)+'\n',{flag:'wx'});await rename(temp,stateRef);};
    if(state&&!recover)throw Error('attempt already exists; recovery required');
    if(state&&state.input_hash!==inputHash)throw Error('body trial recovery input changed');
    if(state?.retry_payload_hash&&state.retry_payload_hash!==hash(JSON.stringify(payload)))throw Error('body trial recovery input changed');
    if(!state){
      // 旧版没有批入口。仅唯一且输入哈希完全一致的原 attempt 可接管。
      const base=join(root,'body-trial'),matches=[];
      if(recover){for(const entry of await readdir(base,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){if(entry.isDirectory()){const dir=join(base,entry.name),input=await json(join(dir,'input.json'));if(input&&(input.input_hash===inputHash||(Object.hasOwn(input.payload??{},'current_feedback')&&Object.hasOwn(payload,'current_feedback')&&withoutFeedback(input.payload)===withoutFeedback(payload))))matches.push(dir);}}}
      if(matches.length>1)throw Error('ambiguous legacy selection attempts');
      if(recover&&!matches.length)throw Error('legacy selection input unknown');
      state={input_hash:inputHash,attempts:matches};
      if(matches.length)state.legacy_attempt_ref=matches[0];
      if(matches.length){const prior=await json(join(matches[0],'input.json'));if(prior.input_hash!==inputHash)Object.assign(state,{prior_input_hash:prior.input_hash,feedback_refreshed:true,feedback_refreshed_at:new Date().toISOString(),retry_payload_hash:hash(JSON.stringify(payload))});}
      if(matches.length)await save();
    }
    if(state.attempts.length){
      const dir=state.attempts.at(-1),inputRef=join(dir,'input.json'),outputRef=join(dir,'output.json'),receiptRef=join(dir,'receipt.json');
      const inputBytes=await readFile(inputRef),input=JSON.parse(inputBytes);
      const refreshed=state.feedback_refreshed&&state.attempts.length===1&&input.input_hash===state.prior_input_hash&&withoutFeedback(input.payload)===withoutFeedback(payload);
      if(!refreshed&&(input.input_hash!==inputHash||JSON.stringify(input.payload)!==JSON.stringify(payload)))throw Error('body trial recovery input changed');
      const deadline=Date.now()+Math.min(Math.max(waitMs,0),60000);
      for(;;){
        const receipt=await json(receiptRef);
        if(receipt&&!refreshed){
          const bytes=await readFile(outputRef).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
          const intact=bytes&&receipt.kind==='selection'&&receipt.input_hash===inputHash&&receipt.input_ref===inputRef&&receipt.output_ref===outputRef&&receipt.input_file_hash===hash(inputBytes)&&receipt.output_hash===hash(bytes);
          if(verify(receipt)&&intact&&validateOutput(bytes))return {inputRef,outputRef,receiptRef,receipt,bytes,reused:true};
          if(verify(receipt)&&!intact)throw Error('body trial recovery receipt or output damaged');
        }
        const outcome=await json(join(dir,'run-result.json'));
        const terminal=outcome&&!outcome.invocationUnknown&&(Number.isInteger(outcome.exitCode)||(Number.isInteger(outcome.child_pid)&&typeof outcome.signal==='string'&&outcome.signal.length>0));
        const processInfo=await json(join(dir,'process.json'));
        let status=terminal||receipt&&verify(receipt)?'stopped':await probe(processInfo);
        if(status==='unknown'&&!processInfo&&state.legacy_attempt_ref===dir)status=(await reconcileLegacyBodyTrial({attemptDir:dir,inputHash:input.input_hash,probeLegacy})).status;
        if(status==='stopped')break;
        if(status!=='running')throw Error('body trial process status unknown');
        if(Date.now()>=deadline)throw Error('body trial process still running');
        await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
      }
      if(state.attempts.length>=2)throw Error('body trial retry exhausted');
    }
    const attemptDir=join(root,'body-trial',randomUUID());await mkdir(attemptDir,{recursive:true});
    const inputRef=join(attemptDir,'input.json'),outputRef=join(attemptDir,'output.json'),receiptRef=join(attemptDir,'receipt.json');
    await writeFile(inputRef,JSON.stringify({input_hash:inputHash,payload})+'\n',{flag:'wx'});
    state.attempts.push(attemptDir);await save();
    const run=await model({...request,input:{input_hash:inputHash,model_requested:'gpt-6.1-sol',images:[]},kind:'selection',payload,attemptDir,outputPath:outputRef,eventsPath:join(attemptDir,'events.jsonl'),stderrPath:join(attemptDir,'stderr.txt'),onSpawn:async info=>{await writeFile(join(attemptDir,'process.json'),JSON.stringify(processIdentity(info))+'\n',{flag:'wx'});}});
    await writeFile(join(attemptDir,'run-result.json'),JSON.stringify(run)+'\n',{flag:'wx'});
    const bytes=await readFile(outputRef).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const receipt={...run,kind:'selection',input_hash:inputHash,input_ref:inputRef,input_file_hash:hash(await readFile(inputRef)),output_ref:outputRef,output_hash:bytes?hash(bytes):null,model_requested:'gpt-6.1-sol',model_observed:'unknown',completed_at:new Date().toISOString()};
    await writeFile(receiptRef,JSON.stringify(receipt)+'\n',{flag:'wx'});
    if(!verify(receipt)||!bytes)throw Error('body trial completion not verified');
    return {inputRef,outputRef,receiptRef,receipt,bytes,reused:false};
  }finally{await unlink(lockRef);}
}
