import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createQuality, readCurrentStrategy } from '../src/quality.mjs';
import { deliveryFixture } from './helpers/delivery-fixture.mjs';

const qualityUrl = pathToFileURL(resolve('src/quality.mjs')).href;
const storageUrl = pathToFileURL(resolve('src/storage.mjs')).href;

function rules(value) {
  return { criteria: [{ category: 'follow', threshold: value }] };
}

function activationInput(f, strategyVersion, parentVersion, ruleSet) {
  return {
    strategy_version: strategyVersion,
    parent_version: parentVersion,
    rules: ruleSet,
    rule_diff: { change: strategyVersion },
    evidence_refs: [`synthetic:${strategyVersion}`],
    preference_version: f.versions.preference_version,
    incident_bindings: [],
  };
}

function strategyCount(store, owner) {
  return store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:strategy:event:%'")
    .get(owner).n;
}

function childProgram() {
  return `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { openStore } from ${JSON.stringify(storageUrl)};
    import { createQuality, readCurrentStrategy } from ${JSON.stringify(qualityUrl)};
    const [dbPath, owner, parentVersion, strategyVersion, preferenceVersion, readyPath, goPath] = process.argv.slice(1);
    const store = openStore(dbPath);
    try {
      const current = readCurrentStrategy(store, owner, '2026-10-26T04:00:00.000Z');
      if (current.strategy_version !== parentVersion) throw new Error('unexpected parent before barrier');
      writeFileSync(readyPath, 'ready');
      const deadline = Date.now() + 10000;
      while (!existsSync(goPath)) {
        if (Date.now() > deadline) throw new Error('activation barrier timed out');
        await delay(5);
      }
      const quality = createQuality({ store, owner, now: () => '2026-10-26T04:00:00.000Z' });
      const result = quality.activateStrategy({ strategy_version: strategyVersion, parent_version: parentVersion,
        rules: { criteria: [{ category: 'follow', threshold: strategyVersion }] },
        rule_diff: { change: strategyVersion }, evidence_refs: ['synthetic:' + strategyVersion],
        preference_version: preferenceVersion, incident_bindings: [] });
      console.log(JSON.stringify({ status: result.status, strategy_version: result.strategy.strategy_version }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.code ?? error.message }));
    } finally { store.close(); }
  `;
}

function startChild(f, strategyVersion, readyPath, goPath) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram(), f.dbPath, f.owner,
    f.versions.strategy_version, strategyVersion, f.versions.preference_version, readyPath, goPath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', code => code === 0 ? resolveClose(stdout.trim())
      : rejectClose(new Error(`strategy child exited ${code}: ${stderr}\n${stdout}`)));
  });
  return { child, closed, output: () => stdout };
}

async function waitForReady(path, children) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (children.some(child => child.exitCode !== null)) throw new Error('strategy child exited before barrier');
    if (Date.now() > deadline) throw new Error('timed out waiting for strategy child');
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function rewriteLedgerPayload(store, row, payload) {
  const payloadHash = hash(payload);
  store.db.prepare(`UPDATE checkpoint SET succeeded_refs_json=?,input_hash=?,output_hash=? WHERE checkpoint_id=?`)
    .run(JSON.stringify([{ payload, hash: payloadHash }]), payloadHash, payloadHash, row.checkpoint_id);
}

test('两个独立进程以同一策略父版本并发激活时仅一个提交且不留孤儿', async t => {
  const f = await deliveryFixture(t);
  const readyA = join(f.root, 'strategy-a.ready');
  const readyB = join(f.root, 'strategy-b.ready');
  const goPath = join(f.root, 'strategy.go');
  const first = startChild(f, `strategy-${randomUUID()}`, readyA, goPath);
  const second = startChild(f, `strategy-${randomUUID()}`, readyB, goPath);
  t.after(() => {
    if (first.child.exitCode === null) first.child.kill();
    if (second.child.exitCode === null) second.child.kill();
  });
  await Promise.all([waitForReady(readyA, [first.child]), waitForReady(readyB, [second.child])]);
  writeFileSync(goPath, 'go');
  const results = [JSON.parse(await first.closed), JSON.parse(await second.closed)];
  assert.equal(results.filter(result => result.status === 'succeeded').length, 1);
  assert.equal(results.filter(result => result.error === 'quality_strategy_parent_mismatch').length, 1);
  assert.equal(strategyCount(f.store, f.owner), 1);
  const versions = f.store.db.prepare('SELECT strategy_version,parent_version FROM strategy_version WHERE parent_version=?')
    .all(f.versions.strategy_version);
  assert.equal(versions.length, 1);
  assert.equal(readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z').strategy_version,
    versions[0].strategy_version);
});

