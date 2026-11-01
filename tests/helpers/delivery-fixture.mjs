import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisplay } from '../../src/display.mjs';
import { openStore, saveContent, saveMaterialVersion } from '../../src/storage.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));

export async function deliveryFixture(t, { target = 1, kind = 'daily_follow', commandId = null, businessDay = '2026-10-23' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-'));
  const dbPath = join(root, 'state.sqlite');
  let store = openStore(dbPath);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const insert = (table, row) => {
    const columns = Object.keys(row);
    store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  };
  const at = '2026-10-23T04:00:00.000Z';
  const owner = 'synthetic-owner';
  const batchId = randomUUID();
  insert('batch', { delivery_batch_id: batchId, owner, command_id: commandId, kind, business_day: businessDay, target, status: 'pending', created_at: at });

  const preference = randomUUID();
  const strategy = randomUUID();
  const baseline = randomUUID();
  const preferenceInput = { explicit_instructions: [], analyses: [] };
  const preferenceInputHash = digest(preferenceInput);
  const preferenceInputFile = JSON.stringify({ ...preferenceInput, input_hash: preferenceInputHash });
  const preferenceInputRef = join(root, 'preference-input.json');
  await writeFile(preferenceInputRef, preferenceInputFile);
  const preferenceOutputFile = JSON.stringify({ hypotheses: [{ topic: '合成关注' }], counterexamples: [] });
  const preferenceOutputRef = join(root, 'preference-output.json');
  await writeFile(preferenceOutputRef, preferenceOutputFile);
  const preferenceReceipt = {
    exitCode: 0, stdout: '{"type":"turn.completed"}', kind: 'preference', input_hash: preferenceInputHash,
    input_ref: preferenceInputRef, input_file_hash: sha(preferenceInputFile),
    output_ref: preferenceOutputRef, output_hash: sha(preferenceOutputFile),
  };
  const preferenceReceiptFile = JSON.stringify(preferenceReceipt);
  const preferenceReceiptRef = join(root, 'preference-receipt.json');
  await writeFile(preferenceReceiptRef, preferenceReceiptFile);
  const preferenceManifest = {
    preference_version: preference, input: preferenceInput, input_hash: preferenceInputHash,
    output_ref: preferenceOutputRef, output_hash: preferenceReceipt.output_hash,
    receipt_ref: preferenceReceiptRef, receipt_hash: sha(preferenceReceiptFile),
  };
  const preferenceManifestFile = JSON.stringify(preferenceManifest);
  const preferenceManifestRef = join(root, 'preference-manifest.json');
  await writeFile(preferenceManifestRef, preferenceManifestFile);
  insert('preference_version', {
    preference_version: preference, explicit_instructions_json: '[]', supporting_content_ids_json: '[]',
    hypotheses_json: JSON.stringify([{ topic: '合成关注' }]),
    confidence: 1, counterexamples_json: '[]', created_at: at,
  });
  insert('checkpoint', {
    checkpoint_id: randomUUID(), owner, run_id: 'synthetic-preference', generation: 0,
    stage: `preference-current:${owner}`,
    succeeded_refs_json: JSON.stringify([{
      preference_version: preference, input_hash: preferenceInputHash,
      manifest_ref: preferenceManifestRef, manifest_hash: sha(preferenceManifestFile),
    }]),
    input_hash: preferenceInputHash, output_hash: sha(preferenceManifestFile), committed_at: at,
  });
  insert('strategy_version', { strategy_version: strategy, rule_diff_json: '{}', preference_version: preference, state: 'active', effective_at: at, created_at: at });

  const sourceContentId = '0123456789abcdef01234567';
  const contentId = saveContent(store, { platform: 'xiaohongshu', content_id: sourceContentId, source_state: 'available' }).entity_id;
  const body = JSON.stringify({ title: '合成标题', description: '合成正文\n第二段', author_name: '合成作者' });
  const bodyRef = join(root, 'body.json');
  await writeFile(bodyRef, body);
  const materialId = saveMaterialVersion(store, {
    content_id: contentId, body_ref: bodyRef, body, media_kind: 'text', completeness: 'complete',
  }).entity_id;
  const baselineSourceId = 'fedcba9876543210fedcba98';
  const baselineContentId = saveContent(store, { platform: 'xiaohongshu', content_id: baselineSourceId, source_state: 'available' }).entity_id;
  const baselineBody = JSON.stringify({ title: '合成基线标题', description: '合成基线正文', author_name: '合成基线作者' });
  const baselineBodyRef = join(root, 'baseline-body.json');
  await writeFile(baselineBodyRef, baselineBody);
  const baselineMaterialId = saveMaterialVersion(store, {
    content_id: baselineContentId, body_ref: baselineBodyRef, body: baselineBody, media_kind: 'text', completeness: 'complete',
  }).entity_id;
  insert('baseline_version', {
    baseline_version: baseline,
    material_version_ids_json: JSON.stringify([baselineMaterialId]),
    coverage_description: JSON.stringify({ material_ids: [baselineMaterialId], coverage: { input_complete: true } }),
    created_at: at,
  });
  const collectionId = randomUUID();
  insert('collection_batch', {
    collection_batch_id: collectionId, observed_from: '2026-10-23', observed_until: '2026-10-23',
    coverage_json: '{"input_complete":true}', total_known: 1, created_at: at,
  });
  insert('collection_observation', {
    collection_observation_id: randomUUID(), collection_batch_id: collectionId, content_id: baselineContentId,
    observed_at: at, membership: 'present', evidence_ref: 'synthetic:baseline-favorite',
  });
  const analysisId = randomUUID();
  const candidateId = randomUUID();
  const decisionId = randomUUID();
  const sourceEvidence = join(root, 'source.json');
  await writeFile(sourceEvidence, JSON.stringify({ observations: [{
    content_id: sourceContentId,
    complete_source_url: `https://www.xiaohongshu.com/explore/${sourceContentId}?synthetic=1`,
  }] }));
  insert('analysis', { analysis_id: analysisId, material_version_id: materialId, input_hash: sha(body), prompt_version: 'synthetic', model_requested: 'synthetic', output_ref: 'synthetic:analysis', completion_evidence: 'synthetic:complete', status: 'complete', created_at: at });
  insert('candidate', { candidate_id: candidateId, content_id: contentId, discovery_batch_id: batchId, source: 'homefeed', discovered_at: at, source_evidence_ref: `file:${sourceEvidence}`, eligibility_state: 'eligible' });
  insert('decision', { decision_id: decisionId, candidate_id: candidateId, analysis_id: analysisId, baseline_version: baseline, preference_version: preference, strategy_version: strategy, category: 'follow', relevance: 'matched', gain_state: 'gain', result: 'eligible', created_at: at });

  const display = createDisplay({ store, root: join(root, 'display'), owner, appRef: 'synthetic-app', now: () => at });
  const built = await display.buildBatch(batchId, [{ decision_id: decisionId, candidate_id: candidateId, content_id: contentId }]);
  if (built.items[0]?.status !== 'succeeded') throw new Error(`synthetic display fixture failed: ${JSON.stringify(built.items[0])}`);
  const recommendation = built.items[0];
  const versions = {
    preference_version: preference,
    strategy_version: strategy,
    baseline_version: baseline,
  };
  const currentVersions = () => versions;
  const generation = store.db.prepare("SELECT generation FROM execution_slot WHERE slot_key='main'").get().generation;
  return {
    root, dbPath, get store() { return store; }, reopen() { store.close(); store = openStore(dbPath); return store; },
    owner, batchId, sourceContentId, contentId, materialId, baselineContentId, baselineMaterialId, analysisId, sourceEvidence,
    preferenceReceiptRef,
    recommendation, versions, currentVersions, generation,
    read: async ref => JSON.parse(await readFile(ref, 'utf8')),
  };
}
