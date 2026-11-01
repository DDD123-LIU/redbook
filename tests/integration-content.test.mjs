import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const completion = { exitCode: 0, stdout: '{"type":"turn.completed"}', stderr: '' };
const businessSummary = '共处理 1 个作品，成功 1 个，失败 0 个，跳过 0';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function onePixelPng(red, green, blue) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

async function writeCliMaterial(outputDir, { sourceId, sourceUrl, body, kind = '图文', imageBytes = [],
  downloadUrls = imageBytes.map((_, index) => `https://img.invalid/${index + 1}.png`).join('\n') }) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'note.txt'), body);
  for (const [index, bytes] of imageBytes.entries()) await writeFile(join(outputDir, `note_${index + 1}.png`), bytes);
  const db = new DatabaseSync(join(outputDir, 'ExploreData.db'));
  db.exec(`CREATE TABLE explore_data (
    "采集时间" TEXT,"作品ID" TEXT,"作品类型" TEXT,"作品标题" TEXT,"作品描述" TEXT,"作品标签" TEXT,
    "发布时间" TEXT,"最后更新时间" TEXT,"收藏数量" INTEGER,"评论数量" INTEGER,"分享数量" INTEGER,
    "点赞数量" INTEGER,"作者昵称" TEXT,"作者ID" TEXT,"作者链接" TEXT,"作品链接" TEXT,
    "下载地址" TEXT,"动图地址" TEXT)`);
  db.prepare('INSERT INTO explore_data VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    '2026-10-26T03:15:00.000Z', sourceId, kind, '合成标题', body, '',
    '2026-10-26T03:15:00.000Z', '2026-10-26T03:15:00.000Z', 0, 0, 0, 0,
    '合成作者', 'synthetic-author', '', sourceUrl, downloadUrls, '');
  db.close();
}

function selectionFor(f, state) {
  return async args => {
    const evidence = args.payload.candidate_analysis.direct_evidence;
    const candidateQuote = evidence[0].quote;
    const baseline = args.payload.baseline.items[0];
    const exploration = args.payload.request.category === 'explore';
    const instructions = exploration ? [...new Set([args.payload.request.explicit_request, args.payload.request.direction].filter(Boolean))] : [];
    const proposal = {
      relevance: { state: 'matched', evidence_index: 0, evidence_quote: candidateQuote,
        hypothesis_indexes: exploration ? [] : [0],
        explicit_request_quote: exploration ? args.payload.request.direction : null },
      gain_state: state,
      compared_candidate_refs: evidence.map((_, index) => index),
      compared_material_ids: [baseline.material_version_id],
      comparisons: evidence.map((item, index) => ({ baseline_material_id: baseline.material_version_id,
        candidate_evidence_ref: index, candidate_quote: item.quote, baseline_quote: baseline.direct_evidence[0].quote,
        relationship: state === 'no_gain' ? 'equivalent' : 'adds', added_kind: state === 'no_gain' ? null : 'steps',
        explanation: state === 'no_gain' ? '候选证据与基线相同。' : '合成比较证据。' })),
      explicit_instruction_assessment: instructions.map(instruction => ({ instruction_quote: instruction,
        relation: 'support', evidence_index: 0, evidence_quote: candidateQuote })),
    };
    await writeFile(args.outputPath, JSON.stringify(proposal));
    f.calls.push({ stage: 'candidates.model', gain_state: state });
    return completion;
  };
}

function analyzeCandidate(f) {
  f.runtime.analysis.model = async args => {
    f.calls.push({ stage: `analysis.model:${args.kind}` });
    const input = args.input;
    const output = args.kind === 'analysis'
      ? { id: input.source_content_id, summary: '本地合成分析',
        direct_evidence: [{ source: 'body', index: null, quote: input.body },
          ...args.input.images.map(image => ({ source: 'image', index: image.index, quote: `合成图片${image.index + 1}显示颜色块。` }))],
        images: args.input.images.map(image => ({ index: image.index, description: `合成图片${image.index + 1}`, readability: 'readable' })),
        inferences: [], actionable: ['按顺序核对输入'], uncertainties: ['本地合成样本'], media_scope: input.media_scope }
      : { hypotheses: [{ topic: '可核查步骤', supporting_analysis_ids: args.input.analyses.map(item => item.analysis_id),
        claim: '重视可核查步骤', confidence: 'medium', alternatives: ['合成样本'], long_term: false }],
        counterexamples: [], limitations: ['合成基线'] };
    await writeFile(args.outputPath, JSON.stringify(output));
    return completion;
  };
}

