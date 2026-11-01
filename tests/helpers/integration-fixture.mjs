import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createAnalyzer } from '../../src/analysis.mjs';
import { createOrchestrator } from '../../src/orchestrator.mjs';
import { openStore, saveContent, saveMaterialVersion } from '../../src/storage.mjs';

const timestamp = '2026-10-26T03:15:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const completion = { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };

function analysisOutput(input) {
  return { id: input.source_content_id, summary: '本地合成分析', images: [],
    direct_evidence: [{ source: 'body', index: null, quote: input.body }],
    inferences: [], actionable: ['按顺序核对输入'], uncertainties: ['本地合成样本'], media_scope: input.media_scope };
}

function selectionOutput(args) {
  const quote = args.payload.candidate_analysis.direct_evidence[0].quote;
  const baseline = args.payload.baseline.items[0];
  assert.match(quote, /新增步骤/);
  assert.match(baseline.direct_evidence[0].quote, /基线/);
  return { relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote,
    hypothesis_indexes: [0], explicit_request_quote: null }, gain_state: 'gain',
    compared_candidate_refs: [0], compared_material_ids: [baseline.material_version_id],
    comparisons: [{ baseline_material_id: baseline.material_version_id, candidate_evidence_ref: 0,
      candidate_quote: quote, baseline_quote: baseline.direct_evidence[0].quote, relationship: 'adds',
      added_kind: 'steps', explanation: '候选包含一项基线没有的步骤。' }], explicit_instruction_assessment: [] };
}

