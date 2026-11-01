// 2026-10-26 Codex：真实完整入口在发送边界退出；只验证原尝试保留和未知结果阻断，不伪造继续许可。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openStore } from '../src/storage.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createDelivery } from '../src/delivery.mjs';

test('I12 新首页完整入口在实际派发后子进程退出，原intent只能核实且未知时不得重发', { timeout: 20000 }, async () => {
  const fixtureUrl = pathToFileURL(resolve('tests/helpers/integration-fixture.mjs')).href;
  const source = `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createDailyIntegrationFixture } from ${JSON.stringify(fixtureUrl)};
    const f = await createDailyIntegrationFixture({ after() {} });
    console.log('FIXTURE:' + JSON.stringify({root:f.root,db:f.dbPath,owner:f.owner,pid:process.pid}));
    for (const table of ['candidate','decision','recommendation','delivery_attempt']) {
      if (f.store.db.prepare('SELECT count(*) n FROM ' + table).get().n !== 0) throw Error('nonempty new-chain table');
    }
    f.setTransport({
      async send(request) {
        const attempt=f.store.db.prepare('SELECT * FROM delivery_attempt WHERE recommendation_id=?').get(request.uuid);
        writeFileSync(join(f.root,'crash-dispatch.json'), JSON.stringify({pid:process.pid,attempt_id:attempt.delivery_attempt_id,
          recommendation_id:request.uuid,payload_hash:attempt.payload_hash,dispatched_at:attempt.dispatched_at,request}));
        process.exit(73);
      }, async lookup() { throw Error('child must not query before crash'); }
    });
    await f.run();
    process.exit(74);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exit = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`child timeout: ${stderr}`)); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
  assert.equal(exit.code, 73, `${stdout}\n${stderr}`);
  const info = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('FIXTURE:')).slice(8));
  assert.throws(() => process.kill(info.pid, 0), { code: 'ESRCH' });
  const markerBytes = await readFile(join(info.root, 'crash-dispatch.json'));
  const marker = JSON.parse(markerBytes);
  const store = openStore(info.db);
  try {
    const attemptBefore = store.db.prepare('SELECT * FROM delivery_attempt').get();
    assert.equal(attemptBefore.status, 'intent');
    assert.equal(attemptBefore.delivery_attempt_id, marker.attempt_id);
    assert.ok(attemptBefore.dispatched_at);
    assert.equal(attemptBefore.payload_hash, marker.payload_hash);
    const head = () => store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
    const originalHead = head();
    assert.equal(JSON.parse(originalHead.succeeded_refs_json)[0].orchestration.active, true);
    const evidenceRef = join(info.root, 'parent-exit-proof.json');
    const now = () => '2026-10-26T03:16:00.000Z';
    await writeFile(evidenceRef, JSON.stringify({ child_exit_code: exit.code, process_id: info.pid,
      attempt_id: marker.attempt_id, observed_at: now(),
      marker_hash: createHash('sha256').update(markerBytes).digest('hex') }));
    const orchestrator = createOrchestrator({ store, root: info.root, owner: info.owner,
      appRef: 'synthetic-app', targetRef: 'synthetic-target', runtime: {}, now });
    const recovery = await orchestrator.recoverCoordinator({ confirmedStoppedRunId: originalHead.run_id, evidenceRef });
    assert.equal(recovery.status, 'recovery_required');
    assert.equal(recovery.reason, 'delivery_attempt_outcome_unconfirmed');
    let sendCalls = 0, lookupCalls = 0;
    const delivery = createDelivery({ store, root: join(info.root, 'delivery'), owner: info.owner,
      appRef: 'synthetic-app', targetRef: 'synthetic-target', now,
      transport: {
        async send() { sendCalls++; throw Error('crashed dispatch must never be resent'); },
        async lookup() { lookupCalls++; return { status: 'unknown', evidence: 'synthetic:crash-no-match' }; },
      } });
    const reconciled = await delivery.reconcileDelivery(marker.attempt_id);
    assert.equal(reconciled.status, 'unknown');
    const after = store.db.prepare('SELECT * FROM delivery_attempt').get();
    assert.equal(after.status, 'unknown');
    assert.equal(after.delivery_attempt_id, marker.attempt_id);
    assert.equal(after.dispatched_at, attemptBefore.dispatched_at);
    assert.equal(store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 1);
    assert.equal(store.db.prepare('SELECT state FROM recommendation').get().state, 'unknown');
    assert.equal(head().checkpoint_id, originalHead.checkpoint_id);
    assert.equal(sendCalls, 0);
    assert.ok(lookupCalls > 0);
    await writeFile(join(process.cwd(), '.codex', `task015-crash-evidence-${Date.now()}.json`), JSON.stringify({
      scenario: 'I12', synthetic_only: true, fixture_root: info.root, database_path: info.db,
      child_exit: exit, process_id: info.pid, batch_id: originalHead.delivery_batch_id, run_id: originalHead.run_id,
      attempt_id: marker.attempt_id, recommendation_id: marker.recommendation_id, payload_hash: marker.payload_hash,
      dispatched_at: after.dispatched_at, recovery, reconciled, send_calls: sendCalls, lookup_calls: lookupCalls,
      final_status: after.status, final_head_active: true, evidence_ref: evidenceRef,
    }, null, 2));
  } finally { store.close(); }
});
