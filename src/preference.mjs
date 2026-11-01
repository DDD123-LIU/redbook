// 2026-10-24 Codex：人工指令通过父版证据链验证，不冒充模型完成。
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyCompletion } from './completion.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function currentPreferencePointer(store,owner){
 const row=store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner,`preference-current:${owner}`);
 return row?JSON.parse(row.succeeded_refs_json)[0]:null;
}

function applyOperation(instructions,operation){
 const result=[...instructions];
 if(!operation||!['append','remove','replace'].includes(operation.kind)||typeof operation.instruction!=='string'||!operation.instruction.trim())throw Error('explicit instruction operation invalid');
 const text=operation.instruction;
 if(operation.kind==='append'){if(!result.includes(text))result.push(text);}
 else{const index=result.indexOf(operation.kind==='remove'?text:operation.old_instruction);if(index<0)throw Error('explicit instruction not found');if(operation.kind==='remove')result.splice(index,1);else result.splice(index,1,text);}
 return result;
}

function operationText(operation){
 if(operation.kind==='append')return `修改偏好：${operation.instruction}`;
 if(operation.kind==='remove')return `删除偏好：${operation.instruction}`;
 return `替换偏好：${operation.old_instruction} => ${operation.instruction}`;
}

function sourceEvent(store,input){
 const event=input.source_event;
 if(!event||event.text!==operationText(input.operation))throw Error('explicit source event text mismatch');
 const saved=store.db.prepare('SELECT * FROM feedback_event WHERE app_ref=? AND chat_ref=? AND event_id=?').get(event.app_ref,event.chat_ref,event.event_id);
 if(!saved?.saved_at||saved.parse_state!=='parsed'||saved.value!==null||saved.content_id!==null)throw Error('explicit source event not saved');
 return saved;
}

// 保留010原有模型根校验；显式子版须递归验证真实父版和来源事件。
export function verifyPreferencePointer(store,pointer,seen=new Set()){
 try{
  if(!pointer?.preference_version||!pointer.manifest_ref||!pointer.manifest_hash||!pointer.input_hash||seen.has(pointer.preference_version))return null;
  seen.add(pointer.preference_version);
  if(sha(readFileSync(pointer.manifest_ref))!==pointer.manifest_hash)return null;
  const manifest=read(pointer.manifest_ref),input=manifest.input??{};
  if(manifest.preference_version!==pointer.preference_version||manifest.input_hash!==pointer.input_hash||digest(Object.fromEntries(Object.entries(input).filter(([key])=>key!=='input_hash')))!==pointer.input_hash||sha(readFileSync(manifest.output_ref))!==manifest.output_hash)return null;
  const output=read(manifest.output_ref),row=store.db.prepare('SELECT * FROM preference_version WHERE preference_version=?').get(pointer.preference_version);
  if(!row||!equal(output.hypotheses,JSON.parse(row.hypotheses_json))||!equal(output.counterexamples,JSON.parse(row.counterexamples_json)))return null;
  let instructions;
  if(manifest.kind==='external_accepted_body_profile'){
   if(manifest.receipt_ref||manifest.receipt_hash||row.parent_version!==null)return null;
   const derived=externalBodyOutput(store,input);
   if(!equal(output,derived)||!equal(JSON.parse(row.supporting_content_ids_json),input.materials.map(x=>x.content_id))||row.confidence!==null)return null;
   instructions=input.explicit_instructions;
   if(input.parent_pointer){const parent=verifyPreferencePointer(store,input.parent_pointer,seen);if(!parent||!equal(instructions,parent.explicit_instructions))return null;}
   else if(instructions.length)return null;
  }else if(manifest.kind==='explicit_instruction'){
   if(manifest.receipt_ref||manifest.receipt_hash)return null;
   const parent=verifyPreferencePointer(store,input.parent_pointer,seen);
   if(!parent||manifest.parent_version!==parent.preference_version||row.parent_version!==parent.preference_version)return null;
   sourceEvent(store,input);
   instructions=applyOperation(parent.explicit_instructions,input.operation);
   if(!equal(output,{...parent.output,explicit_instructions:instructions})||row.supporting_content_ids_json!==parent.row.supporting_content_ids_json||row.confidence!==parent.row.confidence)return null;
  }else{
   if(manifest.kind&&manifest.kind!=='model')return null;
   if(!manifest.receipt_ref||sha(readFileSync(manifest.receipt_ref))!==manifest.receipt_hash)return null;
   const receipt=read(manifest.receipt_ref);
   if(!verifyCompletion(receipt)||receipt.kind!=='preference'||receipt.input_hash!==pointer.input_hash||receipt.output_ref!==manifest.output_ref||receipt.output_hash!==manifest.output_hash||sha(readFileSync(receipt.input_ref))!==receipt.input_file_hash)return null;
   const receiptInput=read(receipt.input_ref);
   if(receiptInput.input_hash!==pointer.input_hash||digest(Object.fromEntries(Object.entries(receiptInput).filter(([key])=>key!=='input_hash')))!==pointer.input_hash)return null;
   instructions=input.explicit_instructions??[];
  }
  if(!Array.isArray(instructions)||!equal(instructions,JSON.parse(row.explicit_instructions_json)))return null;
  return {preference_version:row.preference_version,explicit_instructions:instructions,hypotheses:JSON.parse(row.hypotheses_json),counterexamples:JSON.parse(row.counterexamples_json),row,manifest,output,pointer};
 }catch{return null;}
}