test('错父、同规则与重复策略键拒绝时不推进策略事件序号', async t => {
  const f = await deliveryFixture(t);
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => '2026-10-26T04:00:00.000Z' });
  const firstVersion = `strategy-${randomUUID()}`;
  quality.activateStrategy(activationInput(f, firstVersion, f.versions.strategy_version, rules('first')));
  const currentRules = readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z').rules;
  const countBefore = strategyCount(f.store, f.owner);
  assert.throws(() => quality.activateStrategy(activationInput(f, `strategy-${randomUUID()}`, f.versions.strategy_version, rules('wrong-parent'))),
    error => error.code === 'quality_strategy_parent_mismatch');
  assert.throws(() => quality.activateStrategy(activationInput(f, `strategy-${randomUUID()}`, firstVersion, currentRules)),
    error => error.code === 'quality_strategy_no_change');
  assert.throws(() => quality.activateStrategy(activationInput(f, firstVersion, firstVersion, rules('different'))),
    error => error.code === 'quality_strategy_id_conflict');
  assert.equal(strategyCount(f.store, f.owner), countBefore);
  assert.equal(readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z').strategy_version, firstVersion);
});

test('策略ledger拒绝checkpoint主键映射和payload hash篡改', async t => {
  const f = await deliveryFixture(t);
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => '2026-10-26T04:00:00.000Z' });
  const version = `strategy-${randomUUID()}`;
  quality.activateStrategy(activationInput(f, version, f.versions.strategy_version, rules('tamper')));
  const row = f.store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:strategy:event:%'")
    .get(f.owner);
  const event = JSON.parse(row.succeeded_refs_json)[0];
  assert.throws(() => {
    f.store.db.prepare('UPDATE checkpoint SET checkpoint_id=? WHERE checkpoint_id=?').run(randomUUID(), row.checkpoint_id);
    readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z');
  }, error => error.code === 'quality_checkpoint_corrupt' || error.code === 'quality_strategy_ledger_corrupt');
  const wrongId = f.store.db.prepare("SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:strategy:event:%'")
    .get(f.owner).checkpoint_id;
  f.store.db.prepare('UPDATE checkpoint SET checkpoint_id=? WHERE checkpoint_id=?').run(row.checkpoint_id, wrongId);
  // 还原确定键行，再只改payload，保留原hash和输入输出hash。
  const latest = f.store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:strategy:event:%'")
    .get(f.owner);
  event.payload.rules_hash = 'tampered';
  f.store.db.prepare('UPDATE checkpoint SET succeeded_refs_json=? WHERE checkpoint_id=?')
    .run(JSON.stringify([event]), latest.checkpoint_id);
  assert.throws(() => readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z'),
    error => error.code === 'quality_checkpoint_corrupt');
});

test('策略ledger拒绝重新签名的错误父hash', async t => {
  const f = await deliveryFixture(t);
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => '2026-10-26T04:00:00.000Z' });
  const version = `strategy-${randomUUID()}`;
  quality.activateStrategy(activationInput(f, version, f.versions.strategy_version, rules('parent')));
  const row = f.store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage LIKE 'quality:%:strategy:event:%'")
    .get(f.owner);
  const envelope = JSON.parse(row.succeeded_refs_json)[0];
  envelope.payload.parent_hash = 'incorrect-parent';
  rewriteLedgerPayload(f.store, row, envelope.payload);
  assert.throws(() => readCurrentStrategy(f.store, f.owner, '2026-10-27T04:00:00.000Z'),
    error => error.code === 'quality_strategy_parent_hash_mismatch');
});

test('上海七日monitor窗口与Sunday周审记录支持幂等重入', async t => {
  const f = await deliveryFixture(t);
  const sunday = '2026-10-25T04:00:00.000Z';
  const quality = createQuality({ store: f.store, owner: f.owner, now: () => '2026-10-26T04:00:00.000Z' });
  const sampleId = `monitor-${randomUUID()}`;
  quality.registerMonitorSample({ sample_id: sampleId, category: 'follow', as_of: sunday });
  const declaration = JSON.parse(f.store.db.prepare("SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=?")
    .get(f.owner, `quality:${f.owner}:sample:${sampleId}:declared`).succeeded_refs_json)[0].payload;
  assert.equal(declaration.included_from, '2026-10-18T16:00:00.000Z');
  assert.equal(declaration.included_until, sunday);
  const first = quality.recordWeeklyReview({ as_of: sunday, event_revision: 0 });
  const second = quality.recordWeeklyReview({ as_of: sunday, event_revision: 0 });
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.checkpoint_id, first.checkpoint_id);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM checkpoint WHERE owner=? AND stage=?")
    .get(f.owner, `quality:${f.owner}:weekly-review:2026-10-25`).n, 1);
});
