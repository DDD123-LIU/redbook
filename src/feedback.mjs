import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { prepareExplicitPreference } from './preference.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const values = new Map([['赞', 'like'], ['踩', 'dislike'], ['看过', 'seen']]);

function selectorOf(text) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return { kind: 'recommendation', value: text };
  const batch = text.match(/^([^/\s]+)\/(\d+)$/);
  if (batch) return { kind: 'batch_ordinal', batch_id: batch[1], ordinal: Number(batch[2]) };
  const message = text.match(/^(?:消息|引用)[:：](\S+)$/);
  if (message) return { kind: 'message', value: message[1] };
  if (/^\d+$/.test(text)) return { kind: 'ordinal', value: Number(text) };
  return null;
}

export function parseFeedbackText(input) {
  if (typeof input !== 'string') return { kind: 'invalid' };
  const text = input.trim();
  let match;
  if (text.match(/^再来\s*3\s*条$/)) return { kind: 'request', request_type: 'additional_follow', target: 3 };
  if (text.match(/^探索\s*3\s*条$/)) return { kind: 'request', request_type: 'explore', target: 3 };
  if ((match = text.match(/^修改偏好：(.+)$/))) return { kind: 'preference', operation: { kind: 'append', instruction: match[1].trim() } };
  if ((match = text.match(/^删除偏好：(.+)$/))) return { kind: 'preference', operation: { kind: 'remove', instruction: match[1].trim() } };
  if ((match = text.match(/^替换偏好：(.+?)\s*=>\s*(.+)$/))) return { kind: 'preference', operation: { kind: 'replace', old_instruction: match[1].trim(), instruction: match[2].trim() } };
  if ((match = text.match(/^查询\s*(.+)$/))) {
    const selector = selectorOf(match[1].trim());
    return selector ? { kind: 'query', selector } : { kind: 'invalid' };
  }
  if ((match = text.match(/^更正\s*(.+?)\s*(赞|踩|看过)(?:\s*(?:修订|v)(\d+))?$/i))) {
    const selector = selectorOf(match[1].trim());
    if (selector) return { kind: 'correction', value: values.get(match[2]), selector, expected_revision: match[3] ? Number(match[3]) : undefined };
  }
  if ((match = text.match(/^(.+?)\s*(赞|踩|看过)$/))) {
    const selector = selectorOf(match[1].trim());
    if (selector) return { kind: 'feedback', value: values.get(match[2]), selector };
  }
  if (values.has(text)) return { kind: 'feedback', value: values.get(text), selector: { kind: 'parent' } };
  return { kind: 'invalid' };
}

function privateWrite(root, name, value) {
  const directory = join(root, 'feedback');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  const raw = `${JSON.stringify(value)}\n`;
  writeFileSync(path, raw, { flag: 'wx' });
  return { ref: path, hash: hash(raw) };
}

