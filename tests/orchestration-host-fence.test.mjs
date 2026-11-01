import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runTask013Host } from '../src/orchestration-host.mjs';
import { openStore } from '../src/storage.mjs';

async function fixture(t, { productionEnabled, includeFlag = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'task013-host-fence-'));
  const configPath = join(root, 'host.json');
  const dbPath = join(root, 'state.sqlite');
  const config = {
    dbPath,
    root: join(root, 'artifacts'),
    owner: 'task013-host-fence-test-owner',
    appRef: 'task013-test-app',
    targetRef: 'task013-test-target',
    taskSpaceId: 20,
    pageLabel: 'p2',
  };
  if (includeFlag) config.productionEnabled = productionEnabled;
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = { label: 'p2', async url() { return 'https://www.xiaohongshu.com/explore'; } };
  const task = { spaceId: 20, ownership: 'agent', async pages() { return [page]; } };
  return { root, configPath, config, dbPath, taskSpace: async id => id === 20 ? task : null };
}

function snapshot(root) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name);
    return [name, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null];
  });
}

async function captureCall(options) {
  try { return { result: await runTask013Host(options), error: null }; }
  catch (error) { return { result: null, error }; }
}

test('productionEnabled=false daily在创建DB前拒绝', async t => {
  const f = await fixture(t, { productionEnabled: false });
  let taskSpaceCalls = 0;
  const call = await captureCall({ configPath: f.configPath, source: 'periodic',
    taskSpace: async id => { taskSpaceCalls += 1; return f.taskSpace(id); } });
  assert.equal(existsSync(f.dbPath), false);
  assert.match(call.error?.message ?? '', /production is disabled/i);
  assert.equal(taskSpaceCalls, 0);
});

test('productionEnabled=false recover在创建DB前拒绝', async t => {
  const f = await fixture(t, { productionEnabled: false });
  const call = await captureCall({ configPath: f.configPath, source: 'manual_daily', operation: 'recover',
    invocation: { explicitRequest: true, confirmedStoppedRunId: 'stopped-run', evidenceRef: 'stop-proof' } });
  assert.equal(existsSync(f.dbPath), false);
  assert.match(call.error?.message ?? '', /production is disabled/i);
});

test('productionEnabled=false不改写既存隔离DB或目录', async t => {
  const f = await fixture(t, { productionEnabled: false });
  const store = openStore(f.dbPath);
  store.close();
  const legacy = new DatabaseSync(f.dbPath);
  legacy.exec("DROP INDEX analysis_complete_lookup_idx; CREATE UNIQUE INDEX analysis_success_input_uq ON analysis(material_version_id,input_hash,prompt_version) WHERE status='complete'; PRAGMA user_version=2;");
  legacy.close();
  const before = snapshot(f.root);
  const call = await captureCall({ configPath: f.configPath, source: 'manual_daily', operation: 'recover',
    invocation: { explicitRequest: true, confirmedStoppedRunId: 'stopped-run', evidenceRef: 'stop-proof' } });
  assert.deepEqual(snapshot(f.root), before);
  assert.match(call.error?.message ?? '', /production is disabled/i);
});

test('productionEnabled若存在必须是布尔值', async t => {
  for (const invalid of [null, 'false', 0]) {
    await t.test(String(invalid), async st => {
      const f = await fixture(st, { productionEnabled: invalid });
      const call = await captureCall({ configPath: f.configPath, source: 'periodic' });
      assert.equal(existsSync(f.dbPath), false);
      assert.match(call.error?.message ?? '', /productionEnabled must be a boolean/i);
    });
  }
});

test('recover授权形状在创建DB前校验', async t => {
  const cases = [
    { name: 'non-manual source', source: 'recovery_startup', invocation: { explicitRequest: true, confirmedStoppedRunId: 'r', evidenceRef: 'e' }, expected: /manual_daily authorization/i },
    { name: 'missing explicit request', source: 'manual_daily', invocation: { confirmedStoppedRunId: 'r', evidenceRef: 'e' }, expected: /manual_daily authorization/i },
    { name: 'missing stopped run id', source: 'manual_daily', invocation: { explicitRequest: true, evidenceRef: 'e' }, expected: /confirmedStoppedRunId and evidenceRef are required/i },
    { name: 'missing evidence reference', source: 'manual_daily', invocation: { explicitRequest: true, confirmedStoppedRunId: 'r' }, expected: /confirmedStoppedRunId and evidenceRef are required/i },
  ];
  for (const item of cases) {
    await t.test(item.name, async st => {
      const f = await fixture(st, { includeFlag: false });
      const call = await captureCall({ configPath: f.configPath, source: item.source, operation: 'recover', invocation: item.invocation });
      assert.equal(existsSync(f.dbPath), false);
      assert.match(call.error?.message ?? '', item.expected);
    });
  }
});

test('缺productionEnabled字段和显式true保留隔离每日入口', async t => {
  for (const settings of [{ includeFlag: false }, { productionEnabled: true }]) {
    await t.test(settings.includeFlag === false ? 'legacy field omitted' : 'explicit true', async st => {
      const f = await fixture(st, settings);
      const result = await runTask013Host({ configPath: f.configPath, source: 'scheduled', taskSpace: f.taskSpace,
        now: () => '2026-10-24T04:00:00.000Z' });
      assert.equal(result.status, 'blocked');
      assert.match(result.reason, /runtime capabilities/i);
      assert.equal(existsSync(f.dbPath), true);
    });
  }
});
