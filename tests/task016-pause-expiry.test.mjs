// 2026-10-31 Codex：假时间验证当日暂停，不调用业务或真实额度。
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import * as quota from '../.codex/task016-live-quota.mjs';
import {persistQuotaPause} from '../.codex/task016-auto-worker.mjs';
test('上海午夜到期，旧版只有at的暂停也不跨日',t=>{
 const root=mkdtempSync(join(tmpdir(),'pause-day-')),pauseRef=join(root,'task016-quota-paused.json');t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.equal(typeof quota.getActiveQuotaPause,'function');
 writeFileSync(pauseRef,JSON.stringify({at:'2026-10-31T15:59:59Z',reason:'quota',command:'old'}));
 assert.ok(quota.getActiveQuotaPause({pauseRef,now:new Date('2026-10-31T15:59:59.999Z')}));
 assert.equal(quota.getActiveQuotaPause({pauseRef,now:new Date('2026-10-31T16:00:00Z')}),null);
});
test('新暂停有当天24点到期时间，隔日新故障可保存新暂停并归档旧证据',t=>{
 const root=mkdtempSync(join(tmpdir(),'pause-new-')),handoff=join(root,'handoff.md'),pauseRef=join(root,'task016-quota-paused.json');t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(handoff,'handoff');
 persistQuotaPause({root,handoff,reason:'first',command:'old',now:new Date('2026-10-31T12:00:00Z')});
 assert.equal(JSON.parse(readFileSync(pauseRef)).expires_at,'2026-10-31T16:00:00.000Z');
 persistQuotaPause({root,handoff,reason:'second',command:'new',now:new Date('2026-10-31T16:01:00Z')});
 assert.equal(JSON.parse(readFileSync(pauseRef)).command,'new');assert.ok(readdirSync(root).some(p=>p.includes('expired')));
});
