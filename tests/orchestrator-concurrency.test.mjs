import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openStore } from '../src/storage.mjs';

const now = '2026-10-24T04:00:00.000Z';
const storageUrl = pathToFileURL(resolve('src/storage.mjs')).href;
const orchestratorUrl = pathToFileURL(resolve('src/orchestrator.mjs')).href;

function childProgram() {
  return `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { join } from 'node:path';
    import { openStore } from ${JSON.stringify(storageUrl)};
    import { createOrchestrator } from ${JSON.stringify(orchestratorUrl)};

    const [dbPath, root, owner, latchPath, releasePath, unexpectedPath, blockAtReload] = process.argv.slice(1);
    const timestamp = ${JSON.stringify(now)};
    const forbidden = name => { appendFileSync(unexpectedPath, name + '\\n'); throw new Error('external capability unexpectedly invoked: ' + name); };
    const store = openStore(dbPath);
    const runtime = {
      collection: { cli: async () => forbidden('collection-cli') },
      analysis: { model: async () => forbidden('analysis-model') },
      candidates: { model: async () => forbidden('selection-model') },
      display: { uploadImage: async () => forbidden('display-upload') },
      delivery: { transport: { send: async () => forbidden('delivery-send'), lookup: async () => forbidden('delivery-lookup') } },
      homefeed: { options: { maxPages: 1 } },
    };
    const orchestrator = createOrchestrator({ store, root, owner, appRef: 'synthetic-app', targetRef: 'synthetic-target', runtime, now: () => timestamp });
    const tab = { page: {
      async reload() {
        if (blockAtReload !== 'yes') return;
        writeFileSync(latchPath, 'reload-started');
        while (!existsSync(releasePath)) await delay(10);
      },
      async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', observed_at: timestamp,
        page_state: 'ready', observations: [], anchor_id: null, advanced: false, read_method: 'synthetic-concurrency-test' }; },
      async press() { throw new Error('unexpected pagination for empty one-page fixture'); },
    } };
    try {
      const result = await orchestrator.ensureDailyBatch({ tab });
      console.log(JSON.stringify({ outcome: 'returned', result }));
    } catch (error) {
      console.log(JSON.stringify({ outcome: 'threw', error: String(error?.message ?? error) }));
    } finally { store.close(); }
  `;
}

function startChild({ dbPath, root, owner, latchPath, releasePath, unexpectedPath, blockAtReload = 'no' }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram(), dbPath, root, owner,
    latchPath, releasePath, unexpectedPath, blockAtReload], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', code => code === 0 ? resolveClose({ stdout: stdout.trim(), stderr })
      : rejectClose(new Error(`child exited ${code}: ${stderr}\n${stdout}`)));
  });
  return { child, closed, output: () => stdout };
}