function cli(f, run) {
  f.runtime.collection.cli = async args => {
    f.calls.push({ stage: 'collection.cli', content_id: args.sourceContentId });
    return run(args);
  };
}

function counts(f) {
  return Object.fromEntries(['candidate', 'material_version', 'analysis', 'decision', 'recommendation', 'delivery_attempt']
    .map(table => [table, f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
}

test('I11 完整入口对与基线相同的候选作no_gain reject且不投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url, body: '基线：直接记录操作结果。' });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'no_gain');

  const outcome = await f.run();
  const rows = f.store.db.prepare(`SELECT c.candidate_id,d.result,d.gain_state,d.reasons_json
    FROM candidate c JOIN decision d USING(candidate_id) WHERE c.discovery_batch_id=?`).all(outcome.batch_id);
  const evidence = { scenario: 'I11_no_gain', batch_id: outcome.batch_id, candidate_id: rows[0]?.candidate_id ?? null,
    outcome: { status: outcome.status, shortfall: outcome.shortfall }, decisions: rows, counts: counts(f),
    adapter_calls: f.calls.map(x => x.stage), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(rows.length, 1, JSON.stringify(evidence));
  assert.equal(rows[0].result, 'reject');
  assert.equal(rows[0].gain_state, 'no_gain');
  assert.deepEqual(JSON.parse(rows[0].reasons_json), ['no_information_gain']);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I12 完整入口对无法比较的候选保留undecidable hold且不投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url, body: '新增步骤：先核对输入，再保存结果。' });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'undecidable');

  const outcome = await f.run();
  const rows = f.store.db.prepare(`SELECT c.candidate_id,d.result,d.gain_state,d.reasons_json
    FROM candidate c JOIN decision d USING(candidate_id) WHERE c.discovery_batch_id=?`).all(outcome.batch_id);
  const evidence = { scenario: 'I12_undecidable', batch_id: outcome.batch_id, candidate_id: rows[0]?.candidate_id ?? null,
    outcome: { status: outcome.status, shortfall: outcome.shortfall }, decisions: rows, counts: counts(f),
    adapter_calls: f.calls.map(x => x.stage), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(rows.length, 1, JSON.stringify(evidence));
  assert.equal(rows[0].result, 'hold');
  assert.equal(rows[0].gain_state, 'undecidable');
  assert.deepEqual(JSON.parse(rows[0].reasons_json), ['increment_undecidable']);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM recommendation').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I13 来源可靠删除证据在完整入口保留source_deleted并跳过分析与投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  cli(f, async ({ outputDir }) => {
    const evidencePath = join(outputDir, 'source-deleted-evidence.json');
    await mkdir(outputDir, { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ synthetic: true, source_deleted: true }));
    return { exitCode: 1, stdout: '', stderr: '', reliableSourceDeleted: true,
      sourceDeletedEvidenceRef: evidencePath };
  });

  const outcome = await f.run();
  const row = f.store.db.prepare(`SELECT c.source_content_id,c.source_state,m.fetch_status,m.completeness
    FROM content c JOIN candidate k USING(content_id) LEFT JOIN material_version m USING(content_id)
    WHERE k.discovery_batch_id=?`).get(outcome.batch_id);
  const deletedReceipt = f.calls.filter(x => x.stage === 'collection.cli').length
    ? await (async () => {
      const { readFile, readdir } = await import('node:fs/promises');
      const walk = async dir => {
        let entries = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
        const paths = [];
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) paths.push(...await walk(path)); else if (entry.name === 'receipt.json') paths.push(path);
        }
        return paths;
      };
      const paths = await walk(join(f.runtime.collection.root, 'attempts'));
      const path = paths.at(-1);
      return path ? { path, receipt: JSON.parse(await readFile(path, 'utf8')) } : null;
    })() : null;
  const runPath = deletedReceipt?.receipt?.run_id
    ? join(f.runtime.collection.root, 'runs', deletedReceipt.receipt.run_id, 'run.json') : null;
  const runState = runPath ? JSON.parse(await readFile(runPath, 'utf8')) : null;
  const sourceDeletionProof = deletedReceipt?.receipt?.source_deleted_evidence_ref
    ? JSON.parse(await readFile(deletedReceipt.receipt.source_deleted_evidence_ref, 'utf8')) : null;
  const evidence = { scenario: 'I13_source_deleted', batch_id: outcome.batch_id, content: row, deleted_receipt: deletedReceipt,
    source_deletion_proof: sourceDeletionProof, collection_run: runState,
    outcome: { status: outcome.status, shortfall: outcome.shortfall }, counts: counts(f),
    adapter_calls: f.calls.map(x => x.stage), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(row.source_content_id, f.candidateId);
  assert.equal(row.source_state, 'source_deleted');
  assert.equal(row.fetch_status, 'failed');
  assert.equal(row.completeness, 'unknown');
  assert.equal(deletedReceipt.receipt.status, 'source_deleted');
  assert.ok(deletedReceipt.receipt.source_deleted_evidence_ref);
  assert.deepEqual(sourceDeletionProof, { synthetic: true, source_deleted: true });
  assert.equal(runState.state, 'source_deleted');
  assert.equal(f.calls.some(x => x.stage.startsWith('analysis.model:analysis')), false);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I14 来源不可访问时保留blocked状态且不分析或投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  cli(f, async () => ({ exitCode: 1, stdout: '', stderr: 'login required', blocked: true }));

  const outcome = await f.run();
  const row = f.store.db.prepare(`SELECT c.source_content_id,c.source_state,m.fetch_status,m.completeness
    FROM content c JOIN candidate k USING(content_id) LEFT JOIN material_version m USING(content_id)
    WHERE k.discovery_batch_id=?`).get(outcome.batch_id);
  const evidence = { scenario: 'I14_source_access_blocked', batch_id: outcome.batch_id, content: row,
    outcome: { status: outcome.status, shortfall: outcome.shortfall }, counts: counts(f),
    adapter_calls: f.calls.map(x => x.stage), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(row.source_content_id, f.candidateId);
  assert.equal(row.source_state, 'access_blocked');
  assert.equal(row.fetch_status, 'blocked');
  assert.equal(row.completeness, 'failed');
  assert.equal(f.calls.some(x => x.stage.startsWith('analysis.model:analysis')), false);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I15 完整入口以B式消息原样展示长正文且不摘要或截断', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url,
      body: `新增步骤：${'长正文段落，逐条记录输入和结果。'.repeat(270)}` });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'gain');

  const outcome = await f.run();
  const sent = f.calls.find(x => x.stage === 'delivery.send');
  const payload = sent ? JSON.parse(sent.content).zh_cn : null;
  const sentBody = payload?.content.find(row => row.some?.(part => part.tag === 'text' && part.text.startsWith('新增步骤：')))?.[0]?.text;
  const sourceBody = `新增步骤：${'长正文段落，逐条记录输入和结果。'.repeat(270)}`;
  const evidence = { scenario: 'I15_long_body_full_B', batch_id: outcome.batch_id, body_characters: sentBody?.length ?? 0,
    payload_hash: sent?.payload_hash ?? null, message_body_hash: sentBody ? createHash('sha256').update(sentBody).digest('hex') : null,
    body_matches_source: sentBody === sourceBody,
    counts: counts(f), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(outcome.delivered, 1, JSON.stringify(evidence));
  assert.ok(sentBody?.length > 4000 && sentBody.length < 6000, JSON.stringify(evidence));
  assert.equal(evidence.body_matches_source, true);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
});

