import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHomefeed } from './homefeed.mjs';
import { createCollector } from './collection.mjs';
import { createAnalyzer } from './analysis.mjs';
import { createCandidates } from './candidates.mjs';
import { createDisplay } from './display.mjs';
import { createDelivery } from './delivery.mjs';

const shanghaiTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const targets = Object.freeze({ daily_follow: 20, additional_follow: 3, explore: 3 });
const hash = value => createHash('sha256').update(value).digest('hex');
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const processInstanceId = randomUUID();
const processStartedAt = new Date().toISOString();
const activeInvocations = new Set();

export function dueStatus(now) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) throw new TypeError('now must be a valid date');
  const parts = Object.fromEntries(shanghaiTime.formatToParts(instant).map(({ type, value }) => [type, value]));
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { status: localMinutes >= 11 * 60 + 15 ? 'due' : 'not_due', businessDay: `${parts.year}-${parts.month}-${parts.day}` };
}

function requireRuntime(runtime, tab, kind, direction, requestText) {
  if (!tab || typeof tab !== 'object') return 'caller-provided supported tab is required';
  if (kind === 'explore' && !hasText(direction)) return 'exploration direction is missing';
  if (kind !== 'daily_follow' && !hasText(requestText)) return 'explicit raw requestText is required';
  const required = [
    ['collection', runtime?.collection], ['analysis', runtime?.analysis], ['candidates', runtime?.candidates],
    ['display', runtime?.display], ['delivery', runtime?.delivery],
  ];
  const missing = required.filter(([, value]) => !value || typeof value !== 'object').map(([name]) => name);
  if (missing.length) return `runtime capabilities are missing: ${missing.join(', ')}`;
  if (typeof runtime.delivery.transport?.send !== 'function' || typeof runtime.delivery.transport?.lookup !== 'function') {
    return 'delivery send/lookup capability is incomplete';
  }
  return null;
}