function verifiedFile(root, entry) {
  if (!entry || typeof entry.ref !== 'string' || !isAbsolute(entry.ref)) return null;
  const rel = relative(resolve(root), resolve(entry.ref));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try {
    const raw = readFileSync(entry.ref, 'utf8');
    if (hash(raw) !== entry.hash) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function checkpoint(store, owner, stage) {
  return store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY committed_at DESC,rowid DESC LIMIT 1').get(owner, stage);
}

function verifyDisplay(store, root, owner, recommendationId) {
  const row = checkpoint(store, owner, `display-build:${recommendationId}`);
  if (!row || !row.succeeded_refs_json || !row.output_hash) return null;
  let refs;
  try { refs = JSON.parse(row.succeeded_refs_json); } catch { return null; }
  for (const entry of refs) {
    const item = verifiedFile(root, entry);
    if (item?.recommendation_id === recommendationId && item.status === 'succeeded' && Number.isInteger(item.ordinal) && item.ordinal > 0 && (!row.delivery_batch_id || item.delivery_batch_id === row.delivery_batch_id)) {
      try { if (hash(readFileSync(entry.ref)) === row.output_hash) return item; } catch { /* 文件不可验证 */ }
    }
  }
  return null;
}

function canonicalRows(store, owner) {
  return store.db.prepare(`SELECT d.owner,d.platform,d.source_content_id,d.recommendation_id,r.content_id,r.delivery_batch_id,r.category,r.actual_preference_version,r.actual_strategy_version
    FROM delivered_content d JOIN recommendation r ON r.recommendation_id=d.recommendation_id
    WHERE d.owner=? ORDER BY d.first_success_at,d.recommendation_id`).all(owner);
}

function resolveSelector(store, root, owner, selector, parentId, expectedChatRef) {
  if (selector?.kind === 'parent') selector = { kind: 'message', value: parentId };
  if (!selector || (selector.kind === 'message' && !selector.value)) return { state: 'unmatched' };
  const rows = canonicalRows(store, owner).filter(row => verifyDisplay(store, root, owner, row.recommendation_id));
  let matches = [];
  if (selector.kind === 'recommendation') {
    const alias = store.db.prepare(`SELECT r.content_id FROM recommendation r JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id
      JOIN delivery_attempt a ON a.recommendation_id=r.recommendation_id AND a.status='succeeded' AND a.target_ref=? WHERE b.owner=? AND r.recommendation_id=?`).get(expectedChatRef, owner, selector.value);
    matches = rows.filter(row => row.recommendation_id === selector.value || alias?.content_id === row.content_id);
  }
  if (selector.kind === 'batch_ordinal' || selector.kind === 'ordinal') {
    const aliases = store.db.prepare(`SELECT DISTINCT r.recommendation_id,r.content_id,r.delivery_batch_id FROM recommendation r
      JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id JOIN delivery_attempt a ON a.recommendation_id=r.recommendation_id
      WHERE b.owner=? AND a.target_ref=? AND a.status='succeeded'`).all(owner,expectedChatRef);
    const ids = new Set(aliases.filter(alias => (selector.kind !== 'batch_ordinal' || alias.delivery_batch_id === selector.batch_id)
      && verifyDisplay(store,root,owner,alias.recommendation_id)?.ordinal === (selector.ordinal ?? selector.value)).map(alias=>alias.content_id));
    matches=rows.filter(row=>ids.has(row.content_id));
  }
  if (selector.kind === 'message') {
    const candidates = store.db.prepare(`SELECT DISTINCT r.content_id FROM delivery_attempt a JOIN recommendation r ON r.recommendation_id=a.recommendation_id
      JOIN batch b ON b.delivery_batch_id=r.delivery_batch_id WHERE a.message_id=? AND a.target_ref=? AND a.status='succeeded' AND b.owner=?`).all(selector.value, expectedChatRef, owner);
    const ids = new Set(candidates.map(row => row.content_id));
    matches = rows.filter(row => ids.has(row.content_id));
  }
  if (matches.length !== 1) return { state: matches.length ? 'ambiguous' : 'unmatched' };
  const row = matches[0];
  return { state: 'matched', row, display: verifyDisplay(store, root, owner, row.recommendation_id) };
}

function checkpointInsert(store, owner, name, stage, file, now) {
  store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,input_hash,output_hash,committed_at)
    VALUES(?,?,?,0,?,?,?,?,?)`).run(randomUUID(), owner, name, stage, JSON.stringify([file]), file.hash, file.hash, now);
}

function tuple(owner, appRef, chatRef, eventId) { return `${hash(`${owner}\0${appRef}\0${chatRef}\0${eventId}`)}`; }

function insertEvent(store, event, parsed, association, target, savedAt, correctionOf = null) {
  store.db.prepare(`INSERT INTO feedback_event(app_ref,chat_ref,event_id,recommendation_id,content_id,value,received_at,saved_at,revision,correction_of_event_id,parse_state,association_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.app_ref, event.chat_ref, event.event_id, target?.row.recommendation_id ?? null, target?.row.content_id ?? null,
    parsed.value ?? null, event.received_at, savedAt, null, correctionOf, parsed.kind === 'invalid' ? 'invalid' : 'parsed', association);
}

function currentFor(store, row) {
  return store.db.prepare('SELECT * FROM feedback_current WHERE owner=? AND platform=? AND source_content_id=?').get(row.owner, row.platform, row.source_content_id);
}

function formatReceipt(result) {
  if (result.status === 'saved') return result.preference_version ? `已保存，偏好指令已生效（版本 ${result.preference_version}）。` : '已保存。';
  if (result.status === 'preference_pending') return '已收到偏好指令，当前缺少可验证的偏好版本，暂未生效。';
  if (result.status === 'clarification_required') return '我无法唯一确认目标或版本。请提供推荐 UUID，或批次/序号，并在更正时提供当前修订号。';
  if (result.status === 'query') return result.value ? `当前评价：${result.value}，修订 ${result.revision}。` : '该内容还没有评价。';
  if (result.status === 'unsupported') return '暂不支持探索3条；人工追加请发送再来3条。';
  if (result.status === 'request_pending') return `已记录${result.request_type === 'manual_follow' ? '独立推荐' : '追加'}请求，共 ${result.target} 条；尚未执行。`;
  return '已收到。';
}

export function createFeedback({ store, root, owner, appRef, chatRef, senderRef, transport, now = () => new Date().toISOString() }) {
  if (!store?.db || !root || !owner || !appRef || !chatRef || !senderRef || !transport?.send || !transport?.lookup) throw new TypeError('feedback dependencies are incomplete');

  function eventCheckpoint(event) { return checkpoint(store, owner, `feedback-event:${tuple(owner, event.app_ref, event.chat_ref, event.event_id)}`); }

  function eventCreatedAt(eventId) {
    const cp = checkpoint(store, owner, `feedback-event:${tuple(owner, appRef, chatRef, eventId)}`);
    try { return verifiedFile(root, JSON.parse(cp.succeeded_refs_json)[0])?.created_at ?? null; } catch { return null; }
  }

  async function applyFeedback(event, expectedRevision) {
    if (event?.app_ref !== appRef || event?.chat_ref !== chatRef || event?.sender_ref !== senderRef) return { status: 'ignored', reason: 'identity_mismatch' };
    if (!event.event_id || !event.message_id || !event.created_at || !event.received_at || typeof event.text !== 'string') return { status: 'ignored', reason: 'invalid_event' };
    const key = tuple(owner, appRef, chatRef, event.event_id);
    const prior = eventCheckpoint(event);
    if (prior) return { status: 'duplicate', outbox_id: store.db.prepare('SELECT outbox_id FROM outbox WHERE kind=? AND object_ref=? ORDER BY business_revision LIMIT 1').get('feedback_receipt', key)?.outbox_id };
    const parsed = parseFeedbackText(event.text);
    let association = 'unmatched', target = null, response = { status: 'clarification_required' }, correctionOf = null, preference = null;
    if (parsed.kind === 'feedback' || parsed.kind === 'correction' || parsed.kind === 'query') {
      const selector = parsed.selector.kind === 'parent' ? { kind: 'message', value: event.parent_id } : parsed.selector;
      target = resolveSelector(store, root, owner, selector, event.parent_id, chatRef);
      association = target.state;
      if (target.state === 'matched') {
        const current = currentFor(store, target.row);
        if (parsed.kind === 'query') response = { status: 'query', value: current?.value ?? null, revision: current?.revision ?? null };
        else if (parsed.kind === 'feedback' && current && current.value !== parsed.value) response = { status: 'clarification_required' };
        else if (parsed.kind === 'correction' && (!current || !Number.isInteger(expectedRevision) || current.revision !== expectedRevision)) response = { status: 'clarification_required' };
        else if (parsed.kind !== 'query') {
          correctionOf = parsed.kind === 'correction' ? current.event_id : null;
          response = { status: 'saved' };
        }
      }
    } else if (parsed.kind === 'request') {
      association = 'unmatched'; response = { status: parsed.request_type==='explore'?'unsupported':'request_pending', request_type: parsed.request_type, target: parsed.target };
    } else if (parsed.kind === 'preference') {
      association = 'unmatched';
      try { preference = prepareExplicitPreference({ store, root, owner, event, operation: parsed.operation, now }); response = { status: 'saved', preference_version: preference.preference_version }; }
      catch (error) { response = { status: 'preference_pending', reason: error.message }; }
    }

    const savedAt = now(), checkpointName = `feedback-event:${key}`;
    let outboxId = randomUUID(), duplicate = false;
    try {
      store.transaction(() => {
        if (eventCheckpoint(event)) { duplicate = true; return; }
        if ((parsed.kind === 'feedback' || parsed.kind === 'correction') && target?.state === 'matched') {
          const current = currentFor(store, target.row);
          const expected = parsed.expected_revision ?? expectedRevision;
          const previousAt = current ? eventCreatedAt(current.event_id) : null;
          const stale = previousAt && Date.parse(event.created_at) < Date.parse(previousAt);
          if (stale || (parsed.kind === 'correction' && (!Number.isInteger(expected) || current?.revision !== expected)) ||
            (parsed.kind === 'feedback' && current && current.value !== parsed.value)) {
            response = { status: 'clarification_required' };
          } else {
            correctionOf = parsed.kind === 'correction' && current ? current.event_id : null;
            response = { status: 'saved' };
          }
        }
        const request = { owner, app_ref: appRef, chat_ref: chatRef, event_id: event.event_id, message_id: event.message_id, created_at: event.created_at, received_at: event.received_at, text: event.text, parent_id: event.parent_id ?? null, source_message_type:event.source_message_type??'text',source:event.source??'platform_event',source_evidence_ref:event.source_evidence_ref??null,recovery_of_event_id:event.recovery_of_event_id??null, parsed, response };
        const file = privateWrite(root, `event-${key}-${randomUUID()}`, request);
        const receiptUuid = randomUUID(), body = `${formatReceipt(response)}\n回执ID：${outboxId}`;
        const receipt = { receive_id: chatRef, msg_type: 'text', content: JSON.stringify({ text: body }), uuid: receiptUuid };
        const outboxFile = privateWrite(root, `receipt-${outboxId}`, { outbox_id: outboxId, event_id: event.event_id, request: receipt });
        const stored = response.status === 'saved' ? parsed : { ...parsed, value: null };
        insertEvent(store, event, stored, association, target?.state === 'matched' ? target : null, savedAt, correctionOf);
        if (parsed.kind === 'preference' && response.status === 'saved') {
          const publication = preference.publish();
          if (publication.status !== 'succeeded') throw new Error('explicit preference publish did not succeed');
        }
        if ((parsed.kind === 'feedback' || parsed.kind === 'correction') && response.status === 'saved' && target.state === 'matched') {
          const row = target.row, current = currentFor(store, row);
          if (!current) {
            store.db.prepare(`INSERT INTO feedback_current(owner,app_ref,chat_ref,platform,source_content_id,content_id,recommendation_id,value,revision,event_id,saved_at)
              VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(owner, appRef, chatRef, row.platform, row.source_content_id, row.content_id, row.recommendation_id, parsed.value, event.event_id, savedAt);
          } else if (current.value !== parsed.value) {
            const expected = parsed.expected_revision ?? expectedRevision;
            if (parsed.kind !== 'correction' || current.revision !== expected) throw new Error('feedback revision changed');
            const updated = store.db.prepare(`UPDATE feedback_current SET value=?,event_id=?,saved_at=?,revision=revision+1
              WHERE owner=? AND platform=? AND source_content_id=? AND revision=?`).run(parsed.value, event.event_id, savedAt, owner, row.platform, row.source_content_id, expected);
            if (updated.changes !== 1) throw new Error('feedback revision CAS failed');
          }
        }
        store.db.prepare(`INSERT INTO outbox(outbox_id,kind,object_ref,business_revision,state,created_at,updated_at) VALUES(?, 'feedback_receipt', ?, 1, 'pending', ?, ?)`).run(outboxId, key, savedAt, savedAt);
        checkpointInsert(store, owner, event.event_id, checkpointName, file, savedAt);
        checkpointInsert(store, owner, event.event_id, `feedback-receipt-request:${outboxId}`, outboxFile, savedAt);
      });
      if (duplicate) return { status: 'duplicate', outbox_id: store.db.prepare('SELECT outbox_id FROM outbox WHERE kind=? AND object_ref=?').get('feedback_receipt', key)?.outbox_id };
      return { ...response, outbox_id: outboxId };
    } catch (error) { return { status: 'save_failed', reason: error.message }; }
  }

  function loadOutbox(outboxId) {
    const row = store.db.prepare("SELECT * FROM outbox WHERE outbox_id=? AND kind='feedback_receipt'").get(outboxId);
    if (!row) return null;
    const cp = checkpoint(store, owner, `feedback-receipt-request:${outboxId}`);
    if (!cp) return null;
    let refs; try { refs = JSON.parse(cp.succeeded_refs_json); } catch { return null; }
    const data = verifiedFile(root, refs[0]);
    return data?.outbox_id === outboxId ? { row, cp, data } : null;
  }

  function resultCheckpoint(outboxId) { return checkpoint(store, owner, `feedback-receipt-result:${outboxId}`); }

  async function sendReceipt(outboxId) {
    const found = loadOutbox(outboxId);
    if (!found) return { status: 'unknown', reason: 'receipt_checkpoint_unavailable' };
    if (['succeeded','failed','cancelled'].includes(found.row.state)) return reconcileReceipt(outboxId);
    let attemptId = randomUUID(), claimed = false;
    store.transaction(() => {
      const fresh = store.db.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(outboxId);
      if (fresh.state !== 'pending') return;
      const result = store.db.prepare("UPDATE outbox SET state='intent',attempt_id=?,updated_at=?,revision=revision+1 WHERE outbox_id=? AND state='pending' AND revision=?").run(attemptId, now(), outboxId, fresh.revision);
      claimed = result.changes === 1;
    });
    if (!claimed) {
      const row = store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(outboxId);
      if (row && ['succeeded','failed','cancelled'].includes(row.state)) return reconcileReceipt(outboxId);
      return { status: row?.state ?? 'unknown' };
    }
    let outcome;
    try { outcome = await transport.send(found.data.request); }
    catch (error) { outcome = { status: 'unknown', reason: error.message }; }
    if (!['succeeded', 'failed', 'unknown'].includes(outcome?.status) || (outcome.status === 'succeeded' && !outcome.message_id)) outcome = { status: 'unknown', reason: outcome?.reason ?? 'incomplete_transport_result' };
    const result = { outbox_id: outboxId, attempt_id: attemptId, event_id: found.data.event_id, status: outcome.status, message_id: outcome.message_id ?? null, evidence: outcome.evidence ?? null, reason: outcome.reason ?? null };
    const file = privateWrite(root, `receipt-result-${outboxId}-${attemptId}`, result);
    store.transaction(() => {
      const fresh = store.db.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(outboxId);
      if (fresh.state === 'succeeded' || fresh.state === 'failed') return;
      if (fresh.state !== 'intent' || fresh.attempt_id !== attemptId) throw new Error('receipt claim changed');
      store.db.prepare('UPDATE outbox SET state=?,updated_at=?,revision=revision+1 WHERE outbox_id=? AND state=\'intent\' AND revision=?').run(outcome.status, now(), outboxId, fresh.revision);
      checkpointInsert(store, owner, found.data.event_id, `feedback-receipt-result:${outboxId}`, file, now());
    });
    const finalState = store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(outboxId).state;
    return { status: finalState, message_id: outcome.message_id, evidence: outcome.evidence };
  }

  async function reconcileReceipt(outboxId) {
    const found = loadOutbox(outboxId);
    if (!found) return { status: 'unknown', reason: 'receipt_checkpoint_unavailable' };
    const row = store.db.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(outboxId);
    const cp = resultCheckpoint(outboxId);
    if (cp) {
      let refs; try { refs = JSON.parse(cp.succeeded_refs_json); } catch { refs = []; }
      const result = verifiedFile(root, refs[0]);
      if (result?.outbox_id === outboxId && result.status === row.state &&
        (result.status === 'failed' || result.status === 'succeeded' && typeof result.message_id === 'string' && result.message_id.trim())) return { status: result.status, message_id: result.message_id, evidence: result.evidence };
    }
    // 无持久hash的文件只提供查询线索，不能绕过坏hash或直接升级成功状态。
    let messageIdHint=null;
    try {
      const result=JSON.parse(readFileSync(join(root,'feedback',`receipt-result-${outboxId}-${row.attempt_id}.json`),'utf8'));
      if(result.outbox_id===outboxId&&result.event_id===found.data.event_id&&result.attempt_id===row.attempt_id&&typeof result.message_id==='string'&&result.message_id.trim())messageIdHint=result.message_id;
    } catch { /* 私有结果不可读时，交给lookup核实。 */ }
    let outcome;
    const endedAt = now();
    let lookupError=null;
    try { outcome = await transport.lookup({ outbox_id: outboxId, target_ref: found.data.request.receive_id, payload: found.data.request, started_at: row.created_at, ended_at: endedAt, uuid: found.data.request.uuid, message_id: messageIdHint }); }
    catch (error) { lookupError=error; outcome={status:'unknown',reason:error.message,evidence:'lookup_exception'}; }
    if (outcome?.status === 'succeeded' && outcome.message_id) {
      const result = { outbox_id: outboxId, event_id: found.data.event_id, status: 'succeeded', message_id: outcome.message_id, evidence: outcome.evidence ?? null };
      const file = privateWrite(root, `receipt-result-${outboxId}-reconciled-${randomUUID()}`, result);
      if (row.state === 'failed' || row.state === 'cancelled') return { status: 'evidence_unverifiable', historical_state: row.state, reason: 'lookup_conflicts_with_terminal_state' };
      store.transaction(() => {
        const fresh = store.db.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(outboxId);
        if (fresh.state === 'intent' || fresh.state === 'unknown') store.db.prepare('UPDATE outbox SET state=\'succeeded\',updated_at=?,revision=revision+1 WHERE outbox_id=? AND state=? AND revision=?').run(now(), outboxId, fresh.state, fresh.revision);
        else if (fresh.state !== 'succeeded') return;
        checkpointInsert(store, owner, found.data.event_id, `feedback-receipt-result:${outboxId}`, file, now());
      });
      return store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(outboxId).state === 'succeeded'
        ? { status: 'succeeded', message_id: outcome.message_id, evidence: outcome.evidence }
        : { status: 'unknown', reason: 'outbox_state_changed_during_reconciliation' };
    }
    const resolution = { outbox_id:outboxId,event_id:found.data.event_id,attempt_id:row.attempt_id,status:'unknown',reason:lookupError?.message??outcome?.reason??'receipt_not_verified',evidence:outcome?.evidence??null,checked_at:endedAt };
    if (row.state === 'intent' || row.state === 'unknown') {
      const file = privateWrite(root, `receipt-result-${outboxId}-lookup-${randomUUID()}`, resolution);
      store.transaction(() => {
        const fresh=store.db.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(outboxId);
        if(fresh.state==='intent'){
          const cas=store.db.prepare("UPDATE outbox SET state='unknown',updated_at=?,revision=revision+1 WHERE outbox_id=? AND state='intent' AND revision=?").run(endedAt,outboxId,fresh.revision);
          if(cas.changes!==1)return;
        }else if(fresh.state!=='unknown')return;
        checkpointInsert(store,owner,found.data.event_id,`feedback-receipt-result:${outboxId}`,file,endedAt);
      });
      const state=store.db.prepare('SELECT state FROM outbox WHERE outbox_id=?').get(outboxId).state;
      if(state==='succeeded'||state==='failed')return {status:'unknown',reason:'outbox_state_changed_during_reconciliation'};
    }
    if (row.state === 'succeeded' || row.state === 'failed' || row.state === 'cancelled') return { status: 'evidence_unverifiable', historical_state: row.state, evidence: outcome?.evidence, reason: lookupError?.message??outcome?.reason??'receipt_not_verified' };
    return { status: 'unknown', evidence: outcome?.evidence, reason: lookupError?.message??outcome?.reason??'receipt_not_verified' };
  }

  function queryFeedback(selector) {
    const parsed = typeof selector === 'string' ? selectorOf(selector) : selector;
    const resolved = resolveSelector(store, root, owner, parsed, null, chatRef);
    if (resolved.state !== 'matched') return { status: 'clarification_required' };
    const current = currentFor(store, resolved.row);
    return { status: 'query', recommendation_id: resolved.row.recommendation_id, category:resolved.row.category,actual_preference_version:resolved.row.actual_preference_version,actual_strategy_version:resolved.row.actual_strategy_version,value: current?.value ?? null, revision: current?.revision ?? null };
  }

  async function pendingRequests({ eventId, commandId } = {}) {
    const rows = store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND stage LIKE 'feedback-event:%' ORDER BY committed_at,rowid").all(owner);
    const pending = [];
    for (const row of rows) {
      let refs; try { refs = JSON.parse(row.succeeded_refs_json); } catch { continue; }
      const request = verifiedFile(root, refs[0]);
      const stableCommandId = request ? hash(`${owner}\0${appRef}\0${chatRef}\0${request.event_id}`) : null;
      if (request && (!eventId || request.event_id === eventId) && request.owner === owner && request.app_ref === appRef
        && request.chat_ref === chatRef && (!commandId || stableCommandId === commandId) && typeof request.text === 'string'
        && ['request_pending', 'preference_pending'].includes(request.response?.status)) {
        pending.push({ event_id: request.event_id, ...request.response, provenance: { kind: 'feedback_event', owner: request.owner,
          app_ref: request.app_ref, chat_ref: request.chat_ref, event_id: request.event_id, request_text: request.text,
          source_message_type: request.source_message_type, source: request.source, command_id: stableCommandId,
          evidence_ref: refs[0].ref, evidence_hash: refs[0].hash } });
      }
    }
    return pending;
  }

  async function reprocessUnresolved(eventId){
    const cp=checkpoint(store,owner,`feedback-event:${tuple(owner,appRef,chatRef,eventId)}`);
    let original;try{original=verifiedFile(root,JSON.parse(cp?.succeeded_refs_json??'[]')[0]);}catch{}
    if(!original||original.event_id!==eventId||original.app_ref!==appRef||original.chat_ref!==chatRef||original.owner!==owner)return {status:'save_failed',reason:'original_event_unverifiable'};
    if(original.response?.status!=='clarification_required'||!['invalid','feedback'].includes(original.parsed?.kind))return {status:'duplicate',reason:'original_event_not_unresolved'};
    // 路径配置修复后，只恢复有真实平台来源、现在能唯一关联的原评价。
    if(original.parsed.kind==='feedback'&&resolveSelector(store,root,owner,original.parsed.selector,original.parent_id,chatRef).state!=='matched')return {status:'clarification_required'};
    // 新的解析修订关联原事件；原澄清记录不可变，已保存业务不进入重解析。
    return applyFeedback({...original,event_id:`reparse-v2:${hash(eventId)}`,sender_ref:senderRef,recovery_of_event_id:eventId,source:'stored_platform_event_reparse',source_evidence_ref:JSON.parse(cp.succeeded_refs_json)[0].ref});
  }
  return { applyFeedback, sendReceipt, reconcileReceipt, queryFeedback, pendingRequests, reprocessUnresolved };
}
