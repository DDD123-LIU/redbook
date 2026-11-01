import { createHash, randomUUID } from 'node:crypto';

const RULES_VERSION = 'quality-feedback-v0.2';
const HOUR = 60 * 60 * 1000;

function fail(code, detail = code) {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  const persisted = typeof value === 'string' ? value : JSON.parse(JSON.stringify(value));
  return createHash('sha256').update(typeof persisted === 'string' ? persisted : canonical(persisted)).digest('hex');
}

function instant(value, name) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('quality_invalid_time', `${name} must include a timezone`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('quality_invalid_time', `${name} is invalid`);
  return new Date(milliseconds).toISOString();
}

function validateStore(store, owner) {
  if (!store?.db || typeof store.transaction !== 'function' || typeof owner !== 'string' || !owner) {
    fail('quality_dependencies_incomplete');
  }
}

function checkpointStage(owner, suffix) {
  return `quality:${owner}:${suffix}`;
}

function insertLedger(store, owner, stage, payload, at, generation = 0) {
  const payloadHash = digest(payload);
  store.db.prepare(`INSERT INTO checkpoint(
    checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,input_hash,output_hash,committed_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    digest(`${owner}\0${stage}`), owner, randomUUID(), generation, stage,
    JSON.stringify([{ payload, hash: payloadHash }]), payloadHash, payloadHash, at,
  );
}

function readLedger(row, owner = row?.owner, stage = row?.stage) {
  if (!row) return null;
  if (row.owner !== owner || row.stage !== stage || row.checkpoint_id !== digest(`${owner}\0${stage}`)) {
    fail('quality_checkpoint_corrupt');
  }
  try {
    const refs = JSON.parse(row.succeeded_refs_json);
    if (!Array.isArray(refs) || refs.length !== 1 || !refs[0]?.payload) fail('quality_checkpoint_corrupt');
    const payloadHash = digest(refs[0].payload);
    if (refs[0].hash !== payloadHash || row.input_hash !== payloadHash || row.output_hash !== payloadHash) {
      fail('quality_checkpoint_corrupt');
    }
    return refs[0].payload;
  } catch (error) {
    if (error.code === 'quality_checkpoint_corrupt') throw error;
    fail('quality_checkpoint_corrupt');
  }
}

function rowsWithPrefix(store, owner, prefix) {
  return store.db.prepare(`SELECT * FROM checkpoint WHERE owner=? AND substr(stage,1,?)=? ORDER BY generation,rowid`)
    .all(owner, prefix.length, prefix);
}

function rulesFromRow(row) {
  let value;
  try { value = JSON.parse(row.rule_diff_json ?? '{}'); } catch { fail('quality_strategy_corrupt'); }
  return value?.quality_schema === 'quality-strategy-v1' ? value.rules : value?.rules ?? value;
}

function strategyRow(store, version) {
  return store.db.prepare('SELECT * FROM strategy_version WHERE strategy_version=?').get(version);
}

function bootstrapStrategy(store, owner, at) {
  const rows = store.db.prepare(`SELECT * FROM strategy_version
    WHERE state='active' AND effective_at<=? ORDER BY effective_at DESC,created_at DESC`).all(at);
  if (!rows.length) fail('quality_strategy_unconfigured');
  const newestTime = rows[0].effective_at;
  const tied = rows.filter(row => row.effective_at === newestTime);
  if (tied.length !== 1) fail('quality_strategy_ambiguous');
  const row = tied[0];
  const rules = rulesFromRow(row);
  return {
    strategy_version: row.strategy_version,
    parent_version: row.parent_version ?? null,
    preference_version: row.preference_version ?? null,
    rules,
    rules_hash: digest(rules),
    effective_at: row.effective_at,
    ledger_ref: null,
  };
}

function strategyEvents(store, owner) {
  const prefix = checkpointStage(owner, 'strategy:event:');
  return rowsWithPrefix(store, owner, prefix).map(row => ({ row, payload: readLedger(row, owner, row.stage) }));
}

function incidentEvents(store, owner, canonicalRoot) {
  const prefix = checkpointStage(owner, `incident:${canonicalRoot}:`);
  const events = rowsWithPrefix(store, owner, prefix).map(row => ({ row, payload: readLedger(row, owner, row.stage) }))
    .sort((left, right) => left.payload.sequence - right.payload.sequence);
  let parentHash = null;
  for (let index = 0; index < events.length; index++) {
    const { row, payload } = events[index];
    if (payload.sequence !== index + 1 || payload.owner !== owner || payload.canonical_root !== canonicalRoot
      || payload.parent_hash !== parentHash || row.stage !== checkpointStage(owner, `incident:${canonicalRoot}:${index + 1}`)
      || row.generation !== index + 1) fail('quality_incident_chain_corrupt');
    if (payload.report_revision_id) {
      const source = store.db.prepare(`SELECT rr.snapshot_json,rr.sample_id,s.category FROM report_revision rr
        JOIN sample s USING(sample_id) WHERE rr.report_revision_id=?`).get(payload.report_revision_id);
      const declaration = source && loadSample(store, owner, source.sample_id).declaration;
      const snapshot = source && JSON.parse(source.snapshot_json);
      if (!source || source.category !== payload.category || declaration?.owner !== owner
        || snapshot.snapshot_hash !== payload.source_snapshot_hash || snapshot.view !== 'cutoff') {
        fail('quality_incident_source_report_corrupt');
      }
      verifyReportChain(store, source.sample_id);
    }
    parentHash = row.output_hash;
    if (payload.recovery_outcome_checkpoint_id) {
      const outcome = store.db.prepare('SELECT * FROM checkpoint WHERE checkpoint_id=?').get(payload.recovery_outcome_checkpoint_id);
      if (!outcome || outcome.output_hash !== payload.recovery_outcome_payload_hash) fail('quality_incident_outcome_reference_corrupt');
      const outcomePayload = readLedger(outcome, owner, outcome.stage);
      const source = store.db.prepare('SELECT snapshot_json FROM report_revision WHERE report_revision_id=?')
        .get(outcomePayload.source_report_revision_id);
      if (!source || JSON.parse(source.snapshot_json).snapshot_hash !== outcomePayload.source_snapshot_hash) {
        fail('quality_incident_outcome_source_corrupt');
      }
    }
  }
  return events;
}

function appendIncidentEvent(store, owner, canonicalRoot, payload, at) {
  const history = incidentEvents(store, owner, canonicalRoot);
  const sequence = history.length + 1;
  const event = { ...payload, owner, canonical_root: canonicalRoot, sequence,
    parent_hash: history.at(-1)?.row.output_hash ?? null };
  insertLedger(store, owner, checkpointStage(owner, `incident:${canonicalRoot}:${sequence}`), event, at, sequence);
  const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?')
    .get(owner, checkpointStage(owner, `incident:${canonicalRoot}:${sequence}`));
  return { row, payload: event };
}

function categoryEvents(store, owner, category) {
  const prefix = checkpointStage(owner, `incident-category:${category}:`);
  const events = rowsWithPrefix(store, owner, prefix).map(row => ({ row, payload: readLedger(row, owner, row.stage) }))
    .sort((left, right) => left.payload.sequence - right.payload.sequence);
  let parentHash = null;
  for (let index = 0; index < events.length; index++) {
    const { row, payload } = events[index];
    if (payload.sequence !== index + 1 || payload.owner !== owner || payload.category !== category
      || payload.parent_hash !== parentHash
      || row.stage !== checkpointStage(owner, `incident-category:${category}:${index + 1}`)
      || row.generation !== index + 1) fail('quality_incident_category_chain_corrupt');
    const incidentHistory = incidentEvents(store, owner, payload.canonical_root);
    const incidentHead = incidentHistory.find(event => event.row.checkpoint_id === payload.incident_head_checkpoint_id);
    if (!incidentHead || incidentHead.row.output_hash !== payload.incident_head_payload_hash) {
      fail('quality_incident_category_head_mismatch');
    }
    parentHash = row.output_hash;
  }
  return events;
}

function appendCategoryEvent(store, owner, category, payload, at) {
  const history = categoryEvents(store, owner, category);
  const sequence = history.length + 1;
  const incidentHead = incidentEvents(store, owner, payload.canonical_root).at(-1);
  if (!incidentHead) fail('quality_incident_head_missing');
  const event = { ...payload, owner, category, sequence,
    incident_head_checkpoint_id: incidentHead.row.checkpoint_id,
    incident_head_payload_hash: incidentHead.row.output_hash,
    parent_hash: history.at(-1)?.row.output_hash ?? null };
  insertLedger(store, owner, checkpointStage(owner, `incident-category:${category}:${sequence}`), event, at, sequence);
  const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?')
    .get(owner, checkpointStage(owner, `incident-category:${category}:${sequence}`));
  return { row, payload: event };
}

export function readCurrentStrategy(store, owner, at = new Date().toISOString()) {
  validateStore(store, owner);
  const asOf = instant(at, 'at');
  const events = strategyEvents(store, owner);
  if (!events.length) return bootstrapStrategy(store, owner, asOf);
  events.sort((a, b) => a.payload.sequence - b.payload.sequence);
  const bootstrapVersion = events[0]?.payload.bootstrap_strategy_version;
  const bootstrap = strategyRow(store, bootstrapVersion);
  if (!bootstrap || bootstrap.parent_version || events[0].payload.parent_version !== bootstrapVersion) {
    fail('quality_strategy_bootstrap_mismatch');
  }
  let parent = bootstrapVersion;
  let parentHash = null;
  const seen = new Set();
  for (let index = 0; index < events.length; index++) {
    const { row, payload } = events[index];
    if (payload.owner !== owner || payload.sequence !== index + 1 || seen.has(payload.sequence)
      || row.stage !== checkpointStage(owner, `strategy:event:${payload.sequence}`)) fail('quality_strategy_ledger_corrupt');
    if (payload.parent_hash !== parentHash || row.generation !== payload.sequence) fail('quality_strategy_parent_hash_mismatch');
    if (payload.parent_version !== parent) fail('quality_strategy_parent_mismatch');
    const strategy = strategyRow(store, payload.strategy_version);
    if (!strategy || strategy.parent_version !== payload.parent_version
      || strategy.preference_version !== payload.preference_version
      || strategy.effective_at !== payload.effective_at) fail('quality_strategy_row_mismatch');
    const rules = rulesFromRow(strategy);
    if (digest(rules) !== payload.rules_hash || digest(rules) !== digest(payload.rules)) fail('quality_strategy_hash_mismatch');
    if (Date.parse(payload.effective_at) > Date.parse(asOf)) fail('quality_strategy_future_effective');
    parent = payload.strategy_version;
    parentHash = row.output_hash;
    seen.add(payload.sequence);
  }
  const current = events.at(-1).payload;
  const row = strategyRow(store, current.strategy_version);
  return {
    strategy_version: row.strategy_version,
    parent_version: row.parent_version ?? null,
    preference_version: row.preference_version ?? null,
    rules: rulesFromRow(row),
    rules_hash: current.rules_hash,
    effective_at: row.effective_at,
    ledger_ref: events.at(-1).row.checkpoint_id,
  };
}

function shanghaiDayParts(value) {
  const date = new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}` };
}