async function waitForFile(path, child, readOutput, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (child.exitCode !== null) throw new Error(`child exited before reload latch: ${readOutput()}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for reload latch: ${readOutput()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task013-orchestrator-race-'));
  const privateRoot = join(root, 'private');
  mkdirSync(privateRoot, { recursive: true });
  const dbPath = join(root, 'state.sqlite');
  const store = openStore(dbPath);
  store.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, privateRoot, dbPath, owner: 'task013-race-owner', latchPath: join(root, 'reload.ready'),
    releasePath: join(root, 'reload.release'), unexpectedPath: join(root, 'unexpected-capability.txt') };
}

test('two Node processes serialize first daily admission and release the stage slot at exit', async t => {
  const f = await fixture(t);
  const first = startChild({ ...f, root: f.privateRoot, blockAtReload: 'yes' });
  t.after(() => { if (first.child.exitCode === null) first.child.kill(); });

  try {
    await waitForFile(f.latchPath, first.child, first.output);
    const during = openStore(f.dbPath);
    const firstBatch = during.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-24'").get(f.owner);
    const firstHead = during.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
    const firstSlot = during.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    assert.ok(firstBatch);
    assert.ok(firstHead);
    assert.equal(firstHead.delivery_batch_id, firstBatch.delivery_batch_id);
    assert.deepEqual(JSON.parse(firstHead.pending_ids_json), [firstHead.run_id]);
    assert.equal(firstSlot.owner, f.owner);
    assert.equal(firstSlot.batch_id, firstBatch.delivery_batch_id);
    assert.ok(firstSlot.run_id);

    const second = startChild({ ...f, root: f.privateRoot });
    t.after(() => { if (second.child.exitCode === null) second.child.kill(); });
    const secondDone = await second.closed;
    const secondResult = JSON.parse(secondDone.stdout.split(/\r?\n/).at(-1));
    assert.equal(secondResult.outcome, 'returned');
    assert.ok(['busy', 'recovery_required'].includes(secondResult.result.status), JSON.stringify(secondResult.result));

    const afterSecond = during.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    assert.equal(afterSecond.run_id, firstSlot.run_id);
    assert.equal(afterSecond.generation, firstSlot.generation);
    assert.equal(afterSecond.revision, firstSlot.revision);
    assert.equal(during.db.prepare("SELECT count(*) AS n FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-24'").get(f.owner).n, 1);
    assert.equal(during.db.prepare("SELECT count(DISTINCT run_id) AS n FROM checkpoint WHERE stage='orchestration:main'").get().n, 1);
    during.close();

    writeFileSync(f.releasePath, 'continue');
    const firstDone = await first.closed;
    const firstResult = JSON.parse(firstDone.stdout.split(/\r?\n/).at(-1));
    assert.equal(firstResult.outcome, 'returned');
    assert.equal(firstResult.result.batch_id, firstBatch.delivery_batch_id);
    assert.ok(!existsSync(f.unexpectedPath), 'no model, collection, upload, or delivery operation should run');
  } finally {
    writeFileSync(f.releasePath, 'continue');
  }

  const final = openStore(f.dbPath);
  assert.equal(final.db.prepare("SELECT count(*) AS n FROM batch WHERE owner=? AND kind='daily_follow' AND business_day='2026-10-24'").get(f.owner).n, 1);
  const head = final.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(head.owner, f.owner);
  assert.deepEqual(JSON.parse(head.pending_ids_json), []);
  const slot = final.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(slot.owner, null);
  assert.equal(slot.run_id, null);
  assert.equal(slot.batch_id, null);
  assert.ok(['idle', 'stopped'].includes(slot.state));
  assert.equal(final.db.prepare("SELECT count(DISTINCT run_id) AS n FROM checkpoint WHERE stage='orchestration:main'").get().n, 1);
  final.close();
});

test('failed admission CAS rolls back daily batch, coordinator head, and slot claim', async t => {
  const f = await fixture(t);
  const setup = openStore(f.dbPath);
  setup.db.exec(`CREATE TRIGGER reject_admission_slot BEFORE UPDATE ON execution_slot
    WHEN NEW.owner IS NOT NULL AND NEW.run_id LIKE 'admission:%'
    BEGIN SELECT RAISE(ABORT, 'injected admission slot failure'); END`);
  setup.close();

  const child = startChild({ ...f, root: f.privateRoot });
  const done = await child.closed;
  const result = JSON.parse(done.stdout.split(/\r?\n/).at(-1));
  assert.equal(result.outcome, 'threw');
  assert.match(result.error, /injected admission slot failure/i);

  const final = openStore(f.dbPath);
  assert.equal(final.db.prepare('SELECT count(*) AS n FROM batch').get().n, 0);
  assert.equal(final.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE stage='orchestration:main'").get().n, 0);
  const slot = final.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  assert.equal(slot.owner, null);
  assert.equal(slot.run_id, null);
  assert.equal(slot.batch_id, null);
  assert.ok(['idle', 'stopped'].includes(slot.state));
  final.close();
});