// 外部接受记录是来源声明，不能变成 CLI completion receipt。
function externalBodyOutput(store,input){
 const sources={};
 for(const key of ['profile','ledger','acceptance']){
  const ref=input[key];if(!ref||sha(readFileSync(ref.ref))!==ref.hash)throw Error('external source hash mismatch');
  sources[key]=key==='ledger'?readFileSync(ref.ref,'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x)):read(ref.ref);
 }
 const {profile,ledger,acceptance}=sources;
 if(acceptance.kind!=='human_acceptance'||acceptance.accepted!==true||acceptance.profile_hash!==input.profile.hash||acceptance.ledger_hash!==input.ledger.hash||!['text','recorded_at','chat_ref'].every(k=>typeof acceptance.source?.[k]==='string'&&acceptance.source[k].trim())||!['interface','model','observed'].every(k=>typeof acceptance.model_source?.[k]==='string'&&acceptance.model_source[k].trim()))throw Error('external human acceptance invalid');
 if(profile.scope?.images_seen!==0||!Array.isArray(profile.findings)||!profile.findings.length||!Array.isArray(profile.limitations)||!profile.limitations.length||profile.limitations.some(x=>typeof x!=='string'||!x.trim())||profile.scope.processed!==undefined&&profile.scope.processed!==ledger.length)throw Error('external profile scope invalid');
 const bodies=new Map(),ids=new Set();
 for(const material of input.materials){
  const row=store.db.prepare('SELECT m.*,c.source_content_id FROM material_version m JOIN content c USING(content_id) WHERE material_version_id=?').get(material.material_version_id);
  if(!row||row.fetch_status!=='succeeded'||row.content_id!==material.content_id||row.source_content_id!==material.note_id||row.body_hash!==material.body_hash||sha(readFileSync(row.body_ref))!==material.body_hash||bodies.has(material.note_id))throw Error('external body binding invalid');
  const raw=readFileSync(row.body_ref,'utf8');let body=raw,title='';try{const parsed=JSON.parse(raw);if(typeof parsed.description==='string'){body=parsed.description;title=typeof parsed.title==='string'?parsed.title:'';}}catch{}
  bodies.set(material.note_id,{body,title});
 }
 if(bodies.size!==ledger.length)throw Error('external ledger coverage mismatch');
 const matches=(id,quote,location)=>['正文','标题'].includes(location)&&bodies.get(id)?.[location==='标题'?'title':'body'].includes(quote);
 for(const item of ledger){
  if(ids.has(item.note_id)||!bodies.has(item.note_id)||item.long_term!==false||item.image_seen!==false||typeof item['原文短证据']!=='string'||item['原文短证据']&&!matches(item.note_id,item['原文短证据'],item['证据位置']))throw Error('external ledger evidence invalid');
  ids.add(item.note_id);
 }
 const hypotheses=profile.findings.map(f=>{
  if(typeof f.theme!=='string'||!f.theme.trim()||typeof f.interpretation!=='string'||!f.interpretation.trim()||f.long_term!==false||!['高','中','低'].includes(f.confidence)||!Array.isArray(f.evidence)||!f.evidence.length)throw Error('external finding invalid');
  for(const e of f.evidence)if(!ids.has(e.note_id)||!ledger.find(x=>x.note_id===e.note_id)['原文短证据']||typeof e.quote!=='string'||!e.quote.trim()||!matches(e.note_id,e.quote,e.location))throw Error('external profile evidence invalid');
  return {topic:f.theme,claim:f.interpretation,supporting_analysis_ids:[...new Set(f.evidence.map(e=>`external-body:${e.note_id}`))],confidence:{高:'high',中:'medium',低:'low'}[f.confidence],alternatives:['收藏不等于喜欢、阅读、理解或认同；可能用于资料留存。'],long_term:false};
 });
 return {hypotheses,counterexamples:[],limitations:[...profile.limitations,'外部用户接受的正文阶段；未验证图片、全量覆盖或长期兴趣；来源模型名称为记录陈述。'],explicit_instructions:input.explicit_instructions};
}

export function prepareExternalBodyPreference({store,root,owner,profileRef,ledgerRef,acceptanceRef,materials,now=()=>new Date().toISOString()}){
 const parentPointer=currentPreferencePointer(store,owner),parent=parentPointer?verifyPreferencePointer(store,parentPointer):null;
 if(parentPointer&&!parent)throw Error('verified preference parent unavailable');
 const ref=path=>({ref:path,hash:sha(readFileSync(path))});
 const input={profile:ref(profileRef),ledger:ref(ledgerRef),acceptance:ref(acceptanceRef),parent_pointer:parentPointer,explicit_instructions:parent?.explicit_instructions??[],materials:Object.entries(materials).map(([note_id,id])=>{
  const row=store.db.prepare('SELECT content_id,body_hash FROM material_version WHERE material_version_id=?').get(id);
  if(!row)throw Error('external material missing');return {note_id,material_version_id:id,content_id:row.content_id,body_hash:row.body_hash};
 })};
 const output=externalBodyOutput(store,input),version=`P-external-${randomUUID()}`,created=now(),folder=join(root,'preferences');mkdirSync(folder,{recursive:true});
 const outputRef=join(folder,`${version}.output.json`),manifestRef=join(folder,`${version}.json`),inputHash=digest(input);
 writeFileSync(outputRef,JSON.stringify(output)+'\n',{flag:'wx'});
 const manifest={kind:'external_accepted_body_profile',preference_version:version,created_at:created,input,input_hash:inputHash,output_ref:outputRef,output_hash:sha(readFileSync(outputRef))};
 writeFileSync(manifestRef,JSON.stringify(manifest)+'\n',{flag:'wx'});
 const pointer={preference_version:version,input_hash:inputHash,manifest_ref:manifestRef,manifest_hash:sha(readFileSync(manifestRef))};
 return {preference_version:version,pointer,publish(){return store.transaction(()=>{
  if(!equal(currentPreferencePointer(store,owner),parentPointer)||parentPointer&&!verifyPreferencePointer(store,parentPointer))throw Error('preference parent changed or damaged');
  if(!equal(externalBodyOutput(store,input),output)||sha(readFileSync(manifestRef))!==pointer.manifest_hash||sha(readFileSync(outputRef))!==manifest.output_hash)throw Error('prepared external artifact damaged');
  store.db.prepare('INSERT INTO preference_version(preference_version,explicit_instructions_json,supporting_content_ids_json,hypotheses_json,confidence,counterexamples_json,created_at) VALUES(?,?,?,?,?,?,?)').run(version,JSON.stringify(input.explicit_instructions),JSON.stringify(input.materials.map(x=>x.content_id)),JSON.stringify(output.hypotheses),null,'[]',created);
  store.db.prepare('INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,0,?,?,?,?,?)').run(randomUUID(),owner,`external:${version}`,`preference-current:${owner}`,JSON.stringify([pointer]),inputHash,pointer.manifest_hash,created);
  return {status:'succeeded',preference_version:version};
 });}};
}

export function readVerifiedPreference(store,owner){
 try{return verifyPreferencePointer(store,currentPreferencePointer(store,owner));}catch{return null;}
}

export function prepareExplicitPreference({store,root,owner,event,operation,now=()=>new Date().toISOString()}){
 const parent=readVerifiedPreference(store,owner);
 if(!parent)throw Error('verified preference parent unavailable');
 const instructions=applyOperation(parent.explicit_instructions,operation);
 if(event?.text!==operationText(operation))throw Error('explicit source event text mismatch');
 const version=`P-explicit-${randomUUID()}`,created=now(),input={parent_pointer:parent.pointer,source_event:{app_ref:event.app_ref,chat_ref:event.chat_ref,event_id:event.event_id,created_at:event.created_at,text:event.text},operation};
 const folder=join(root,'preferences');mkdirSync(folder,{recursive:true});
 const output={...parent.output,explicit_instructions:instructions},outputRef=join(folder,`${version}.output.json`),manifestRef=join(folder,`${version}.json`);
 writeFileSync(outputRef,JSON.stringify(output)+'\n',{flag:'wx'});
 const inputHash=digest(input),manifest={kind:'explicit_instruction',preference_version:version,parent_version:parent.preference_version,created_at:created,input,input_hash:inputHash,output_ref:outputRef,output_hash:sha(readFileSync(outputRef))};
 writeFileSync(manifestRef,JSON.stringify(manifest)+'\n',{flag:'wx'});
 const pointer={preference_version:version,input_hash:inputHash,manifest_ref:manifestRef,manifest_hash:sha(readFileSync(manifestRef))};
 return {preference_version:version,publish(){
  return store.transaction(()=>{
   if(!equal(currentPreferencePointer(store,owner),parent.pointer)||!verifyPreferencePointer(store,parent.pointer))throw Error('preference parent changed or damaged');
   sourceEvent(store,input);
   if(sha(readFileSync(manifestRef))!==pointer.manifest_hash||sha(readFileSync(outputRef))!==manifest.output_hash)throw Error('prepared preference artifact damaged');
   store.db.prepare('INSERT INTO preference_version(preference_version,parent_version,explicit_instructions_json,supporting_content_ids_json,hypotheses_json,confidence,counterexamples_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(version,parent.preference_version,JSON.stringify(instructions),parent.row.supporting_content_ids_json,parent.row.hypotheses_json,parent.row.confidence,parent.row.counterexamples_json,created);
   store.db.prepare('INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,input_hash,output_hash,committed_at) VALUES(?,?,?,0,?,?,?,?,?)').run(randomUUID(),owner,`explicit:${event.event_id}`,`preference-current:${owner}`,JSON.stringify([pointer]),inputHash,pointer.manifest_hash,created);
   return {status:'succeeded',preference_version:version};
  });
 }};
}
