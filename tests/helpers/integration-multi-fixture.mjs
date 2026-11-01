import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openStore } from '../../src/storage.mjs';
import { createOrchestrator } from '../../src/orchestrator.mjs';

const completion = { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function writeCollectionOutput(outputDir, { sourceId, sourceUrl, body, at }) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), body);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(outputDir, 'ExploreData.db'));
  db.exec(`CREATE TABLE explore_data (
    "采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,
    "发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,
    "点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,
    "下载地址" TEXT,"动图地址" TEXT)`);
  db.prepare('INSERT INTO explore_data VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    at, sourceId, '图文', '合成崩溃候选', body, '', at, at, 0, 0, 0, 0, '合成作者', 'synthetic-author', '', sourceUrl, '', '');
  db.close();
}

function selectionOutput(args) {
  const quote = args.payload.candidate_analysis.direct_evidence[0].quote;
  const baselineItems = args.payload.baseline.items;
  return { relevance: { state: 'matched', evidence_index: 0, evidence_quote: quote,
    hypothesis_indexes: [0], explicit_request_quote: null }, gain_state: 'gain',
    compared_candidate_refs: [0], compared_material_ids: baselineItems.map(item => item.material_version_id),
    comparisons: baselineItems.map(item => ({ baseline_material_id: item.material_version_id,
      candidate_evidence_ref: 0, candidate_quote: quote, baseline_quote: item.direct_evidence[0].quote,
      relationship: 'adds', added_kind: 'steps', explanation: '合成候选记录了可核查的新步骤。' })),
    explicit_instruction_assessment: [] };
}

export function createSyntheticTransport(store, sendLogPath) {
  return {
    async send(request) {
      const attempt = store.db.prepare(`SELECT a.* FROM delivery_attempt a
        JOIN recommendation r USING(recommendation_id) WHERE r.recommendation_id=?`).get(request.uuid);
      assert.ok(attempt?.delivery_attempt_id, `transport request has no persisted attempt: ${request.uuid}`);
      assert.ok(attempt.dispatched_at, 'synthetic send must follow persisted dispatch');
      assert.equal(request.receive_id, 'synthetic-target');
      assert.equal(request.msg_type, 'post');
      const payloadHash = hash(Buffer.from(JSON.stringify({ msg_type: request.msg_type, content: request.content })));
      assert.equal(payloadHash, attempt.payload_hash);
      const row = { attempt_id: attempt.delivery_attempt_id, recommendation_id: request.uuid,
        payload_hash: attempt.payload_hash, message_id: `synthetic-${request.uuid}` };
      appendFileSync(sendLogPath, `${JSON.stringify(row)}\n`, { flag: 'a' });
      return { status: 'succeeded', message_id: row.message_id, evidence: `synthetic:${attempt.delivery_attempt_id}` };
    },
    async lookup(query) { return { status: 'unknown', evidence: `synthetic:no-lookup:${query.attempt_id}` }; },
  };
}