export function createOrchestrator({ store, root, owner, appRef, targetRef, runtime, now = () => new Date().toISOString(), uuid = randomUUID }) {
  if (!store?.db || typeof store.transaction !== 'function' || !root || !owner) throw new TypeError('writable store, private root and owner are required');
  root = resolve(root);
  const at = () => {
    const value = new Date(now());
    if (Number.isNaN(value.getTime())) throw new TypeError('now must return a valid date');
    return value.toISOString();
  };
  const head = () => store.db.prepare("SELECT * FROM checkpoint WHERE stage='orchestration:main' ORDER BY rowid DESC LIMIT 1").get() ?? null;
  const activeHead = row => {
    if (!row) return false;
    if (!headProof(row)) return true;
    return JSON.parse(row.pending_ids_json).length > 0;
  };
  const slot = () => store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
  const batch = batchId => store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId, owner) ?? null;

  function headProof(row) {
    try {
      const proof = JSON.parse(row.succeeded_refs_json).find(ref => ref && typeof ref === 'object' && ref.orchestration)?.orchestration;
      if (!proof || proof.owner !== row.owner || proof.batchId !== row.delivery_batch_id || proof.runId !== row.run_id
        || proof.batchGeneration !== row.generation || typeof proof.active !== 'boolean'
        || proof.active !== (JSON.parse(row.pending_ids_json).length > 0)
        || !Number.isSafeInteger(proof.process_id) || proof.process_id < 1
        || typeof proof.process_instance_id !== 'string' || !proof.process_instance_id.trim()
        || typeof proof.process_started_at !== 'string' || Number.isNaN(new Date(proof.process_started_at).getTime())
        || !['admitted', 'executing', 'returned'].includes(proof.invocation_state) || !Array.isArray(proof.worker_refs)
        || (proof.phase_refs !== undefined && !Array.isArray(proof.phase_refs))
        || hash(JSON.stringify(proof)) !== row.output_hash) return null;
      return proof;
    } catch { return null; }
  }

  function continuationLineage(origin, terminal, { commandId = null, terminalState = 'returned' } = {}) {
    const invalid = reason => ({ status: 'invalid', reason });
    if (!origin || !terminal || origin.owner !== owner || terminal.owner !== owner
      || origin.batchId !== terminal.batchId || !Number.isSafeInteger(origin.batchGeneration)
      || !Number.isSafeInteger(terminal.batchGeneration) || origin.batchGeneration < 1
      || terminal.batchGeneration < origin.batchGeneration || !origin.runId || !terminal.runId) return invalid('identity');

    const rows = [];
    let runId = terminal.runId;
    for (let generation = terminal.batchGeneration; generation >= origin.batchGeneration; generation--) {
      const current = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(owner, runId, generation, terminal.batchId);
      const proof = current && headProof(current);
      if (!current || !proof || current.owner !== owner || current.delivery_batch_id !== terminal.batchId
        || current.run_id !== runId || current.generation !== generation) return invalid('head');
      if (generation === terminal.batchGeneration) {
        const latest = head();
        const latestProof = latest && headProof(latest);
        const latestBatch = store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND delivery_batch_id=?
          AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, terminal.batchId);
        const currentBatch = batch(terminal.batchId);
        if (latestBatch?.checkpoint_id !== current.checkpoint_id || currentBatch?.generation !== generation) return invalid('terminal_stale');
        if (terminalState === 'active' ? !proof.active : proof.active || proof.invocation_state !== 'returned') {
          return invalid('terminal_state');
        }
        if (terminalState === 'active' ? latest?.checkpoint_id !== current.checkpoint_id
          : !latestProof || activeHead(latest) || latestProof.invocation_state !== 'returned') return invalid('global_active');
        if (commandId && (proof.continued_from !== terminal.continuedFromRunId
          || terminal.continuedFromGeneration !== generation - 1)) return invalid('terminal_parent');
      } else if (proof.active || proof.invocation_state !== 'returned') return invalid('parent_active');

      const node = { generation, run_id: runId, row: current, proof };
      rows.push(node);
      if (generation === origin.batchGeneration) break;
      if (typeof proof.continued_from !== 'string' || !proof.continued_from.trim()
        || typeof proof.evidence_ref !== 'string' || !proof.evidence_ref.trim()) return invalid('parent_link');
      const commandRows = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=?
        AND generation=? AND delivery_batch_id=? AND stage LIKE 'orchestration:command:%' ORDER BY rowid`)
        .all(owner, runId, generation, terminal.batchId);
      if (commandRows.length !== 1) return invalid('command_count');
      const command = commandRows[0];
      let saved;
      try { saved = JSON.parse(command.succeeded_refs_json)[0]; } catch { return invalid('command_json'); }
      const expectedStage = typeof saved?.command_id === 'string' && saved.command_id.trim()
        ? `orchestration:command:${hash(saved.command_id)}` : null;
      const firstHead = store.db.prepare(`SELECT rowid AS checkpoint_rowid FROM checkpoint WHERE owner=? AND run_id=?
        AND generation=? AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid LIMIT 1`)
        .get(owner, runId, generation, terminal.batchId);
      if (!expectedStage || command.stage !== expectedStage || command.owner !== owner || command.run_id !== runId
        || command.generation !== generation || command.delivery_batch_id !== terminal.batchId
        || command.input_hash !== hash(saved.command_id) || command.output_hash !== hash(JSON.stringify(saved))
        || saved.batch_id !== terminal.batchId || saved.run_id !== runId || saved.generation !== generation
        || !firstHead || command.checkpoint_rowid <= firstHead.checkpoint_rowid) return invalid('command_identity');
      if (generation === terminal.batchGeneration && commandId && saved.command_id !== commandId) return invalid('command_identity');
      node.command = command;
      node.saved_command = saved;
      const parentRunId = proof.continued_from;
      const parent = store.db.prepare(`SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
        AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(owner, parentRunId, generation - 1, terminal.batchId);
      const childFirst = firstHead.checkpoint_rowid;
      if (!parent || parent.checkpoint_rowid >= childFirst) return invalid('row_order');
      runId = parentRunId;
    }
    const root = rows.at(-1);
    if (!root || root.run_id !== origin.runId || root.generation !== origin.batchGeneration) return invalid('origin');
    const auditedRows = terminalState === 'active' ? rows.slice(1) : rows;
    for (const node of auditedRows) {
      const phase = phaseAudit(node.proof, terminal.batchId);
      if (phase?.reason || phase?.pendingStages?.length) return invalid('phase');
      const worker = workerAudit(node.proof);
      if (worker) return invalid('worker');
      node.phase_checkpoints = phase.phase_checkpoints.map(ref => {
        const row = store.db.prepare('SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE checkpoint_id=?').get(ref.checkpoint_id);
        return { ...ref, checkpoint_rowid: row?.checkpoint_rowid, owner: row?.owner, run_id: row?.run_id,
          generation: row?.generation, batch_id: row?.delivery_batch_id, stage: row?.stage,
          input_hash: row?.input_hash, pending_ids_json: row?.pending_ids_json, succeeded_refs_json: row?.succeeded_refs_json };
      });
    }
    return { status: 'valid', rows: rows.map(node => ({ generation: node.generation, run_id: node.run_id,
      main_checkpoint_id: node.row.checkpoint_id, main_output_hash: node.row.output_hash, main_rowid: node.row.checkpoint_rowid,
      main_owner: node.row.owner, main_batch_id: node.row.delivery_batch_id, main_stage: node.row.stage,
      main_input_hash: node.row.input_hash, main_pending_ids_json: node.row.pending_ids_json,
      main_succeeded_refs_json: node.row.succeeded_refs_json,
      command_checkpoint_id: node.command?.checkpoint_id ?? null, command_output_hash: node.command?.output_hash ?? null,
      command_rowid: node.command?.checkpoint_rowid ?? null, command_owner: node.command?.owner ?? null,
      command_run_id: node.command?.run_id ?? null, command_generation: node.command?.generation ?? null,
      command_batch_id: node.command?.delivery_batch_id ?? null, command_stage: node.command?.stage ?? null,
      command_input_hash: node.command?.input_hash ?? null, command_succeeded_refs_json: node.command?.succeeded_refs_json ?? null,
      phase_checkpoints: node.phase_checkpoints })) };
  }

  function processAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'ESRCH' ? false : null; }
  }

  function unresolvedWorker(batchId, allowedUndispatchedAttemptId = null) {
    const attempts = store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.dispatched_at FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      WHERE b.owner=? AND a.status IN ('intent','unknown') ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 25`).all(owner);
    for (const attempt of attempts) {
      if (attempt.status === 'intent') {
        if (attempt.delivery_attempt_id === allowedUndispatchedAttemptId && attempt.dispatched_at === null) continue;
        return { reason: 'delivery_intent_unaccounted', attempt_id: attempt.delivery_attempt_id };
      }
      const checkpoint = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, `delivery-attempt:${attempt.delivery_attempt_id}`);
      if (!checkpoint) return { reason: 'delivery_worker_proof_missing', attempt_id: attempt.delivery_attempt_id };
      try {
        const ref = JSON.parse(checkpoint.succeeded_refs_json)[0];
        if (!ref?.ref || !ref.hash) return { reason: 'delivery_worker_proof_missing', attempt_id: attempt.delivery_attempt_id };
        const raw = readFileSync(ref.ref);
        if (hash(raw) !== ref.hash) return { reason: 'delivery_worker_proof_mismatch', attempt_id: attempt.delivery_attempt_id };
        const worker = JSON.parse(raw.toString('utf8'));
        if (worker.attempt_id !== attempt.delivery_attempt_id) return { reason: 'delivery_worker_identity_mismatch', attempt_id: attempt.delivery_attempt_id };
        if (attempt.status === 'unknown' && processAlive(worker.process_id) !== false) {
          return { reason: 'delivery_worker_exit_unconfirmed', attempt_id: attempt.delivery_attempt_id };
        }
      } catch { return { reason: 'delivery_worker_proof_unreadable', attempt_id: attempt.delivery_attempt_id }; }
    }
    return null;
  }

  function unresolvedWorkerSnapshot() {
    return store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.revision,a.dispatched_at FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      WHERE b.owner=? AND a.status IN ('intent','unknown') ORDER BY a.intent_at,a.delivery_attempt_id`).all(owner).map(attempt => {
      const proof = store.db.prepare('SELECT checkpoint_id,output_hash FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, `delivery-attempt:${attempt.delivery_attempt_id}`);
      return { ...attempt, checkpoint_id: proof?.checkpoint_id ?? null, output_hash: proof?.output_hash ?? null };
    });
  }

  function cancellationEvidence(attemptId) {
    const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `delivery-attempt:${attemptId}`);
    if (!row) throw new Error('prepared delivery checkpoint is missing');
    const ref = JSON.parse(row.succeeded_refs_json)[0];
    if (!ref?.ref || !ref.hash) throw new Error('prepared delivery checkpoint reference is invalid');
    const raw = readFileSync(ref.ref);
    if (hash(raw) !== ref.hash || hash(raw) !== row.output_hash) throw new Error('prepared delivery checkpoint hash mismatch');
    const context = JSON.parse(raw.toString('utf8'));
    if (!context.intent_ref || !context.intent_hash) throw new Error('prepared delivery intent reference is missing');
    const intentRaw = readFileSync(context.intent_ref);
    if (hash(intentRaw) !== context.intent_hash) throw new Error('prepared delivery intent hash mismatch');
    const intent = JSON.parse(intentRaw.toString('utf8'));
    if (intent.attempt_id !== attemptId) throw new Error('prepared delivery attempt identity mismatch');
    const evidence = { attempt_id: intent.attempt_id, recommendation_id: intent.recommendation_id,
      content_id: intent.content_id, decision_id: intent.decision_id, delivery_batch_id: intent.delivery_batch_id,
      owner: intent.owner, target_ref: intent.target_ref, app_hash: intent.app_hash, payload_hash: intent.payload_hash,
      coordination: context.coordination ?? null, intent_ref: context.intent_ref, intent_hash: context.intent_hash,
      reason: 'task013-confirmed-not-dispatched' };
    const path = join(root, `task013-cancel-${attemptId}-${uuid()}.json`);
    writeFileSync(path, `${JSON.stringify(evidence)}\n`, { flag: 'wx' });
    return path;
  }


  function preparedDelivery(attemptId) {
    const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `delivery-attempt:${attemptId}`);
    if (!row) throw new Error('delivery attempt checkpoint is missing');
    const reference = JSON.parse(row.succeeded_refs_json)[0];
    if (!reference?.ref || !reference.hash) throw new Error('delivery attempt checkpoint reference is invalid');
    const raw = readFileSync(reference.ref);
    if (hash(raw) !== reference.hash || hash(raw) !== row.output_hash) throw new Error('delivery attempt checkpoint hash mismatch');
    const context = JSON.parse(raw.toString('utf8'));
    if (!context.intent_ref || !context.intent_hash) throw new Error('delivery intent reference is missing');
    const intentRaw = readFileSync(context.intent_ref);
    if (hash(intentRaw) !== context.intent_hash) throw new Error('delivery intent hash mismatch');
    const intent = JSON.parse(intentRaw.toString('utf8'));
    if (intent.attempt_id !== attemptId || intent.owner !== owner) throw new Error('delivery intent identity mismatch');
    return { row, context, intent };
  }

  function undispatchedIntentProof(attemptId) {
    try {
      const attempt = store.db.prepare(`SELECT a.*,r.rowid AS recommendation_rowid,r.revision AS recommendation_revision,r.state AS recommendation_state,
        r.delivery_batch_id AS recommendation_batch_id,r.content_id AS recommendation_content_id,
        r.decision_id AS recommendation_decision_id FROM delivery_attempt a
        JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?`).get(attemptId);
      if (!attempt || attempt.status !== 'intent' || attempt.dispatched_at !== null) return null;
      const { row, context, intent } = preparedDelivery(attemptId);
      const old = context.coordination;
      if (!old || row.owner !== owner || row.delivery_batch_id !== attempt.recommendation_batch_id
        || intent.owner !== owner || intent.attempt_id !== attemptId || intent.delivery_batch_id !== attempt.recommendation_batch_id
        || intent.recommendation_id !== attempt.recommendation_id || intent.content_id !== attempt.recommendation_content_id
        || intent.decision_id !== attempt.recommendation_decision_id || intent.coordination?.runId !== old.runId
        || intent.coordination?.batchGeneration !== old.batchGeneration) return null;
      const oldBatch = batch(attempt.recommendation_batch_id);
      const oldHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=? AND delivery_batch_id=?
        AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
        .get(owner, old.runId, old.batchGeneration, attempt.recommendation_batch_id);
      const latestBatchHead = store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND delivery_batch_id=?
        AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, attempt.recommendation_batch_id);
      const oldProof = oldHead && headProof(oldHead);
      if (!oldBatch || oldBatch.generation !== old.batchGeneration || !oldHead || oldHead.checkpoint_id !== latestBatchHead?.checkpoint_id
        || !oldProof || activeHead(oldHead) || oldProof.invocation_state !== 'returned') return null;
      const phaseState = phaseAudit(oldProof, attempt.recommendation_batch_id);
      if (phaseState?.reason || phaseState?.pendingStages?.length) return null;
      if (workerAudit(oldProof)) return null;
      return { attempt_id: attemptId, attempt_revision: attempt.revision, recommendation_id: attempt.recommendation_id,
        recommendation_revision: attempt.recommendation_revision, recommendation_rowid: attempt.recommendation_rowid,
        original_batch_id: attempt.recommendation_batch_id, original_run_id: old.runId, original_generation: old.batchGeneration,
        delivery_checkpoint_id: row.checkpoint_id, delivery_output_hash: row.output_hash,
        original_head_checkpoint_id: oldHead.checkpoint_id, original_head_output_hash: oldHead.output_hash,
        phase_checkpoints: phaseState.phase_checkpoints };
    } catch { return null; }
  }

  function phaseCheckpointsCurrent(proof, batchId, references) {
    if (!Array.isArray(references) || references.length !== 5) return false;
    return references.every(reference => {
      const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND checkpoint_id=? AND stage=?')
        .get(proof.owner, reference.checkpoint_id, `orchestration:phase:${batchId}:${reference.stage}`);
      if (!row || row.run_id !== proof.runId || row.generation !== proof.batchGeneration || row.delivery_batch_id !== batchId
        || row.output_hash !== reference.output_hash) return false;
      try {
        const phase = JSON.parse(row.succeeded_refs_json)[0]?.orchestration_phase;
        return phase?.status === reference.status && hash(JSON.stringify(phase)) === row.output_hash;
      } catch { return false; }
    });
  }

  function phaseReferencesForIdentity(proof, batchId) {
    const stages = ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'];
    const references = [];
    for (const stage of stages) {
      const row = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=? AND delivery_batch_id=? AND stage=?
        ORDER BY rowid DESC LIMIT 1`).get(owner, proof.runId, proof.batchGeneration, batchId,
        `orchestration:phase:${batchId}:${stage}`);
      if (!row) return null;
      try {
        const phase = JSON.parse(row.succeeded_refs_json)[0]?.orchestration_phase;
        if (!phase || hash(JSON.stringify(phase)) !== row.output_hash
          || !['succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'invalidated'].includes(phase.status)) return null;
        references.push({ stage, checkpoint_id: row.checkpoint_id, output_hash: row.output_hash, status: phase.status });
      } catch { return null; }
    }
    return references;
  }

  function undispatchedIntentFenceCurrent(snapshot) {
    const attempt = store.db.prepare(`SELECT a.*,r.rowid AS recommendation_rowid,r.revision AS recommendation_revision,
      r.state AS recommendation_state,r.delivery_batch_id AS recommendation_batch_id
      FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) WHERE a.delivery_attempt_id=?`).get(snapshot.attempt_id);
    const delivery = store.db.prepare('SELECT checkpoint_id,output_hash FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `delivery-attempt:${snapshot.attempt_id}`);
    const oldHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=? AND delivery_batch_id=?
      AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
      .get(owner, snapshot.original_run_id, snapshot.original_generation, snapshot.original_batch_id);
    const latestBatchHead = store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND delivery_batch_id=?
      AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, snapshot.original_batch_id);
    const oldBatch = batch(snapshot.original_batch_id);
    const proof = oldHead && headProof(oldHead);
    return Boolean(attempt && attempt.status === 'intent' && attempt.dispatched_at === null
      && attempt.revision === snapshot.attempt_revision && attempt.recommendation_id === snapshot.recommendation_id
      && attempt.recommendation_rowid === snapshot.recommendation_rowid && attempt.recommendation_revision === snapshot.recommendation_revision
      && attempt.recommendation_state === 'intent' && attempt.recommendation_batch_id === snapshot.original_batch_id
      && delivery?.checkpoint_id === snapshot.delivery_checkpoint_id && delivery.output_hash === snapshot.delivery_output_hash
      && oldHead?.checkpoint_id === snapshot.original_head_checkpoint_id && oldHead.output_hash === snapshot.original_head_output_hash
      && latestBatchHead?.checkpoint_id === snapshot.original_head_checkpoint_id && oldBatch?.generation === snapshot.original_generation
      && proof && !activeHead(oldHead) && proof.invocation_state === 'returned'
      && phaseCheckpointsCurrent(proof, snapshot.original_batch_id, snapshot.phase_checkpoints));
  }


  function cancelledContinuationItems(coordination, limit = Number.MAX_SAFE_INTEGER) {
    if (!coordination?.continueCommandId || !coordination.continuedFromRunId
      || !Number.isSafeInteger(coordination.continuedFromGeneration)) return { items: [], invalidAttemptId: null };
    const attempts = store.db.prepare(`SELECT a.delivery_attempt_id,a.dispatched_at,a.status,r.*,d.candidate_id FROM recommendation r
      JOIN decision d USING(decision_id) JOIN delivery_attempt a USING(recommendation_id)
      WHERE r.delivery_batch_id=? AND r.state='cancelled_before_dispatch'
      AND a.rowid=(SELECT latest.rowid FROM delivery_attempt latest WHERE latest.recommendation_id=r.recommendation_id
        ORDER BY latest.rowid DESC LIMIT 1)
      ORDER BY a.intent_at,a.delivery_attempt_id`).all(coordination.batchId);
    const items = [];
    for (const attempt of attempts) {
      try {
        const { context, intent } = preparedDelivery(attempt.delivery_attempt_id);
        const origin = context.coordination;
        const lineage = continuationLineage(origin, coordination, { commandId: coordination.continueCommandId, terminalState: 'active' });
        if (attempt.status !== 'cancelled_before_dispatch' || attempt.dispatched_at || attempt.state !== 'cancelled_before_dispatch'
          || !lineage || lineage.status !== 'valid' || context.phase !== 'cancelled_before_dispatch' || !context.cancellation_evidence_ref
          || intent.coordination?.owner !== owner || intent.coordination?.batchId !== coordination.batchId
          || intent.coordination?.runId !== origin?.runId || intent.coordination?.batchGeneration !== origin?.batchGeneration
          || attempt.state !== 'cancelled_before_dispatch' || attempt.recommendation_id !== intent.recommendation_id
          || attempt.delivery_batch_id !== intent.delivery_batch_id || attempt.content_id !== intent.content_id
          || attempt.decision_id !== intent.decision_id) {
          return { items, invalidAttemptId: attempt.delivery_attempt_id };
        }
        const cancellationBytes = readFileSync(context.cancellation_evidence_ref);
        if (hash(cancellationBytes) !== context.cancellation_evidence_hash) return { items, invalidAttemptId: attempt.delivery_attempt_id };
        const cancellation = JSON.parse(cancellationBytes.toString('utf8'));
        if (cancellation.attempt_id !== attempt.delivery_attempt_id
          || cancellation.recommendation_id !== intent.recommendation_id
          || cancellation.delivery_batch_id !== intent.delivery_batch_id
          || cancellation.intent_ref !== context.intent_ref || cancellation.intent_hash !== context.intent_hash) {
          return { items, invalidAttemptId: attempt.delivery_attempt_id };
        }
        const proof = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
          .get(owner, `display-build:${intent.recommendation_id}`);
        if (!proof || proof.output_hash !== intent.build_hash
          || !JSON.parse(proof.succeeded_refs_json).some(ref => ref.ref === intent.build_ref && ref.hash === intent.build_hash)) {
          return { items, invalidAttemptId: attempt.delivery_attempt_id };
        }
        const buildBytes = readFileSync(intent.build_ref);
        if (hash(buildBytes) !== intent.build_hash) return { items, invalidAttemptId: attempt.delivery_attempt_id };
        const artifact = JSON.parse(buildBytes.toString('utf8'));
        if (artifact.status !== 'succeeded' || artifact.display_state !== 'complete'
          || artifact.recommendation_id !== intent.recommendation_id || artifact.delivery_batch_id !== intent.delivery_batch_id
          || artifact.content_id !== intent.content_id || artifact.decision_id !== intent.decision_id
          || artifact.ordinal !== intent.ordinal
          || artifact.payload_hash !== intent.payload_hash || hash(JSON.stringify(artifact.payload)) !== intent.payload_hash
          || artifact.actual_preference_version !== intent.actual_preference_version
          || artifact.actual_strategy_version !== intent.actual_strategy_version) {
          return { items, invalidAttemptId: attempt.delivery_attempt_id };
        }
        items.push({ status: 'succeeded', previous_attempt_id: attempt.delivery_attempt_id,
          cancellation_evidence_ref: context.cancellation_evidence_ref, evidence_refs: [context.cancellation_evidence_ref, intent.build_ref],
          candidate_id: attempt.candidate_id,
          ...Object.fromEntries(['recommendation_id', 'delivery_batch_id', 'content_id', 'decision_id', 'category',
            'actual_preference_version', 'actual_strategy_version', 'ordinal', 'payload_hash', 'build_ref', 'build_hash']
            .map(key => [key, intent[key]])) });
      } catch {
        return { items, invalidAttemptId: attempt.delivery_attempt_id };
      }
    }
    return { items: items.slice(0, limit), invalidAttemptId: null };
  }

  function cancelUndispatchedContinuationAttempts(coordination, previousCoordination) {
    const attempts = store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.dispatched_at FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      WHERE b.owner=? AND b.delivery_batch_id=? AND a.status IN ('intent','unknown')
      ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 25`).all(owner, coordination.batchId);
    const uncertain = attempts.find(attempt => attempt.status === 'unknown' || attempt.dispatched_at);
    if (uncertain) return { status: 'recovery_required', reason: 'delivery_attempt_outcome_unconfirmed', attempt_id: uncertain.delivery_attempt_id };
    let delivery;
    const cancelled = [];
    for (const attempt of attempts) {
      let context;
      try { ({ context } = preparedDelivery(attempt.delivery_attempt_id)); }
      catch (error) { return { status: 'recovery_required', reason: 'delivery_attempt_proof_unavailable',
        attempt_id: attempt.delivery_attempt_id, detail: String(error.message ?? error) }; }
      if (context.coordination?.runId !== previousCoordination.runId
        || context.coordination?.batchGeneration !== previousCoordination.batchGeneration) continue;
      try {
        delivery ??= makeModules(coordination, 'delivery').delivery;
        const evidenceRef = cancellationEvidence(attempt.delivery_attempt_id);
        const result = delivery.cancelPrepared({ attemptId: attempt.delivery_attempt_id, evidenceRef });
        if (result.status !== 'cancelled_before_dispatch') return { status: 'recovery_required',
          reason: 'delivery_intent_cancellation_unconfirmed', attempt_id: attempt.delivery_attempt_id };
        cancelled.push(attempt.delivery_attempt_id);
      } catch (error) {
        return { status: 'recovery_required', reason: 'delivery_intent_cancellation_failed',
          attempt_id: attempt.delivery_attempt_id, detail: String(error.message ?? error) };
      }
    }
    return { status: 'ready', cancelled_attempt_ids: cancelled };
  }

  function updateWorkerProof(info, exited = false) {
    store.transaction(() => {
      const live = head(), proof = live && headProof(live);
      if (!live || !proof || !activeHead(live) || live.owner !== owner || live.run_id !== info.coordinator_run_id
        || live.generation !== info.coordinator_generation || live.delivery_batch_id !== info.coordinator_batch_id) {
        throw new Error('coordinator changed while recording stage worker proof');
      }
      const refs = [...(proof.worker_refs ?? [])];
      const index = refs.findIndex(ref => ref.stage === info.stage && ref.attempt_id === info.attempt_id);
      if (exited) {
        if (index < 0) throw new Error('stage worker spawn proof is missing');
        const bytes = readFileSync(refs[index].process_ref);
        if (hash(bytes) !== refs[index].process_hash) throw new Error('stage worker process proof hash mismatch');
        const processProof = JSON.parse(bytes.toString('utf8'));
        if (processProof.attempt_id !== info.attempt_id || processProof.pid !== info.process_id || processProof.run_id !== info.stage_run_id) {
          throw new Error('stage worker process identity mismatch');
        }
        refs[index] = { ...refs[index], exit_observed: true, exit_code: info.exit_code, signal: info.signal ?? null,
          timed_out: Boolean(info.timed_out), ended_at: info.ended_at };
      } else {
        if (index >= 0) throw new Error('stage worker attempt was registered twice');
        const processBytes = readFileSync(info.process_ref);
        if (hash(processBytes) !== info.process_hash) throw new Error('stage worker process proof hash mismatch');
        const processProof = JSON.parse(processBytes.toString('utf8'));
        if (processProof.attempt_id !== info.attempt_id || processProof.pid !== info.process_id
          || processProof.parent_pid !== info.parent_pid || processProof.run_id !== info.stage_run_id) {
          throw new Error('stage worker process identity mismatch');
        }
        refs.push({ stage: info.stage, attempt_id: info.attempt_id, stage_run_id: info.stage_run_id,
          batch_id: info.batch_id ?? null, candidate_id: info.candidate_id ?? null, batch_key: info.batch_key ?? null,
          process_ref: info.process_ref, process_hash: info.process_hash, process_id: info.process_id,
          parent_pid: info.parent_pid, exit_observed: false });
      }
      appendHead({ owner, batchId: live.delivery_batch_id, runId: live.run_id, batchGeneration: live.generation }, true,
        { invocation_state: 'executing', worker_refs: refs, phase_refs: proof.phase_refs ?? [] });
    });
  }

  function appendHead(coordination, active, details = {}) {
    const timestamp = at();
    const priorHead = head();
    const priorProof = priorHead && headProof(priorHead);
    const continuation = priorProof && priorProof.owner === coordination.owner && priorProof.batchId === coordination.batchId
      && priorProof.runId === coordination.runId && priorProof.batchGeneration === coordination.batchGeneration
      ? { continued_from: priorProof.continued_from, evidence_ref: priorProof.evidence_ref } : {};
    const body = { ...coordination, ...continuation, active, process_id: process.pid, process_instance_id: processInstanceId,
      process_started_at: processStartedAt, invocation_state: active ? 'admitted' : 'returned', worker_refs: [], ...details, updated_at: timestamp };
    store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
      succeeded_refs_json,input_hash,output_hash,committed_at)
      VALUES(?,?,?,?,?,'orchestration:main',?,?,?,?,?)`).run(
      uuid(), coordination.owner, coordination.runId, coordination.batchGeneration, coordination.batchId,
      JSON.stringify(active ? [coordination.runId] : []), JSON.stringify([{ orchestration: body }]),
      hash(JSON.stringify(coordination)), hash(JSON.stringify(body)), timestamp,
    );
  }

  function consumeAdmission(coordination) {
    return store.transaction(() => {
      const live = head();
      const proof = live && headProof(live);
      if (!live || !proof || live.owner !== coordination.owner || live.run_id !== coordination.runId
        || live.generation !== coordination.batchGeneration || live.delivery_batch_id !== coordination.batchId
        || !activeHead(live) || proof.invocation_state !== 'admitted') return false;
      appendHead(coordination, true, { invocation_state: 'executing', worker_refs: proof.worker_refs ?? [], phase_refs: proof.phase_refs ?? [] });
      return true;
    });
  }

  function markInvocationReturned(coordination, reason) {
    store.transaction(() => {
      const live = head();
      const proof = live && headProof(live);
      if (!live || !proof || live.owner !== coordination.owner || live.run_id !== coordination.runId
        || live.generation !== coordination.batchGeneration || live.delivery_batch_id !== coordination.batchId || !activeHead(live)) return;
      appendHead(coordination, true, { invocation_state: 'returned', return_reason: reason,
        worker_refs: proof.worker_refs ?? [], phase_refs: proof.phase_refs ?? [] });
    });
  }

  function recordPhase(coordination, stage, status, { pendingIds = [], evidenceRefs = [], result = null } = {}) {
    if (!['pending', 'running', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'invalidated'].includes(status)) {
      throw new TypeError('orchestration phase status is invalid');
    }
    const timestamp = at();
    const refs = [...new Set(evidenceRefs)];
    const evidenceProofs = refs.flatMap(ref => {
      if (typeof ref !== 'string') return [];
      try { return [{ ref, hash: hash(readFileSync(ref)) }]; } catch { return []; }
    });
    const value = { phase: stage, status, result, evidence_refs: refs, evidence_proofs: evidenceProofs, recorded_at: timestamp };
    const outputHash = hash(JSON.stringify(value));
    const checkpointId = uuid();
    store.transaction(() => {
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
        succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,committed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(checkpointId, owner, coordination.runId, coordination.batchGeneration,
        coordination.batchId, `orchestration:phase:${coordination.batchId}:${stage}`, JSON.stringify(pendingIds),
        JSON.stringify([{ orchestration_phase: value }]), JSON.stringify(status === 'failed' ? [value] : []),
        JSON.stringify(status === 'unknown' ? [value] : []), hash(JSON.stringify(coordination)), outputHash, timestamp);
      if (status !== 'pending') {
        const live = head(), proof = live && headProof(live);
        if (live && proof && activeHead(live) && live.owner === owner && live.run_id === coordination.runId
          && live.delivery_batch_id === coordination.batchId && live.generation === coordination.batchGeneration) {
          const refs = (proof.phase_refs ?? []).filter(ref => ref.stage !== stage);
          refs.push({ stage, status, checkpoint_id: checkpointId, output_hash: outputHash });
          appendHead(coordination, true, { invocation_state: 'executing', worker_refs: proof.worker_refs ?? [], phase_refs: refs });
        }
      }
    });
    return { ...value, checkpoint_id: checkpointId, output_hash: outputHash };
  }

  function phaseAudit(proof, batchId) {
    const stages = ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'];
    const pending = [];
    const phaseCheckpoints = [];
    let sawPending = false;
    for (const stage of stages) {
      try {
        const checkpointRef = (proof.phase_refs ?? []).find(item => item.stage === stage);
        const row = checkpointRef
          ? store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND checkpoint_id=? AND stage=?')
            .get(proof.owner, checkpointRef.checkpoint_id, `orchestration:phase:${batchId}:${stage}`)
          : store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=? AND delivery_batch_id=? AND stage=?
            ORDER BY rowid DESC LIMIT 1`).get(proof.owner, proof.runId, proof.batchGeneration, batchId,
            `orchestration:phase:${batchId}:${stage}`);
        const phase = row && JSON.parse(row.succeeded_refs_json)[0]?.orchestration_phase;
        if (!row || proof.owner !== owner || proof.batchId !== batchId || row.run_id !== proof.runId || row.generation !== proof.batchGeneration
          || row.delivery_batch_id !== batchId || !phase
          || hash(JSON.stringify(phase)) !== row.output_hash) return { reason: 'stage_worker_exit_unconfirmed', stage };
        phaseCheckpoints.push({ stage, checkpoint_id: row.checkpoint_id, output_hash: row.output_hash, status: phase.status });
        for (const evidence of phase.evidence_proofs ?? []) {
          if (hash(readFileSync(evidence.ref)) !== evidence.hash) return { reason: 'stage_worker_evidence_changed', stage };
        }
        const ref = checkpointRef && checkpointRef.checkpoint_id === row.checkpoint_id
          && checkpointRef.output_hash === row.output_hash && checkpointRef.status === phase.status;
        if (!ref && phase.status !== 'pending') return { reason: 'stage_worker_reference_missing', stage };
        if (phase.status === 'pending') { sawPending = true; pending.push(stage); continue; }
        if (sawPending) return { reason: 'stage_phase_order_invalid', stage };
        if (phase.status === 'running') return { reason: 'stage_invocation_not_returned', stage };
        if (!['succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'invalidated'].includes(phase.status)) {
          return { reason: 'stage_phase_status_invalid', stage };
        }
      } catch { return { reason: 'stage_worker_proof_unreadable', stage }; }
    }
    return { pendingStages: pending, phase_checkpoints: phaseCheckpoints };
  }

  function continuationGate(batchRow) {
    const attempts = store.db.prepare(`SELECT a.rowid AS attempt_rowid,a.delivery_attempt_id,a.dispatched_at,a.status,
        a.revision AS attempt_revision,r.recommendation_id,r.revision AS recommendation_revision,r.state
      FROM recommendation r JOIN delivery_attempt a USING(recommendation_id)
      WHERE r.delivery_batch_id=? AND r.state='cancelled_before_dispatch'
        AND a.rowid=(SELECT latest.rowid FROM delivery_attempt latest WHERE latest.recommendation_id=r.recommendation_id
          ORDER BY latest.rowid DESC LIMIT 1)
      ORDER BY a.intent_at,a.delivery_attempt_id`).all(batchRow.delivery_batch_id);
    if (!attempts.length) return { status: 'clear' };
    const snapshots = [];
    for (const attempt of attempts) {
      try {
        if (attempt.status !== 'cancelled_before_dispatch' || attempt.dispatched_at) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_attempt_changed',
            attempt_id: attempt.delivery_attempt_id };
        }
        const { row, context, intent } = preparedDelivery(attempt.delivery_attempt_id);
        const origin = context.coordination;
        if (!origin || row.owner !== owner || row.delivery_batch_id !== batchRow.delivery_batch_id
          || intent.owner !== owner || intent.delivery_batch_id !== batchRow.delivery_batch_id
          || intent.recommendation_id !== attempt.recommendation_id || intent.coordination?.runId !== origin.runId
          || intent.coordination?.batchGeneration !== origin.batchGeneration || context.phase !== 'cancelled_before_dispatch'
          || !context.cancellation_evidence_ref || !context.cancellation_evidence_hash) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_proof_invalid',
            attempt_id: attempt.delivery_attempt_id };
        }
        const cancellationBytes = readFileSync(context.cancellation_evidence_ref);
        if (hash(cancellationBytes) !== context.cancellation_evidence_hash) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_proof_invalid',
            attempt_id: attempt.delivery_attempt_id };
        }
        const cancellation = JSON.parse(cancellationBytes.toString('utf8'));
        if (cancellation.attempt_id !== attempt.delivery_attempt_id || cancellation.recommendation_id !== intent.recommendation_id
          || cancellation.delivery_batch_id !== intent.delivery_batch_id || cancellation.intent_ref !== context.intent_ref
          || cancellation.intent_hash !== context.intent_hash) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_proof_invalid',
            attempt_id: attempt.delivery_attempt_id };
        }
        const terminalHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND delivery_batch_id=?
          AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, batchRow.delivery_batch_id);
        const terminalProof = terminalHead && headProof(terminalHead);
        if (!terminalHead || !terminalProof) return { status: 'recovery_required',
          reason: 'cancelled_continuation_coordinator_invalid', attempt_id: attempt.delivery_attempt_id };
        const terminal = { owner, batchId: batchRow.delivery_batch_id, runId: terminalHead.run_id,
          batchGeneration: terminalHead.generation };
        const lineage = continuationLineage(origin, terminal, { terminalState: 'returned' });
        if (lineage.status !== 'valid') return { status: 'recovery_required',
          reason: 'cancelled_continuation_coordinator_invalid', detail: lineage.reason, attempt_id: attempt.delivery_attempt_id };
        const proof = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
          .get(owner, `display-build:${intent.recommendation_id}`);
        if (!proof || proof.output_hash !== intent.build_hash
          || !JSON.parse(proof.succeeded_refs_json).some(ref => ref.ref === intent.build_ref && ref.hash === intent.build_hash)) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_proof_invalid',
            attempt_id: attempt.delivery_attempt_id };
        }
        const buildBytes = readFileSync(intent.build_ref);
        if (hash(buildBytes) !== intent.build_hash) return { status: 'recovery_required',
          reason: 'cancelled_continuation_proof_invalid', attempt_id: attempt.delivery_attempt_id };
        const artifact = JSON.parse(buildBytes.toString('utf8'));
        if (artifact.status !== 'succeeded' || artifact.display_state !== 'complete'
          || artifact.recommendation_id !== intent.recommendation_id || artifact.delivery_batch_id !== intent.delivery_batch_id
          || artifact.content_id !== intent.content_id || artifact.decision_id !== intent.decision_id
          || artifact.ordinal !== intent.ordinal || artifact.payload_hash !== intent.payload_hash
          || hash(JSON.stringify(artifact.payload)) !== intent.payload_hash
          || artifact.actual_preference_version !== intent.actual_preference_version
          || artifact.actual_strategy_version !== intent.actual_strategy_version) {
          return { status: 'recovery_required', reason: 'cancelled_continuation_proof_invalid',
            attempt_id: attempt.delivery_attempt_id };
        }
        snapshots.push({ attempt_id: attempt.delivery_attempt_id, attempt_rowid: attempt.attempt_rowid,
          attempt_revision: attempt.attempt_revision, recommendation_id: attempt.recommendation_id,
          recommendation_revision: attempt.recommendation_revision, origin, lineage: lineage.rows });
      } catch (error) {
        return { status: 'recovery_required', reason: 'cancelled_continuation_proof_unreadable',
          attempt_id: attempt.delivery_attempt_id, detail: String(error?.message ?? error) };
      }
    }
    const terminalHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND delivery_batch_id=?
      AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, batchRow.delivery_batch_id);
    return { status: 'blocked', reason: 'explicit_continue_required', batch_id: batchRow.delivery_batch_id,
      run_id: terminalHead.run_id, generation: terminalHead.generation,
      attempt_ids: snapshots.map(item => item.attempt_id), snapshots };
  }

  function continuationSnapshotsCurrent(snapshots, batchId) {
    for (const snapshot of snapshots ?? []) {
      const attempt = store.db.prepare('SELECT rowid AS attempt_rowid,* FROM delivery_attempt WHERE delivery_attempt_id=?')
        .get(snapshot.attempt_id);
      const recommendation = store.db.prepare('SELECT * FROM recommendation WHERE recommendation_id=?')
        .get(snapshot.recommendation_id);
      const latestAttempt = store.db.prepare('SELECT delivery_attempt_id FROM delivery_attempt WHERE recommendation_id=? ORDER BY rowid DESC LIMIT 1')
        .get(snapshot.recommendation_id);
      if (!attempt || attempt.attempt_rowid !== snapshot.attempt_rowid || attempt.revision !== snapshot.attempt_revision
        || attempt.status !== 'cancelled_before_dispatch' || attempt.dispatched_at !== null
        || recommendation?.revision !== snapshot.recommendation_revision || recommendation.state !== 'cancelled_before_dispatch'
        || latestAttempt?.delivery_attempt_id !== snapshot.attempt_id) return false;
      for (const node of snapshot.lineage) {
        const current = store.db.prepare('SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE checkpoint_id=?')
          .get(node.main_checkpoint_id);
        const latest = store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
          AND delivery_batch_id=? AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`)
          .get(owner, node.run_id, node.generation, batchId);
        if (!current || current.checkpoint_rowid !== node.main_rowid || current.output_hash !== node.main_output_hash
          || current.owner !== node.main_owner || current.delivery_batch_id !== node.main_batch_id
          || current.stage !== node.main_stage || current.run_id !== node.run_id || current.generation !== node.generation
          || current.input_hash !== node.main_input_hash || current.pending_ids_json !== node.main_pending_ids_json
          || current.succeeded_refs_json !== node.main_succeeded_refs_json || !headProof(current)
          || latest?.checkpoint_id !== node.main_checkpoint_id) return false;
        if (node.command_checkpoint_id) {
          const command = store.db.prepare('SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE checkpoint_id=?')
            .get(node.command_checkpoint_id);
          let saved;
          try { saved = command && JSON.parse(command.succeeded_refs_json)[0]; } catch { return false; }
          const commandRows = store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND run_id=? AND generation=?
            AND delivery_batch_id=? AND stage LIKE 'orchestration:command:%' ORDER BY rowid`)
            .all(node.command_owner, node.command_run_id, node.command_generation, node.command_batch_id);
          if (!command || command.checkpoint_rowid !== node.command_rowid || command.output_hash !== node.command_output_hash
            || command.owner !== node.command_owner || command.run_id !== node.command_run_id
            || command.generation !== node.command_generation || command.delivery_batch_id !== node.command_batch_id
            || command.stage !== node.command_stage || command.input_hash !== node.command_input_hash
            || command.succeeded_refs_json !== node.command_succeeded_refs_json || commandRows.length !== 1
            || commandRows[0].checkpoint_id !== node.command_checkpoint_id || !saved
            || typeof saved.command_id !== 'string' || !saved.command_id.trim()
            || command.stage !== `orchestration:command:${hash(saved.command_id)}`
            || command.input_hash !== hash(saved.command_id) || command.output_hash !== hash(JSON.stringify(saved))
            || saved.batch_id !== node.command_batch_id || saved.run_id !== node.command_run_id
            || saved.generation !== node.command_generation) return false;
        }
        for (const phase of node.phase_checkpoints ?? []) {
          const currentPhase = store.db.prepare('SELECT rowid AS checkpoint_rowid,* FROM checkpoint WHERE checkpoint_id=?')
            .get(phase.checkpoint_id);
          let phaseValue;
          try { phaseValue = currentPhase && JSON.parse(currentPhase.succeeded_refs_json)[0]?.orchestration_phase; } catch { return false; }
          if (!currentPhase || currentPhase.checkpoint_rowid !== phase.checkpoint_rowid
            || currentPhase.output_hash !== phase.output_hash || currentPhase.owner !== phase.owner
            || currentPhase.run_id !== phase.run_id || currentPhase.generation !== phase.generation
            || currentPhase.delivery_batch_id !== phase.batch_id || currentPhase.stage !== phase.stage
            || currentPhase.input_hash !== phase.input_hash || currentPhase.pending_ids_json !== phase.pending_ids_json
            || currentPhase.succeeded_refs_json !== phase.succeeded_refs_json
            || currentPhase.output_hash !== hash(JSON.stringify(phaseValue)) || phaseValue?.status !== phase.status) return false;
        }
      }
    }
    return true;
  }

  function skipPendingPhases(coordination, reason) {
    for (const stage of ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery']) {
      if (latestPhase(coordination.batchId, stage)?.status === 'pending') {
        recordPhase(coordination, stage, 'skipped', { result: { reason } });
      }
    }
  }

  function workerAudit(proof) {
    for (const worker of proof.worker_refs ?? []) {
      try {
        const bytes = readFileSync(worker.process_ref);
        if (hash(bytes) !== worker.process_hash) return { reason: 'stage_worker_process_proof_mismatch', attempt_id: worker.attempt_id };
        const processInfo = JSON.parse(bytes.toString('utf8'));
        if (processInfo.attempt_id !== worker.attempt_id || processInfo.pid !== worker.process_id
          || processInfo.parent_pid !== worker.parent_pid || processInfo.run_id !== worker.stage_run_id) {
          return { reason: 'stage_worker_process_identity_mismatch', attempt_id: worker.attempt_id };
        }
        if (!worker.exit_observed && processAlive(worker.process_id) !== false) {
          return { reason: 'stage_worker_exit_unconfirmed', attempt_id: worker.attempt_id };
        }
        if (worker.exit_observed && (!Number.isInteger(worker.exit_code) && !worker.signal)) {
          return { reason: 'stage_worker_close_proof_missing', attempt_id: worker.attempt_id };
        }
      } catch { return { reason: 'stage_worker_proof_unreadable', attempt_id: worker.attempt_id }; }
    }
    return null;
  }

  function recoveryEvidenceFile(headRow, worker, sourceRef) {
    const value = { owner, batch_id: headRow.delivery_batch_id, coordinator_run_id: headRow.run_id,
      coordinator_generation: headRow.generation, worker, source_evidence_ref: sourceRef, recorded_at: at() };
    const path = join(root, `task013-recovery-${headRow.run_id}-${worker.stage_run_id}.json`);
    const bytes = `${JSON.stringify(value)}\n`;
    try { writeFileSync(path, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = readFileSync(path);
      if (hash(prior) !== hash(bytes)) throw new Error('recovery evidence path is already bound to another worker');
    }
    return path;
  }

  async function recoverOccupiedStageSlot(headRow, proof, sourceRef) {
    const current = slot();
    if (current.owner === null && current.run_id === null && ['idle', 'stopped'].includes(current.state)) return { status: 'quiescent' };
    if (current.owner !== owner || !current.run_id) return { status: 'recovery_required', reason: 'stage_slot_owner_mismatch' };
    let worker = (proof.worker_refs ?? []).find(item => item.stage_run_id === current.run_id);
    if (!worker) {
      const feedRoot = runtime.homefeed?.root ?? join(root, 'homefeed');
      const displayRoot = runtime.display?.root ?? join(root, 'display');
      const feedRun = join(feedRoot, 'runs', `${current.run_id}.json`);
      const displayRun = join(displayRoot, `run-${current.run_id}.json`);
      if (existsSync(feedRun)) worker = { stage: 'homefeed', stage_run_id: current.run_id, attempt_id: null };
      else if (existsSync(displayRun)) worker = { stage: 'display', stage_run_id: current.run_id, attempt_id: null };
    }
    if (!worker) return { status: 'recovery_required', reason: 'stage_slot_worker_reference_missing' };
    const evidenceRef = recoveryEvidenceFile(headRow, worker, sourceRef);
    const coordination = { owner, batchId: headRow.delivery_batch_id, runId: headRow.run_id, batchGeneration: headRow.generation };
    let modules;
    try { modules = makeModules(coordination, worker.stage); }
    catch (error) { return { status: 'recovery_required', reason: 'stage_recovery_runtime_unavailable', detail: String(error.message ?? error) }; }
    try {
      let result;
      if (worker.stage === 'analysis') result = await modules.analyzer.recover({ confirmedStoppedRunId: current.run_id, evidenceRef });
      else if (worker.stage === 'collection' || worker.stage === 'selection') {
        if (!worker.candidate_id || !worker.attempt_id) return { status: 'recovery_required', reason: 'candidate_attempt_identity_missing' };
        result = await modules.candidates.recover({ batchId: worker.batch_id ?? coordination.batchId,
          candidateId: worker.candidate_id, attemptId: worker.attempt_id, confirmedStoppedRunId: current.run_id, evidenceRef });
      } else if (worker.stage === 'homefeed') result = modules.homefeed.recover({ confirmedStoppedRunId: current.run_id, evidenceRef });
      else if (worker.stage === 'display') result = modules.display.recover({ confirmedStoppedRunId: current.run_id, evidenceRef });
      else if (worker.stage === 'delivery') result = await modules.delivery.recover({ attemptId: worker.attempt_id,
        confirmedStoppedRunId: current.run_id, evidenceRef });
      else return { status: 'recovery_required', reason: 'stage_recovery_interface_missing', stage: worker.stage };
      const after = slot();
      if (after.owner !== null || after.run_id !== null || !['idle', 'stopped'].includes(after.state)) {
        return { status: 'recovery_required', reason: 'stage_recovery_did_not_release_slot', result };
      }
      return { status: 'recovered', stage: worker.stage, attempt_id: worker.attempt_id, evidence_ref: evidenceRef, result };
    } catch (error) {
      return { status: 'recovery_required', reason: 'stage_module_recovery_rejected', stage: worker.stage,
        detail: String(error?.message ?? error) };
    }
  }


  function recoverUndispatchedDelivery(headRow, proof, sourceRef) {
    const coordination = { owner, batchId: headRow.delivery_batch_id, runId: headRow.run_id, batchGeneration: headRow.generation };
    const initialSlot = slot();
    const phaseRef = (proof.phase_refs ?? []).find(item => item.stage === 'delivery');
    const phaseRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, `orchestration:phase:${coordination.batchId}:delivery`);
    let phase;
    try { phase = phaseRow && JSON.parse(phaseRow.succeeded_refs_json)[0]?.orchestration_phase; } catch { return { status: 'recovery_required', reason: 'delivery_phase_proof_unreadable' }; }
    if (!phaseRow || !phaseRef || phaseRow.run_id !== coordination.runId || phaseRow.generation !== coordination.batchGeneration
      || phaseRow.delivery_batch_id !== coordination.batchId || phaseRef.checkpoint_id !== phaseRow.checkpoint_id
      || phaseRef.output_hash !== phaseRow.output_hash || phase.status !== 'running' || phaseRef.status !== 'running'
      || hash(JSON.stringify(phase)) !== phaseRow.output_hash) return { status: 'quiescent' };
    const phaseAuditBefore = phaseAudit(proof, coordination.batchId);
    if (phaseAuditBefore?.reason && !(phaseAuditBefore.reason === 'stage_invocation_not_returned' && phaseAuditBefore.stage === 'delivery')) {
      return { status: 'recovery_required', ...phaseAuditBefore };
    }
    if (initialSlot.owner !== null || initialSlot.run_id !== null || !['idle', 'stopped'].includes(initialSlot.state)) {
      return { status: 'recovery_required', reason: 'stage_slot_not_quiescent' };
    }
    if (proof.process_instance_id === processInstanceId && activeInvocations.has(coordination.runId)) {
      return { status: 'recovery_required', reason: 'coordinator_invocation_is_active' };
    }
    if (proof.process_instance_id !== processInstanceId && processAlive(proof.process_id) !== false) {
      return { status: 'recovery_required', reason: 'coordinator_process_exit_unconfirmed' };
    }

    const pending = store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.dispatched_at,a.revision,r.delivery_batch_id FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      WHERE b.owner=? AND a.status IN ('intent','unknown') ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 26`).all(owner);
    if (pending.length > 25) return { status: 'recovery_required', reason: 'delivery_recovery_attempt_limit_exceeded' };
    if (pending.some(item => item.status === 'unknown' || item.dispatched_at)) {
      const item = pending.find(value => value.status === 'unknown' || value.dispatched_at);
      return { status: 'recovery_required', reason: 'delivery_attempt_outcome_unconfirmed', attempt_id: item.delivery_attempt_id };
    }
    const candidates = [];
    for (const attempt of pending) {
      if (attempt.delivery_batch_id !== coordination.batchId) return { status: 'recovery_required',
        reason: 'foreign_delivery_intent_unresolved', attempt_id: attempt.delivery_attempt_id };
      let prepared;
      try { prepared = preparedDelivery(attempt.delivery_attempt_id); }
      catch (error) { return { status: 'recovery_required', reason: 'delivery_attempt_proof_unavailable',
        attempt_id: attempt.delivery_attempt_id, detail: String(error.message ?? error) }; }
      if (prepared.intent.coordination?.owner !== owner || prepared.intent.coordination?.batchId !== coordination.batchId
        || prepared.intent.coordination?.runId !== coordination.runId
        || prepared.intent.coordination?.batchGeneration !== coordination.batchGeneration) {
        return { status: 'recovery_required', reason: 'delivery_attempt_coordinator_mismatch', attempt_id: attempt.delivery_attempt_id };
      }
      candidates.push({ ...attempt, prepared });
    }
    const cancelledCandidates = [];
    const cancelledRows = store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.dispatched_at,a.revision,r.delivery_batch_id FROM delivery_attempt a
      JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='cancelled_before_dispatch'
      ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 26`).all(coordination.batchId);
    if (cancelledRows.length > 25) return { status: 'recovery_required', reason: 'delivery_recovery_attempt_limit_exceeded' };
    for (const attempt of cancelledRows) {
      let prepared;
      try { prepared = preparedDelivery(attempt.delivery_attempt_id); }
      catch (error) { return { status: 'recovery_required', reason: 'delivery_attempt_proof_unavailable',
        attempt_id: attempt.delivery_attempt_id, detail: String(error.message ?? error) }; }
      if (prepared.intent.coordination?.runId === coordination.runId
        && prepared.intent.coordination?.batchGeneration === coordination.batchGeneration) {
        if (prepared.context.phase !== 'cancelled_before_dispatch' || !prepared.context.cancellation_evidence_ref) {
          return { status: 'recovery_required', reason: 'delivery_cancellation_proof_missing', attempt_id: attempt.delivery_attempt_id };
        }
        cancelledCandidates.push({ ...attempt, prepared });
      }
    }
    const recoveryCandidates = [...candidates, ...cancelledCandidates];
    if (!recoveryCandidates.length) return { status: 'quiescent' };
    let delivery;
    try { delivery = makeModules(coordination, 'delivery').delivery; }
    catch (error) { return { status: 'recovery_required', reason: 'delivery_recovery_runtime_unavailable', detail: String(error.message ?? error) }; }

    const evidenceRefs = [];
    const terminalAttempts = [];
    try {
      for (const candidate of recoveryCandidates) {
        const cancellationRef = candidate.status === 'cancelled_before_dispatch'
          ? candidate.prepared.context.cancellation_evidence_ref : cancellationEvidence(candidate.delivery_attempt_id);
        const cancelled = delivery.cancelPrepared({ attemptId: candidate.delivery_attempt_id, evidenceRef: cancellationRef });
        if (cancelled.status !== 'cancelled_before_dispatch') {
          return { status: 'recovery_required', reason: 'delivery_intent_cancellation_unconfirmed', attempt_id: candidate.delivery_attempt_id };
        }
        const currentAttempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(candidate.delivery_attempt_id);
        const prepared = preparedDelivery(candidate.delivery_attempt_id);
        if (currentAttempt.status !== 'cancelled_before_dispatch' || currentAttempt.dispatched_at
          || !prepared.context.cancellation_evidence_ref || prepared.context.phase !== 'cancelled_before_dispatch') {
          return { status: 'recovery_required', reason: 'delivery_cancellation_proof_missing', attempt_id: candidate.delivery_attempt_id };
        }
        evidenceRefs.push(prepared.context.intent_ref, prepared.context.cancellation_evidence_ref);
        terminalAttempts.push({ attempt_id: candidate.delivery_attempt_id, revision: currentAttempt.revision,
          checkpoint_id: prepared.row.checkpoint_id, output_hash: prepared.row.output_hash });
      }
    } catch (error) {
      return { status: 'recovery_required', reason: 'delivery_intent_cancellation_failed', detail: String(error.message ?? error) };
    }

    const audit = { owner, batch_id: coordination.batchId, coordinator_run_id: coordination.runId,
      coordinator_generation: coordination.batchGeneration, coordinator_process_id: proof.process_id,
      coordinator_process_instance_id: proof.process_instance_id, coordinator_process_exit_confirmed: proof.process_instance_id !== processInstanceId,
      coordinator_invocation_inactive: !activeInvocations.has(coordination.runId),
      source_evidence_ref: sourceRef, running_phase_checkpoint_id: phaseRow.checkpoint_id,
      slot: { revision: initialSlot.revision, generation: initialSlot.generation, state: initialSlot.state,
        owner: initialSlot.owner, run_id: initialSlot.run_id, stop_requested: Boolean(initialSlot.stop_requested) },
      attempts: terminalAttempts, recorded_at: at() };
    const auditPath = join(root, `task013-delivery-recovery-${coordination.runId}-${uuid()}.json`);
    const auditBytes = Buffer.from(`${JSON.stringify(audit)}\n`, 'utf8');
    writeFileSync(auditPath, auditBytes, { flag: 'wx' });
    evidenceRefs.push(auditPath);
    const refs = [...new Set(evidenceRefs)];
    const evidenceProofs = refs.map(ref => ({ ref, hash: hash(readFileSync(ref)) }));
    const recordedAt = at();
    const phaseValue = { phase: 'delivery', status: 'failed', result: { reason: 'coordinator_exit_before_dispatch',
      execution_state: 'confirmed_idle_before_dispatch', attempt_ids: terminalAttempts.map(item => item.attempt_id),
      running_phase_checkpoint_id: phaseRow.checkpoint_id }, evidence_refs: refs, evidence_proofs: evidenceProofs, recorded_at: recordedAt };
    const phaseCheckpointId = uuid();
    const phaseOutputHash = hash(JSON.stringify(phaseValue));
    const changed = store.transaction(() => {
      const liveHead = head(), liveProof = liveHead && headProof(liveHead), liveSlot = slot();
      if (!liveHead || !liveProof || liveHead.checkpoint_id !== headRow.checkpoint_id || !activeHead(liveHead)
        || liveHead.owner !== owner || liveHead.run_id !== coordination.runId || liveHead.generation !== coordination.batchGeneration
        || liveHead.delivery_batch_id !== coordination.batchId || liveProof.owner !== owner
        || liveProof.runId !== coordination.runId || liveProof.batchGeneration !== coordination.batchGeneration
        || liveProof.process_id !== proof.process_id || liveProof.process_instance_id !== proof.process_instance_id
        || liveSlot.revision !== initialSlot.revision || liveSlot.generation !== initialSlot.generation
        || liveSlot.owner !== initialSlot.owner || liveSlot.run_id !== initialSlot.run_id || liveSlot.state !== initialSlot.state
        || Boolean(liveSlot.stop_requested) !== Boolean(initialSlot.stop_requested)) return false;
      const livePhase = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, `orchestration:phase:${coordination.batchId}:delivery`);
      if (!livePhase || livePhase.checkpoint_id !== phaseRow.checkpoint_id || livePhase.output_hash !== phaseRow.output_hash
        || livePhase.run_id !== coordination.runId || livePhase.generation !== coordination.batchGeneration) return false;
      for (const item of terminalAttempts) {
        const attempt = store.db.prepare('SELECT status,dispatched_at,revision FROM delivery_attempt WHERE delivery_attempt_id=?')
          .get(item.attempt_id);
        const checkpoint = store.db.prepare('SELECT checkpoint_id,output_hash FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
          .get(owner, `delivery-attempt:${item.attempt_id}`);
        if (!attempt || attempt.status !== 'cancelled_before_dispatch' || attempt.dispatched_at || attempt.revision !== item.revision
          || !checkpoint || checkpoint.checkpoint_id !== item.checkpoint_id || checkpoint.output_hash !== item.output_hash) return false;
      }
      if (store.db.prepare("SELECT 1 FROM delivery_attempt a JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id WHERE b.owner=? AND a.status IN ('intent','unknown') LIMIT 1")
        .get(owner)) return false;
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,
        succeeded_refs_json,failed_refs_json,input_hash,output_hash,committed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(phaseCheckpointId, owner, coordination.runId, coordination.batchGeneration,
        coordination.batchId, `orchestration:phase:${coordination.batchId}:delivery`, '[]', JSON.stringify([{ orchestration_phase: phaseValue }]),
        JSON.stringify([phaseValue]), hash(JSON.stringify(coordination)), phaseOutputHash, recordedAt);
      const phaseRefs = (liveProof.phase_refs ?? []).filter(item => item.stage !== 'delivery');
      phaseRefs.push({ stage: 'delivery', status: 'failed', checkpoint_id: phaseCheckpointId, output_hash: phaseOutputHash });
      appendHead(coordination, true, { invocation_state: 'executing', worker_refs: liveProof.worker_refs ?? [], phase_refs: phaseRefs });
      const settledHead = head(), settledProof = settledHead && headProof(settledHead);
      if (!settledHead || !settledProof || settledHead.owner !== owner || settledHead.run_id !== coordination.runId
        || settledHead.generation !== coordination.batchGeneration || settledHead.delivery_batch_id !== coordination.batchId) return false;
      appendHead(coordination, false, { invocation_state: 'returned', recovery_evidence_ref: auditPath,
        worker_refs: settledProof.worker_refs, phase_refs: settledProof.phase_refs ?? [], worker_audit_complete: true });
      return true;
    });
    return changed ? { status: 'recovered', stage: 'delivery', attempt_ids: terminalAttempts.map(item => item.attempt_id),
      evidence_ref: auditPath } : { status: 'recovery_required', reason: 'delivery_recovery_state_changed' };
  }

  function latestPhase(batchId, stage) {
    const row = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE stage=? ORDER BY rowid DESC LIMIT 1')
      .get(`orchestration:phase:${batchId}:${stage}`);
    try { return row ? JSON.parse(row.succeeded_refs_json)[0]?.orchestration_phase ?? null : null; }
    catch { return null; }
  }

  function closeExpiredBatches(day) {
    store.transaction(() => {
      const old = store.db.prepare(`SELECT * FROM batch WHERE owner=? AND kind IN ('daily_follow','additional_follow','explore') AND business_day<?
        AND status NOT IN ('completed','closed_day') ORDER BY business_day`).all(owner, day);
      for (const row of old) {
        const changed = store.casState({ entity: 'batch', entity_id: row.delivery_batch_id,
          expectedState: row.status, expectedRevision: row.revision, nextState: 'closed_day', updatedAt: at() });
        if (changed.status !== 'succeeded') throw new Error('cross-day batch closure CAS rejected');
        store.db.prepare("UPDATE candidate SET eligibility_state='hold' WHERE discovery_batch_id=? AND eligibility_state<>'hold'")
          .run(row.delivery_batch_id);
      }
    });
  }

  function createOrFindBatch({ kind, day, commandId, explicitRequest, direction }) {
    if (!Object.hasOwn(targets, kind)) throw new TypeError('kind must be daily_follow, additional_follow or explore');
    if (kind !== 'daily_follow' && (explicitRequest !== true || typeof commandId !== 'string' || !commandId.trim())) {
      throw new TypeError('explicitRequest and stable commandId are required for additional/explore batches');
    }
    if (kind === 'explore' && !hasText(direction)) {
      const existing = store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId);
      if (existing) {
        if (existing.kind !== kind) throw new Error('commandId is already bound to a different batch kind');
        return existing;
      }
      const batchId = uuid();
      store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,updated_at)
        VALUES(?,?,?,'explore',?,3,?,'blocked',?)`).run(batchId, owner, commandId, day, at(), at());
      return store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(batchId);
    }
    if (kind === 'daily_follow') {
      const existing = store.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=?").get(owner, day);
      if (existing) return existing;
    } else {
      const existing = store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId);
      if (existing) {
        if (existing.kind !== kind) throw new Error('commandId is already bound to a different batch kind');
        return existing;
      }
    }
    const batchId = uuid();
    store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`).run(batchId, owner, kind === 'daily_follow' ? null : commandId,
      kind, day, targets[kind], at(), at());
    return store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(batchId);
  }

  async function bindRequest({ source, kind, commandId, requestText, direction }) {
    if (!['direct_user', 'feedback'].includes(source)) throw new TypeError('requestSource must be direct_user or feedback');
    if (source === 'feedback' && typeof runtime?.feedback?.pendingRequests !== 'function') {
      throw new Error('feedback request source is unavailable');
    }
    const pending = source === 'feedback' ? await runtime.feedback.pendingRequests({ commandId }) : [];
    const event = pending.find(item => item.provenance?.command_id === commandId);
    let request;
    if (source === 'feedback') {
      if (!event) throw new Error('saved feedback request is not pending');
      const provenance = event.provenance;
      if (event.status !== 'request_pending' || event.request_type !== kind || event.target !== targets[kind]
        || provenance?.kind !== 'feedback_event' || provenance.owner !== owner || provenance.app_ref !== appRef
        || !provenance.event_id || provenance.command_id !== commandId || provenance.request_text !== requestText
        || provenance.source_message_type !== 'text' || typeof provenance.evidence_ref !== 'string' || typeof provenance.evidence_hash !== 'string') {
        throw new Error('saved feedback request provenance does not match command');
      }
      request = { source: 'feedback', command_id: commandId, kind, target: targets[kind], direction: direction ?? null,
        request_text: requestText, feedback: provenance };
    } else {
      request = { source: 'direct_user', command_id: commandId, kind, target: targets[kind], direction: direction ?? null,
        request_text: requestText };
    }
    const stage = `orchestration:request:${hash(commandId)}`;
    const serialized = JSON.stringify(request);
    store.transaction(() => {
      const prior = store.db.prepare('SELECT succeeded_refs_json,output_hash FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
        .get(owner, stage);
      if (prior) {
        const saved = JSON.parse(prior.succeeded_refs_json)[0]?.orchestration_request;
        if (!saved || JSON.stringify(saved) !== serialized || prior.output_hash !== hash(serialized)) {
          throw new Error('commandId is already bound to a different request');
        }
        return;
      }
      const timestamp = at();
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,input_hash,output_hash,committed_at)
        VALUES(?,?,?,0,?,?,?,?,?)`).run(uuid(), owner, commandId, stage, JSON.stringify([{ orchestration_request: request }]),
        hash(serialized), hash(serialized), timestamp);
    });
    return request;
  }

  function admit({ kind, commandId, explicitRequest, direction }) {
    return store.transaction(() => {
      const day = dueStatus(at()).businessDay;
      const priorHead = head();
      if (activeHead(priorHead)) return { status: 'recovery_required', reason: 'coordinator_not_quiescent', run_id: priorHead.run_id };
      const currentSlot = slot();
      if (!['idle', 'stopped'].includes(currentSlot.state) || currentSlot.owner !== null || currentSlot.run_id !== null || currentSlot.stop_requested) {
        return { status: 'recovery_required', reason: 'execution_slot_not_idle' };
      }
      const currentBatch = createOrFindBatch({ kind, day, commandId, explicitRequest, direction });
      if (kind === 'explore' && !hasText(direction)) return { status: 'blocked', reason: 'exploration_direction_missing', batch_id: currentBatch.delivery_batch_id };
      if (currentBatch.status === 'completed' || currentBatch.status === 'closed_day') return { status: currentBatch.status, batch_id: currentBatch.delivery_batch_id };
      if (currentBatch.stop_requested || currentBatch.status === 'stopped') return { status: 'stopped', batch_id: currentBatch.delivery_batch_id };
      if (kind === 'daily_follow' && store.db.prepare(`SELECT 1 AS found FROM delivery_attempt a
        JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='cancelled_before_dispatch'
        AND r.state='cancelled_before_dispatch' AND a.dispatched_at IS NULL
        AND a.rowid=(SELECT latest.rowid FROM delivery_attempt latest WHERE latest.recommendation_id=a.recommendation_id
          ORDER BY latest.rowid DESC LIMIT 1) LIMIT 1`).get(currentBatch.delivery_batch_id)) {
        return { status: 'recovery_required', reason: 'explicit_continue_state_changed', batch_id: currentBatch.delivery_batch_id };
      }
      if (!['pending', 'running', 'partial', 'blocked'].includes(currentBatch.status)) return { status: currentBatch.status, batch_id: currentBatch.delivery_batch_id };
      const generation = currentBatch.generation + 1;
      const updated = store.casState({ entity: 'batch', entity_id: currentBatch.delivery_batch_id,
          expectedState: currentBatch.status, expectedRevision: currentBatch.revision, nextState: 'running',
          fields: { generation, updated_at: at() }, updatedAt: at() });
      if (updated.status !== 'succeeded') throw new Error('batch admission CAS rejected');
      const identity = { owner, batchId: currentBatch.delivery_batch_id, runId: uuid(), batchGeneration: generation };
      appendHead(identity, true, { command_id: commandId ?? null });
      const claimed = store.casSlot({ owner, runId: `admission:${identity.runId}`, generation: currentSlot.generation + 1,
        batchId: identity.batchId, stopRequested: false, expectedOwner: currentSlot.owner, expectedRunId: currentSlot.run_id,
        expectedGeneration: currentSlot.generation, expectedStopRequested: Boolean(currentSlot.stop_requested),
        expectedState: currentSlot.state, expectedRevision: currentSlot.revision, nextState: 'running',
        updatedAt: at(), coordination: identity });
      if (claimed.status !== 'succeeded') throw new Error('atomic admission slot CAS rejected');
      const runningSlot = slot();
      const released = store.casSlot({ owner: null, runId: null, generation: runningSlot.generation, batchId: null,
        stopRequested: false, expectedOwner: owner, expectedRunId: `admission:${identity.runId}`,
        expectedGeneration: runningSlot.generation, expectedStopRequested: false, expectedState: 'running',
        expectedRevision: runningSlot.revision, nextState: 'stopped', updatedAt: at() });
      if (released.status !== 'succeeded') throw new Error('admission slot release rejected');
      return { status: 'admitted', batch_id: identity.batchId, coordination: identity };
    });
  }

  function makeModules(coordination, onlyStage = null) {
    const collection = runtime.collection, analysis = runtime.analysis, candidateRuntime = runtime.candidates;
    const common = { store, owner, coordination, now };
    const onWorkerSpawned = info => updateWorkerProof({ ...info, coordinator_run_id: coordination.runId,
      coordinator_generation: coordination.batchGeneration, coordinator_batch_id: coordination.batchId });
    const onWorkerExited = info => updateWorkerProof({ ...info, coordinator_run_id: coordination.runId,
      coordinator_generation: coordination.batchGeneration, coordinator_batch_id: coordination.batchId }, true);
    const modules = {};
    if (onlyStage === null || ['collection', 'selection', 'analysis'].includes(onlyStage)) {
      const collector = createCollector({ ...common, root: collection.root ?? join(root, 'collection'), cli: collection.cli,
        settingsPath: collection.settingsPath, executable: collection.executable, decodeImage: collection.decodeImage,
        onWorkerSpawned, onWorkerExited });
      const analyzer = createAnalyzer({ ...common, root: analysis.root ?? join(root, 'analysis'), model: analysis.model,
        executable: analysis.executable, proxy: analysis.proxy, decodeImage: analysis.decodeImage, onWorkerSpawned, onWorkerExited });
      modules.analyzer = analyzer;
      modules.candidates = createCandidates({ ...common, root: candidateRuntime.root ?? join(root, 'candidates'), collector, analyzer,
        model: candidateRuntime.model, executable: candidateRuntime.executable, proxy: candidateRuntime.proxy, decodeImage: candidateRuntime.decodeImage,
        onWorkerSpawned, onWorkerExited });
    }
    if (onlyStage === null || onlyStage === 'homefeed') modules.homefeed = createHomefeed({ ...common, root: runtime.homefeed?.root ?? join(root, 'homefeed') });
    if (onlyStage === null || onlyStage === 'display') {
      const displayRuntime = runtime.display ?? {};
      modules.display = createDisplay({ ...common, root: displayRuntime.root ?? join(root, 'display'), appRef,
        client: displayRuntime.client, uploadImage: displayRuntime.uploadImage, decodeImage: displayRuntime.decodeImage });
    }
    if (onlyStage === null || onlyStage === 'delivery') {
      const deliveryRuntime = runtime.delivery ?? {};
      modules.delivery = createDelivery({ ...common, root: deliveryRuntime.root ?? join(root, 'delivery'), targetRef, appRef,
        transport: deliveryRuntime.transport, currentVersions: deliveryRuntime.currentVersions });
    }
    return modules;
  }

  function assertCurrent(coordination) { store.assertCoordinator(coordination, { now: at() }); }

  function stopAfterStage(coordination, completedStage) {
    const current = batch(coordination.batchId);
    const time = dueStatus(at());
    const order = ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery'];
    if (current?.stop_requested) {
      for (const stage of order.slice(order.indexOf(completedStage) + 1)) {
        if (latestPhase(coordination.batchId, stage)?.status === 'pending') recordPhase(coordination, stage, 'skipped', { result: { reason: 'batch_stopped_before_stage' } });
      }
      const result = { status: 'stopped', batch_id: coordination.batchId, reason: 'batch_stop_requested' };
      finish(coordination, 'stopped', result);
      return result;
    }
    if (!current || current.status === 'closed_day'
      || (['daily_follow', 'additional_follow', 'explore'].includes(current.kind) && current.business_day !== time.businessDay)) {
      closeExpiredBatches(time.businessDay);
      for (const stage of order.slice(order.indexOf(completedStage) + 1)) {
        if (latestPhase(coordination.batchId, stage)?.status === 'pending') recordPhase(coordination, stage, 'skipped', { result: { reason: 'batch_day_closed_before_stage' } });
      }
      const result = { status: 'closed_day', batch_id: coordination.batchId, reason: 'batch_business_day_closed' };
      finish(coordination, 'closed_day', result);
      return result;
    }
    return null;
  }

  function finish(coordination, batchStatus, result, { undispatchedIntent = null } = {}) {
    if (undispatchedIntent) {
      const verified = undispatchedIntentProof(undispatchedIntent.attempt_id);
      if (!verified || JSON.stringify(verified) !== JSON.stringify(undispatchedIntent)) {
        throw new Error('undispatched delivery intent proof changed before finish');
      }
    }
    const reviewedHead = head();
    const reviewedProof = reviewedHead && headProof(reviewedHead);
    if (!activeHead(reviewedHead) || reviewedProof?.invocation_state !== 'executing' || reviewedHead.owner !== coordination.owner
      || reviewedHead.run_id !== coordination.runId || reviewedHead.generation !== coordination.batchGeneration
      || reviewedHead.delivery_batch_id !== coordination.batchId) throw new Error('coordinator head changed before finish');
    const reviewedPhase = phaseAudit(reviewedProof, coordination.batchId);
    if (!reviewedPhase || reviewedPhase.pendingStages.length) throw new Error(reviewedPhase?.reason ?? 'orchestration phases are not terminal');
    const audit = workerAudit(reviewedProof);
    if (audit) throw new Error(audit.reason);
    const reviewedSlot = slot();
    if (reviewedSlot.owner !== null || reviewedSlot.run_id !== null || !['idle', 'stopped'].includes(reviewedSlot.state)) {
      throw new Error('stage execution slot is not quiescent');
    }
    const reviewedWorkers = unresolvedWorkerSnapshot();
    const workerState = unresolvedWorker(coordination.batchId, undispatchedIntent?.attempt_id ?? null);
    if (workerState) throw new Error(workerState.reason);
    store.transaction(() => {
      const currentHead = head();
      const currentProof = currentHead && headProof(currentHead);
      if (!activeHead(currentHead) || currentProof?.invocation_state !== 'executing' || currentHead.owner !== coordination.owner
        || currentHead.run_id !== coordination.runId || currentHead.generation !== coordination.batchGeneration
        || currentHead.delivery_batch_id !== coordination.batchId || currentHead.checkpoint_id !== reviewedHead.checkpoint_id
        || currentHead.output_hash !== reviewedHead.output_hash) {
        throw new Error('coordinator head changed before finish');
      }
      if (!phaseCheckpointsCurrent(currentProof, coordination.batchId, reviewedPhase.phase_checkpoints)) {
        throw new Error('orchestration phase checkpoints changed before finish');
      }
      const currentSlot = slot();
      if (currentSlot.revision !== reviewedSlot.revision || currentSlot.generation !== reviewedSlot.generation
        || currentSlot.owner !== reviewedSlot.owner || currentSlot.run_id !== reviewedSlot.run_id
        || currentSlot.batch_id !== reviewedSlot.batch_id || currentSlot.state !== reviewedSlot.state
        || Boolean(currentSlot.stop_requested) !== Boolean(reviewedSlot.stop_requested)
        || currentSlot.owner !== null || currentSlot.run_id !== null || !['idle', 'stopped'].includes(currentSlot.state)) {
        throw new Error('stage execution slot is not quiescent');
      }
      if (JSON.stringify(unresolvedWorkerSnapshot()) !== JSON.stringify(reviewedWorkers)) {
        throw new Error('unresolved delivery attempts changed before finish');
      }
      const inflight = store.db.prepare(`SELECT a.delivery_attempt_id FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)
        WHERE r.delivery_batch_id=? AND a.dispatched_at IS NOT NULL AND a.status='intent'`).all(coordination.batchId);
      if (inflight.length) throw new Error('a dispatched delivery worker has not been accounted');
      if (undispatchedIntent && !undispatchedIntentFenceCurrent(undispatchedIntent)) {
        throw new Error('undispatched delivery intent fence changed before finish');
      }
      const current = batch(coordination.batchId);
      if (!current) throw new Error('orchestrated batch disappeared');
      if (current.status === 'running' && batchStatus !== 'running') {
        const changed = store.casState({ entity: 'batch', entity_id: current.delivery_batch_id,
          expectedState: current.status, expectedRevision: current.revision, nextState: batchStatus, updatedAt: at() });
        if (changed.status !== 'succeeded') throw new Error('batch final state CAS rejected');
      }
      appendHead(coordination, false, { invocation_state: 'returned', result_status: result.status,
        worker_refs: currentProof.worker_refs, phase_refs: currentProof.phase_refs, worker_audit_complete: true });
    });
  }

  async function run({ kind = 'daily_follow', tab, commandId, explicitRequest, requestText, direction, requestSource = 'direct_user', coordination: continuedCoordination } = {}) {
    const time = dueStatus(at());
    if (['daily_follow', 'additional_follow', 'explore'].includes(kind)) closeExpiredBatches(time.businessDay);
    if (!continuedCoordination && kind === 'daily_follow' && time.status !== 'due') {
      const existing = store.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=?").get(owner, time.businessDay);
      return { status: 'not_due', batch_id: existing?.delivery_batch_id ?? null, business_day: time.businessDay };
    }
    if (!Object.hasOwn(targets, kind)) throw new TypeError('kind must be daily_follow, additional_follow or explore');
    const request = requestText ?? (typeof explicitRequest === 'string' ? explicitRequest : null);
    if (!continuedCoordination && kind !== 'daily_follow' && hasText(request) && typeof commandId === 'string' && commandId.trim()) {
      await bindRequest({ source: requestSource, kind, commandId, requestText: request, direction });
    }
    if (kind === 'explore' && hasText(request) && typeof commandId === 'string' && commandId.trim() && !hasText(direction)) {
      const saved = store.transaction(() => createOrFindBatch({ kind, day: time.businessDay, commandId, explicitRequest: true, direction }));
      return { status: 'blocked', batch_id: saved.delivery_batch_id, reason: 'exploration_direction_missing' };
    }
    const existing = kind === 'daily_follow'
      ? store.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=?").get(owner, time.businessDay)
      : commandId ? store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId) : null;
    if (existing && kind !== 'daily_follow' && existing.kind !== kind) throw new Error('commandId is already bound to a different batch kind');
    if (existing && ['completed', 'closed_day'].includes(existing.status)) return { status: existing.status, batch_id: existing.delivery_batch_id, business_day: existing.business_day };
    if (existing?.stop_requested || existing?.status === 'stopped') return { status: 'stopped', batch_id: existing.delivery_batch_id, business_day: existing.business_day };
    if (!continuedCoordination) {
      const latest = head();
      if (activeHead(latest)) return { status: 'recovery_required', batch_id: latest.delivery_batch_id,
        business_day: batch(latest.delivery_batch_id)?.business_day ?? null, run_id: latest.run_id };
    }
    if (!continuedCoordination && kind === 'daily_follow' && existing && !['completed', 'closed_day'].includes(existing.status)) {
      const gate = continuationGate(existing);
      if (gate.status !== 'clear') return gate.status === 'blocked'
        ? { status: gate.status, reason: gate.reason, batch_id: gate.batch_id, run_id: gate.run_id,
          generation: gate.generation, attempt_ids: gate.attempt_ids }
        : { status: 'recovery_required', reason: gate.reason, batch_id: existing.delivery_batch_id,
          ...(gate.attempt_id ? { attempt_id: gate.attempt_id } : {}) };
    }
    if (kind !== 'daily_follow' && (!hasText(request) || typeof commandId !== 'string' || !commandId.trim())) {
      throw new TypeError('explicitRequest and stable commandId are required for additional/explore batches');
    }
    const proposalAudit = continuedCoordination ? cancelledContinuationItems(continuedCoordination) : { items: [], invalidAttemptId: null };
    if (proposalAudit.invalidAttemptId) return { status: 'recovery_required', batch_id: continuedCoordination.batchId,
      reason: 'continuation_proposal_proof_invalid', attempt_id: proposalAudit.invalidAttemptId };
    const initialBatch = continuedCoordination ? batch(continuedCoordination.batchId) : null;
    const initialDelivered = continuedCoordination ? store.db.prepare("SELECT count(DISTINCT content_id) AS count FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
      .get(continuedCoordination.batchId).count : 0;
    const initialRemaining = initialBatch ? Math.max(0, initialBatch.target - initialDelivered) : 0;
    const initialProposals = proposalAudit.items.slice(0, initialRemaining);
    const continuationCoversTarget = initialRemaining > 0 && initialProposals.length >= initialRemaining;
    const missing = continuationCoversTarget
      ? (!targetRef || !appRef || typeof runtime?.delivery?.transport?.send !== 'function'
        || typeof runtime?.delivery?.transport?.lookup !== 'function' ? 'delivery send/lookup capability is incomplete' : null)
      : requireRuntime(runtime, tab, kind, direction, requestText ?? (typeof explicitRequest === 'string' ? explicitRequest : null));
    if (missing) {
      if (!continuedCoordination) {
        store.transaction(() => createOrFindBatch({ kind, day: time.businessDay,
          commandId: kind === 'daily_follow' ? null : commandId,
          explicitRequest: kind === 'daily_follow' ? null : true, direction }));
      }
      const current = kind === 'daily_follow'
        ? store.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND business_day=?").get(owner, time.businessDay)
        : store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId);
      if (current?.status === 'pending') {
        store.casState({ entity: 'batch', entity_id: current.delivery_batch_id, expectedState: current.status,
          expectedRevision: current.revision, nextState: 'blocked', updatedAt: at() });
      }
      return { status: 'blocked', batch_id: current?.delivery_batch_id ?? null,
        business_day: current?.business_day ?? time.businessDay, reason: missing };
    }
    const admission = continuedCoordination
      ? { status: 'admitted', batch_id: continuedCoordination.batchId, coordination: continuedCoordination }
      : admit({ kind, commandId, explicitRequest: kind === 'daily_follow' ? null : true, direction });
    if (admission.status !== 'admitted') return admission;
    const coordination = admission.coordination;
    if (activeInvocations.has(coordination.runId)) return { status: 'already_running', batch_id: coordination.batchId, run_id: coordination.runId };
    activeInvocations.add(coordination.runId);
    let activePhase = null;
    try {
      if (!consumeAdmission(coordination)) return { status: 'recovery_required', batch_id: coordination.batchId, run_id: coordination.runId, reason: 'admission_already_consumed_or_stale' };
      for (const phase of ['delivery_reconcile', 'homefeed', 'candidates', 'display', 'delivery']) {
        recordPhase(coordination, phase, 'pending', { pendingIds: [coordination.batchId] });
      }
      const modules = makeModules(coordination, continuationCoversTarget ? 'delivery' : null);
      const batchRow = batch(coordination.batchId);
      assertCurrent(coordination);
      activePhase = 'delivery_reconcile';
      recordPhase(coordination, activePhase, 'running', { pendingIds: [coordination.batchId] });
      let reconciledCount = 0;
      while (true) {
        const pendingAttempts = store.db.prepare(`SELECT a.delivery_attempt_id,a.status,a.dispatched_at,r.recommendation_id,r.delivery_batch_id,b.status AS batch_status,b.stop_requested,b.kind,b.business_day FROM delivery_attempt a
          JOIN recommendation r USING(recommendation_id) JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
          WHERE b.owner=? AND a.status IN ('intent','unknown') ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 25`).all(owner);
        if (pendingAttempts.length === 0) break;
        for (const attempt of pendingAttempts) {
          let reconciled;
          if (attempt.status === 'intent' && attempt.dispatched_at === null
            && (attempt.batch_status === 'closed_day' || attempt.stop_requested || attempt.batch_status === 'stopped')) {
            const evidenceRef = cancellationEvidence(attempt.delivery_attempt_id);
            reconciled = modules.delivery.cancelPrepared({ attemptId: attempt.delivery_attempt_id, evidenceRef });
          } else {
            reconciled = await modules.delivery.reconcileDelivery(attempt.delivery_attempt_id);
          }
          reconciledCount++;
          const afterAttempt = store.db.prepare('SELECT status FROM delivery_attempt WHERE delivery_attempt_id=?').get(attempt.delivery_attempt_id);
          if (['unknown', 'intent'].includes(afterAttempt?.status)) {
            const undispatchedIntent = afterAttempt.status === 'intent' && attempt.dispatched_at === null
              ? undispatchedIntentProof(attempt.delivery_attempt_id) : null;
            const result = { status: 'blocked', reason: reconciled.status === 'intent' && attempt.dispatched_at === null
              ? 'prepared_delivery_requires_same_batch_resume' : 'delivery_unknown_requires_reconciliation', batch_id: coordination.batchId,
              attempt_status: afterAttempt.status, attempt_id: attempt.delivery_attempt_id,
              original_batch_id: store.db.prepare('SELECT r.delivery_batch_id FROM recommendation r WHERE r.recommendation_id=(SELECT recommendation_id FROM delivery_attempt WHERE delivery_attempt_id=?)')
                .get(attempt.delivery_attempt_id)?.delivery_batch_id ?? null };
            recordPhase(coordination, activePhase, afterAttempt.status === 'intent' ? 'blocked' : 'unknown',
              { pendingIds: [attempt.delivery_attempt_id], evidenceRefs: reconciled.evidence_refs ?? [], result });
            for (const stage of ['homefeed', 'candidates', 'display', 'delivery']) {
              recordPhase(coordination, stage, 'skipped', { result: { reason: 'owner_delivery_attempt_unresolved' } });
            }
            finish(coordination, 'blocked', result, { undispatchedIntent });
            return result;
          }
        }
      }
      recordPhase(coordination, activePhase, 'succeeded', { result: { reconciled_attempts: reconciledCount, owner_scope: true } });
      const alreadySucceeded = store.db.prepare("SELECT count(DISTINCT r.content_id) AS count FROM recommendation r JOIN batch b USING(delivery_batch_id) WHERE r.delivery_batch_id=? AND r.state='succeeded'")
        .get(coordination.batchId).count;
      const remaining = Math.max(0, batchRow.target - alreadySucceeded);
      if (remaining === 0) {
        const result = { status: 'completed', batch_id: coordination.batchId, delivered: alreadySucceeded, shortfall: 0 };
        recordPhase(coordination, 'homefeed', 'skipped', { result: { reason: 'target_already_met' } });
        recordPhase(coordination, 'candidates', 'skipped', { result: { reason: 'target_already_met' } });
        recordPhase(coordination, 'display', 'skipped', { result: { reason: 'target_already_met' } });
        recordPhase(coordination, 'delivery', 'skipped', { result: { reason: 'target_already_met' } });
        finish(coordination, 'completed', result);
        return result;
      }
      const continuationItems = proposalAudit.items.slice(0, remaining);
      const skipDiscovery = continuationItems.length >= remaining;
      let feed, candidateResult, displayResult;
      if (skipDiscovery) {
        feed = { status: 'succeeded' };
        candidateResult = { status: 'succeeded', eligible: [] };
        displayResult = { status: 'succeeded', items: continuationItems, evidence_refs: continuationItems.flatMap(item => item.evidence_refs) };
        recordPhase(coordination, 'homefeed', 'skipped', { result: { reason: 'verified_continuation_proposals_cover_remaining_target' } });
        recordPhase(coordination, 'candidates', 'skipped', { result: { reason: 'verified_continuation_proposals_cover_remaining_target' } });
        recordPhase(coordination, 'display', 'skipped', { evidenceRefs: displayResult.evidence_refs,
          result: { reason: 'reused_verified_display_builds', item_count: continuationItems.length } });
      } else {
        assertCurrent(coordination);
        activePhase = 'homefeed';
        feed = modules.homefeed.state(coordination.batchId);
        const priorFeed = latestPhase(coordination.batchId, activePhase);
        if (priorFeed?.status === 'succeeded' && feed?.refresh_state === 'succeeded') {
          recordPhase(coordination, activePhase, 'skipped', { result: { reused_checkpoint: true, prior_run_id: priorFeed.run_id } });
        } else {
          recordPhase(coordination, activePhase, 'running', { pendingIds: [coordination.batchId] });
          feed = await modules.homefeed.refreshHomefeed(coordination.batchId, tab, runtime.homefeed?.options ?? {});
          recordPhase(coordination, activePhase, feed?.refresh_state === 'succeeded' ? 'succeeded' : 'failed',
            { evidenceRefs: feed?.evidence_refs ?? [], result: { refresh_state: feed?.refresh_state ?? null, unique_count: feed?.unique_count ?? null } });
        }
        const afterFeed = stopAfterStage(coordination, 'homefeed');
        if (afterFeed) return afterFeed;
        assertCurrent(coordination);
        activePhase = 'candidates';
        recordPhase(coordination, activePhase, 'running', { pendingIds: [coordination.batchId] });
        candidateResult = await modules.candidates.run({ batchId: coordination.batchId, explicitRequest: kind === 'daily_follow' ? null : request,
          direction, maxCandidates: runtime.candidates.maxCandidates ?? 200,
          excludeCandidateIds: continuationItems.map(item => item.candidate_id) });
        recordPhase(coordination, activePhase, candidateResult.status === 'unknown' ? 'unknown' : candidateResult.status === 'blocked' ? 'blocked'
          : candidateResult.status === 'failed' ? 'failed' : 'succeeded', { pendingIds: candidateResult.pending?.map(item => item.candidate_id) ?? [],
          evidenceRefs: candidateResult.evidence_refs ?? [], result: { status: candidateResult.status, shortfall: candidateResult.shortfall } });
        const afterCandidates = stopAfterStage(coordination, 'candidates');
        if (afterCandidates) return afterCandidates;
        assertCurrent(coordination);
        const successfulIds = new Set(store.db.prepare("SELECT content_id FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
          .all(coordination.batchId).map(row => row.content_id));
        const continuationDecisions = new Set(continuationItems.map(item => item.decision_id));
        const newBudget = Math.max(0, remaining - continuationItems.length);
        const requested = (candidateResult.eligible ?? []).filter(item => !successfulIds.has(item.content_id)
          && !continuationDecisions.has(item.decision_id)).slice(0, newBudget);
        activePhase = 'display';
        recordPhase(coordination, activePhase, 'running', { pendingIds: [...continuationItems.map(item => item.decision_id), ...requested.map(item => item.decision_id)] });
        const builtDisplay = requested.length
          ? await modules.display.buildBatch(coordination.batchId, requested)
          : { status: 'succeeded', items: [], evidence_refs: [] };
        displayResult = { ...builtDisplay, items: [...continuationItems, ...(builtDisplay.items ?? [])],
          evidence_refs: [...continuationItems.flatMap(item => item.evidence_refs), ...(builtDisplay.evidence_refs ?? [])] };
        recordPhase(coordination, activePhase, displayResult.status === 'blocked' ? 'blocked' : displayResult.status === 'failed' ? 'failed' : 'succeeded',
          { pendingIds: (displayResult.items ?? []).filter(item => item.status !== 'succeeded').map(item => item.decision_id),
            evidenceRefs: displayResult.evidence_refs ?? [], result: { status: displayResult.status, item_count: displayResult.items?.length ?? 0 } });
      }
      const afterDisplay = stopAfterStage(coordination, 'display');
      if (afterDisplay) return afterDisplay;
      assertCurrent(coordination);
      const attempts = [];
      activePhase = 'delivery';
      recordPhase(coordination, activePhase, 'running', { pendingIds: displayResult.items?.map(item => item.recommendation_id) ?? [] });
      for (const item of displayResult.items ?? []) {
        if (item.status !== 'succeeded') continue;
        assertCurrent(coordination);
        const deliveredNow = store.db.prepare("SELECT count(DISTINCT content_id) AS count FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
          .get(coordination.batchId).count;
        if (deliveredNow >= batchRow.target) break;
        // 每条准备前恢复运行态，避免上一条成功状态遮住新建但未派发的意图。
        recordPhase(coordination, activePhase, 'running', { pendingIds: [item.recommendation_id],
          result: { recommendation_id: item.recommendation_id } });
        const currentSlot = slot();
        const prepared = item.previous_attempt_id
          ? await modules.delivery.reprepareCancelled({ attemptId: item.previous_attempt_id, item,
            continueCommandId: coordination.continueCommandId, evidenceRef: item.cancellation_evidence_ref,
            expectedGeneration: currentSlot.generation })
          : await modules.delivery.prepareDelivery(item, currentSlot.generation);
        if (prepared.status !== 'succeeded') { attempts.push(prepared); continue; }
        const sent = await modules.delivery.sendPrepared(prepared.attempt_id);
        const accounted = sent.status === 'unknown' ? await modules.delivery.reconcileDelivery(prepared.attempt_id) : sent;
        attempts.push(accounted);
        recordPhase(coordination, activePhase, accounted.status === 'unknown' ? 'unknown' : accounted.status === 'failed' ? 'failed'
          : accounted.status === 'succeeded' ? 'succeeded' : 'blocked',
          { pendingIds: accounted.status === 'succeeded' || accounted.status === 'failed' ? [] : [prepared.attempt_id],
            evidenceRefs: accounted.evidence_refs ?? [], result: { attempt_id: prepared.attempt_id, status: accounted.status } });
        const afterSend = stopAfterStage(coordination, 'delivery');
        if (afterSend) return { ...afterSend, delivery: attempts };
        if (accounted.status === 'unknown' || accounted.status === 'intent') break;
      }
      const afterCount = store.db.prepare("SELECT count(DISTINCT content_id) AS count FROM recommendation WHERE delivery_batch_id=? AND state='succeeded'")
        .get(coordination.batchId).count;
      const unresolved = attempts.some(item => item.status === 'unknown' || item.status === 'intent');
      const stopped = batch(coordination.batchId).stop_requested === 1;
      const status = stopped ? 'stopped' : unresolved ? 'blocked' : afterCount >= batchRow.target ? 'completed' : 'partial';
      const result = { status, batch_id: coordination.batchId, delivered: afterCount,
        shortfall: Math.max(0, batchRow.target - afterCount), feed_status: feed.status,
        candidate_status: candidateResult.status, display_status: displayResult.status, delivery: attempts };
      recordPhase(coordination, activePhase, status === 'completed' ? 'succeeded' : status === 'blocked' ? 'blocked' : status === 'stopped' ? 'skipped' : 'succeeded',
        { pendingIds: attempts.filter(item => ['unknown', 'intent'].includes(item.status)).map(item => item.attempt_id), result });
      finish(coordination, status, result);
      return result;
    } catch (error) {
      // 异常可能来自仍在运行的外部 worker；保留活动协调头，等待有证据的恢复。
      const phase = activePhase && latestPhase(coordination.batchId, activePhase);
      const preserveUnresolvedAttempt = phase && ['blocked', 'unknown'].includes(phase.status)
        && ['intent', 'unknown'].includes(phase.result?.attempt_status);
      try { if (activePhase && !preserveUnresolvedAttempt) recordPhase(coordination, activePhase, 'failed', { result: { reason: String(error?.message ?? error) } }); } catch { /* checkpoint损坏时保留原证据。 */ }
      try { skipPendingPhases(coordination, 'run_returned_before_stage'); } catch { /* checkpoint损坏时保留原证据。 */ }
      try { markInvocationReturned(coordination, String(error?.message ?? error)); } catch { /* 身份改变时不覆盖新协调头。 */ }
      return { status: 'recovery_required', batch_id: coordination.batchId, run_id: coordination.runId, reason: String(error?.message ?? error) };
    } finally {
      activeInvocations.delete(coordination.runId);
    }
  }

  async function requestStop({ batchId } = {}) {
    if (!batchId) throw new TypeError('batchId is required');
    store.transaction(() => {
      const current = batch(batchId);
      if (!current) throw new Error('batch missing');
      const result = store.casState({ entity: 'batch', entity_id: batchId, expectedState: current.status,
        expectedRevision: current.revision, nextState: current.status, fields: { stop_requested: 1, updated_at: at() }, updatedAt: at() });
      if (result.status !== 'succeeded') throw new Error('batch stop CAS rejected');
      const currentSlot = slot();
      if (currentSlot.owner === owner && currentSlot.batch_id === batchId && currentSlot.state === 'running') {
        const stopped = store.casSlot({ owner: currentSlot.owner, runId: currentSlot.run_id, generation: currentSlot.generation,
          stopRequested: true, expectedOwner: currentSlot.owner, expectedRunId: currentSlot.run_id,
          expectedGeneration: currentSlot.generation, expectedStopRequested: Boolean(currentSlot.stop_requested),
          expectedState: currentSlot.state, expectedRevision: currentSlot.revision, nextState: 'stopping', updatedAt: at() });
        if (stopped.status !== 'succeeded') throw new Error('execution slot stop CAS rejected');
      }
    });
    return { status: 'stop_requested', batch_id: batchId };
  }

  async function continueBatch({ batchId, commandId, confirmedStoppedRunId, evidenceRef, explicitRequest, direction } = {}) {
    if (!batchId || !commandId || !confirmedStoppedRunId || !evidenceRef || explicitRequest !== true) {
      throw new TypeError('batchId, explicit continue commandId, confirmedStoppedRunId and evidenceRef are required');
    }
    const commandStage = `orchestration:command:${hash(commandId)}`;
    const savedCommand = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1')
      .get(owner, commandStage);
    if (savedCommand) {
      try {
        const saved = JSON.parse(savedCommand.succeeded_refs_json)[0];
        const savedHead = saved && store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND run_id=? AND generation=? AND delivery_batch_id=?
          AND stage='orchestration:main' ORDER BY rowid DESC LIMIT 1`).get(owner, saved.run_id, saved.generation, saved.batch_id);
        const savedProof = savedHead && headProof(savedHead);
        if (savedCommand.delivery_batch_id !== batchId || savedCommand.run_id !== saved?.run_id
          || savedCommand.generation !== saved?.generation || saved?.batch_id !== batchId || saved?.command_id !== commandId
          || savedCommand.input_hash !== hash(commandId) || savedCommand.output_hash !== hash(JSON.stringify(saved)) || !savedProof
          || savedProof.continued_from !== confirmedStoppedRunId) {
          return { status: 'recovery_required', reason: 'continue_command_identity_mismatch' };
        }
        const previousCoordination = { owner, batchId, runId: confirmedStoppedRunId, batchGeneration: saved.generation - 1 };
        const coordination = { owner, batchId, runId: saved.run_id, batchGeneration: saved.generation,
          continueCommandId: commandId, continuedFromRunId: previousCoordination.runId,
          continuedFromGeneration: previousCoordination.batchGeneration };
        const cancellation = cancelUndispatchedContinuationAttempts(coordination, previousCoordination);
        if (cancellation.status !== 'ready') return { status: 'recovery_required', ...cancellation };
        return { status: 'duplicate_command', ...saved, coordination, cancelled_attempt_ids: cancellation.cancelled_attempt_ids };
      } catch { return { status: 'recovery_required', reason: 'continue_command_proof_invalid' }; }
    }
    const reviewedCurrent = batch(batchId);
    const reviewedContinuation = reviewedCurrent ? continuationGate(reviewedCurrent) : { status: 'clear' };
    if (reviewedContinuation.status === 'recovery_required') return reviewedContinuation;
    const reviewedGlobalHead = head();
    const reviewedGlobalProof = reviewedGlobalHead && headProof(reviewedGlobalHead);
    const reviewedSlot = slot();
    const reviewedOldHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND stage='orchestration:main'
      AND delivery_batch_id=? ORDER BY rowid DESC LIMIT 1`).get(owner, batchId);
    const reviewedOldProof = reviewedOldHead && headProof(reviewedOldHead);
    if (!reviewedCurrent || !reviewedGlobalHead || !reviewedGlobalProof || activeHead(reviewedGlobalHead)
      || reviewedGlobalProof.invocation_state !== 'returned'
      || !reviewedOldHead || !reviewedOldProof || reviewedOldHead.owner !== owner || reviewedOldProof.owner !== owner
      || reviewedOldHead.run_id !== confirmedStoppedRunId || reviewedOldHead.generation !== reviewedCurrent.generation
      || reviewedOldProof.invocation_state !== 'returned' || activeHead(reviewedOldHead)) {
      return { status: 'recovery_required', reason: 'coordinator_exit_not_confirmed' };
    }
    const reviewedPhase = phaseAudit(reviewedOldProof, batchId);
    if (reviewedPhase?.reason) return { status: 'recovery_required', ...reviewedPhase };
    const reviewedWorker = workerAudit(reviewedOldProof);
    if (reviewedWorker) return { status: 'recovery_required', ...reviewedWorker };
    const continued = store.transaction(() => {
      const priorCommand = store.db.prepare('SELECT succeeded_refs_json FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner, commandStage);
      if (priorCommand) return { status: 'duplicate_command', ...JSON.parse(priorCommand.succeeded_refs_json)[0] };
      const current = batch(batchId);
      if (!current) throw new Error('batch missing');
      if (current.status === 'closed_day' || current.status === 'completed') return { status: current.status, batch_id: batchId };
      const liveGlobalHead = head();
      const liveGlobalProof = liveGlobalHead && headProof(liveGlobalHead);
      const oldHead = store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND stage='orchestration:main'
        AND delivery_batch_id=? ORDER BY rowid DESC LIMIT 1`).get(owner, batchId);
      const proof = oldHead && headProof(oldHead);
      const latestBatchRun = oldHead && store.db.prepare(`SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage='orchestration:main'
        AND delivery_batch_id=? ORDER BY rowid DESC LIMIT 1`).get(owner, batchId);
      const currentSlot = slot();
      if (!liveGlobalHead || liveGlobalHead.checkpoint_id !== reviewedGlobalHead.checkpoint_id
        || liveGlobalHead.output_hash !== reviewedGlobalHead.output_hash || !liveGlobalProof
        || activeHead(liveGlobalHead) || liveGlobalProof.invocation_state !== 'returned'
        || !oldHead || oldHead.checkpoint_id !== reviewedOldHead.checkpoint_id || oldHead.output_hash !== reviewedOldHead.output_hash
        || latestBatchRun?.checkpoint_id !== reviewedOldHead.checkpoint_id
        || !proof || oldHead.owner !== owner || proof.owner !== owner || oldHead.run_id !== confirmedStoppedRunId
        || oldHead.delivery_batch_id !== batchId || current.generation !== reviewedCurrent.generation
        || current.revision !== reviewedCurrent.revision || oldHead.generation !== current.generation
        || activeHead(oldHead) || proof.invocation_state !== 'returned'
        || currentSlot.revision !== reviewedSlot.revision || currentSlot.generation !== reviewedSlot.generation
        || currentSlot.owner !== reviewedSlot.owner || currentSlot.run_id !== reviewedSlot.run_id
        || currentSlot.batch_id !== reviewedSlot.batch_id || currentSlot.state !== reviewedSlot.state
        || Boolean(currentSlot.stop_requested) !== Boolean(reviewedSlot.stop_requested)
        || currentSlot.owner !== null || currentSlot.run_id !== null || !['idle', 'stopped'].includes(currentSlot.state)) {
        return { status: 'recovery_required', reason: 'coordinator_exit_not_confirmed' };
      }
      if (!phaseCheckpointsCurrent(proof, batchId, reviewedPhase.phase_checkpoints)) {
        return { status: 'recovery_required', reason: 'stage_checkpoint_changed_during_continue' };
      }
      if (!continuationSnapshotsCurrent(reviewedContinuation.snapshots, batchId)) {
        return { status: 'recovery_required', reason: 'continuation_obligation_changed_during_continue',
          attempt_id: reviewedContinuation.snapshots?.find(snapshot => {
            const attempt = store.db.prepare('SELECT * FROM delivery_attempt WHERE delivery_attempt_id=?').get(snapshot.attempt_id);
            return !attempt || attempt.revision !== snapshot.attempt_revision;
          })?.attempt_id ?? reviewedContinuation.attempt_ids?.[0] };
      }
      if (reviewedPhase.pendingStages.length) {
        const oldCoordination = { owner, batchId, runId: oldHead.run_id, batchGeneration: oldHead.generation };
        skipPendingPhases(oldCoordination, 'confirmed_not_started_before_recovery');
        const phaseRefs = phaseReferencesForIdentity(proof, batchId);
        if (!phaseRefs) return { status: 'recovery_required', reason: 'stage_checkpoint_changed_during_continue' };
        appendHead(oldCoordination, false, { invocation_state: 'returned', continued_from: proof.continued_from,
          evidence_ref: proof.evidence_ref, worker_refs: proof.worker_refs, phase_refs: phaseRefs, worker_audit_complete: true });
      }
      if (currentSlot.owner !== null || currentSlot.run_id !== null || !['idle', 'stopped'].includes(currentSlot.state)) return { status: 'recovery_required', reason: 'stage_slot_not_quiescent' };
      const uncertain = store.db.prepare(`SELECT a.delivery_attempt_id FROM delivery_attempt a
        JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=?
        AND (a.status='unknown' OR (a.status='intent' AND a.dispatched_at IS NOT NULL))
        ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 1`).get(batchId);
      if (uncertain) return { status: 'recovery_required', reason: 'delivery_attempt_outcome_unconfirmed', attempt_id: uncertain.delivery_attempt_id };
      const preparedAttempts = store.db.prepare(`SELECT a.delivery_attempt_id FROM delivery_attempt a
        JOIN recommendation r USING(recommendation_id) WHERE r.delivery_batch_id=? AND a.status='intent' AND a.dispatched_at IS NULL
        ORDER BY a.intent_at,a.delivery_attempt_id LIMIT 25`).all(batchId);
      for (const attempt of preparedAttempts) {
        try {
          const { context } = preparedDelivery(attempt.delivery_attempt_id);
          if (context.coordination?.runId !== oldHead.run_id || context.coordination?.batchGeneration !== oldHead.generation) {
            return { status: 'recovery_required', reason: 'delivery_attempt_coordinator_mismatch', attempt_id: attempt.delivery_attempt_id };
          }
        } catch (error) {
          return { status: 'recovery_required', reason: 'delivery_attempt_proof_unavailable',
            attempt_id: attempt.delivery_attempt_id, detail: String(error.message ?? error) };
        }
      }
      const day = dueStatus(at()).businessDay;
      if (['daily_follow', 'additional_follow', 'explore'].includes(current.kind) && current.business_day !== day) {
        const closed = store.casState({ entity: 'batch', entity_id: batchId, expectedState: current.status,
          expectedRevision: current.revision, nextState: 'closed_day', updatedAt: at() });
        if (closed.status !== 'succeeded') throw new Error('cross-day continuation closure CAS rejected');
        store.db.prepare("UPDATE candidate SET eligibility_state='hold' WHERE discovery_batch_id=? AND eligibility_state<>'hold'")
          .run(batchId);
        return { status: 'closed_day', batch_id: batchId };
      }
      const latestBatch = batch(batchId);
      const updated = store.casState({ entity: 'batch', entity_id: batchId, expectedState: latestBatch.status,
        expectedRevision: latestBatch.revision, nextState: 'running', fields: { generation: latestBatch.generation + 1,
          stop_requested: 0, updated_at: at() }, updatedAt: at() });
      if (updated.status !== 'succeeded') throw new Error('continue batch CAS rejected');
      const generation = latestBatch.generation + 1;
      const coordination = { owner, batchId, runId: uuid(), batchGeneration: generation };
      appendHead(coordination, true, { continued_from: confirmedStoppedRunId, evidence_ref: evidenceRef, worker_refs: [], phase_refs: [] });
      const saved = { batch_id: batchId, run_id: coordination.runId, generation, command_id: commandId };
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,succeeded_refs_json,input_hash,output_hash,committed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(uuid(), owner, coordination.runId, generation, batchId, commandStage,
        JSON.stringify([saved]), hash(commandId), hash(JSON.stringify(saved)), at());
      return { status: 'continued', ...saved, coordination };
    });
    if (!['continued', 'duplicate_command'].includes(continued.status)) return continued;
    const baseCoordination = continued.coordination ?? { owner, batchId: continued.batch_id, runId: continued.run_id,
      batchGeneration: continued.generation };
    const previousCoordination = { owner, batchId, runId: confirmedStoppedRunId, batchGeneration: baseCoordination.batchGeneration - 1 };
    const coordination = { ...baseCoordination, continueCommandId: commandId, continuedFromRunId: previousCoordination.runId,
      continuedFromGeneration: previousCoordination.batchGeneration };
    const cancellation = cancelUndispatchedContinuationAttempts(coordination, previousCoordination);
    if (cancellation.status !== 'ready') return { ...continued, status: 'recovery_required', ...cancellation };
    return { ...continued, coordination, cancelled_attempt_ids: cancellation.cancelled_attempt_ids };
  }

  async function recoverCoordinator({ confirmedStoppedRunId, evidenceRef } = {}) {
    if (!confirmedStoppedRunId || !evidenceRef) throw new TypeError('confirmedStoppedRunId and evidenceRef are required');
    let currentHead = head();
    if (!activeHead(currentHead) || currentHead.owner !== owner || currentHead.run_id !== confirmedStoppedRunId) {
      return { status: 'recovery_required', reason: 'coordinator_identity_mismatch' };
    }
    let proof = headProof(currentHead);
    if (!proof || proof.owner !== owner) return { status: 'recovery_required', reason: 'coordinator_proof_missing_or_invalid' };
    if (proof.process_instance_id === processInstanceId && activeInvocations.has(confirmedStoppedRunId)) {
      return { status: 'recovery_required', reason: 'coordinator_invocation_is_active' };
    }
    if (proof.process_instance_id !== processInstanceId && processAlive(proof.process_id) !== false) {
      return { status: 'recovery_required', reason: 'coordinator_process_exit_unconfirmed' };
    }
    const workerExit = workerAudit(proof);
    if (workerExit) return { status: 'recovery_required', ...workerExit };
    const stageRecovery = await recoverOccupiedStageSlot(currentHead, proof, evidenceRef);
    if (!['quiescent', 'recovered'].includes(stageRecovery.status)) return { status: 'recovery_required', ...stageRecovery };
    const deliveryRecovery = recoverUndispatchedDelivery(currentHead, proof, evidenceRef);
    if (deliveryRecovery.status === 'recovered') return { status: 'recovered', ...deliveryRecovery,
      batch_id: currentHead.delivery_batch_id, run_id: confirmedStoppedRunId };
    if (deliveryRecovery.status !== 'quiescent') return { status: 'recovery_required', ...deliveryRecovery };
    const reviewedCheckpointId = currentHead.checkpoint_id;
    currentHead = head();
    proof = currentHead && headProof(currentHead);
    const currentSlot = slot();
    if (!proof || currentHead.checkpoint_id !== reviewedCheckpointId || !activeHead(currentHead)
      || currentHead.owner !== owner || currentHead.run_id !== confirmedStoppedRunId
      || currentSlot.owner !== null || currentSlot.run_id !== null || !['idle', 'stopped'].includes(currentSlot.state)) {
      return { status: 'recovery_required', reason: 'coordinator_or_stage_state_changed_during_stage_recovery' };
    }
    const worker = unresolvedWorker(currentHead.delivery_batch_id);
    if (worker) return { status: 'recovery_required', ...worker };
    let phaseState = phaseAudit(proof, currentHead.delivery_batch_id);
    if (phaseState?.reason) return { status: 'recovery_required', ...phaseState };
    if (phaseState?.pendingStages?.length) {
      const coordination = { owner, batchId: currentHead.delivery_batch_id, runId: currentHead.run_id, batchGeneration: currentHead.generation };
      skipPendingPhases(coordination, 'confirmed_not_started_before_recovery');
      currentHead = head(); proof = headProof(currentHead); phaseState = phaseAudit(proof, currentHead.delivery_batch_id);
      if (phaseState?.reason || phaseState?.pendingStages?.length) return { status: 'recovery_required', ...(phaseState ?? {}) };
    }
    const audit = workerAudit(proof);
    if (audit) return { status: 'recovery_required', ...audit };
    const changed = store.transaction(() => {
      const live = head();
      const liveProof = live && headProof(live);
      const liveSlot = slot();
       if (!live || live.owner !== owner || live.checkpoint_id !== currentHead.checkpoint_id || !liveProof || liveProof.owner !== owner || !activeHead(live)
        || live.run_id !== currentHead.run_id || live.generation !== currentHead.generation
        || live.delivery_batch_id !== currentHead.delivery_batch_id || liveSlot.owner !== null || liveSlot.run_id !== null
        || !['idle', 'stopped'].includes(liveSlot.state) || unresolvedWorker(live.delivery_batch_id)
        || phaseAudit(liveProof, live.delivery_batch_id)?.reason || workerAudit(liveProof)) return false;
      appendHead({ owner: live.owner, batchId: live.delivery_batch_id,
        runId: live.run_id, batchGeneration: live.generation }, false, { recovery_evidence_ref: evidenceRef, invocation_state: 'returned',
        worker_refs: liveProof.worker_refs, phase_refs: liveProof.phase_refs ?? [], worker_audit_complete: true });
      return true;
    });
    if (!changed) return { status: 'recovery_required', reason: 'coordinator_state_changed_during_recovery' };
    return { status: 'recovered', batch_id: currentHead.delivery_batch_id, run_id: confirmedStoppedRunId, evidence_ref: evidenceRef };
  }

  return {
    dueStatus,
    ensureDailyBatch: options => run({ ...options, kind: 'daily_follow' }),
    run,
    requestStop,
    continueBatch,
    recoverCoordinator,
  };
}
