import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCodex} from '../src/analysis.mjs';

test('筛选沿用官方CLI且使用显式契约；原分析默认不受影响', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'redbook-selection-cli-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const schema = {type:'object',properties:{state:{type:'string'}},required:['state'],additionalProperties:false};
  await runCodex({kind:'selection',input:{input_hash:'synthetic',model_requested:'gpt-6.1-sol'},
    schema,prompt:'合成筛选契约',payload:{candidate:'synthetic'},attemptDir:dir,
    outputPath:join(dir,'out.json'),eventsPath:join(dir,'events.jsonl'),stderrPath:join(dir,'stderr.txt'),executable:process.execPath});
  assert.deepEqual(JSON.parse(await readFile(join(dir,'schema.json'))),schema);
  const request = JSON.parse(await readFile(join(dir,'request.json')));
  assert.equal(request.prompt,'合成筛选契约\n'+JSON.stringify({candidate:'synthetic'}));
  assert(request.args.includes('--ignore-user-config'));
});
