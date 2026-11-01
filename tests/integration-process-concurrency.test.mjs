// 2026-10-26 Codex：父进程真实新候选整链与独立Node进程完整入口争用同一SQLite。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

test('I03 独立Node进程竞争正在执行的完整入口，保持同日单批槽且只有父链发送', { timeout: 20000 }, async t => {
  const f = await createDailyIntegrationFixture(t);
  const gate = f.pauseNextReload();
  const firstPromise = f.run();
  let first, competitor, head, slot;
  try {
    await gate.entered;
    const config = { db: f.dbPath, root: f.root, owner: f.owner };
    const source = `
      import {openStore} from ${JSON.stringify(pathToFileURL(resolve('src/storage.mjs')).href)};
      import {createOrchestrator} from ${JSON.stringify(pathToFileURL(resolve('src/orchestrator.mjs')).href)};
      const config=${JSON.stringify(config)},store=openStore(config.db);let calls=0;
      const forbidden=async()=>{calls++;throw Error('competing process must not start external work');};
      try {
        const runtime={collection:{cli:forbidden},analysis:{model:forbidden},candidates:{model:forbidden},display:{uploadImage:forbidden},delivery:{transport:{send:forbidden,lookup:forbidden}}};
        const result=await createOrchestrator({store,root:config.root,owner:config.owner,appRef:'synthetic-app',targetRef:'synthetic-target',runtime,now:()=> '2026-10-26T03:15:00.000Z'})
          .ensureDailyBatch({tab:{page:{reload:forbidden,evaluate:forbidden}}});
        console.log(JSON.stringify({result,external_calls:calls,pid:process.pid}));
      } finally {store.close();}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exit = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('competing child timeout')); }, 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolveExit(code); });
    });
    assert.equal(exit, 0, stderr);
    competitor = JSON.parse(stdout.trim());
    head = f.store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
    slot = f.store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  } finally {
    gate.release();
    first = await firstPromise;
  }
  assert.notEqual(competitor.pid, process.pid);
  assert.equal(competitor.result.status, 'recovery_required');
  assert.equal(competitor.result.batch_id, first.batch_id);
  assert.equal(competitor.result.run_id, head.run_id);
  assert.equal(JSON.parse(head.succeeded_refs_json)[0].orchestration.active, true);
  assert.equal(slot.state, 'running');
  assert.equal(slot.batch_id, first.batch_id);
  assert.equal(competitor.external_calls, 0);
  assert.equal(first.delivered, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM batch').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 1);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
  await f.writeEvidence({ scenario: 'I03-two-node-processes', parent_pid: process.pid, competitor,
    active_head: head, active_slot: slot, parent_result: first, calls: f.calls });
});