function latestRevision(store, sampleId) {
  return store.db.prepare('SELECT * FROM report_revision WHERE sample_id=? ORDER BY rowid DESC LIMIT 1').get(sampleId) ?? null;
}

function verifyReportChain(store, sampleId) {
  const rows = store.db.prepare('SELECT * FROM report_revision WHERE sample_id=? ORDER BY rowid').all(sampleId);
  let parent = null;
  for (const row of rows) {
    let snapshot;
    try { snapshot = JSON.parse(row.snapshot_json); } catch { fail('quality_report_corrupt'); }
    const { snapshot_hash: snapshotHash, ...body } = snapshot;
    if (row.parent_report_revision_id !== parent || snapshot.parent_report_revision_id !== parent
      || snapshotHash !== digest(body)) fail('quality_report_chain_corrupt');
    parent = row.report_revision_id;
  }
  return rows;
}

function reportContentHash(snapshot) {
  const { as_of, observation_at, ...content } = snapshot;
  return digest(content);
}

function loadSample(store, owner, sampleId) {
  const declaredRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?')
    .get(owner, checkpointStage(owner, `sample:${sampleId}:declared`));
  const declaration = readLedger(declaredRow, owner, checkpointStage(owner, `sample:${sampleId}:declared`));
  if (!declaration || declaration.sample_id !== sampleId || declaration.owner !== owner) fail('quality_sample_not_found');
  const sample = store.db.prepare('SELECT * FROM sample WHERE sample_id=?').get(sampleId);
  if (!sample || sample.purpose !== declaration.purpose || sample.category !== declaration.category) fail('quality_sample_corrupt');
  return { sample, declaration, declarationHash: digest(declaration) };
}

function reportStatus(declaration, metrics, closed, cutoffReached) {
  const blockers = [];
  if (declaration.target_total == null) blockers.push('target_total_unset');
  if (!declaration.included_from || !declaration.included_until) blockers.push('inclusion_period_unset');
  if (!closed) blockers.push('sample_period_open');
  if (!cutoffReached) blockers.push('observation_window_open');
  if (metrics.N === 0) blockers.push('no_successful_recommendations');
  if (metrics.L + metrics.D === 0) blockers.push('no_valid_like_or_dislike');
  if (metrics.U > 0) blockers.push('delivery_unknown');
  if (metrics.boundary_unknowns > 0) blockers.push('boundary_unknown');
  if (declaration.target_total != null && metrics.N < declaration.target_total) blockers.push('target_not_met');
  if (metrics.N === 0 || metrics.L + metrics.D === 0) return { qualification: 'undetermined', blockers };
  if (blockers.length) return { qualification: 'pending', blockers };
  const missPass = 20n * BigInt(metrics.E) < BigInt(metrics.N);
  const likePass = 20n * BigInt(metrics.L) >= 19n * BigInt(metrics.L + metrics.D);
  return { qualification: missPass && likePass ? 'passed' : 'failed', blockers: [], thresholds: { missPass, likePass } };
}

function stateAt(histories, fallback, at) {
  const changes = histories.filter(row => row.changed_at <= at);
  return changes.length ? changes.at(-1).new_status ?? changes.at(-1).new_state : fallback;
}