test('I16 完整入口保留多图原序并按同一顺序构建B式消息', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  const expectedImages = [onePixelPng(255, 0, 0), onePixelPng(0, 255, 0), onePixelPng(0, 0, 255)];
  const expectedHashes = expectedImages.map(image => createHash('sha256').update(image).digest('hex'));
  const expectedImageKeys = expectedHashes.map(imageHash => `synthetic-image-${imageHash}`);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url,
      body: '新增步骤：图片按原序排列。', imageBytes: expectedImages });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  const uploads = [];
  f.runtime.display.uploadImage = async (path, intent) => {
    const actualHash = createHash('sha256').update(await readFile(path)).digest('hex');
    uploads.push({ path, index: intent.index, declared_hash: intent.media_hash, actual_hash: actualHash });
    assert.equal(intent.media_hash, actualHash, 'display adapter hash must match uploaded file bytes');
    assert.equal(actualHash, expectedHashes[intent.index], `image at index ${intent.index} must retain its original fixture position`);
    return { image_key: `synthetic-image-${actualHash}` };
  };
  f.runtime.candidates.model = selectionFor(f, 'gain');

  const outcome = await f.run();
  const sent = f.calls.find(x => x.stage === 'delivery.send');
  const rows = sent ? JSON.parse(sent.content).zh_cn.content.filter(row => row[0].tag === 'img') : [];
  const evidence = { scenario: 'I16_ordered_images', batch_id: outcome.batch_id,
    expected_hashes: expectedHashes, uploaded_indexes: uploads.map(x => x.index),
    uploaded_declared_hashes: uploads.map(x => x.declared_hash), uploaded_actual_hashes: uploads.map(x => x.actual_hash),
    message_image_keys: rows.map(row => row[0].image_key), expected_image_keys: expectedImageKeys, counts: counts(f),
    send_calls: f.calls.filter(x => x.stage === 'delivery.send').length, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(outcome.delivered, 1, JSON.stringify(evidence));
  assert.deepEqual(uploads.map(x => x.index), [0, 1, 2]);
  assert.deepEqual(uploads.map(x => x.actual_hash), expectedHashes);
  assert.deepEqual(uploads.map(x => x.declared_hash), expectedHashes);
  assert.deepEqual(rows.map(row => row[0].image_key), expectedImageKeys);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
});