async function writeCollectionOutput(outputDir, { sourceId, sourceUrl, body }) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), body);
  const db = new DatabaseSync(join(outputDir, 'ExploreData.db'));
  db.exec(`CREATE TABLE explore_data (
    "采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,
    "发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,
    "点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,
    "下载地址" TEXT,"动图地址" TEXT)`);
  db.prepare(`INSERT INTO explore_data VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    timestamp, sourceId, '图文', '合成标题', body, '', timestamp, timestamp,
    0, 0, 0, 0, '合成作者', 'synthetic-author', '', sourceUrl, '', '');
  db.close();
}

export async function createDailyIntegrationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task015-integration-'));
  const dbPath = join(root, 'state.sqlite');
  const store = openStore(dbPath);
  let storeClosed = false;
  const owner = 'task015-synthetic-owner';
  let clockValue = timestamp;
  const now = () => clockValue;
  const candidateId = 'a15a00000000000000000001';
  const candidateUrl = `https://www.xiaohongshu.com/explore/${candidateId}?xsec_token=synthetic-task015`;
  const baselineId = 'b15a00000000000000000001';
  const baselineBody = '基线：直接记录操作结果。';
  const calls = [];

  t.after(() => {
    if (!storeClosed) store.close();
    storeClosed = true;
    console.log(`[task015 synthetic fixture preserved] root=${root} db=${join(root, 'state.sqlite')}`);
  });

  const baselineContentId = saveContent(store, { platform: 'xiaohongshu', content_id: baselineId, source_state: 'available' }).entity_id;
  const baselineBodyRef = join(root, 'baseline.txt');
  await writeFile(baselineBodyRef, baselineBody);
  const baselineMaterialId = saveMaterialVersion(store, { content_id: baselineContentId,
    body_ref: baselineBodyRef, body: baselineBody, media_kind: 'text', completeness: 'complete' }).entity_id;

  const model = async args => {
    calls.push({ stage: `analysis.model:${args.kind}` });
    if (args.kind === 'analysis' && args.input.source_content_id === candidateId) {
      assert.match(args.input.body, /新增步骤/);
      assert.deepEqual(args.input.images, []);
    }
    const output = args.kind === 'analysis' ? analysisOutput(args.input) : {
      hypotheses: [{ topic: '可核查步骤', supporting_analysis_ids: args.input.analyses.map(item => item.analysis_id),
        claim: '重视可核查步骤', confidence: 'medium', alternatives: ['合成样本'], long_term: false }],
      counterexamples: [], limitations: ['合成基线'],
    };
    await writeFile(args.outputPath, JSON.stringify(output));
    return completion;
  };
  const analyzer = createAnalyzer({ store, root: join(root, 'baseline-analysis'), owner, model,
    now: () => timestamp });
  const baselineResult = await analyzer.run({ batchKey: 'task015-synthetic-baseline', materialIds: [baselineMaterialId] });
  assert.equal(baselineResult.status, 'succeeded', JSON.stringify(baselineResult));
  const preferenceVersion = baselineResult.preference_version;
  const strategyVersion = 'task015-synthetic-strategy';
  store.db.prepare(`INSERT INTO strategy_version(strategy_version,parent_version,rule_diff_json,evidence_refs_json,
    preference_version,state,effective_at,created_at) VALUES(?,NULL,'{}','[]',?,'active',?,?)`)
    .run(strategyVersion, preferenceVersion, timestamp, timestamp);
  store.db.prepare(`INSERT INTO collection_batch(collection_batch_id,observed_from,observed_until,coverage_json,
    total_count,total_known,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('task015-synthetic-baseline-batch', '2026-10-26', '2026-10-26', '{}', 1, 1, '[]', timestamp);
  store.db.prepare(`INSERT INTO collection_observation(collection_observation_id,collection_batch_id,content_id,
    observed_at,membership,evidence_ref,collected_at,coverage_ref) VALUES(?,?,?,?,?,?,?,?)`)
    .run('task015-synthetic-baseline-observation', 'task015-synthetic-baseline-batch', baselineContentId,
      timestamp, 'present', 'synthetic:baseline-favorite', timestamp, null);

  calls.length = 0;
  const runtime = {
    collection: { root: join(root, 'collection'), cli: async ({ outputDir, sourceContentId, url }) => {
      assert.equal(sourceContentId, candidateId);
      assert.equal(url, candidateUrl);
      calls.push({ stage: 'collection.cli', content_id: sourceContentId });
      await writeCollectionOutput(outputDir, { sourceId: sourceContentId, sourceUrl: url,
        body: '新增步骤：先检查输入，再记录结果。' });
      return { exitCode: 0, stdout: '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0', stderr: '' };
    } },
    analysis: { root: join(root, 'analysis'), model },
    candidates: { root: join(root, 'candidates'), model: async args => {
      calls.push({ stage: 'candidates.model' });
      await writeFile(args.outputPath, JSON.stringify(selectionOutput(args)));
      return completion;
    } },
    homefeed: { root: join(root, 'homefeed'), options: { maxPages: 1, maxItems: 20 } },
    display: { root: join(root, 'display') },
    delivery: { root: join(root, 'delivery'), currentVersions: () => ({
      preference_version: preferenceVersion, strategy_version: strategyVersion,
      baseline_version: store.db.prepare('SELECT baseline_version FROM baseline_version ORDER BY rowid DESC LIMIT 1').get()?.baseline_version ?? null,
    }), transport: {
      async send(intent) {
        const attempt = store.db.prepare('SELECT delivery_attempt_id,payload_hash FROM delivery_attempt WHERE recommendation_id=? ORDER BY intent_at DESC LIMIT 1').get(intent.uuid);
        calls.push({ stage: 'delivery.send', recommendation_id: intent.uuid, receive_id: intent.receive_id,
          attempt_id: attempt?.delivery_attempt_id, msg_type: intent.msg_type, content: intent.content });
        assert.equal(intent.receive_id, 'synthetic-target');
        assert.equal(intent.msg_type, 'post');
        assert.ok(attempt?.payload_hash, `missing delivery attempt for transport request ${intent.uuid}`);
        const actualPayloadHash = hash(JSON.stringify({ msg_type: intent.msg_type, content: intent.content }));
        assert.equal(actualPayloadHash, attempt.payload_hash);
        const rendered = JSON.parse(intent.content).zh_cn;
        assert.ok(rendered.title.includes(`[${intent.uuid}]`));
        assert.ok(rendered.content.some(row => row.some?.(part => part.tag === 'text' && /新增步骤/.test(part.text))));
        calls.at(-1).payload_hash = actualPayloadHash;
        return { status: 'succeeded', message_id: 'synthetic-integration-message', evidence: `synthetic:${attempt.delivery_attempt_id}` };
      },
      async lookup(query) { calls.push({ stage: 'delivery.lookup', attempt_id: query.attempt_id }); return { status: 'unknown', evidence: 'synthetic:no-match' }; },
    } },
  };
  const makeOrchestrator = (storeOverride = store) => createOrchestrator({ store: storeOverride, root, owner, appRef: 'synthetic-app',
    targetRef: 'synthetic-target', runtime, now });
  let reloadGate = null;
  const tab = { page: {
    async reload() {
      calls.push({ stage: 'homefeed.reload' });
      if (reloadGate) { const gate = reloadGate; reloadGate = null; gate.entered(); await gate.wait; }
    },
    async evaluate(_extract, options) {
      calls.push({ stage: 'homefeed.evaluate', max_items: options.maxItems, seen_count: options.seenIds.length });
      return { source_page: 'https://www.xiaohongshu.com/explore', page_state: 'ready',
        observations: [{ content_id: candidateId, complete_source_url: candidateUrl, author_name: '合成作者', media_kind: 'image' }],
        anchor_id: candidateId };
    },
  } };

  return {
    store, owner, root, dbPath, candidateId, runtime, tab, now,
    run: async (orchestrator = makeOrchestrator()) => orchestrator.ensureDailyBatch({ tab }),
    runWith: async options => makeOrchestrator(options?.storeOverride ?? store).run({ ...options, storeOverride: undefined, tab: options?.tab ?? tab }),
    setClock(value) {
      if (!Number.isFinite(Date.parse(value))) throw new TypeError('synthetic clock value must be an ISO timestamp');
      clockValue = new Date(value).toISOString();
    },
    makeOrchestrator,
    setTransport(transport) { runtime.delivery.transport = transport; },
    auditRetained(batchId) {
      if (!storeClosed) { store.close(); storeClosed = true; }
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const integrity = db.prepare('PRAGMA integrity_check').all();
        const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
        const causal = db.prepare(`SELECT count(*) AS n FROM candidate c
          JOIN content co USING(content_id)
          JOIN decision d USING(candidate_id)
          JOIN analysis a USING(analysis_id)
          JOIN recommendation r USING(decision_id)
          JOIN delivery_attempt da USING(recommendation_id)
          WHERE c.discovery_batch_id=? AND co.source_content_id=?`).get(batchId, candidateId).n;
        let checkedFileRefs = 0;
        let unhashedFileRefs = 0;
        const badFileRefs = [];
        const visitedFiles = new Set();
        const inspectReference = (rawPath, expectedHash, checkpointId) => {
          const filePath = typeof rawPath === 'string' && rawPath.startsWith('file:') ? rawPath.slice(5) : rawPath;
          if (typeof filePath !== 'string' || !isAbsolute(filePath) || visitedFiles.has(filePath)) return;
          visitedFiles.add(filePath);
          try {
            const bytes = readFileSync(filePath);
            if (typeof expectedHash === 'string' && /^[a-f0-9]{64}$/i.test(expectedHash)) {
              checkedFileRefs++;
              if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) badFileRefs.push(checkpointId);
            } else {
              unhashedFileRefs++;
              try { inspectValue(JSON.parse(bytes.toString('utf8')), checkpointId); } catch { /* 非JSON材料仍检查存在性。 */ }
            }
          } catch { badFileRefs.push(checkpointId); }
        };
        const inspectValue = (value, checkpointId) => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) { for (const entry of value) inspectValue(entry, checkpointId); return; }
          for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string' && (key === 'ref' || key.endsWith('_ref'))) {
              const hashKey = { ref: 'hash', snapshot_ref: 'hash', manifest_ref: 'manifest_hash',
                receipt_ref: 'receipt_hash', output_ref: 'output_hash' }[key];
              inspectReference(item, hashKey ? value[hashKey] : null, checkpointId);
            }
            if (item && typeof item === 'object') inspectValue(item, checkpointId);
          }
        };
        for (const row of db.prepare('SELECT checkpoint_id,succeeded_refs_json FROM checkpoint').all()) {
          let refs;
          try { refs = JSON.parse(row.succeeded_refs_json); } catch { badFileRefs.push(row.checkpoint_id); continue; }
          inspectValue(refs, row.checkpoint_id);
        }
        const sourceRow = db.prepare(`SELECT c.source_evidence_ref, co.source_content_id
          FROM candidate c JOIN content co USING(content_id)
          WHERE c.discovery_batch_id=? AND co.source_content_id=?`).get(batchId, candidateId);
        const source = sourceRow?.source_evidence_ref;
        let homefeedSourceContainsCandidate = false;
        if (source) inspectReference(source, null, 'homefeed-source-evidence');
        if (source) {
          try {
            const filePath = source.startsWith('file:') ? source.slice(5) : source;
            const page = JSON.parse(readFileSync(filePath, 'utf8'));
            homefeedSourceContainsCandidate = page.observations?.some(item =>
              item.content_id?.toLowerCase() === sourceRow.source_content_id.toLowerCase()) === true;
          } catch { /* 无法回读来源材料时保留审计失败状态。 */ }
        }
        return { read_only: true, integrity, foreign_key_violations: foreignKeys,
          causal_business_rows: causal, checked_checkpoint_files: checkedFileRefs, unhashed_existing_file_refs: unhashedFileRefs,
          bad_checkpoint_files: [...new Set(badFileRefs)], homefeed_source_ref: source ?? null,
          homefeed_source_contains_candidate: homefeedSourceContainsCandidate };
      } finally { db.close(); }
    },
    pauseNextReload() {
      let entered;
      const enteredPromise = new Promise(resolve => { entered = resolve; });
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      reloadGate = { entered: () => entered(), wait };
      return { entered: enteredPromise, release };
    },
    calls,
    async writeEvidence(record) {
      const path = join(process.cwd(), '.codex', `task015-integration-evidence-${Date.now()}-${randomUUID()}.json`);
      await writeFile(path, `${JSON.stringify({ generated_at: new Date().toISOString(), fixture_root: root,
        database_path: join(root, 'state.sqlite'), synthetic_only: true, ...record }, null, 2)}\n`, { flag: 'wx' });
      return path;
    },
  };
}
