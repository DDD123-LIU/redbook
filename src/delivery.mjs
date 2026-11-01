import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateRequest } from './display.mjs';
import { readVerifiedPreference } from './preference.mjs';
import { readCurrentStrategy } from './quality.mjs';
import { verifyBodyTrialDecision } from './candidates.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const evidenceRefs = value => (Array.isArray(value) ? value : value == null ? [] : [value])
  .filter(item => typeof item === 'string' && item.trim());

function businessDay(value) {
  const parts = Object.fromEntries(DAY_FORMATTER.formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function createDelivery({ store, root, owner, targetRef, appRef, transport, coordination = null, now = () => new Date().toISOString(), currentVersions }) {
  if (!store?.db || !root || !owner || !targetRef || !appRef || typeof transport?.send !== 'function' || typeof transport?.lookup !== 'function') {
    throw new TypeError('store, private root, owner, targetRef, appRef and send/lookup transport are required');
  }
  coordination = coordination ? Object.freeze({ ...coordination }) : null;
  if (coordination && coordination.owner !== owner) throw new Error('delivery coordinator owner mismatch');
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const at = () => new Date(now()).toISOString();
  const appHash = hash(appRef);
  const writeExact = (path, value) => {
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(path, bytes, { flag: 'wx' });
    return { ref: path, hash: hash(bytes) };
  };
  const slot = () => store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  const batchDayIsCurrent = batch => batch.status !== 'closed_day' && batch.stop_requested === 0 && batch.business_day === businessDay(at());
  function assertCoordinator(batchId = coordination?.batchId, identity = coordination) {
    if (identity && (identity.owner !== owner || identity.batchId !== batchId)) throw new Error('delivery coordinator owner or batch mismatch');
    store.assertCoordinator(identity, { now: at() });
  }
  function sameCoordinator(left, right) {
    if (left == null || right == null) return left == null && right == null;
    return ['owner', 'batchId', 'runId', 'batchGeneration'].every(key => left[key] === right[key]);
  }

  function readVerifiedFile(ref, expectedHash) {
    if (!ref || !expectedHash) throw new Error('delivery evidence reference or hash missing');
    const bytes = readFileSync(ref);
    if (hash(bytes) !== expectedHash) throw new Error('delivery evidence hash mismatch');
    return JSON.parse(bytes.toString('utf8'));
  }

  function buildArtifact(item) {
    if (!item?.build_ref || !item.build_hash || !item.payload_hash || !item.recommendation_id) throw new Error('complete display build evidence required');
    const proof = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `display-build:${item.recommendation_id}`);
    if (!proof || proof.output_hash !== item.build_hash) throw new Error('display build checkpoint missing or mismatched');
    const checkpointRefs = JSON.parse(proof.succeeded_refs_json);
    if (!checkpointRefs.some(ref => ref.ref === item.build_ref && ref.hash === item.build_hash)) throw new Error('display build checkpoint reference mismatch');
    const artifact = readVerifiedFile(item.build_ref, item.build_hash);
    if (artifact.status !== 'succeeded' || artifact.display_state !== 'complete'
      || artifact.recommendation_id !== item.recommendation_id || artifact.payload_hash !== item.payload_hash
      || !artifact.payload || digest(artifact.payload) !== item.payload_hash) throw new Error('display payload binding invalid');
    for (const key of ['delivery_batch_id', 'decision_id', 'content_id', 'actual_preference_version', 'actual_strategy_version']) {
      if (artifact[key] !== item[key]) throw new Error(`display ${key} binding mismatch`);
    }
    return artifact;
  }

  function latestObservation(contentId) {
    return store.db.prepare(`SELECT membership FROM collection_observation WHERE content_id=?
      ORDER BY observed_at DESC,rowid DESC LIMIT 1`).get(contentId)?.membership ?? null;
  }

  function databaseCurrentVersions(batch, decision, recommendation) {
    let current;
    const fullDecision=store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(recommendation.decision_id);
    const trial=verifyBodyTrialDecision(store,owner,fullDecision);
    if(trial){
      current={preference_version:fullDecision.preference_version,baseline_version:fullDecision.baseline_version};
    }else if (typeof currentVersions === 'function') {
      current = currentVersions();
      if (!current || typeof current !== 'object') throw new Error('current version evidence unavailable');
    } else {
      const preference = readVerifiedPreference(store, owner);
      if (!preference) throw new Error('current preference evidence invalid');
      const baseline = store.db.prepare("SELECT * FROM baseline_version WHERE CASE WHEN json_valid(coverage_description) THEN coalesce(json_extract(coverage_description,'$.kind'),'')<>'accepted_body_trial' ELSE 1 END ORDER BY created_at DESC,rowid DESC LIMIT 1").get();
      if (!baseline) throw new Error('current baseline evidence missing');
      let descriptor;
      try { descriptor = JSON.parse(baseline.coverage_description); } catch { throw new Error('current baseline evidence invalid'); }
      if (descriptor.coverage?.input_complete !== true) throw new Error('current baseline is incomplete');
      const currentContentIds = store.db.prepare(`SELECT c.content_id FROM content c WHERE
      EXISTS (SELECT 1 FROM collection_observation o WHERE o.content_id=c.content_id
        AND o.collection_observation_id=(SELECT latest.collection_observation_id FROM collection_observation latest WHERE latest.content_id=c.content_id ORDER BY latest.observed_at DESC,latest.rowid DESC LIMIT 1)
        AND o.membership='present')
      OR EXISTS (SELECT 1 FROM delivered_content d WHERE d.owner=? AND d.platform=c.platform AND d.source_content_id=c.source_content_id)`)
        .all(owner).map(row => row.content_id).sort();
      const baselineRows = store.db.prepare(`SELECT m.content_id,m.material_version_id FROM material_version m
      WHERE m.material_version_id IN (SELECT value FROM json_each(?))`).all(baseline.material_version_ids_json);
      const baselineContentIds = [...new Set(baselineRows.map(row => row.content_id))].sort();
      if (JSON.stringify(currentContentIds) !== JSON.stringify(baselineContentIds)) throw new Error('current baseline membership changed');
      for (const row of baselineRows) {
        const latest = store.db.prepare(`SELECT material_version_id FROM material_version WHERE content_id=? AND fetch_status='succeeded'
        ORDER BY fetched_at DESC,rowid DESC LIMIT 1`).get(row.content_id);
        if (latest?.material_version_id !== row.material_version_id) throw new Error('current baseline material changed');
      }
      current = { preference_version: preference.preference_version, baseline_version: baseline.baseline_version };
    }
    const strategy = readCurrentStrategy(store, owner, at());
    if (current.strategy_version && current.strategy_version !== strategy.strategy_version) throw new Error('current strategy evidence is stale');
    return { ...current, strategy_version: strategy.strategy_version };
  }

  function checkCurrent({ item, recommendation, decision, batch, expectedGeneration, requirePending = true, coordinator = coordination, allowCancelled = false }) {
    assertCoordinator(item.delivery_batch_id, coordinator);
    if (!batch || batch.owner !== owner || !batchDayIsCurrent(batch)) throw new Error('delivery batch is stopped, closed or from another day');
    if (recommendation.recommendation_id !== item.recommendation_id || recommendation.content_id !== item.content_id
      || recommendation.delivery_batch_id !== item.delivery_batch_id || recommendation.decision_id !== item.decision_id
      || recommendation.actual_preference_version !== item.actual_preference_version
      || recommendation.actual_strategy_version !== item.actual_strategy_version) throw new Error('recommendation binding changed');
    const allowedStates = requirePending ? ['pending', 'failed', ...(allowCancelled ? ['cancelled_before_dispatch'] : [])] : ['pending', 'intent'];
    if (!allowedStates.includes(recommendation.state)) {
      if (requirePending) throw new Error('recommendation is not pending or retryable');
      throw new Error('recommendation cannot be dispatched');
    }
    const fullDecision=decision&&store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(item.decision_id);
    const trial=verifyBodyTrialDecision(store,owner,fullDecision);
    if (!decision || !trial && decision.result !== 'eligible' || decision.baseline_version !== item.baseline_version
      || decision.preference_version !== item.actual_preference_version || decision.strategy_version !== item.actual_strategy_version
      || decision.category !== item.category) throw new Error('decision is no longer eligible or its versions changed');
    const candidate = store.db.prepare('SELECT eligibility_state FROM candidate WHERE candidate_id=?').get(decision.candidate_id);
    if (!trial && candidate?.eligibility_state !== 'eligible') throw new Error('candidate is no longer eligible');
    const current = databaseCurrentVersions(batch, decision, recommendation);
    if (current.preference_version !== item.actual_preference_version || current.strategy_version !== item.actual_strategy_version
      || current.baseline_version !== decision.baseline_version) throw new Error('delivery versions are no longer current');
    const activeStrategy = store.db.prepare("SELECT state FROM strategy_version WHERE strategy_version=?").get(current.strategy_version);
    if (activeStrategy?.state !== 'active') throw new Error('delivery strategy is not active');
    const observed = latestObservation(recommendation.content_id);
    if (observed === 'present') throw new Error('favorite state blocks delivery');
    const content = store.db.prepare('SELECT platform,source_content_id FROM content WHERE content_id=?').get(item.content_id);
    if (!content) throw new Error('delivery content missing');
    const prior = store.db.prepare(`SELECT a.status FROM delivery_attempt a
      JOIN recommendation r ON r.recommendation_id=a.recommendation_id
      JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      JOIN content c ON c.content_id=r.content_id
      WHERE b.owner=? AND c.platform=? AND c.source_content_id=? AND a.delivery_attempt_id<>coalesce(?, '')
        AND a.status IN ('intent','unknown','succeeded') LIMIT 1`).get(owner, content.platform, content.source_content_id, item.attempt_id ?? null);
    if (prior) throw new Error(`content already has ${prior.status} delivery`);
    const currentSlot = slot();
    if (currentSlot.stop_requested || currentSlot.generation !== expectedGeneration
      || !['idle', 'stopped'].includes(currentSlot.state) || currentSlot.owner !== null || currentSlot.run_id !== null) {
      throw new Error('execution slot stopped or generation changed');
    }
    return { content, slot: currentSlot };
  }

  function attemptCheckpoint(attemptId) {
    const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `delivery-attempt:${attemptId}`);
    if (!row) return null;
    const ref = JSON.parse(row.succeeded_refs_json)[0];
    return { row, ref, value: readVerifiedFile(ref?.ref, ref?.hash) };
  }

  function receiptCheckpointStatus(attemptId, receiptPath, receiptHash) {
    const rows = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC')
      .all(owner, `delivery-attempt:${attemptId}`);
    for (const row of rows) {
      try {
        const ref = JSON.parse(row.succeeded_refs_json)[0];
        const state = readVerifiedFile(ref.ref, ref.hash);
        if (state.receipt_ref !== receiptPath) continue;
        return state.receipt_hash === receiptHash ? 'verified' : 'mismatch';
      } catch { continue; }
    }
    return 'missing';
  }

  function verifyAccountedReceipt(attempt) {
    const rows = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC')
      .all(owner, `delivery-attempt:${attempt.delivery_attempt_id}`);
    for (const row of rows) {
      try {
        const ref = JSON.parse(row.succeeded_refs_json)[0];
        const state = readVerifiedFile(ref.ref, ref.hash);
        if (!state.receipt_ref || !state.receipt_hash || !existsSync(state.receipt_ref)) continue;
        const receipt = readVerifiedFile(state.receipt_ref, state.receipt_hash);
        if (!verifyReceipt(attempt, receipt) || receipt.result?.status !== attempt.status) continue;
        const queryEvidence = evidenceRefs(receipt.result.evidence_refs ?? receipt.result.evidence);
        const storedQueryEvidence = JSON.parse(attempt.query_evidence_refs_json ?? '[]');
        const storedVerificationEvidence = JSON.parse(attempt.verification_evidence_refs_json ?? '[]');
        if (!queryEvidence.length || JSON.stringify(queryEvidence) !== JSON.stringify(storedQueryEvidence)) continue;
        if (attempt.status === 'succeeded') {
          if (typeof attempt.message_id !== 'string' || !attempt.message_id.trim()
            || receipt.result.message_id !== attempt.message_id
            || JSON.stringify(storedVerificationEvidence) !== JSON.stringify([state.receipt_ref, ...queryEvidence])) continue;
        } else if (attempt.status === 'failed') {
          if (attempt.message_id !== null || storedVerificationEvidence.length !== 0) continue;
        } else continue;
        return receipt;
      } catch { /* 损坏的旧checkpoint不代替后续有效证据。 */ }
    }
    throw new Error('evidence_unverifiable: accounted delivery receipt missing or corrupt or inconsistent');
  }

  function checkpointReceipt(attemptId, receipt, runId, generation) {
    store.transaction(() => saveCheckpoint(attemptId, receipt.delivery_batch_id, receipt,
      { run_id: runId, generation }));
  }

  function saveCheckpoint(attemptId, batchId, value, token) {
    const proof = writeExact(join(root, `delivery-${attemptId}-${randomUUID()}.json`), value);
    return recordCheckpoint(attemptId, batchId, value, token, proof);
  }

  function recordCheckpoint(attemptId, batchId, value, token, proof) {
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,input_hash,output_hash,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), owner, token.run_id, token.generation, batchId,
      `delivery-attempt:${attemptId}`, JSON.stringify([proof]), digest(value), proof.hash, at());
    return proof;
  }

  function persistReceipt(attempt, envelope, path = join(root, `receipt-${attempt.delivery_attempt_id}.json`)) {
    if (existsSync(path)) return readVerifiedFile(path, hash(readFileSync(path)));
    const value = {
      attempt_id: attempt.delivery_attempt_id,
      recommendation_id: attempt.recommendation_id,
      owner,
      target_ref: attempt.target_ref,
      app_hash: appHash,
      payload_hash: attempt.payload_hash,
      ...envelope,
      received_at: at(),
    };
    const proof = writeExact(path, value);
    value.receipt_ref = proof.ref;
    value.receipt_hash = proof.hash;
    return value;
  }

  function cancelBeforeDispatch({ attempt, context, recommendation, decision, batch, reason, decisionInvalidated = false,
    evidence, cancellationEvidence = null, workerProof = {}, checkpointIdentity = {}, preparedCheckpoint = null }) {
    const updated = store.db.prepare(`UPDATE delivery_attempt SET status='cancelled_before_dispatch',returned_at=?,
      query_evidence_refs_json=?,revision=revision+1,updated_at=?
      WHERE delivery_attempt_id=? AND status='intent' AND revision=? AND dispatched_at IS NULL`)
      .run(at(), JSON.stringify(evidence), at(), attempt.delivery_attempt_id, attempt.revision);
    if (updated.changes !== 1) return { status: 'dispatch_claim_lost', attempt_id: attempt.delivery_attempt_id };
    if (recommendation?.state === 'intent') {
      const recommendationUpdate = store.casState({ entity: 'recommendation', entity_id: recommendation.recommendation_id,
        expectedState: 'intent', expectedRevision: recommendation.revision, nextState: 'cancelled_before_dispatch', evidence_refs: evidence });
      if (recommendationUpdate.status !== 'succeeded') throw new Error('recommendation cancellation CAS rejected');
    }
    if (preparedCheckpoint) {
      recordCheckpoint(attempt.delivery_attempt_id, context.delivery_batch_id, preparedCheckpoint.value,
        preparedCheckpoint.identity, preparedCheckpoint.proof);
    } else {
      const latestVersions = (() => { try { return databaseCurrentVersions(batch, decision, recommendation); } catch { return null; } })();
      saveCheckpoint(attempt.delivery_attempt_id, context.delivery_batch_id, { ...context, phase: 'cancelled_before_dispatch',
        cancellation_reason: reason, decision_invalidated: decisionInvalidated, observed_versions: latestVersions,
        cancellation_evidence_refs: evidence, cancellation_evidence_ref: cancellationEvidence?.ref ?? null,
        cancellation_evidence_hash: cancellationEvidence?.hash ?? null, cancelled_at: at(), ...workerProof },
      { run_id: checkpointIdentity.run_id ?? context.run_id ?? `cancel-${attempt.delivery_attempt_id}`,
        generation: checkpointIdentity.generation ?? context.generation ?? 0 });
    }
    return { status: 'cancelled_before_dispatch', attempt_id: attempt.delivery_attempt_id, decision_invalidated: decisionInvalidated, reason };
  }

  function preparedIntent(attempt) {
    const checkpoint = attemptCheckpoint(attempt.delivery_attempt_id);
    if (!checkpoint) throw new Error('prepared delivery intent checkpoint missing');
    const { row, ref, value } = checkpoint;
    const mismatch = ['owner', 'delivery_batch_id', 'output_hash', 'attempt_id', 'checkpoint_owner', 'target_ref', 'app_hash',
      'recommendation_id', 'checkpoint_batch', 'attempt_target', 'payload_hash', 'intent_ref', 'intent_hash'].filter(field => ({
        owner: row.owner !== owner, delivery_batch_id: row.delivery_batch_id !== value.delivery_batch_id, output_hash: row.output_hash !== ref?.hash,
        attempt_id: value.attempt_id !== attempt.delivery_attempt_id, checkpoint_owner: value.owner !== owner, target_ref: value.target_ref !== targetRef,
        app_hash: value.app_hash !== appHash, recommendation_id: value.recommendation_id !== attempt.recommendation_id,
        checkpoint_batch: value.delivery_batch_id !== row.delivery_batch_id, attempt_target: value.target_ref !== attempt.target_ref,
        payload_hash: value.payload_hash !== attempt.payload_hash, intent_ref: !value.intent_ref, intent_hash: !value.intent_hash,
      })[field]);
    if (mismatch.length) throw new Error(`prepared delivery intent checkpoint identity mismatch: ${mismatch.join(',')}`);
    const intent = readVerifiedFile(value.intent_ref, value.intent_hash);
    const fields = ['attempt_id', 'recommendation_id', 'content_id', 'decision_id', 'delivery_batch_id', 'category', 'owner', 'target_ref', 'app_hash',
      'actual_preference_version', 'actual_strategy_version', 'baseline_version', 'ordinal', 'expected_generation', 'build_ref', 'build_hash', 'payload_hash', 'created_at'];
    if (fields.some(field => intent[field] !== value[field]) || intent.attempt_id !== attempt.delivery_attempt_id
      || intent.recommendation_id !== attempt.recommendation_id || intent.delivery_batch_id !== row.delivery_batch_id
      || intent.owner !== owner || intent.target_ref !== targetRef || intent.app_hash !== appHash
      || intent.payload_hash !== attempt.payload_hash || intent.created_at !== attempt.intent_at
      || !sameCoordinator(intent.coordination ?? null, value.coordination ?? null)) {
      throw new Error('prepared delivery intent evidence binding mismatch');
    }
    return { value, row };
  }

  function readCancellationEvidence(ref, attempt, context) {
    const bytes = readFileSync(ref);
    const value = JSON.parse(bytes.toString('utf8'));
    const fields = ['attempt_id', 'recommendation_id', 'content_id', 'decision_id', 'delivery_batch_id', 'owner',
      'target_ref', 'app_hash', 'payload_hash', 'intent_ref', 'intent_hash'];
    if (fields.some(field => value[field] !== context[field]) || value.attempt_id !== attempt.delivery_attempt_id
      || value.recommendation_id !== attempt.recommendation_id || value.owner !== owner || value.target_ref !== targetRef
      || value.app_hash !== appHash || !sameCoordinator(value.coordination ?? null, context.coordination ?? null)) {
      throw new Error('delivery cancellation evidence binding mismatch');
    }
    return { ref, hash: hash(bytes) };
  }

  function cancelPrepared({ attemptId, evidenceRef }) {
    if (!attemptId || typeof evidenceRef !== 'string' || !evidenceRef.trim()) throw new TypeError('attemptId and evidenceRef are required');
    const attempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    if (!attempt) throw new Error('delivery attempt missing');
    if (attempt.status === 'succeeded' || attempt.status === 'failed') {
      verifyAccountedReceipt(attempt);
      return { status: attempt.status, attempt_id: attemptId };
    }
    if (attempt.status !== 'intent' || attempt.dispatched_at) {
      if (attempt.status === 'cancelled_before_dispatch') {
        const prepared = preparedIntent(attempt);
        if (prepared.value.cancellation_evidence_ref) {
          const proof = readCancellationEvidence(evidenceRef, attempt, prepared.value);
          if (proof.ref !== prepared.value.cancellation_evidence_ref || proof.hash !== prepared.value.cancellation_evidence_hash) {
            throw new Error('delivery cancellation evidence changed after cancellation');
          }
        }
      }
      return { status: attempt.status, attempt_id: attemptId,
        ...(attempt.dispatched_at ? { reason: 'dispatch_claim_already_exists' } : {}) };
    }
    const prepared = preparedIntent(attempt);
    const context = prepared.value;
    const cancellationEvidence = readCancellationEvidence(evidenceRef, attempt, context);
    const recommendationBefore = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(attempt.recommendation_id);
    const decisionBefore = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(context.decision_id);
    const batchBefore = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(context.delivery_batch_id);
    if (!recommendationBefore || !decisionBefore || !batchBefore || batchBefore.owner !== owner
      || recommendationBefore.delivery_batch_id !== context.delivery_batch_id || recommendationBefore.content_id !== context.content_id
      || recommendationBefore.decision_id !== context.decision_id) throw new Error('prepared delivery intent ownership or batch binding mismatch');
    const latestVersions = (() => { try { return databaseCurrentVersions(batchBefore, decisionBefore, recommendationBefore); } catch { return null; } })();
    const cancelledAt = at();
    const checkpointValue = { ...context, phase: 'cancelled_before_dispatch', cancellation_reason: 'explicit_cancel_prepared',
      decision_invalidated: false, observed_versions: latestVersions, cancellation_evidence_refs: [evidenceRef],
      cancellation_evidence_ref: cancellationEvidence.ref, cancellation_evidence_hash: cancellationEvidence.hash, cancelled_at: cancelledAt };
    const checkpointProof = writeExact(join(root, `delivery-${attemptId}-${randomUUID()}.json`), checkpointValue);
    const preparedCheckpoint = { value: checkpointValue, proof: checkpointProof,
      identity: { run_id: prepared.row.run_id, generation: prepared.row.generation } };
    const result = store.transaction(() => {
      const current = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
      if (!current || current.status !== 'intent' || current.dispatched_at) return { status: current?.status ?? 'unknown', attempt_id: attemptId,
        ...(current?.dispatched_at ? { reason: 'dispatch_claim_already_exists' } : {}) };
      if (current.revision !== attempt.revision) return { status: current.status, attempt_id: attemptId, reason: 'attempt_revision_changed' };
      const latestProof = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, `delivery-attempt:${attemptId}`);
      if (!latestProof || latestProof.checkpoint_id !== prepared.row.checkpoint_id || latestProof.output_hash !== prepared.row.output_hash
        || latestProof.run_id !== prepared.row.run_id || latestProof.generation !== prepared.row.generation
        || latestProof.delivery_batch_id !== context.delivery_batch_id) throw new Error('prepared intent checkpoint changed before cancellation');
      const recommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(current.recommendation_id);
      const decision = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(context.decision_id);
      const batch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(context.delivery_batch_id);
      const candidate = decision && store.db.prepare('SELECT * FROM candidate WHERE candidate_id=?').get(decision.candidate_id);
      if (!recommendation || !decision || !batch || batch.owner !== owner || recommendation.delivery_batch_id !== context.delivery_batch_id
        || recommendation.content_id !== context.content_id || recommendation.decision_id !== context.decision_id
        || candidate?.content_id !== context.content_id || candidate?.discovery_batch_id !== context.delivery_batch_id) {
        throw new Error('prepared delivery intent ownership or batch binding mismatch');
      }
      return cancelBeforeDispatch({ attempt: current, context, recommendation, decision, batch,
        reason: 'explicit_cancel_prepared', evidence: [evidenceRef], cancellationEvidence,
        checkpointIdentity: preparedCheckpoint.identity, preparedCheckpoint });
    });
    if (result.status === 'dispatch_claim_lost') {
      const latest = store.db.prepare('SELECT status,dispatched_at FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
      return { status: latest?.status ?? 'unknown', attempt_id: attemptId,
        ...(latest?.dispatched_at ? { reason: 'dispatch_claim_already_exists' } : { reason: 'dispatch_claim_lost' }) };
    }
    return result;
  }

  function continueProof(continueCommandId, previousCoordination) {
    if (!coordination || typeof continueCommandId !== 'string' || !continueCommandId.trim()) {
      throw new TypeError('continueCommandId and active delivery coordination are required');
    }
    assertCoordinator(coordination.batchId, coordination);
    const head = store.db.prepare("SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get();
    const proof = head && JSON.parse(head.succeeded_refs_json).find(ref => ref?.orchestration)?.orchestration;
    if (!head || !proof || hash(JSON.stringify(proof)) !== head.output_hash || proof.active !== true
      || head.owner !== owner || head.run_id !== coordination.runId || head.generation !== coordination.batchGeneration
      || head.delivery_batch_id !== coordination.batchId || proof.owner !== owner || proof.batchId !== coordination.batchId
      || proof.runId !== coordination.runId || proof.batchGeneration !== coordination.batchGeneration
      || proof.continued_from !== coordination.continuedFromRunId
      || coordination.continuedFromGeneration !== coordination.batchGeneration - 1
      || typeof proof.evidence_ref !== 'string' || !proof.evidence_ref.trim()
      || !previousCoordination || previousCoordination.owner !== owner || previousCoordination.batchId !== coordination.batchId
      || !Number.isSafeInteger(previousCoordination.batchGeneration) || previousCoordination.batchGeneration < 1
      || previousCoordination.batchGeneration >= coordination.batchGeneration || !previousCoordination.runId) {
      throw new Error('explicit continue coordinator proof is missing or mismatched');
    }
    const currentBatch = store.db.prepare('SELECT generation FROM batch WHERE owner=? AND delivery_batch_id=?').get(owner, coordination.batchId);
    if (currentBatch?.generation !== coordination.batchGeneration) throw new Error('continue batch generation is stale');
    const chain = [];
    let runId = coordination.runId;
    for (let generation = coordination.batchGeneration; generation >= previousCoordination.batchGeneration; generation--) {
      const node = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(owner, runId, generation, coordination.batchId);
      let nodeProof;
      try { nodeProof = node && JSON.parse(node.succeeded_refs_json).find(ref => ref?.orchestration)?.orchestration; } catch {}
      if (!node || !nodeProof || hash(JSON.stringify(nodeProof)) !== node.output_hash
        || node.owner !== owner || node.run_id !== runId || node.generation !== generation
        || node.delivery_batch_id !== coordination.batchId || nodeProof.owner !== owner
        || nodeProof.batchId !== coordination.batchId || nodeProof.runId !== runId
        || nodeProof.batchGeneration !== generation || typeof nodeProof.active !== 'boolean'
        || nodeProof.active !== (JSON.parse(node.pending_ids_json).length > 0)) {
        throw new Error('continue lineage main checkpoint is missing or invalid');
      }
      if (generation === coordination.batchGeneration) {
        if (node.checkpoint_id !== head.checkpoint_id || !nodeProof.active
          || nodeProof.continued_from !== coordination.continuedFromRunId) throw new Error('continue lineage terminal head is stale');
      } else if (nodeProof.active || nodeProof.invocation_state !== 'returned') {
        throw new Error('continue lineage parent is active or unreturned');
      }
      chain.push({ generation, run_id: runId, row: node, proof: nodeProof });
      if (generation === previousCoordination.batchGeneration) break;
      if (typeof nodeProof.continued_from !== 'string' || !nodeProof.continued_from.trim()
        || typeof nodeProof.evidence_ref !== 'string' || !nodeProof.evidence_ref.trim()) {
        throw new Error('continue lineage parent link is missing');
      }
      const commandRows = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage LIKE 'orchestration:command:%' ORDER BY rowid`)
        .all(owner, runId, generation, coordination.batchId);
      if (commandRows.length !== 1) throw new Error('continue lineage command checkpoint is missing or ambiguous');
      const command = commandRows[0];
      let saved;
      try { saved = JSON.parse(command.succeeded_refs_json)[0]; } catch { throw new Error('continue lineage command checkpoint is unreadable'); }
      const stage = typeof saved?.command_id === 'string' && saved.command_id.trim()
        ? `orchestration:command:${hash(saved.command_id)}` : null;
      const firstHead = store.db.prepare(`SELECT rowid AS checkpoint_rowid FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid LIMIT 1`)
        .get(owner, runId, generation, coordination.batchId);
      if (!stage || command.stage !== stage || command.run_id !== runId || command.generation !== generation
        || command.delivery_batch_id !== coordination.batchId || command.input_hash !== hash(saved.command_id)
        || command.output_hash !== hash(JSON.stringify(saved))
        || saved.batch_id !== coordination.batchId || saved.run_id !== runId || saved.generation !== generation
        || !firstHead || command.checkpoint_rowid <= firstHead.checkpoint_rowid
        || (generation === coordination.batchGeneration && saved.command_id !== continueCommandId)) {
        throw new Error('continue lineage command identity or hash is invalid');
      }
      const parentRunId = nodeProof.continued_from;
      const parent = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(owner, parentRunId, generation - 1, coordination.batchId);
      if (!parent || parent.checkpoint_rowid >= firstHead.checkpoint_rowid) throw new Error('continue lineage row order is invalid');
      runId = parentRunId;
    }
    const origin = chain.at(-1);
    if (!origin || origin.run_id !== previousCoordination.runId
      || origin.generation !== previousCoordination.batchGeneration) throw new Error('continue lineage does not reach the original attempt');
    for (const node of chain.slice(1)) {
      if (node.proof.invocation_state !== 'returned' || !Array.isArray(node.proof.phase_refs)
        || !Array.isArray(node.proof.worker_refs)) throw new Error('continue lineage returned phase or worker proof is missing');
      for (const stage of ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery']) {
        const ref = node.proof.phase_refs.find(item => item.stage === stage);
        if (!ref || !ref.checkpoint_id || !ref.output_hash) throw new Error('continue lineage phase checkpoint reference is missing');
        const phaseRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND checkpoint_id=? AND stage=?')
          .get(owner, ref.checkpoint_id, `orchestration:phase:${coordination.batchId}:${stage}`);
        let phase;
        try { phase = phaseRow && JSON.parse(phaseRow.succeeded_refs_json)[0]?.orchestration_phase; } catch {}
        if (!phaseRow || phaseRow.run_id !== node.run_id || phaseRow.generation !== node.generation
          || phaseRow.delivery_batch_id !== coordination.batchId || phaseRow.output_hash !== ref.output_hash
          || phaseRow.output_hash !== hash(JSON.stringify(phase)) || ref.status !== phase.status
          || !['succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'invalidated'].includes(phase.status)) {
          throw new Error('continue lineage phase checkpoint is invalid');
        }
      }
    }
    const commandStage = `orchestration:command:${hash(continueCommandId)}`;
    const command = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner, commandStage);
    const saved = command && JSON.parse(command.succeeded_refs_json)[0];
    if (!command || !saved || command.owner !== owner || command.run_id !== coordination.runId
      || command.generation !== coordination.batchGeneration || command.delivery_batch_id !== coordination.batchId
      || command.input_hash !== hash(continueCommandId) || command.output_hash !== hash(JSON.stringify(saved))
      || saved.command_id !== continueCommandId || saved.batch_id !== coordination.batchId
      || saved.run_id !== coordination.runId || saved.generation !== coordination.batchGeneration) {
      throw new Error('continue command checkpoint is missing or mismatched');
    }
    return { proof, command, saved };
  }

  async function reprepareCancelled({ attemptId, item, continueCommandId, evidenceRef, expectedGeneration }) {
    if (!attemptId || !item || !continueCommandId || !evidenceRef || expectedGeneration == null) {
      throw new TypeError('attemptId, item, continueCommandId, cancellation evidenceRef and expectedGeneration are required');
    }
    const oldAttempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    if (!oldAttempt) throw new Error('cancelled delivery attempt missing');
    const cancellation = cancelPrepared({ attemptId, evidenceRef });
    if (cancellation.status !== 'cancelled_before_dispatch') throw new Error('only an undispatched cancelled attempt can be reprepared');
    const oldPrepared = preparedIntent(store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId));
    const oldContext = oldPrepared.value;
    const cancellationProof = readCancellationEvidence(evidenceRef, oldAttempt, oldContext);
    if (oldAttempt.status !== 'cancelled_before_dispatch' || oldAttempt.dispatched_at
      || oldContext.phase !== 'cancelled_before_dispatch' || oldContext.cancellation_evidence_ref !== cancellationProof.ref
      || oldContext.cancellation_evidence_hash !== cancellationProof.hash
      || !(oldContext.cancellation_evidence_refs ?? []).includes(evidenceRef)
      || !oldContext.coordination || oldContext.owner !== owner || oldContext.target_ref !== targetRef || oldContext.app_hash !== appHash) {
      throw new Error('original cancellation proof does not authorize reprepare');
    }
    if (item.recommendation_id !== oldAttempt.recommendation_id || item.delivery_batch_id !== oldContext.delivery_batch_id
      || item.content_id !== oldContext.content_id || item.decision_id !== oldContext.decision_id
      || item.ordinal !== oldContext.ordinal || item.payload_hash !== oldContext.payload_hash
      || item.build_ref !== oldContext.build_ref || item.build_hash !== oldContext.build_hash) {
      throw new Error('reprepare item identity differs from the cancelled intent');
    }
    const mappingStage = `delivery-reprepare:${attemptId}:${hash(continueCommandId)}`;
    const existing = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner, mappingStage);
    const authority = continueProof(continueCommandId, oldContext.coordination);
    if (existing) {
      const mapped = JSON.parse(existing.succeeded_refs_json)[0];
      if (existing.output_hash !== hash(JSON.stringify(mapped)) || !sameCoordinator(mapped.coordination, coordination)
        || mapped.previous_attempt_id !== attemptId || mapped.continue_command_id !== continueCommandId) {
        throw new Error('reprepare idempotency checkpoint is invalid');
      }
      const next = store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(mapped.attempt_id);
      if (!next) throw new Error('reprepared delivery attempt is missing');
      return { status: next.status, attempt_id: mapped.attempt_id, entity_id: mapped.attempt_id, duplicate: true };
    }
    const artifact = buildArtifact(item);
    if (artifact.payload_hash !== oldContext.payload_hash || digest(artifact.payload) !== oldContext.payload_hash) {
      throw new Error('reprepare payload differs from the cancelled intent');
    }
    const recommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(oldAttempt.recommendation_id);
    const decision = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(oldContext.decision_id);
    const batch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(oldContext.delivery_batch_id);
    const currentItem = { ...item, baseline_version: oldContext.baseline_version, attempt_id: attemptId };
    checkCurrent({ item: currentItem, recommendation, decision, batch, expectedGeneration, allowCancelled: true });
    const request = { receive_id: targetRef, msg_type: artifact.payload.msg_type, content: artifact.payload.content, uuid: item.recommendation_id };
    const validRequest = validateRequest(artifact.payload, { receive_id: targetRef, uuid: item.recommendation_id });
    if (validRequest.status !== 'succeeded') throw new Error('reprepared delivery request exceeds verified capacity');

    const nextAttemptId = randomUUID();
    const createdAt = at();
    const intent = { attempt_id: nextAttemptId, previous_attempt_id: attemptId, continue_command_id: continueCommandId,
      cancellation_evidence_ref: cancellationProof.ref, cancellation_evidence_hash: cancellationProof.hash,
      recommendation_id: item.recommendation_id, delivery_batch_id: item.delivery_batch_id, decision_id: item.decision_id,
      content_id: item.content_id, category: item.category, actual_preference_version: item.actual_preference_version,
      actual_strategy_version: item.actual_strategy_version, baseline_version: oldContext.baseline_version, ordinal: oldContext.ordinal,
      coordination, owner, target_ref: targetRef, app_hash: appHash, expected_generation: expectedGeneration,
      build_ref: oldContext.build_ref, build_hash: oldContext.build_hash, payload_hash: oldContext.payload_hash,
      payload: artifact.payload, request, versions: oldContext.versions, created_at: createdAt };
    const intentFile = writeExact(join(root, `intent-${nextAttemptId}.json`), intent);
    const proofValue = { ...intent, intent_ref: intentFile.ref, intent_hash: intentFile.hash };
    const checkpointFile = writeExact(join(root, `delivery-${nextAttemptId}-${randomUUID()}.json`), proofValue);
    return store.transaction(() => {
      const liveOld = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
      const liveOldProof = preparedIntent(liveOld);
      const liveCancellation = readCancellationEvidence(evidenceRef, liveOld, liveOldProof.value);
      if (liveOld.status !== 'cancelled_before_dispatch' || liveOld.dispatched_at || liveOld.revision !== oldAttempt.revision
        || liveOldProof.row.checkpoint_id !== oldPrepared.row.checkpoint_id
        || liveCancellation.hash !== cancellationProof.hash || liveCancellation.ref !== cancellationProof.ref) {
        throw new Error('cancelled attempt changed before reprepare');
      }
      continueProof(continueCommandId, oldContext.coordination);
      const liveMapping = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, mappingStage);
      if (liveMapping) {
        const mapped = JSON.parse(liveMapping.succeeded_refs_json)[0];
        if (liveMapping.output_hash !== hash(JSON.stringify(mapped)) || !sameCoordinator(mapped.coordination, coordination)
          || mapped.previous_attempt_id !== attemptId || mapped.continue_command_id !== continueCommandId) {
          throw new Error('reprepare idempotency checkpoint is invalid');
        }
        const next = store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(mapped.attempt_id);
        if (!next) throw new Error('reprepared delivery attempt is missing');
        return { status: next.status, attempt_id: mapped.attempt_id, entity_id: mapped.attempt_id, duplicate: true };
      }
      const liveRecommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(item.recommendation_id);
      const liveDecision = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(oldContext.decision_id);
      const liveBatch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(item.delivery_batch_id);
      checkCurrent({ item: currentItem, recommendation: liveRecommendation, decision: liveDecision, batch: liveBatch,
        expectedGeneration, allowCancelled: true });
      const toPending = store.casState({ entity: 'recommendation', entity_id: item.recommendation_id,
        expectedState: 'cancelled_before_dispatch', expectedRevision: liveRecommendation.revision,
        nextState: 'pending', evidence_refs: [evidenceRef] });
      if (toPending.status !== 'succeeded') throw new Error('cancelled recommendation pending CAS rejected');
      const pending = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(item.recommendation_id);
      store.db.prepare(`INSERT INTO delivery_attempt(delivery_attempt_id,recommendation_id,target_ref,payload_hash,intent_at,status,created_at)
        VALUES(?,?,?,?,?,'intent',?)`).run(nextAttemptId, item.recommendation_id, targetRef, intent.payload_hash, createdAt, createdAt);
      const toIntent = store.casState({ entity: 'recommendation', entity_id: item.recommendation_id,
        expectedState: 'pending', expectedRevision: pending.revision, nextState: 'intent', evidence_refs: [intentFile.ref] });
      if (toIntent.status !== 'succeeded') throw new Error('reprepared recommendation intent CAS rejected');
      const liveSlot = slot();
      recordCheckpoint(nextAttemptId, item.delivery_batch_id, proofValue,
        { run_id: `prepare-${nextAttemptId}`, generation: liveSlot.generation }, checkpointFile);
      const mapped = { previous_attempt_id: attemptId, continue_command_id: continueCommandId,
        attempt_id: nextAttemptId, coordination };
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,input_hash,output_hash,committed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
        mappingStage, JSON.stringify([mapped]), hash(continueCommandId), hash(JSON.stringify(mapped)), at());
      return { status: 'succeeded', attempt_id: nextAttemptId, entity_id: nextAttemptId, evidence_refs: [intentFile.ref] };
    });
  }

  function verifyReceipt(attempt, receipt) {
    return receipt?.attempt_id === attempt.delivery_attempt_id && receipt.recommendation_id === attempt.recommendation_id
      && receipt.owner === owner && receipt.target_ref === attempt.target_ref && receipt.app_hash === appHash
      && receipt.payload_hash === attempt.payload_hash && receipt.received_at;
  }

  function account(attempt, result, receipt) {
    const verified = verifyReceipt(attempt, receipt);
    if (!verified) throw new Error('delivery receipt does not match attempt');
    const receivedEvidence = evidenceRefs(result.evidence_refs ?? result.evidence);
    const status = result.status === 'succeeded' && typeof result.message_id === 'string' && result.message_id.trim() && receivedEvidence.length
      ? 'succeeded'
      : result.status === 'failed' && receivedEvidence.length ? 'failed' : 'unknown';
    const proofRef = receipt.receipt_ref ?? join(root, `receipt-${attempt.delivery_attempt_id}.json`);
    const queryRefs = receivedEvidence;
    const verificationRefs = status === 'succeeded' ? [proofRef, ...queryRefs] : [];
    const accountedAt = at();
    return store.transaction(() => {
      const latest = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attempt.delivery_attempt_id);
      if (!latest) throw new Error('delivery attempt missing during account');
      if (latest.status === 'succeeded' || latest.status === 'failed'
        || latest.status === 'unknown' && result.status !== 'succeeded') return latest.status;
      const targetStatus = status;
      const changed = store.casState({
        entity: 'delivery_attempt', entity_id: latest.delivery_attempt_id, expectedState: latest.status,
        expectedRevision: latest.revision, nextState: targetStatus,
        fields: {
          returned_at: accountedAt, message_id: targetStatus === 'succeeded' ? result.message_id : null,
          verification_evidence_refs_json: JSON.stringify(verificationRefs),
          query_evidence_refs_json: JSON.stringify(queryRefs),
        }, updatedAt: accountedAt, evidence_refs: [...verificationRefs, ...queryRefs],
      });
      if (changed.status !== 'succeeded') throw new Error('delivery attempt account CAS rejected');
      const recommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(attempt.recommendation_id);
      if (recommendation?.state === 'intent' || targetStatus === 'succeeded' && recommendation?.state === 'unknown') {
        const recommendationResult = store.casState({
          entity: 'recommendation', entity_id: recommendation.recommendation_id, expectedState: recommendation.state,
          expectedRevision: recommendation.revision, nextState: targetStatus,
          ...(targetStatus === 'succeeded' ? { fields: { first_success_at: accountedAt } } : {}), updatedAt: accountedAt,
          evidence_refs: verificationRefs,
        });
        if (recommendationResult.status !== 'succeeded') throw new Error('recommendation account CAS rejected');
      }
      if (targetStatus === 'succeeded') {
        const identity = store.db.prepare(`SELECT b.owner,c.platform,c.source_content_id FROM recommendation r
          JOIN batch b USING(delivery_batch_id) JOIN content c USING(content_id) WHERE r.recommendation_id=?`).get(attempt.recommendation_id);
        store.db.prepare(`INSERT INTO delivered_content(owner,platform,source_content_id,recommendation_id,first_success_at)
          VALUES(?,?,?,?,?)`).run(identity.owner, identity.platform, identity.source_content_id, attempt.recommendation_id, accountedAt);
      }
      return targetStatus;
    });
  }

  async function prepareDelivery(item, expectedGeneration = slot().generation) {
    assertCoordinator(item?.delivery_batch_id);
    const artifact = buildArtifact(item);
    const joined = store.db.prepare(`SELECT r.*,d.baseline_version,d.preference_version,d.strategy_version,d.category,d.result,
      d.candidate_id,b.owner,b.status batch_status,b.stop_requested,b.business_day
      FROM recommendation r JOIN decision d USING(decision_id) JOIN batch b USING(delivery_batch_id)
      WHERE r.recommendation_id=?`).get(item.recommendation_id);
    const expectedItem = {
      recommendation_id: item.recommendation_id,
      delivery_batch_id: item.delivery_batch_id,
      content_id: item.content_id,
      decision_id: item.decision_id,
      category: item.category,
      actual_preference_version: item.actual_preference_version,
      actual_strategy_version: item.actual_strategy_version,
      baseline_version: joined?.baseline_version,
    };
    if (artifact.payload_hash !== item.payload_hash) throw new Error('display payload hash mismatch');
    const request = { receive_id: targetRef, msg_type: artifact.payload.msg_type, content: artifact.payload.content, uuid: item.recommendation_id };
    const validRequest = validateRequest(artifact.payload, { receive_id: targetRef, uuid: item.recommendation_id });
    if (validRequest.status !== 'succeeded') throw new Error('delivery request exceeds verified capacity');
    if (!joined || !['pending', 'failed'].includes(joined.state) || joined.owner !== owner || joined.batch_status === 'closed_day') throw new Error('recommendation or owner not dispatchable');
    const currentSlot = slot();
    if (currentSlot.generation !== expectedGeneration || currentSlot.stop_requested
      || !['idle', 'stopped'].includes(currentSlot.state) || currentSlot.owner !== null || currentSlot.run_id !== null) throw new Error('execution slot stopped or generation changed');
    const decision = { ...joined, result: joined.result, baseline_version: joined.baseline_version, preference_version: joined.preference_version, strategy_version: joined.strategy_version };
    const batch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(item.delivery_batch_id);
    checkCurrent({ item: { ...item, ...expectedItem }, recommendation: joined, decision, batch, expectedGeneration });

    const attemptId = randomUUID();
    const now = at();
    const intent = {
      attempt_id: attemptId, recommendation_id: item.recommendation_id, delivery_batch_id: item.delivery_batch_id,
      decision_id: item.decision_id, content_id: item.content_id, category: item.category,
      actual_preference_version: item.actual_preference_version, actual_strategy_version: item.actual_strategy_version,
      baseline_version: joined.baseline_version, ordinal: item.ordinal,
      coordination,
      owner, target_ref: targetRef, app_hash: appHash, expected_generation: expectedGeneration,
      build_ref: item.build_ref, build_hash: item.build_hash, payload_hash: item.payload_hash,
      payload: artifact.payload, request, versions: {
        preference_version: item.actual_preference_version,
        strategy_version: item.actual_strategy_version,
        baseline_version: joined.baseline_version,
      }, created_at: now,
    };
    const checkpointFile = writeExact(join(root, `intent-${attemptId}.json`), intent);
    store.transaction(() => {
      const liveRecommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(item.recommendation_id);
      const liveDecision = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(item.decision_id);
      const liveBatch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(item.delivery_batch_id);
      checkCurrent({ item: { ...item, ...expectedItem }, recommendation: liveRecommendation, decision: liveDecision, batch: liveBatch, expectedGeneration });
      store.db.prepare(`INSERT INTO delivery_attempt(delivery_attempt_id,recommendation_id,target_ref,payload_hash,intent_at,status,created_at)
        VALUES(?,?,?,?,?,'intent',?)`).run(attemptId, item.recommendation_id, targetRef, item.payload_hash, now, now);
      const moved = store.casState({ entity: 'recommendation', entity_id: item.recommendation_id, expectedState: liveRecommendation.state,
        expectedRevision: liveRecommendation.revision, nextState: 'intent', evidence_refs: [checkpointFile.ref] });
      if (moved.status !== 'succeeded') throw new Error('recommendation intent CAS rejected');
      const current = slot();
      saveCheckpoint(attemptId, item.delivery_batch_id, { ...intent, intent_ref: checkpointFile.ref, intent_hash: checkpointFile.hash },
        { run_id: `prepare-${attemptId}`, generation: current.generation });
    });
    return { status: 'succeeded', attempt_id: attemptId, entity_id: attemptId, evidence_refs: [checkpointFile.ref] };
  }

  function requestFor(attemptId) {
    const { value } = attemptCheckpoint(attemptId) ?? {};
    if (!value || value.owner !== owner || value.app_hash !== appHash || value.target_ref !== targetRef) throw new Error('delivery attempt checkpoint invalid');
    const artifact = readVerifiedFile(value.build_ref, value.build_hash);
    if (artifact.payload_hash !== value.payload_hash || digest(artifact.payload) !== value.payload_hash) throw new Error('delivery payload checkpoint changed');
    return { value, request: value.request };
  }

  function markUnknown(attempt, evidence) {
    const row = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attempt.delivery_attempt_id);
    if (!row || row.status !== 'intent') return row?.status ?? 'unknown';
    store.transaction(() => {
      const current = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(row.delivery_attempt_id);
      if (current.status !== 'intent') return;
      const updated = store.casState({ entity: 'delivery_attempt', entity_id: row.delivery_attempt_id,
        expectedState: 'intent', expectedRevision: current.revision, nextState: 'unknown',
        fields: { returned_at: at(), query_evidence_refs_json: JSON.stringify(evidence ? [evidence] : []) }, evidence_refs: evidence ? [evidence] : [] });
      if (updated.status !== 'succeeded') throw new Error('unknown account CAS rejected');
      const rec = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(row.recommendation_id);
      if (rec?.state === 'intent') store.casState({ entity: 'recommendation', entity_id: rec.recommendation_id,
        expectedState: 'intent', expectedRevision: rec.revision, nextState: 'unknown', evidence_refs: evidence ? [evidence] : [] });
    });
    return 'unknown';
  }

  async function sendPrepared(attemptId) {
    const row = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    if (!row || !attemptCheckpoint(attemptId)) throw new Error('prepared delivery attempt missing');
    if (row.status === 'succeeded' || row.status === 'failed') {
      verifyAccountedReceipt(row);
      return { status: row.status, attempt_id: attemptId };
    }
    if (row.status !== 'intent') return { status: row.status, attempt_id: attemptId };
    if (row.dispatched_at) {
      const receiptPath = join(root, `receipt-${attemptId}.json`);
      if (existsSync(receiptPath)) return applyReceipt(row, receiptPath);
      return { status: 'unknown', attempt_id: attemptId, reason: 'dispatch_claim_already_exists' };
    }
    const context = requestFor(attemptId);
    if (!sameCoordinator(context.value.coordination ?? null, coordination)) throw new Error('delivery coordinator identity does not match persisted intent');
    const token = { run_id: randomUUID(), process_id: process.pid, attempt_id: attemptId,
      generation: context.value.expected_generation, started_at: at() };
    const runFile = writeExact(join(root, `worker-${attemptId}-${token.run_id}.json`), token);
    let claimed = false;
    let cancelled = null;
    store.transaction(() => {
      const currentAttempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
      if (!currentAttempt || currentAttempt.status !== 'intent' || currentAttempt.dispatched_at) return;
      const recommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?').get(row.recommendation_id);
      const decision = store.db.prepare('SELECT * FROM decision WHERE decision_id=?').get(context.value.decision_id);
      const batch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(context.value.delivery_batch_id);
      const checkedItem = { ...context.value, attempt_id: attemptId, baseline_version: context.value.versions.baseline_version };
      try {
        checkCurrent({ item: checkedItem, recommendation, decision, batch, expectedGeneration: context.value.expected_generation, requirePending: false,
          coordinator: context.value.coordination ?? null });
      } catch (error) {
        const reason = error.message;
        const decisionInvalidated = /version|eligible|baseline|preference|strategy|favorite/.test(reason);
        const evidence = `delivery-pre-dispatch:${decisionInvalidated ? 'decision_invalidated' : 'cancelled'}:${reason}`;
        cancelled = cancelBeforeDispatch({ attempt: currentAttempt, context: context.value, recommendation, decision, batch,
          reason, decisionInvalidated, evidence: [evidence], workerProof: { worker_ref: runFile.ref, worker_hash: runFile.hash },
          checkpointIdentity: token });
        return;
      }
      const claim = store.db.prepare(`UPDATE delivery_attempt SET dispatched_at=?,revision=revision+1,updated_at=?
        WHERE delivery_attempt_id=? AND status='intent' AND revision=? AND dispatched_at IS NULL`)
        .run(at(), at(), attemptId, currentAttempt.revision);
      if (Number(claim.changes) !== 1) return;
      saveCheckpoint(attemptId, context.value.delivery_batch_id, { ...context.value, ...token, worker_ref: runFile.ref, worker_hash: runFile.hash }, token);
      claimed = true;
    });
    if (cancelled) return cancelled;
    if (!claimed) return { status: row.status === 'intent' ? 'unknown' : row.status, attempt_id: attemptId, reason: 'dispatch_claim_lost' };
    let result;
    try { result = await transport.send(context.request); }
    catch (error) { result = { status: 'unknown', reason: 'transport_exception', detail: String(error?.message ?? error) }; }
    const allowedStatus = ['succeeded', 'failed', 'unknown'].includes(result?.status) ? result.status : 'unknown';
    const envelope = {
      result: { ...result, status: allowedStatus },
      reason: allowedStatus === 'unknown' ? result?.reason ?? 'transport_result_unknown' : result?.reason ?? null,
    };
    const receipt = persistReceipt(row, envelope);
    if (!receipt.receipt_ref) {
      receipt.receipt_ref = join(root, `receipt-${attemptId}.json`);
      receipt.receipt_hash = hash(readFileSync(receipt.receipt_ref));
    }
    checkpointReceipt(attemptId, { ...context.value, ...token, worker_ref: runFile.ref, worker_hash: runFile.hash,
      receipt_ref: receipt.receipt_ref, receipt_hash: receipt.receipt_hash, receipt_result: receipt.result }, token.run_id, token.generation);
    const normalized = receipt.result;
    const status = account(row, normalized, receipt);
    return { status, attempt_id: attemptId, message_id: normalized.message_id ?? null, evidence_refs: [receipt.receipt_ref] };
  }

  function applyReceipt(attempt, receiptPath) {
    const receiptHash = hash(readFileSync(receiptPath));
    const checkpointStatus = receiptCheckpointStatus(attempt.delivery_attempt_id, receiptPath, receiptHash);
    if (checkpointStatus === 'mismatch') throw new Error('delivery receipt checkpoint missing or mismatched');
    if (checkpointStatus === 'missing') return { status: 'unknown', attempt_id: attempt.delivery_attempt_id, reason: 'receipt_checkpoint_pending' };
    const receipt = readVerifiedFile(receiptPath, receiptHash);
    if (!verifyReceipt(attempt, receipt)) throw new Error('delivery receipt binding invalid');
    const status = account(attempt, receipt.result, { ...receipt, receipt_ref: receiptPath, receipt_hash: hash(readFileSync(receiptPath)) });
    return { status, attempt_id: attempt.delivery_attempt_id, message_id: receipt.result.message_id ?? null, evidence_refs: [receiptPath] };
  }

  async function reconcileDelivery(attemptId) {
    const attempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    if (!attempt) throw new Error('delivery attempt missing');
    if (attempt.status === 'succeeded' || attempt.status === 'failed') {
      verifyAccountedReceipt(attempt);
      return { status: attempt.status, attempt_id: attemptId, message_id: attempt.message_id };
    }
    if (attempt.status === 'cancelled_before_dispatch') return { status: attempt.status, attempt_id: attemptId };
    const receiptPath = join(root, `receipt-${attemptId}.json`);
    if (existsSync(receiptPath)) {
      const initial = readVerifiedFile(receiptPath, hash(readFileSync(receiptPath)));
      if (!verifyReceipt(attempt, initial)) throw new Error('delivery receipt binding invalid');
      if (initial.result?.status === 'succeeded' || initial.result?.status === 'failed') {
        const applied = applyReceipt(attempt, receiptPath);
        if (applied.reason !== 'receipt_checkpoint_pending') return applied;
      }
    }
    if (!attempt.dispatched_at) return { status: attempt.status, attempt_id: attemptId };
    if (attempt.status === 'intent') {
      const checkpoint = attemptCheckpoint(attemptId)?.value;
      if (!checkpoint?.worker_ref || !checkpoint.worker_hash) return { status: 'unknown', attempt_id: attemptId, reason: 'dispatch_claim_pending_recovery' };
      const worker = readVerifiedFile(checkpoint.worker_ref, checkpoint.worker_hash);
      try { process.kill(worker.process_id, 0); return { status: 'unknown', attempt_id: attemptId, reason: 'dispatch_worker_active' }; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      markUnknown(attempt, `process-exit:${worker.run_id}`);
    }
    const currentAttempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    let result;
    const attemptContext = attemptCheckpoint(attemptId)?.value;
    try { result = await transport.lookup({
      attempt_id: attemptId, recommendation_id: currentAttempt.recommendation_id, target_ref: currentAttempt.target_ref,
      payload_hash: currentAttempt.payload_hash, message_id: currentAttempt.message_id ?? null,
      payload: attemptContext?.request, ordinal: attemptContext?.ordinal ?? null,
      started_at: currentAttempt.dispatched_at ?? currentAttempt.intent_at, ended_at: at(),
    }); } catch { result = { status: 'unknown' }; }
    const verificationEvidence = evidenceRefs(result?.evidence_refs ?? result?.evidence);
    if (result?.status !== 'succeeded' || typeof result.message_id !== 'string' || !result.message_id.trim()
      || !verificationEvidence.length) {
      return { status: 'unknown', attempt_id: attemptId, evidence_refs: verificationEvidence };
    }
    const receipt = persistReceipt(currentAttempt, { result: { ...result, status: 'succeeded' }, reason: null, reconciled_at: at() },
      join(root, `reconcile-${attemptId}-${randomUUID()}.json`));
    if (!receipt.receipt_ref) {
      receipt.receipt_ref = receiptPath;
      receipt.receipt_hash = hash(readFileSync(receiptPath));
    }
    const checkpoint = attemptCheckpoint(attemptId)?.value;
    checkpointReceipt(attemptId, { ...checkpoint, receipt_ref: receipt.receipt_ref,
      receipt_hash: receipt.receipt_hash, receipt_result: receipt.result }, checkpoint?.run_id ?? `reconcile-${attemptId}`, checkpoint?.generation ?? 0);
    const status = account(currentAttempt, receipt.result, receipt);
    return { status, attempt_id: attemptId, message_id: receipt.result.message_id,
      evidence_refs: [receipt.receipt_ref, ...verificationEvidence] };
  }

  async function recover({ attemptId, confirmedStoppedRunId, evidenceRef }) {
    if (!attemptId || !confirmedStoppedRunId || !evidenceRef) throw new TypeError('attemptId, confirmedStoppedRunId and evidenceRef are required');
    const attempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(attemptId);
    if (!attempt) throw new Error('delivery attempt missing');
    if (attempt.status === 'succeeded' || attempt.status === 'failed') {
      verifyAccountedReceipt(attempt);
      return { status: attempt.status, attempt_id: attemptId, message_id: attempt.message_id };
    }
    if (attempt.status === 'cancelled_before_dispatch') return { status: attempt.status, attempt_id: attemptId };
    const receiptPath = join(root, `receipt-${attemptId}.json`);
    if (existsSync(receiptPath)) return applyReceipt(attempt, receiptPath);
    const workerProof = attemptCheckpoint(attemptId)?.value;
    if (!workerProof?.worker_ref || !workerProof.worker_hash) throw new Error('delivery worker checkpoint missing');
    const worker = readVerifiedFile(workerProof.worker_ref, workerProof.worker_hash);
    if (worker.run_id !== confirmedStoppedRunId || worker.attempt_id !== attemptId) throw new Error('stopped worker identity mismatch');
    try { process.kill(worker.process_id, 0); throw new Error('delivery worker is still running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!attempt.dispatched_at) return { status: attempt.status, attempt_id: attemptId };
    const status = markUnknown(attempt, evidenceRef);
    return { status, attempt_id: attemptId, evidence_refs: [evidenceRef] };
  }

  return { prepareDelivery, cancelPrepared, reprepareCancelled, sendPrepared, reconcileDelivery, recover };
}