function collectFacts(store, declaration, at, eventRevision, feedbackAsOf = at) {
  const { owner, category } = declaration;
  const candidates = store.db.prepare(
    'SELECT r.*,b.owner,co.platform,co.source_content_id,d.decision_id AS linked_decision_id,' +
    'd.created_at AS decision_created_at,d.result AS decision_result,c.source_evidence_ref,' +
    'c.eligibility_state,a.status AS analysis_status FROM recommendation r ' +
    'JOIN batch b USING(delivery_batch_id) JOIN content co USING(content_id) ' +
    'JOIN decision d USING(decision_id) JOIN candidate c USING(candidate_id) JOIN analysis a USING(analysis_id) ' +
    'WHERE b.owner=? AND r.category=? AND r.created_at<=?'
  ).all(owner, category, at);
  const attemptsByRecommendation = new Map();
  const recommendationHistory = new Map();
  const boundaryUnknowns = [];
  const failures = [];
  const unknowns = [];
  const withinSampleRange = dispatchedAt => Boolean(dispatchedAt
    && (!declaration.included_from || dispatchedAt >= declaration.included_from)
    && (!declaration.included_until || dispatchedAt <= declaration.included_until));
  const inRange = dispatchedAt => Boolean(dispatchedAt && dispatchedAt <= at
    && withinSampleRange(dispatchedAt));

  for (const rec of candidates) {
    const stateHistory = store.db.prepare(
      "SELECT * FROM entity_state_history WHERE entity_type='recommendation' AND entity_id=? ORDER BY history_id"
    ).all(rec.recommendation_id);
    recommendationHistory.set(rec.recommendation_id, stateHistory);
    const attempts = store.db.prepare('SELECT * FROM delivery_attempt WHERE recommendation_id=? ORDER BY intent_at,delivery_attempt_id')
      .all(rec.recommendation_id).map(attempt => {
        const history = store.db.prepare('SELECT * FROM delivery_attempt_history WHERE delivery_attempt_id=? ORDER BY history_id')
          .all(attempt.delivery_attempt_id);
        return { attempt, history, state: stateAt(history, null, at), inRange: inRange(attempt.dispatched_at) };
      });
    attemptsByRecommendation.set(rec.recommendation_id, attempts);
  }

  const delivered = store.db.prepare(
    'SELECT dc.*,r.category,r.actual_preference_version,r.actual_strategy_version,r.first_success_at AS recommendation_first_success_at,' +
    'r.delivery_batch_id,r.recommendation_id,r.content_id,r.decision_id,r.state AS recommendation_state,' +
    'co.platform AS rec_platform,co.source_content_id AS rec_source_content_id,' +
    'd.created_at AS decision_created_at,d.result AS decision_result,c.source_evidence_ref,a.status AS analysis_status ' +
    'FROM delivered_content dc JOIN recommendation r USING(recommendation_id) ' +
    'JOIN content co ON co.content_id=r.content_id JOIN decision d USING(decision_id) ' +
    'JOIN candidate c USING(candidate_id) JOIN analysis a USING(analysis_id) ' +
    'WHERE dc.owner=? AND r.category=? ' +
    'AND dc.platform=co.platform AND dc.source_content_id=co.source_content_id'
  ).all(owner, category);
  const members = [];
  const successByRecommendation = new Set();
  const excludedRecoveryRecommendations = new Set();
  const seenContent = new Set();

  for (const success of delivered) {
    if (declaration.purpose === 'recovery' && success.actual_strategy_version !== declaration.strategy_version) {
      excludedRecoveryRecommendations.add(success.recommendation_id);
      continue;
    }
    const attempts = attemptsByRecommendation.get(success.recommendation_id) ?? [];
    const recHistory = recommendationHistory.get(success.recommendation_id) ?? [];
    const recSuccess = recHistory.find(row => row.new_state === 'succeeded' && row.changed_at <= at);
    const attemptSuccess = attempts.map(entry => ({
      ...entry,
      successHistory: entry.history.find(row => row.new_status === 'succeeded' && row.changed_at <= at),
    })).find(entry => entry.successHistory);
    const attempt = attemptSuccess?.attempt;
    if (!success.first_success_at || success.first_success_at > at) continue;
    const dispatchAt = attempt?.dispatched_at ?? null;
    if (dispatchAt && (dispatchAt > at || !withinSampleRange(dispatchAt))) continue;
    const successTimes = [
      success.first_success_at,
      success.recommendation_first_success_at,
      attempt?.returned_at,
      recSuccess?.changed_at,
      attemptSuccess?.successHistory?.changed_at,
    ].filter(Boolean);
    const milliseconds = successTimes.map(value => Date.parse(value));
    const ordered = milliseconds.length === 5
      && milliseconds.every(Number.isFinite)
      && milliseconds.every(value => value <= Date.parse(at))
      && Boolean(dispatchAt)
      && Date.parse(dispatchAt) <= Date.parse(successTimes[2])
      && Date.parse(successTimes[2]) <= Date.parse(successTimes[4])
      && Date.parse(dispatchAt) <= Date.parse(successTimes[3])
      && Date.parse(successTimes[2]) <= Date.parse(successTimes[0])
      && Date.parse(successTimes[2]) <= Date.parse(successTimes[1]);

    let dispatchProof = null;
    if (attempt && dispatchAt && dispatchAt <= at) {
      const checkpointRows = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid')
        .all(owner, 'delivery-attempt:' + attempt.delivery_attempt_id);
      for (const row of checkpointRows) {
        try {
          const ref = JSON.parse(row.succeeded_refs_json)[0];
          if (row.committed_at >= dispatchAt && row.committed_at <= at && ref?.ref && ref?.hash
            && row.output_hash === ref.hash) {
            dispatchProof = { checkpoint_id: row.checkpoint_id, hash: ref.hash, committed_at: row.committed_at };
          }
        } catch { /* 无法解析的checkpoint不作为派发证明。 */ }
      }
    }

    const strategy = strategyRow(store, success.actual_strategy_version);
    const recoveryEvidenceValid = declaration.purpose !== 'recovery'
      || (success.actual_strategy_version === declaration.strategy_version
        && strategy && success.decision_created_at >= strategy.effective_at
        && success.decision_result === 'eligible'
        && success.analysis_status === 'complete'
        && Boolean(success.source_evidence_ref));
    if (!inRange(dispatchAt) || !dispatchProof || !recSuccess || !attemptSuccess || !ordered || !recoveryEvidenceValid) {
      boundaryUnknowns.push({
        recommendation_id: success.recommendation_id,
        delivery_attempt_id: attempt?.delivery_attempt_id ?? null,
        reason: !inRange(dispatchAt) ? 'dispatch_time_unverifiable_or_out_of_range'
          : !dispatchProof ? 'worker_checkpoint_missing'
            : !ordered ? 'clock_boundary_unknown'
              : !recoveryEvidenceValid ? 'recovery_screening_evidence_missing' : 'success_history_missing',
        evidence_refs: dispatchProof ? ['checkpoint:' + dispatchProof.checkpoint_id + ':' + dispatchProof.hash] : [],
      });
      continue;
    }
    const identity = success.rec_platform + '\0' + success.rec_source_content_id;
    if (seenContent.has(identity)) continue;
    seenContent.add(identity);
    successByRecommendation.add(success.recommendation_id);
    const confirmedAt = new Date(Math.max(...milliseconds)).toISOString();
    members.push({
      recommendation_id: success.recommendation_id,
      content_id: success.content_id,
      platform: success.rec_platform,
      source_content_id: success.rec_source_content_id,
      category: success.category,
      preference_version: success.actual_preference_version,
      strategy_version: success.actual_strategy_version,
      delivery_batch_id: success.delivery_batch_id,
      decision_id: success.decision_id,
      dispatched_at: dispatchAt,
      first_success_at: success.first_success_at,
      confirmed_at: confirmedAt,
      delivery_attempt_id: attempt.delivery_attempt_id,
      evidence_refs: [...JSON.parse(attempt.verification_evidence_refs_json || '[]'),
        'checkpoint:' + dispatchProof.checkpoint_id + ':' + dispatchProof.hash],
    });
  }

  for (const rec of candidates) {
    if (successByRecommendation.has(rec.recommendation_id) || excludedRecoveryRecommendations.has(rec.recommendation_id)) continue;
    if (declaration.purpose === 'recovery' && rec.actual_strategy_version !== declaration.strategy_version) continue;
    for (const { attempt, state, inRange: attemptInRange } of attemptsByRecommendation.get(rec.recommendation_id) ?? []) {
      if (state === 'succeeded') {
        if (attempt.dispatched_at && (attempt.dispatched_at > at || !withinSampleRange(attempt.dispatched_at))) continue;
        if (!attempt.dispatched_at && state === 'intent') continue;
        boundaryUnknowns.push({ recommendation_id: rec.recommendation_id, delivery_attempt_id: attempt.delivery_attempt_id,
          reason: attempt.dispatched_at ? 'success_index_or_history_missing' : 'success_without_dispatch_time', evidence_refs: [] });
      } else if (['failed', 'unknown', 'intent'].includes(state)) {
        if (!attempt.dispatched_at) {
          if (state === 'intent') continue;
          boundaryUnknowns.push({ recommendation_id: rec.recommendation_id, delivery_attempt_id: attempt.delivery_attempt_id,
            reason: 'delivery_result_without_dispatch_time', evidence_refs: [] });
        } else if (attempt.dispatched_at > at || !withinSampleRange(attempt.dispatched_at)) {
          continue;
        } else if (attemptInRange) {
          const proofRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? AND committed_at<=? ORDER BY rowid DESC LIMIT 1')
            .get(owner, 'delivery-attempt:' + attempt.delivery_attempt_id, at);
          let proofRef = null;
          try {
            const ref = JSON.parse(proofRow?.succeeded_refs_json ?? '[]')[0];
            if (ref?.ref && ref?.hash && ref.hash === proofRow.output_hash && proofRow.committed_at >= attempt.dispatched_at) {
              proofRef = 'checkpoint:' + proofRow.checkpoint_id + ':' + ref.hash;
            }
          } catch { /* 没有可核对的checkpoint引用。 */ }
          if (!proofRef) {
            boundaryUnknowns.push({ recommendation_id: rec.recommendation_id, delivery_attempt_id: attempt.delivery_attempt_id,
              reason: 'worker_checkpoint_missing', evidence_refs: [] });
          } else if (state === 'failed') {
            failures.push({ recommendation_id: rec.recommendation_id, delivery_attempt_id: attempt.delivery_attempt_id,
              dispatched_at: attempt.dispatched_at, evidence_refs: [proofRef, ...JSON.parse(attempt.verification_evidence_refs_json || '[]')] });
          } else {
            unknowns.push({ recommendation_id: rec.recommendation_id, delivery_attempt_id: attempt.delivery_attempt_id,
              dispatched_at: attempt.dispatched_at, evidence_refs: [proofRef, ...JSON.parse(attempt.query_evidence_refs_json || '[]')] });
          }
        }
      }
    }
  }

  const feedback = store.db.prepare(
    'SELECT feedback_history_id,recommendation_id,value,revision,event_id,saved_at,correction_of_event_id ' +
    'FROM feedback_history WHERE owner=? AND feedback_history_id<=? AND saved_at<=? ' +
    'ORDER BY recommendation_id,revision,feedback_history_id'
  ).all(owner, eventRevision, feedbackAsOf);
  const latestFeedback = new Map();
  for (const row of feedback) latestFeedback.set(row.recommendation_id, row);
  const byValue = { like: 0, dislike: 0, seen: 0 };
  const feedbackRows = [];
  for (const member of members) {
    const row = latestFeedback.get(member.recommendation_id);
    if (row) {
      byValue[row.value] += 1;
      feedbackRows.push({ ...row });
    }
  }
  const N = members.length;
  const L = byValue.like;
  const D = byValue.dislike;
  const E = N - L - D;
  const S = byValue.seen;
  const maxFeedbackWatermark = store.db.prepare(
    'SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history WHERE owner=? AND feedback_history_id<=? AND saved_at<=?'
  ).get(owner, eventRevision, feedbackAsOf).id;
  const availableFeedbackWatermark = store.db.prepare(
    'SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history WHERE owner=? AND saved_at<=?'
  ).get(owner, feedbackAsOf).id;
  const deliveryWatermark = store.db.prepare('SELECT coalesce(max(history_id),0) AS id FROM delivery_attempt_history WHERE changed_at<=?').get(at).id;
  const stateWatermark = store.db.prepare('SELECT coalesce(max(history_id),0) AS id FROM entity_state_history WHERE changed_at<=?').get(at).id;
  const lastSuccess = members.map(member => member.confirmed_at).sort().at(-1) ?? null;
  return {
    members, metrics: { N, L, D, E, S, U: new Set(unknowns.map(row => row.recommendation_id)).size,
      F: new Set(failures.map(row => row.recommendation_id)).size },
    feedbackRows, failures, unknowns, boundaryUnknowns, last_success_at: lastSuccess,
    watermarks: { requested_feedback_history_id: eventRevision, observed_feedback_history_id: maxFeedbackWatermark,
      available_feedback_history_id: availableFeedbackWatermark,
      feedback_history_complete: eventRevision >= availableFeedbackWatermark,
      delivery_attempt_history_id: deliveryWatermark, entity_state_history_id: stateWatermark },
    latestFeedback,
  };
}