async function runCrashChild(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const store = openStore(config.db_path);
  const now = () => config.now;
  const currentVersions = () => ({ ...config.current_versions,
    baseline_version: store.db.prepare('SELECT baseline_version FROM baseline_version ORDER BY rowid DESC LIMIT 1').get()?.baseline_version ?? null,
  });
  const ids = config.candidate_ids;
  const sourceUrl = id => `https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic-task015`;
  const transport = createSyntheticTransport(store, config.send_log_path);
  const runtime = {
    collection: { root: join(config.root, 'collection'), cli: async ({ outputDir, sourceContentId, url }) => {
      const body = `新增步骤：候选${sourceContentId.slice(-2)}先校验输入，再记录结果。`;
      if (!ids.includes(sourceContentId) || url !== sourceUrl(sourceContentId)) throw new Error('unexpected synthetic collection input');
      await writeCollectionOutput(outputDir, { sourceId: sourceContentId, sourceUrl: url, body, at: config.now });
      appendFileSync(config.call_log_path, `${JSON.stringify({ stage: 'collection', content_id: sourceContentId })}\n`, { flag: 'a' });
      return { exitCode: 0, stdout: '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0', stderr: '' };
    } },
    analysis: { root: join(config.root, 'analysis'), model: async args => {
      const input = args.input;
      const output = { id: input.source_content_id, summary: '本地合成分析', images: [],
        direct_evidence: [{ source: 'body', index: null, quote: input.body }],
        inferences: [], actionable: ['按顺序核对输入'], uncertainties: ['本地合成样本'], media_scope: input.media_scope };
      await writeFile(args.outputPath, JSON.stringify(output));
      appendFileSync(config.call_log_path, `${JSON.stringify({ stage: 'analysis', content_id: input.source_content_id })}\n`, { flag: 'a' });
      return completion;
    } },
    candidates: { root: join(config.root, 'candidates'), model: async args => {
      await writeFile(args.outputPath, JSON.stringify(selectionOutput(args)));
      appendFileSync(config.call_log_path, `${JSON.stringify({ stage: 'selection', candidate_id: args.payload.candidate.candidate_id })}\n`, { flag: 'a' });
      return completion;
    } },
    homefeed: { root: join(config.root, 'homefeed'), options: { maxPages: 1, maxItems: 20 } },
    display: { root: join(config.root, 'display') },
    delivery: { root: join(config.root, 'delivery'), currentVersions, transport },
  };
  const observations = ids.map(id => ({ content_id: id, complete_source_url: sourceUrl(id), author_name: '合成作者', media_kind: 'image' }));
  const tab = { page: {
    async reload() {},
    async evaluate() { return { source_page: 'https://www.xiaohongshu.com/explore', page_state: 'ready', observations, anchor_id: observations.at(-1).content_id }; },
  } };
  const orchestrator = createOrchestrator({ store, root: config.root, owner: config.owner,
    appRef: 'synthetic-app', targetRef: 'synthetic-target', runtime, now });

  let transactionDepth = 0;
  const originalTransaction = store.transaction.bind(store);
  function checkCrashPoint() {
    const probe = { at: now(), inTransaction: store.db.isTransaction };
    const batch = store.db.prepare(`SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=?`)
      .get(config.owner, '2026-10-26');
    if (!batch) { appendFileSync(join(config.root, 'task015-crash-probe.jsonl'), `${JSON.stringify(probe)}\n`, { flag: 'a' }); return; }
    const successes = store.db.prepare(`SELECT count(DISTINCT r.content_id) AS n FROM recommendation r
      WHERE r.delivery_batch_id=? AND r.state='succeeded'`).get(batch.delivery_batch_id).n;
    const pending = store.db.prepare(`SELECT a.*,r.recommendation_id FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='intent'
      AND a.dispatched_at IS NULL`).all(batch.delivery_batch_id);
    if (pending.length !== 1) return;
    const phaseRow = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(config.owner, `orchestration:phase:${batch.delivery_batch_id}:delivery`);
    const phase = phaseRow && JSON.parse(phaseRow.succeeded_refs_json)[0]?.orchestration_phase;
    const slot = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    const lastSucceeded = store.db.prepare(`SELECT a.delivery_attempt_id,a.status FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='succeeded'
      ORDER BY a.rowid DESC LIMIT 1`).get(batch.delivery_batch_id);
    const head = store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1")
      .get(config.owner);
    probe.successes = successes;
    probe.pending_attempts = pending.map(row => ({ id: row.delivery_attempt_id, status: row.status, dispatched_at: row.dispatched_at }));
    probe.phase = phase?.status;
    probe.phase_result = phase?.result;
    probe.slot = slot && { state: slot.state, owner: slot.owner, run_id: slot.run_id };
    probe.batch_status = batch.status;
    probe.head = head && { run_id: head.run_id, delivery_batch_id: head.delivery_batch_id, status: head.status };
    probe.last_succeeded_attempt_id = lastSucceeded?.delivery_attempt_id;
    appendFileSync(join(config.root, 'task015-crash-probe.jsonl'), `${JSON.stringify(probe)}\n`, { flag: 'a' });
    const phaseMatchesPriorSuccess = phase?.status === 'succeeded'
      && phase?.result?.attempt_id === lastSucceeded?.delivery_attempt_id;
    const phaseMatchesPendingIntent = phase?.status === 'running'
      && phase?.result?.recommendation_id === pending[0].recommendation_id;
    if (successes !== 19 || !lastSucceeded || (!phaseMatchesPriorSuccess && !phaseMatchesPendingIntent)
      || lastSucceeded?.status !== 'succeeded'
      || batch.status !== 'running' || head?.delivery_batch_id !== batch.delivery_batch_id
      || slot.owner !== null || slot.run_id !== null) return;
    const marker = { root: config.root, db_path: config.db_path, owner: config.owner, process_id: process.pid,
      run_id: head.run_id, batch_id: batch.delivery_batch_id, attempt_id: pending[0].delivery_attempt_id,
      recommendation_id: pending[0].recommendation_id, payload_hash: pending[0].payload_hash,
      success_count: successes, phase_status: phase.status, phase_result: phase.result,
      phase_result_attempt_id: phase.result.attempt_id ?? null,
      phase_result_recommendation_id: phase.result.recommendation_id ?? null,
      last_succeeded_attempt_id: lastSucceeded.delivery_attempt_id, batch_status: batch.status,
      head_batch_id: head.delivery_batch_id, outer_commit_returned: !store.db.isTransaction,
      execution_slot: { state: slot.state, owner: slot.owner, run_id: slot.run_id },
      observed_at: now() };
    writeFileSync(config.crash_marker_path, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    process.exit(73);
  }
  store.transaction = callback => {
    transactionDepth++;
    try { return originalTransaction(callback); }
    finally {
      transactionDepth--;
      if (transactionDepth === 0 && !store.db.isTransaction) checkCrashPoint();
    }
  };
  try {
    await orchestrator.run({ kind: 'daily_follow', tab });
    process.exitCode = 74;
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCrashChild(process.argv[2]).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 75;
  });
}
