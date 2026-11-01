import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../src/analysis.mjs';

test('正式CLI请求明确使用用户要求的中档推理，不依赖默认设置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redbook-medium-'));
  try {
    const result = await runCodex({ input: { model_requested: 'gpt-6.1-sol', input_hash: 'fixture' },
      kind: 'preference', attemptDir: root, outputPath: join(root, 'output.json'),
      eventsPath: join(root, 'events.jsonl'), stderrPath: join(root, 'stderr.txt'),
      executable: join(root, 'does-not-exist.exe') });
    assert.equal(result.spawnError, true);
    const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
    const overrides = request.args.flatMap((value, index) => value === '-c' ? [request.args[index + 1]] : []);
    assert.ok(overrides.includes('model_reasoning_effort="medium"'), '中档推理必须进入实际CLI参数');
    assert.equal(request.model_requested, 'gpt-6.1-sol');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