function snapshotFor(declaration, declarationHash, facts, { view, asOf, observationAt, factsAsOf = observationAt,
  cutoffAt, closed, cutoffReached }) {
  const feedbackTime = observationAt;
  const feedbackRows = facts.feedbackRows.filter(row => row.saved_at <= feedbackTime);
  const latestByRecommendation = new Map();
  for (const row of feedbackRows) latestByRecommendation.set(row.recommendation_id, row);
  let L = 0, D = 0, S = 0;
  for (const row of latestByRecommendation.values()) {
    if (row.value === 'like') L++;
    else if (row.value === 'dislike') D++;
    else if (row.value === 'seen') S++;
  }
  const N = facts.members.filter(member => member.first_success_at <= factsAsOf).length;
  const E = N - L - D;
  const metrics = { N, L, D, E, S, U: facts.metrics.U, F: facts.metrics.F,
    boundary_unknowns: facts.boundaryUnknowns.length };
  const status = reportStatus(declaration, metrics, closed, cutoffReached);
  const indicators = {
    missing_rate: { numerator: E, denominator: N, value: N ? E / N : null,
      display: N ? E / N : '暂无数据', passes: N ? 20 * E < N : null },
    agreement: { numerator: L, denominator: L + D, value: L + D ? L / (L + D) : null,
      display: L + D ? L / (L + D) : '暂无数据', passes: L + D ? 20 * L >= 19 * (L + D) : null },
    valid_feedback_coverage: { numerator: L + D, denominator: N, value: N ? (L + D) / N : null,
      display: N ? (L + D) / N : '暂无数据' },
    any_feedback_coverage: { numerator: L + D + S, denominator: N, value: N ? (L + D + S) / N : null,
      display: N ? (L + D + S) / N : '暂无数据' },
  };
  const snapshot = {
    schema_version: 1,
    rules_version: RULES_VERSION,
    owner: declaration.owner,
    sample_id: declaration.sample_id,
    purpose: declaration.purpose,
    category: declaration.category,
    view,
    declaration,
    declaration_hash: declarationHash,
    event_revision: declaration.requested_event_revision,
    as_of: asOf,
    observation_at: observationAt,
    facts_as_of: factsAsOf,
    cutoff_at: cutoffAt,
    inclusion_closed: closed,
    today_in_progress: declaration.purpose === 'monitor' && shanghaiDayParts(asOf).date === shanghaiDayParts(observationAt).date,
    observing_recommendation_ids: facts.members.filter(member => Date.parse(member.first_success_at) + 48 * HOUR > Date.parse(factsAsOf))
      .map(member => member.recommendation_id),
    watermarks: facts.watermarks,
    feedback_history_complete: facts.watermarks.feedback_history_complete,
    members: facts.members.filter(member => member.first_success_at <= factsAsOf),
    adopted_feedback: [...latestByRecommendation.values()],
    failures: facts.failures,
    unknowns: facts.unknowns,
    boundary_unknowns: facts.boundaryUnknowns,
    missing_reasons: E ? [{ reason: 'unknown', count: E, evidence_refs: [] }] : [],
    metrics,
    indicators,
    qualification: status.qualification,
    blockers: status.blockers,
    thresholds: status.thresholds ?? null,
  };
  return snapshot;
}

