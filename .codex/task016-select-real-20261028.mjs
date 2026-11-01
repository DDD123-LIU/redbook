// 2026-10-30 Codex：按已确认规则恢复原结果或持久限制的一次重试。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openStore} from '../src/storage.mjs';
import {createBodyTrialSelector} from '../src/candidates.mjs';
import {resolveCodexExecutable} from './task016-live-quota.mjs';
const root=resolve(process.env.TASK016_RUN_ROOT??'.codex/private/task016-trial-20261028'),batchName=process.argv[2]??'real',out=join(root,`selection-${batchName}.json`),startedRef=join(root,`selection-${batchName}-started.json`);
const recover=process.env.TASK016_SELECTION_RECOVER==='1';
if((existsSync(out)||existsSync(startedRef))&&!recover)throw Error('attempt already exists; inspect before recovery');
const state=JSON.parse(readFileSync(join(root,'homepage-bodies.json'),'utf8'));
if(state.stopped)throw Error('global access barrier');
const priorIds=batchName==='extra'?new Set(JSON.parse(readFileSync(join(root,'selection-started.json'),'utf8')).ids):new Set();
const candidates=state.items.filter(x=>x.status==='succeeded'&&x.body.trim()&&!priorIds.has(x.source_id));
const store=openStore(resolve('.codex/private/task013-production/state.sqlite'),{readonly:true});
try{
 const slot=store.db.prepare('SELECT * FROM execution_slot').get();if(!['idle','stopped'].includes(slot.state)||slot.run_id)throw Error('slot busy');
 const collectedIds=store.db.prepare("SELECT DISTINCT c.source_content_id FROM content c JOIN collection_observation o USING(content_id) WHERE o.membership='present'").all().map(x=>x.source_content_id);
 const deliveredIds=store.db.prepare('SELECT source_content_id FROM delivered_content WHERE owner=?').all('TASK012-synthetic').map(x=>x.source_content_id);
 const executable=resolveCodexExecutable();
 if(!existsSync(startedRef))writeFileSync(startedRef,JSON.stringify({at:new Date().toISOString(),pid:process.pid,count:candidates.length,ids:candidates.map(x=>x.source_id),executable}),{flag:'wx'});
 const selector=createBodyTrialSelector({store,root,owner:'TASK012-synthetic',executable,proxy:'http://127.0.0.1:7897'});
 const result=await selector.select({candidates,collectedIds,deliveredIds,recoveryKey:batchName,recover});
 if(existsSync(out)){if(JSON.stringify(JSON.parse(readFileSync(out,'utf8')))!==JSON.stringify(result))throw Error('saved selection differs from verified recovery');}else writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log({status:'verified',decisions:result.decisions.map(x=>({id:x.source_id,status:x.status})),scope:result.scope});
}catch(e){writeFileSync(join(root,`selection-${batchName}-failed-${Date.now()}.json`),JSON.stringify({at:new Date().toISOString(),message:e.message}),{flag:'wx'});throw e;}finally{store.close();}