test('I17 损坏图片材料以unknown保留并阻止分析、决策和投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url,
      body: '新增步骤：图片损坏时停止。', imageBytes: [Buffer.from('not-an-image')] });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });

  const outcome = await f.run();
  const row = f.store.db.prepare(`SELECT c.source_content_id,m.fetch_status,m.completeness,m.material_version_id
    FROM content c JOIN candidate k USING(content_id) LEFT JOIN material_version m USING(content_id)
    WHERE k.discovery_batch_id=? ORDER BY m.rowid DESC LIMIT 1`).get(outcome.batch_id);
  const evidence = { scenario: 'I17_corrupt_image', batch_id: outcome.batch_id, content: row,
    outcome: { status: outcome.status, shortfall: outcome.shortfall }, counts: counts(f),
    adapter_calls: f.calls.map(x => x.stage), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(row.source_content_id, f.candidateId);
  assert.equal(row.fetch_status, 'unknown');
  assert.equal(row.completeness, 'partial');
  assert.equal(f.calls.some(x => x.stage === 'analysis.model:analysis'), false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I18 视频只按正文处理并持久video_unread；缺封面时阻止展示和投递', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  const evaluate = f.tab.page.evaluate.bind(f.tab.page);
  f.tab.page.evaluate = async (...args) => {
    const result = await evaluate(...args);
    result.observations[0].media_kind = 'video';
    return result;
  };
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url,
      body: '新增步骤：只检查视频帖子中读取到的正文。', kind: '视频' });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'gain');

  const outcome = await f.run();
  const content = f.store.db.prepare(`SELECT c.source_content_id,m.material_version_id,m.media_kind,m.completeness,m.material_hash,
      a.analysis_id,a.status AS analysis_status,d.result AS decision_result
    FROM content c JOIN candidate k USING(content_id)
    JOIN material_version m USING(content_id) JOIN analysis a USING(material_version_id)
    LEFT JOIN decision d USING(analysis_id) WHERE k.discovery_batch_id=? AND m.fetch_status='succeeded'`).get(outcome.batch_id);
  const analysis = content ? f.store.db.prepare('SELECT output_ref FROM analysis WHERE analysis_id=?').get(content.analysis_id) : null;
  const output = analysis ? JSON.parse(await readFile(analysis.output_ref, 'utf8')) : null;
  const evidence = { scenario: 'I18_video_body_unread_no_cover', batch_id: outcome.batch_id,
    content, analysis_output: output, outcome: { status: outcome.status, delivered: outcome.delivered ?? 0,
      shortfall: outcome.shortfall ?? null }, counts: counts(f), adapter_calls: f.calls.map(x => x.stage),
    send_calls: f.calls.filter(x => x.stage === 'delivery.send').length, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(content.source_content_id, f.candidateId);
  assert.equal(content.media_kind, 'video');
  assert.equal(content.completeness, 'video_unread');
  assert.equal(content.analysis_status, 'complete');
  assert.equal(output.media_scope, 'video_body_only');
  assert.ok(output.direct_evidence.every(item => item.source === 'body'));
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 0);
});