function saveReport(store, declaration, snapshot, reason) {
  const chain = verifyReportChain(store, declaration.sample_id);
  const contentHash = reportContentHash(snapshot);
  const existing = chain.find(row => JSON.parse(row.snapshot_json).content_hash === contentHash);
  if (existing) return { status: 'duplicate', report_revision_id: existing.report_revision_id, snapshot_hash: JSON.parse(existing.snapshot_json).snapshot_hash };
  const parent = chain.at(-1)?.report_revision_id ?? null;
  const body = { ...snapshot, content_hash: contentHash, parent_report_revision_id: parent };
  const snapshotHash = digest(body);
  const reportId = randomUUID();
  const savedSnapshot = { ...body, snapshot_hash: snapshotHash };
  store.db.prepare(`INSERT INTO report_revision(report_revision_id,sample_id,parent_report_revision_id,event_revision,snapshot_json,reason,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(reportId, declaration.sample_id, parent,
    snapshot.event_revision, JSON.stringify(savedSnapshot), reason, snapshot.as_of);
  return { status: 'succeeded', report_revision_id: reportId, snapshot_hash: snapshotHash };
}

function insertMembers(store, sampleId, members) {
  const insert = store.db.prepare('INSERT OR IGNORE INTO sample_member(sample_id,recommendation_id) VALUES(?,?)');
  for (const member of members) insert.run(sampleId, member.recommendation_id);
}

function currentReportReason(store, sampleId, snapshot) {
  const previousRow = store.db.prepare(`SELECT snapshot_json FROM report_revision
    WHERE sample_id=? ORDER BY rowid DESC`).all(sampleId)
    .map(row => JSON.parse(row.snapshot_json)).find(value => value.view === 'current');
  if (!previousRow) return 'initial_calculation';
  const previousFeedback = new Map((previousRow.adopted_feedback ?? []).map(row => [row.recommendation_id, row]));
  const feedback = snapshot.adopted_feedback ?? [];
  if (feedback.some(row => previousFeedback.get(row.recommendation_id)?.revision !== row.revision)) {
    return feedback.some(row => previousFeedback.has(row.recommendation_id)) ? 'feedback_correction' : 'late_feedback';
  }
  if ((snapshot.watermarks?.delivery_attempt_history_id ?? 0) > (previousRow.watermarks?.delivery_attempt_history_id ?? 0)
    || (snapshot.watermarks?.entity_state_history_id ?? 0) > (previousRow.watermarks?.entity_state_history_id ?? 0)
    || (snapshot.members?.length ?? 0) > (previousRow.members?.length ?? 0)
    || (snapshot.boundary_unknowns?.length ?? 0) < (previousRow.boundary_unknowns?.length ?? 0)) return 'delivery_verification';
  return 'current_calculation';
}

function recordRecoveryOutcome(store, owner, declaration, snapshot, reportRevisionId, cutoffEventRef, at) {
  if (snapshot.view !== 'cutoff' || !snapshot.feedback_history_complete) fail('quality_recovery_cutoff_incomplete');
  const categoryHistory = categoryEvents(store, owner, declaration.category);
  const matchingRoot = [...categoryHistory].reverse().find(event => event.payload.incident_id === declaration.incident_id);
  if (!matchingRoot) fail('quality_incident_not_current');
  const canonicalRoot = matchingRoot.payload.canonical_root;
  const history = incidentEvents(store, owner, canonicalRoot);
  const priorEntry = [...history].reverse().find(event => event.payload.sample_id === declaration.sample_id
    && event.payload.adjustment_strategy_version === declaration.strategy_version);
  const prior = priorEntry?.payload;
  if (!prior || prior.adjustment_index < 1 || prior.adjustment_index > 2) fail('quality_recovery_binding_mismatch');
  const outcomeStage = checkpointStage(owner,
    `recovery-outcome:${canonicalRoot}:${prior.adjustment_index}:${declaration.sample_id}:${digest(cutoffEventRef)}`);
  const report = store.db.prepare('SELECT snapshot_json FROM report_revision WHERE report_revision_id=?').get(reportRevisionId);
  const sourceSnapshot = JSON.parse(report?.snapshot_json ?? '{}');
  const qualification = snapshot.qualification;
  const fixedPayload = { owner, canonical_root: canonicalRoot, category: declaration.category,
    incident_id: declaration.incident_id, adjustment_index: prior.adjustment_index,
    strategy_version: declaration.strategy_version, sample_id: declaration.sample_id,
    cutoff_event_ref: cutoffEventRef, source_report_revision_id: reportRevisionId,
    source_snapshot_hash: sourceSnapshot.snapshot_hash, qualification,
    evidence_refs: snapshot.members.flatMap(member => member.evidence_refs ?? []),
  };
  const existingOutcome = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, outcomeStage);
  if (existingOutcome) {
    if (digest(readLedger(existingOutcome, owner, outcomeStage)) !== digest(fixedPayload)) fail('quality_recovery_outcome_conflict');
    return { status: 'duplicate', checkpoint_id: existingOutcome.checkpoint_id };
  }
  if (history.some(event => event.payload.adjustment_index === prior.adjustment_index
    && event.payload.recovery_qualification === 'failed')) return { status: 'already_failed' };

  const latestCategory = categoryHistory.at(-1)?.payload;
  if (latestCategory?.incident_id !== declaration.incident_id || latestCategory.status === 'resolved') {
    fail('quality_incident_not_current');
  }
  const active = store.db.prepare('SELECT * FROM incident WHERE incident_id=?').get(declaration.incident_id);
  if (!active) fail('quality_incident_not_found');
  let status = 'adjusted';
  if (qualification === 'passed') status = 'resolved';
  else if (qualification === 'failed' && prior.adjustment_index === 2) status = 'exhausted';
  else if (qualification === 'failed') status = 'open';
  const outcome = { ...fixedPayload, parent_incident_event_id: priorEntry.row.checkpoint_id,
    parent_incident_payload_hash: priorEntry.row.output_hash, evaluated_at: at, status };
  insertLedger(store, owner, outcomeStage, outcome, at, prior.adjustment_index);
  const outcomeRow = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, outcomeStage);
  appendIncidentEvent(store, owner, canonicalRoot, { ...prior,
    recovery_outcome_checkpoint_id: outcomeRow.checkpoint_id,
    recovery_outcome_payload_hash: outcomeRow.output_hash,
    recovery_qualification: qualification, recovery_report_revision_id: reportRevisionId,
    recovery_cutoff_at: snapshot.cutoff_at, resolved_at: status === 'resolved' ? at : null,
    evaluated_at: at, status }, at);
  store.db.prepare('UPDATE incident SET adjustment_index=?,status=?,updated_at=? WHERE incident_id=?')
    .run(prior.adjustment_index, status, at, declaration.incident_id);
  if (status === 'resolved' || status === 'exhausted' || status === 'open') {
    appendCategoryEvent(store, owner, declaration.category,
      { canonical_root: canonicalRoot, incident_id: declaration.incident_id, status }, at);
  }
  return { status: 'succeeded', checkpoint_id: store.db.prepare('SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage=?')
    .get(owner, outcomeStage).checkpoint_id };
}

export function createQuality({ store, owner, now = () => new Date().toISOString() }) {
  validateStore(store, owner);

  function registerSample(input) {
    const at = instant(now(), 'now');
    if (!input || typeof input.sample_id !== 'string' || !input.sample_id.trim()) fail('quality_sample_id_required');
    if (!['initial', 'monitor', 'recovery'].includes(input.purpose)) fail('quality_sample_purpose_invalid');
    if (!['follow', 'explore'].includes(input.category)) fail('quality_sample_category_invalid');
    if (input.target_total != null && (!Number.isSafeInteger(input.target_total) || input.target_total < 0)) fail('quality_target_total_invalid');
    const includedFrom = input.included_from == null ? null : instant(input.included_from, 'included_from');
    const includedUntil = input.included_until == null ? null : instant(input.included_until, 'included_until');
    if (includedFrom && includedUntil && includedUntil < includedFrom) fail('quality_sample_period_invalid');
    if (input.purpose === 'recovery' && !input.incident_id) fail('quality_incident_required');
    if (input.strategy_version && !strategyRow(store, input.strategy_version)) fail('quality_strategy_not_found');
    const declaration = {
      owner,
      sample_id: input.sample_id,
      purpose: input.purpose,
      category: input.category,
      included_from: includedFrom,
      included_until: includedUntil,
      target_total: input.target_total ?? null,
      strategy_version: input.strategy_version ?? null,
      incident_id: input.incident_id ?? null,
      preference_version: input.preference_version ?? null,
      declared_at: at,
      rules_version: RULES_VERSION,
      unknown_parameters: [
        ...(input.target_total == null ? ['target_total'] : []),
        ...(!includedFrom || !includedUntil ? ['inclusion_period'] : []),
      ],
    };
    const declaredStage = checkpointStage(owner, `sample:${input.sample_id}:declared`);
    const initialStage = checkpointStage(owner, `initial:${owner}:${input.category}`);
    const outcome = store.transaction(() => {
      const existing = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, declaredStage);
      if (existing) {
        const prior = readLedger(existing, owner, declaredStage);
        const { declared_at: priorDeclaredAt, ...priorInput } = prior;
        const { declared_at: requestedDeclaredAt, ...requestedInput } = declaration;
        if (digest(priorInput) !== digest(requestedInput)) fail('quality_sample_declaration_conflict');
        return { status: 'duplicate', entity_id: input.sample_id };
      }
      if (input.purpose !== 'monitor' && includedFrom && at > includedFrom) fail('quality_sample_must_be_pre_registered');
      if (input.purpose === 'initial') {
        const pointer = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, initialStage);
        if (pointer) {
          const current = readLedger(pointer, owner, initialStage);
          if (current.sample_id !== input.sample_id) fail('quality_initial_sample_already_registered');
        }
      }
      if (input.purpose === 'recovery') {
        const incident = store.db.prepare('SELECT * FROM incident WHERE incident_id=? AND category=?')
          .get(input.incident_id, input.category);
        if (!incident) fail('quality_incident_not_found');
        const active = categoryEvents(store, owner, input.category).at(-1)?.payload;
        if (active?.incident_id !== input.incident_id || active.status === 'resolved') fail('quality_incident_not_current');
        const history = incidentEvents(store, owner, active.canonical_root);
        const reservation = history.at(-1)?.payload;
        if (!reservation || reservation.adjustment_strategy_version !== input.strategy_version
          || reservation.sample_id) fail('quality_recovery_not_reserved');
        if (reservation.category !== input.category || reservation.adjustment_index < 1 || reservation.adjustment_index > 2) {
          fail('quality_recovery_binding_mismatch');
        }
      }
      store.db.prepare(`INSERT INTO sample(sample_id,purpose,category,included_from,included_until,target_total,cutoff_at,strategy_version,event_revision,created_at)
        VALUES(?,?,?,?,?,?,NULL,?,0,?)`).run(input.sample_id, input.purpose, input.category,
        includedFrom, includedUntil, input.target_total ?? null, input.strategy_version ?? null, at);
      insertLedger(store, owner, declaredStage, declaration, at);
      if (input.purpose === 'recovery') {
        const active = categoryEvents(store, owner, input.category).at(-1)?.payload;
        const history = incidentEvents(store, owner, active.canonical_root);
        const prior = history.at(-1).payload;
        const event = { ...prior, sample_id: input.sample_id,
          registered_at: at, status: 'adjusted' };
        appendIncidentEvent(store, owner, active.canonical_root, event, at);
      }
      if (input.purpose === 'initial') {
        insertLedger(store, owner, initialStage, { owner, category: input.category, sample_id: input.sample_id }, at);
      }
      return { status: 'succeeded', entity_id: input.sample_id };
    });
    return outcome;
  }

  function registerMonitorSample({ sample_id, category, target_total = null, as_of = now() } = {}) {
    const asOf = instant(as_of, 'as_of');
    const existing = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?')
      .get(owner, checkpointStage(owner, `sample:${sample_id}:declared`));
    if (existing) {
      const prior = readLedger(existing, owner, checkpointStage(owner, `sample:${sample_id}:declared`));
      if (prior.purpose !== 'monitor' || prior.category !== category || prior.target_total !== (target_total ?? null)) {
        fail('quality_sample_declaration_conflict');
      }
      return { status: 'duplicate', entity_id: sample_id };
    }
    const parts = shanghaiDayParts(asOf);
    const [year, month, day] = parts.date.split('-').map(Number);
    const todayStartUtc = Date.UTC(year, month - 1, day) - 8 * HOUR;
    return registerSample({
      sample_id,
      purpose: 'monitor',
      category,
      included_from: new Date(todayStartUtc - 6 * 24 * HOUR).toISOString(),
      included_until: asOf,
      target_total,
    });
  }

  function openIncident({ report_revision_id } = {}) {
    const at = instant(now(), 'now');
    if (typeof report_revision_id !== 'string' || !report_revision_id.trim()) fail('quality_incident_report_required');
    return store.transaction(() => {
      const row = store.db.prepare(`SELECT rr.*,s.category FROM report_revision rr
        JOIN sample s USING(sample_id) WHERE rr.report_revision_id=?`).get(report_revision_id);
      if (!row) fail('quality_incident_report_not_found');
      const loaded = loadSample(store, owner, row.sample_id);
      if (loaded.declaration.owner !== owner || loaded.declaration.category !== row.category) fail('quality_incident_report_owner_mismatch');
      const chain = verifyReportChain(store, row.sample_id);
      const saved = chain.find(item => item.report_revision_id === report_revision_id);
      const snapshot = JSON.parse(saved?.snapshot_json ?? '{}');
      if (snapshot.view !== 'cutoff' || snapshot.qualification !== 'failed'
        || !snapshot.feedback_history_complete || !snapshot.inclusion_closed
        || !snapshot.cutoff_at || snapshot.observation_at < snapshot.cutoff_at) fail('quality_incident_requires_cutoff_failure');

      const categoryHistory = categoryEvents(store, owner, row.category);
      const previousRoot = categoryHistory.at(-1)?.payload;
      if (previousRoot && previousRoot.status !== 'resolved') {
        const currentEvents = incidentEvents(store, owner, previousRoot.canonical_root);
        return { status: 'existing', incident_id: previousRoot.incident_id,
          canonical_root: previousRoot.canonical_root, adjustment_index: currentEvents.at(-1)?.payload.adjustment_index ?? 0 };
      }
      if (previousRoot?.status === 'resolved') {
        const last = incidentEvents(store, owner, previousRoot.canonical_root).at(-1)?.payload;
        if (snapshot.purpose === 'recovery' || !last?.resolved_at
          || snapshot.observation_at <= last.resolved_at || snapshot.as_of <= last.resolved_at) {
          fail('quality_incident_report_not_new_failure');
        }
      }

      const canonicalRoot = digest({ owner, category: row.category, report_revision_id });
      const incidentId = `quality-${canonicalRoot.slice(0, 32)}`;
      const existing = store.db.prepare('SELECT * FROM incident WHERE incident_id=?').get(incidentId);
      if (existing) fail('quality_incident_root_conflict');
      const recommendationId = snapshot.members?.[0]?.recommendation_id;
      const evidence = recommendationId ? store.db.prepare(`SELECT d.baseline_version,d.strategy_version FROM recommendation r
        JOIN decision d USING(decision_id) WHERE r.recommendation_id=?`).get(recommendationId) : null;
      const payload = { owner, canonical_root: canonicalRoot, incident_id: incidentId, category: row.category,
        report_revision_id, source_snapshot_hash: snapshot.snapshot_hash,
        baseline_version: evidence?.baseline_version ?? null,
        failed_strategy_version: evidence?.strategy_version ?? null, adjustment_index: 0,
        status: 'open', opened_at: at };
      store.db.prepare(`INSERT INTO incident(incident_id,category,report_revision_id,baseline_version,adjustment_index,status,created_at,updated_at)
        VALUES(?,?,?,?,NULL,'open',?,?)`).run(incidentId, row.category, report_revision_id, evidence?.baseline_version ?? null, at, at);
      appendIncidentEvent(store, owner, canonicalRoot, payload, at);
      appendCategoryEvent(store, owner, row.category,
        { canonical_root: canonicalRoot, incident_id: incidentId, status: 'open' }, at);
      return { status: 'succeeded', incident_id: incidentId, canonical_root: canonicalRoot,
        category: row.category, report_revision_id, adjustment_index: 0 };
    });
  }

  function activateStrategy({ strategy_version, parent_version, rules, rule_diff, evidence_refs, preference_version,
    incident_bindings = [] } = {}) {
    const at = instant(now(), 'now');
    if (typeof strategy_version !== 'string' || !strategy_version.trim()) fail('quality_strategy_id_required');
    if (!Array.isArray(evidence_refs) || evidence_refs.length === 0
      || evidence_refs.some(ref => typeof ref !== 'string' || !ref.trim())) fail('quality_strategy_evidence_required');
    if (!Array.isArray(incident_bindings)) fail('quality_incident_bindings_invalid');
    if (rule_diff == null || (typeof rule_diff === 'string' && !rule_diff.trim())
      || (typeof rule_diff === 'object' && !Object.keys(rule_diff).length)) fail('quality_strategy_diff_required');
    if ((!Array.isArray(rules) && (!rules || typeof rules !== 'object')) || !Object.keys(rules).length) {
      fail('quality_strategy_rules_invalid');
    }
    let normalizedRules;
    try { normalizedRules = JSON.parse(JSON.stringify(rules)); } catch { fail('quality_strategy_rules_invalid'); }
    return store.transaction(() => {
      const current = readCurrentStrategy(store, owner, at);
      if (parent_version !== current.strategy_version) fail('quality_strategy_parent_mismatch');
      if (digest(normalizedRules) === digest(current.rules)) fail('quality_strategy_no_change');
      if (strategyRow(store, strategy_version)) fail('quality_strategy_id_conflict');
      const preference = preference_version ?? current.preference_version ?? null;
      if (preference && !store.db.prepare('SELECT 1 FROM preference_version WHERE preference_version=?').get(preference)) {
        fail('quality_strategy_preference_not_found');
      }
      const categoryPrefix = checkpointStage(owner, 'incident-category:');
      const categoryNames = new Set(rowsWithPrefix(store, owner, categoryPrefix)
        .map(row => readLedger(row, owner, row.stage).category));
      const latestByCategory = new Map();
      for (const category of categoryNames) {
        const history = categoryEvents(store, owner, category);
        if (history.length) latestByCategory.set(category, history.at(-1).payload);
      }
      const openRoots = [...latestByCategory.values()].filter(event => event.status !== 'resolved');
      const bindings = new Map(incident_bindings.map(binding => [binding?.canonical_root ?? binding?.incident_id, binding]));
      if (bindings.size !== incident_bindings.length) fail('quality_incident_bindings_invalid');
      for (const root of openRoots) if (!bindings.has(root.canonical_root) && !bindings.has(root.incident_id)) {
        fail('quality_incident_binding_required');
      }
      for (const key of bindings.keys()) if (!openRoots.some(root => root.canonical_root === key || root.incident_id === key)) {
        fail('quality_incident_binding_mismatch');
      }
      const events = strategyEvents(store, owner);
      const sequence = events.length + 1;
      const storedRules = { quality_schema: 'quality-strategy-v1', rules: normalizedRules, rule_diff };
      const rulesHash = digest(normalizedRules);
      store.db.prepare(`INSERT INTO strategy_version(
        strategy_version,parent_version,rule_diff_json,evidence_refs_json,preference_version,state,effective_at,created_at
      ) VALUES(?,?,?,?,?,'active',?,?)`).run(strategy_version, current.strategy_version, JSON.stringify(storedRules),
        JSON.stringify(evidence_refs), preference, at, at);
      const bootstrapVersion = events.length ? events[0].payload.bootstrap_strategy_version : current.strategy_version;
      const appliedBindings = [];
      for (const root of openRoots) {
        const history = incidentEvents(store, owner, root.canonical_root);
        const priorIndex = Math.max(0, ...history.map(entry => entry.payload.adjustment_index ?? 0));
        const adjustmentIndex = priorIndex + 1;
        if (adjustmentIndex > 2) fail('quality_incident_adjustment_limit');
        if (priorIndex > 0 && history.at(-1)?.payload.recovery_qualification !== 'failed') {
          fail('quality_incident_adjustment_not_ready');
        }
        const binding = { incident_id: root.incident_id,
          category: root.category, report_revision_id: root.report_revision_id, baseline_version: history[0].payload.baseline_version,
          failed_strategy_version: history[0].payload.failed_strategy_version, adjustment_index: adjustmentIndex,
          adjustment_strategy_version: strategy_version, sample_id: null, status: 'adjusted',
          activated_at: at };
        appendIncidentEvent(store, owner, root.canonical_root, binding, at);
        store.db.prepare('UPDATE incident SET adjustment_index=?,status=?,updated_at=? WHERE incident_id=?')
          .run(adjustmentIndex, 'adjusted', at, root.incident_id);
        appliedBindings.push(binding);
      }
      const event = { owner, sequence, strategy_version, parent_version: current.strategy_version,
        bootstrap_strategy_version: bootstrapVersion, preference_version: preference, rules: normalizedRules,
        rules_hash: rulesHash, rule_diff, evidence_refs, effective_at: at, incident_bindings: appliedBindings,
        parent_hash: events.at(-1)?.row.output_hash ?? null };
      insertLedger(store, owner, checkpointStage(owner, `strategy:event:${sequence}`), event, at, sequence);
      return { status: 'succeeded', strategy: readCurrentStrategy(store, owner, at), sequence,
        incident_bindings: appliedBindings };
    });
  }

  function calculate(sampleId, eventRevision, asOf) {
    const at = instant(asOf, 'as_of');
    const currentTime = instant(now(), 'now');
    if (at > currentTime) fail('quality_as_of_future');
    if (!Number.isSafeInteger(eventRevision) || eventRevision < 0) fail('quality_event_revision_invalid');
    return store.transaction(() => {
      const { sample, declaration: baseDeclaration, declarationHash } = loadSample(store, owner, sampleId);
      const maxRevision = store.db.prepare('SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history').get().id;
      if (eventRevision > maxRevision) fail('quality_event_revision_future');
      const declaration = { ...baseDeclaration, requested_event_revision: eventRevision };
      const facts = collectFacts(store, declaration, at, eventRevision);
      const priorCurrent = store.db.prepare('SELECT snapshot_json FROM report_revision WHERE sample_id=? ORDER BY rowid DESC')
        .all(sampleId).map(row => JSON.parse(row.snapshot_json)).find(snapshot => snapshot.view === 'current');
      if (priorCurrent && at < priorCurrent.as_of) {
        const historicalCutoff = facts.last_success_at
          ? new Date(Date.parse(facts.last_success_at) + 48 * HOUR).toISOString() : null;
        const historicalSnapshot = snapshotFor(declaration, declarationHash, facts, {
          view: 'historical', asOf: at, observationAt: at, cutoffAt: historicalCutoff,
          closed: Boolean(declaration.included_until && at >= declaration.included_until),
          cutoffReached: Boolean(historicalCutoff && at >= historicalCutoff),
        });
        const report = saveReport(store, baseDeclaration, historicalSnapshot, 'historical_calculation');
        return { status: 'succeeded', sample_id: sampleId, reports: [report], metrics: historicalSnapshot.metrics,
          qualification: historicalSnapshot.qualification, blockers: historicalSnapshot.blockers };
      }
      insertMembers(store, sampleId, facts.members);
      const closed = Boolean(declaration.included_until && at >= declaration.included_until);
      const saved = [];
      const cutoffPrefix = checkpointStage(owner, `sample:${sampleId}:cutoff-event:`);
      const cutoffEvents = rowsWithPrefix(store, owner, cutoffPrefix)
        .map(row => ({ row, payload: readLedger(row, owner, row.stage) }))
        .sort((left, right) => left.payload.sequence - right.payload.sequence);
      let cutoffParentHash = null;
      for (let index = 0; index < cutoffEvents.length; index++) {
        const { row, payload } = cutoffEvents[index];
        if (payload.sequence !== index + 1 || payload.owner !== owner || payload.sample_id !== sampleId
          || payload.parent_hash !== cutoffParentHash
          || row.stage !== checkpointStage(owner, `sample:${sampleId}:cutoff-event:${index + 1}`)
          || row.generation !== index + 1) fail('quality_cutoff_chain_corrupt');
        cutoffParentHash = row.output_hash;
      }
      const frozenPrefix = checkpointStage(owner, `sample:${sampleId}:cutoff-frozen:`);
      const frozenEvents = rowsWithPrefix(store, owner, frozenPrefix)
        .map(row => ({ row, payload: readLedger(row, owner, row.stage) }))
        .sort((left, right) => left.payload.sequence - right.payload.sequence);
      let frozenParentHash = null;
      for (let index = 0; index < frozenEvents.length; index++) {
        const { row, payload } = frozenEvents[index];
        const cutoffEvent = cutoffEvents.find(event => event.payload.sequence === payload.cutoff_event_sequence);
        if (payload.sequence !== index + 1 || payload.owner !== owner || payload.sample_id !== sampleId
          || payload.parent_hash !== frozenParentHash
          || row.stage !== checkpointStage(owner, `sample:${sampleId}:cutoff-frozen:${index + 1}`)
          || row.generation !== index + 1 || !cutoffEvent
          || payload.cutoff_event_checkpoint_id !== cutoffEvent.row.checkpoint_id
          || payload.cutoff_event_hash !== cutoffEvent.row.output_hash) fail('quality_cutoff_freeze_chain_corrupt');
        frozenParentHash = row.output_hash;
      }
      const frozenByCutoff = new Map(frozenEvents.map(event => [event.payload.cutoff_event_sequence, event]));
      let current = cutoffEvents.at(-1)?.payload ?? null;
      let sequence = current?.sequence ?? 0;
      const appendCutoff = (lastSuccessAt, cutoffAt, cause) => {
        const next = { owner, sample_id: sampleId, sequence: ++sequence, last_success_at: lastSuccessAt,
          cutoff_at: cutoffAt, cause, parent_hash: cutoffEvents.at(-1)?.row.output_hash ?? null };
        const stage = checkpointStage(owner, `sample:${sampleId}:cutoff-event:${sequence}`);
        insertLedger(store, owner, stage, next, at, sequence);
        const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, stage);
        cutoffEvents.push({ row, payload: next });
        current = next;
      };
      const observationDeadline = event => new Date(Math.max(
        Date.parse(event.cutoff_at),
        declaration.included_until ? Date.parse(declaration.included_until) : Number.NEGATIVE_INFINITY,
      )).toISOString();
      const confirmSuccess = (successAt, cause) => {
        if (!current) {
          appendCutoff(successAt, new Date(Date.parse(successAt) + 48 * HOUR).toISOString(), cause);
          return;
        }
        const alreadyFrozen = frozenByCutoff.has(current.sequence);
        const effectiveDeadline = observationDeadline(current);
        if (!alreadyFrozen && successAt <= effectiveDeadline) {
          appendCutoff(successAt, new Date(Date.parse(successAt) + 48 * HOUR).toISOString(), cause);
          return;
        }
        if (closed && !alreadyFrozen && successAt > effectiveDeadline) {
          freezeCutoff(current, 'success_after_cutoff');
        }
        const nextCutoff = new Date(Date.parse(successAt) + 48 * HOUR).toISOString();
        appendCutoff(successAt, nextCutoff, cause);
      };
      const freezeCutoff = (event, reason) => {
        if (frozenByCutoff.has(event.sequence)) return;
        const observationAt = observationDeadline(event);
        if (!closed || at < observationAt) return;
        const freezeSequence = frozenEvents.length + 1;
        const cutoffEvent = cutoffEvents.find(entry => entry.payload.sequence === event.sequence);
        if (!cutoffEvent) fail('quality_cutoff_event_missing');
        const payload = { owner, sample_id: sampleId, sequence: freezeSequence,
          cutoff_event_sequence: event.sequence, cutoff_at: event.cutoff_at, observation_at: event.cutoff_at,
          facts_as_of: observationAt,
          cutoff_event_checkpoint_id: cutoffEvent.row.checkpoint_id, cutoff_event_hash: cutoffEvent.row.output_hash,
          last_success_at: event.last_success_at, frozen_at: at, reason,
          parent_hash: frozenEvents.at(-1)?.row.output_hash ?? null };
        const stage = checkpointStage(owner, `sample:${sampleId}:cutoff-frozen:${freezeSequence}`);
        insertLedger(store, owner, stage, payload, at, freezeSequence);
        const row = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, stage);
        const frozenEvent = { row, payload };
        frozenEvents.push(frozenEvent);
        frozenByCutoff.set(event.sequence, frozenEvent);
      };
      const newSuccesses = facts.members.map(member => member.confirmed_at).filter(value =>
        !current?.last_success_at || value > current.last_success_at).sort();
      for (const successAt of newSuccesses) confirmSuccess(successAt, 'confirmed_success');
      if (closed && current && at >= observationDeadline(current)) freezeCutoff(current, 'observation_deadline_reached');
      const priorCutoffReports = store.db.prepare('SELECT snapshot_json FROM report_revision WHERE sample_id=?')
        .all(sampleId).map(row => JSON.parse(row.snapshot_json));
      for (const frozenEvent of frozenEvents) {
        const cutoffEvent = cutoffEvents.find(event => event.payload.sequence === frozenEvent.payload.cutoff_event_sequence);
        if (!cutoffEvent) fail('quality_cutoff_event_missing');
        const cutoffEventRef = `${cutoffEvent.row.checkpoint_id}:${cutoffEvent.row.output_hash}`;
        const reportExists = priorCutoffReports.some(snapshot => snapshot.view === 'cutoff'
          && snapshot.cutoff_event_ref === cutoffEventRef && snapshot.feedback_history_complete);
        const factsAsOf = frozenEvent.payload.facts_as_of ?? observationDeadline(frozenEvent.payload);
        const observationAt = frozenEvent.payload.observation_at ?? frozenEvent.payload.cutoff_at;
        if (reportExists || at < factsAsOf) continue;
        const cutoffFacts = collectFacts(store, declaration, factsAsOf, eventRevision, frozenEvent.payload.cutoff_at);
        const cutoffSnapshot = snapshotFor(declaration, declarationHash, cutoffFacts, {
          view: cutoffFacts.watermarks.feedback_history_complete ? 'cutoff' : 'cutoff_partial',
          asOf: at, observationAt, factsAsOf, cutoffAt: frozenEvent.payload.cutoff_at,
          closed: true, cutoffReached: true,
        });
        cutoffSnapshot.cutoff_event_ref = cutoffEventRef;
        cutoffSnapshot.cutoff_epoch = frozenEvent.payload.sequence;
        const cutoffReport = saveReport(store, baseDeclaration, cutoffSnapshot,
          cutoffSnapshot.view === 'cutoff' ? 'original_cutoff' : 'partial_cutoff_history');
        saved.push(cutoffReport);
        if (declaration.purpose === 'recovery' && cutoffSnapshot.view === 'cutoff' && cutoffReport.report_revision_id) {
          recordRecoveryOutcome(store, owner, baseDeclaration, cutoffSnapshot, cutoffReport.report_revision_id, cutoffEventRef, at);
        }
      }
      const cutoffAt = current?.cutoff_at ?? null;
      store.db.prepare('UPDATE sample SET cutoff_at=? WHERE sample_id=?').run(cutoffAt, sampleId);
      const currentSnapshot = snapshotFor(declaration, declarationHash, facts, {
        view: 'current', asOf: at, observationAt: at, cutoffAt,
        closed, cutoffReached: Boolean(cutoffAt && at >= cutoffAt),
      });
      saved.push(saveReport(store, baseDeclaration, currentSnapshot, currentReportReason(store, sampleId, currentSnapshot)));
      return { status: 'succeeded', sample_id: sampleId, reports: saved, metrics: currentSnapshot.metrics,
        qualification: currentSnapshot.qualification, blockers: currentSnapshot.blockers };
    });
  }

  function recordWeeklyReview({ as_of = now(), event_revision } = {}) {
    const at = instant(as_of, 'as_of');
    const day = shanghaiDayParts(at);
    if (day.weekday !== 'Sun') fail('quality_weekly_review_not_due');
    const revision = event_revision ?? store.db.prepare('SELECT coalesce(max(feedback_history_id),0) AS id FROM feedback_history').get().id;
    const stage = checkpointStage(owner, `weekly-review:${day.date}`);
    const previous = store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=?').get(owner, stage);
    if (previous) {
      const payload = readLedger(previous, owner, stage);
      if (payload.event_revision !== revision) fail('quality_weekly_review_conflict');
      return { status: 'duplicate', date: day.date, checkpoint_id: previous.checkpoint_id,
        report_revision_ids: payload.report_revision_ids };
    }
    const results = [];
    for (const category of ['follow', 'explore']) {
      const sampleId = `monitor-${digest({ owner, category, day: day.date }).slice(0, 32)}`;
      registerMonitorSample({ sample_id: sampleId, category, as_of: at });
      results.push(calculate(sampleId, revision, at));
    }
    const payload = { owner, date: day.date, as_of: at, event_revision: revision,
      sample_ids: results.map(result => result.sample_id), report_revision_ids: results.flatMap(result => result.reports.map(report => report.report_revision_id)) };
    store.transaction(() => insertLedger(store, owner, stage, payload, at));
    const row = store.db.prepare('SELECT checkpoint_id FROM checkpoint WHERE owner=? AND stage=?').get(owner, stage);
    return { status: 'succeeded', date: day.date, checkpoint_id: row.checkpoint_id, report_revision_ids: payload.report_revision_ids };
  }

  return { registerSample, registerMonitorSample, calculate, recordWeeklyReview, openIncident, activateStrategy };
}
