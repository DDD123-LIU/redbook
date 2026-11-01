// 2026-10-24 Codex：人工指令沿用已验证模型父版，不调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/storage.mjs';
import { readVerifiedPreference, prepareExplicitPreference } from '../src/preference.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),digest=x=>sha(JSON.stringify(x));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'pref012-')),store=openStore(join(root,'state.sqlite')),owner='owner';t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const input={explicit_instructions:['原指令'],analyses:[]},inputHash=digest(input),inputRef=join(root,'input.json');
 writeFileSync(inputRef,JSON.stringify({...input,input_hash:inputHash}));
 const output={hypotheses:[{topic:'合成关注'}],counterexamples:[]},outputRef=join(root,'output.json');writeFileSync(outputRef,JSON.stringify(output));
 const receipt={exitCode:0,stdout:'{"type":"turn.completed"}',kind:'preference',input_hash:inputHash,input_ref:inputRef,input_file_hash:sha(readFileSync(inputRef)),output_ref:outputRef,output_hash:sha(readFileSync(outputRef))},receiptRef=join(root,'receipt.json');writeFileSync(receiptRef,JSON.stringify(receipt));
 const id=randomUUID(),manifest={preference_version:id,input,input_hash:inputHash,output_ref:outputRef,output_hash:receipt.output_hash,receipt_ref:receiptRef,receipt_hash:sha(readFileSync(receiptRef))},manifestRef=join(root,'manifest.json');writeFileSync(manifestRef,JSON.stringify(manifest));
 store.db.prepare('INSERT INTO preference_version(preference_version,explicit_instructions_json,hypotheses_json,counterexamples_json,created_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(input.explicit_instructions),JSON.stringify(output.hypotheses),'[]','2026-10-24T00:00:00Z');
 const pointer={preference_version:id,input_hash:inputHash,manifest_ref:manifestRef,manifest_hash:sha(readFileSync(manifestRef))};
 store.db.prepare('INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,committed_at) VALUES(?,?,?,0,?,?,?)').run(randomUUID(),owner,'synthetic',`preference-current:${owner}`,JSON.stringify([pointer]),'2026-10-24T00:00:00Z');
 const event=()=>({app_ref:'app',chat_ref:'chat',event_id:randomUUID(),text:'修改偏好：少看营销',created_at:'2026-10-24T00:01:00Z',received_at:'2026-10-24T00:01:01Z'});
 const save=e=>store.db.prepare("INSERT INTO feedback_event(app_ref,chat_ref,event_id,received_at,saved_at,parse_state,association_state) VALUES(?,?,?,?,?,'parsed','unmatched')").run(e.app_ref,e.chat_ref,e.event_id,e.received_at,e.received_at);
 return {root,store,owner,event,save,id,receiptRef,manifestRef,output};
}
test('人工子版保留父推断并能从current严格读入，事件/版本同事务发布',t=>{
 const f=fixture(t),e=f.event(),p=prepareExplicitPreference({...f,event:e,operation:{kind:'append',instruction:'少看营销'}});
 assert.equal(readVerifiedPreference(f.store,f.owner).preference_version,f.id);
 f.store.transaction(()=>{f.save(e);p.publish();});
 const current=readVerifiedPreference(f.store,f.owner);assert.equal(current.preference_version,p.preference_version);assert.deepEqual(current.hypotheses,f.output.hypotheses);assert.deepEqual(current.explicit_instructions,['原指令','少看营销']);
 const manifest=JSON.parse(readFileSync(current.pointer.manifest_ref));assert.equal(manifest.kind,'explicit_instruction');assert.equal(manifest.receipt_ref,undefined);
 writeFileSync(f.receiptRef,'{}');assert.equal(readVerifiedPreference(f.store,f.owner),null);
});
test('并发准备只允许当前父版发布；失败整笔回滚，不留已处理事件',t=>{
 const f=fixture(t),a=f.event(),b=f.event(),one=prepareExplicitPreference({...f,event:a,operation:{kind:'append',instruction:'少看营销'}}),two=prepareExplicitPreference({...f,event:b,operation:{kind:'append',instruction:'少看营销'}});
 f.store.transaction(()=>{f.save(a);one.publish();});assert.throws(()=>f.store.transaction(()=>{f.save(b);two.publish();}),/parent/);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM feedback_event').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM preference_version').get().n,2);
});
test('没有已保存来源事件不能发布；显式删除/替换只动指定指令',t=>{
 const f=fixture(t),e=f.event(),p=prepareExplicitPreference({...f,event:e,operation:{kind:'append',instruction:'少看营销'}});assert.throws(()=>p.publish(),/event/);
 assert.throws(()=>prepareExplicitPreference({...f,event:{...e,text:'删除偏好：不存在'},operation:{kind:'remove',instruction:'不存在'}}),/instruction/);
 const r={...e,text:'替换偏好：原指令 => 新指令'},q=prepareExplicitPreference({...f,event:r,operation:{kind:'replace',old_instruction:'原指令',instruction:'新指令'}});f.store.transaction(()=>{f.save(r);q.publish();});assert.deepEqual(readVerifiedPreference(f.store,f.owner).explicit_instructions,['新指令']);
});