test('I19 与现存收藏同ID的首页候选在采集和筛选前拒绝', async t => {
  const f = await createDailyIntegrationFixture(t);
  const evaluate = f.tab.page.evaluate.bind(f.tab.page);
  f.tab.page.evaluate = async (...args) => {
    const result = await evaluate(...args);
    const id = 'b15a00000000000000000001';
    result.observations[0] = { ...result.observations[0], content_id: id,
      complete_source_url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic-favorite` };
    result.anchor_id = id;
    return result;
  };

  const outcome = await f.run();
  const candidate = f.store.db.prepare(`SELECT c.candidate_id,c.eligibility_state,co.source_content_id
    FROM candidate c JOIN content co USING(content_id) WHERE c.discovery_batch_id=?`).get(outcome.batch_id);
  const evidence = { scenario: 'I19_saved_favorite_same_id', batch_id: outcome.batch_id,
    candidate, counts: counts(f), adapter_calls: f.calls.map(x => x.stage),
    send_calls: f.calls.filter(x => x.stage === 'delivery.send').length, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(candidate.source_content_id, 'b15a00000000000000000001');
  assert.equal(candidate.eligibility_state, 'reject');
  assert.equal(f.calls.some(x => x.stage === 'collection.cli'), false);
  assert.equal(f.calls.some(x => x.stage.startsWith('analysis.model:')), false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM decision').get().n, 0);
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 0);
});

test('I20 新日批重遇已成功投递的同ID内容时拒绝且复核类别和版本绑定', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url, body: '新增步骤：建立内容版本关系。' });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'gain');

  const first = await f.run();
  const versions = f.runtime.delivery.currentVersions();
  const firstRows = f.store.db.prepare(`SELECT d.category,d.baseline_version,d.preference_version,d.strategy_version,
      r.category AS recommendation_category,r.actual_preference_version,r.actual_strategy_version
    FROM decision d JOIN recommendation r USING(decision_id) WHERE r.delivery_batch_id=?`).all(first.batch_id);
  f.setClock('2026-10-27T03:15:00.000Z');
  const second = await f.run();
  const states = f.store.db.prepare(`SELECT b.business_day,c.eligibility_state,co.source_content_id
    FROM candidate c JOIN batch b ON b.delivery_batch_id=c.discovery_batch_id JOIN content co USING(content_id)
    WHERE b.owner=? ORDER BY b.business_day`).all(f.owner);
  const evidence = { scenario: 'I20_successful_id_same_id_again', first_batch_id: first.batch_id,
    second_batch_id: second.batch_id, versions, first_decision_recommendation: firstRows, candidates: states,
    counts: counts(f), send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    adapter_calls: f.calls.map(x => x.stage), second_status: second.status, exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(first.delivered, 1);
  assert.notEqual(second.batch_id, first.batch_id);
  assert.equal(firstRows.length, 1);
  assert.deepEqual({ ...firstRows[0] }, { category: 'follow', baseline_version: versions.baseline_version,
    preference_version: versions.preference_version, strategy_version: versions.strategy_version,
    recommendation_category: 'follow', actual_preference_version: versions.preference_version,
    actual_strategy_version: versions.strategy_version });
  assert.equal(states.length, 2);
  assert.equal(states[1].eligibility_state, 'reject');
  assert.equal(f.calls.filter(x => x.stage === 'delivery.send').length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_attempt').get().n, 1);
});

test('I21 explore完整入口按explore类别绑定用户请求和当前偏好/策略版本', async t => {
  const f = await createDailyIntegrationFixture(t);
  analyzeCandidate(f);
  cli(f, async ({ outputDir, sourceContentId, url }) => {
    await writeCliMaterial(outputDir, { sourceId: sourceContentId, sourceUrl: url, body: '新增步骤：核对请求中的输入流程。' });
    return { exitCode: 0, stdout: businessSummary, stderr: '' };
  });
  f.runtime.candidates.model = selectionFor(f, 'gain');
  const request = '核对输入流程';
  const outcome = await f.runWith({ kind: 'explore', commandId: 'task015-explore-1',
    requestText: request, direction: request, explicitRequest: true });
  const versions = f.runtime.delivery.currentVersions();
  const row = f.store.db.prepare(`SELECT b.kind,d.category,d.preference_version,d.strategy_version,d.baseline_version,
      r.category AS recommendation_category,r.actual_preference_version,r.actual_strategy_version
    FROM decision d JOIN recommendation r USING(decision_id) JOIN batch b USING(delivery_batch_id)
    WHERE r.delivery_batch_id=?`).get(outcome.batch_id);
  const evidence = { scenario: 'I21_explore_category_versions', batch_id: outcome.batch_id,
    request, versions, row, outcome: { status: outcome.status, delivered: outcome.delivered ?? 0,
      shortfall: outcome.shortfall ?? null }, send_calls: f.calls.filter(x => x.stage === 'delivery.send').length,
    adapter_calls: f.calls.map(x => x.stage), exit_code: 0, synthetic_only: true };
  await f.writeEvidence(evidence);

  assert.equal(outcome.delivered, 1, JSON.stringify(evidence));
  assert.deepEqual({ ...row }, { kind: 'explore', category: 'explore',
    preference_version: versions.preference_version, strategy_version: versions.strategy_version,
    baseline_version: versions.baseline_version, recommendation_category: 'explore',
    actual_preference_version: versions.preference_version, actual_strategy_version: versions.strategy_version });
});
