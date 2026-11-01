import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDelivery } from '../src/delivery.mjs';
import { createFeishuTransport } from '../src/feishu-adapter.mjs';
import { createDailyIntegrationFixture } from './helpers/integration-fixture.mjs';

const timestamp = '2026-10-26T03:15:00.000Z';

async function timeoutRecovery(t, lookupMode) {
  const fixture = await createDailyIntegrationFixture(t);
  const storedMessages = [];
  const adapterCalls = { sends: [], gets: [], lists: [], listResponses: [] };
  const messageId = `synthetic-accepted-${lookupMode}`;
  const client = { im: { message: {
    async create({ data }) {
      adapterCalls.sends.push({ receive_id: data.receive_id, msg_type: data.msg_type, uuid: data.uuid,
        content_hash: createHash('sha256').update(data.content).digest('hex') });
      storedMessages.push({ message_id: messageId, chat_id: data.receive_id, msg_type: data.msg_type,
        create_time: String(Math.floor(Date.parse(timestamp) / 1000)),
        sender: { sender_type: 'app', id_type: 'app_id', id: 'synthetic-app' },
        body: { content: data.content } });
      throw new Error('synthetic timeout after accepted send');
    },
    async get(input) {
      adapterCalls.gets.push(input);
      const found = storedMessages.filter(message => message.message_id === input.path.message_id);
      return { code: 0, data: { items: found } };
    },
    async list(input) {
      adapterCalls.lists.push(input);
      let response;
      if (lookupMode === 'http403') response = { code: 403, msg: 'synthetic forbidden' };
      else if (lookupMode === 'incomplete-pagination') response = { code: 0, data: { items: storedMessages, has_more: true } };
      else if (lookupMode === 'zero-match') response = { code: 0, data: { items: [], has_more: false } };
      else if (lookupMode === 'multi-match') response = { code: 0, data: {
        items: [...storedMessages, { ...storedMessages[0], message_id: `${messageId}-duplicate` }], has_more: false } };
      else if (adapterCalls.lists.length === 1) response = { code: 0, data: { items: [], has_more: true } };
      else response = { code: 0, data: { items: storedMessages, has_more: false } };
      adapterCalls.listResponses.push(response);
      return response;
    },
  } } };
  const transport = createFeishuTransport({ client, targetRef: 'synthetic-target', appRef: 'synthetic-app',
    root: `${fixture.root}/feishu`, now: () => timestamp });
  fixture.setTransport(transport);

  for (const table of ['candidate', 'decision', 'recommendation', 'delivery_attempt']) {
    assert.equal(fixture.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} must begin empty`);
  }
  const first = await fixture.run();
  const afterFirst = fixture.store.db.prepare(`SELECT a.*,r.state AS recommendation_state,r.decision_id,r.content_id
    FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)`).get();
  assert.ok(afterFirst, 'full entry must create an attempt before reconciliation');
  assert.equal(afterFirst.status, 'unknown', 'timeout must remain unknown before lookup recovery');

  const delivery = createDelivery({ store: fixture.store, root: fixture.runtime.delivery.root,
    owner: fixture.owner, targetRef: 'synthetic-target', appRef: 'synthetic-app', transport,
    now: fixture.now, currentVersions: fixture.runtime.delivery.currentVersions });
  const recoveries = [];
  for (let index = 0; index < 2; index++) {
    if (lookupMode === 'unique-match' && recoveries.at(-1)?.status === 'succeeded') break;
    recoveries.push(await delivery.reconcileDelivery(afterFirst.delivery_attempt_id));
  }
  const recovery = recoveries.at(-1);
  const finalAttempt = fixture.store.db.prepare(`SELECT a.*,r.state AS recommendation_state,r.decision_id,r.content_id
    FROM delivery_attempt a JOIN recommendation r USING(recommendation_id)`).get();
  const candidate = fixture.store.db.prepare('SELECT candidate_id FROM candidate WHERE content_id=?').get(finalAttempt.content_id);
  const listCalls = adapterCalls.lists.length;
  const sendCalls = adapterCalls.sends.length;
  assert.equal(sendCalls, 1, 'reconciliation must not repeat the send');
  assert.equal(listCalls, lookupMode === 'unique-match' ? 2 : 3,
    'the full entry and explicit reconciliations call the actual Feishu adapter');
  assert.equal(adapterCalls.gets.length, 0, 'unknown send has no exact message id; lookup must use complete list scope');
  assert.ok(finalAttempt.payload_hash);
  assert.ok(candidate?.candidate_id);
  if (lookupMode === 'unique-match') {
    assert.ok(recoveries.some(result => result.status === 'succeeded'));
    assert.equal(finalAttempt.status, 'succeeded');
    assert.equal(finalAttempt.recommendation_state, 'succeeded');
    assert.equal(finalAttempt.message_id, messageId);
  } else {
    assert.equal(finalAttempt.status, 'unknown');
    assert.ok(recoveries.every(result => result.status === 'unknown'));
  }

  const receiptAudit = [];
  const checkpoints = fixture.store.db.prepare('SELECT * FROM checkpoint WHERE stage=? ORDER BY rowid')
    .all(`delivery-attempt:${finalAttempt.delivery_attempt_id}`);
  for (const checkpoint of checkpoints) {
    for (const ref of JSON.parse(checkpoint.succeeded_refs_json)) {
      if (!ref.ref || !ref.hash) continue;
      const stateBytes = await readFile(ref.ref);
      assert.equal(createHash('sha256').update(stateBytes).digest('hex'), ref.hash);
      const state = JSON.parse(stateBytes);
      if (!state.receipt_ref) continue;
      const receiptBytes = await readFile(state.receipt_ref);
      assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), state.receipt_hash);
      const receipt = JSON.parse(receiptBytes);
      assert.equal(receipt.attempt_id, finalAttempt.delivery_attempt_id);
      assert.equal(receipt.recommendation_id, finalAttempt.recommendation_id);
      assert.equal(receipt.owner, fixture.owner);
      assert.equal(receipt.target_ref, 'synthetic-target');
      assert.equal(receipt.payload_hash, finalAttempt.payload_hash);
      const evidence = receipt.result.evidence_refs ?? receipt.result.evidence ?? [];
      const references = Array.isArray(evidence) ? evidence : [evidence];
      const evidenceFiles = [];
      for (const reference of references) {
        if (!/^feishu-(?:send|query):/.test(reference)) continue;
        const path = join(fixture.root, 'feishu', reference.slice(reference.indexOf(':') + 1));
        const bytes = await readFile(path);
        const body = JSON.parse(bytes);
        if (reference.startsWith('feishu-query:')) {
          assert.equal(body.app_ref, 'synthetic-app');
          assert.equal(body.query.target_ref, 'synthetic-target');
          assert.ok([body.query.uuid, body.query.recommendation_id].includes(finalAttempt.recommendation_id));
          assert.ok(Array.isArray(body.responses));
        }
        evidenceFiles.push({ reference, path, hash: createHash('sha256').update(bytes).digest('hex') });
      }
      receiptAudit.push({ checkpoint_id: checkpoint.checkpoint_id, receipt_ref: state.receipt_ref,
        receipt_hash: state.receipt_hash, status: receipt.result.status, evidence_files: evidenceFiles });
    }
  }
  assert.ok(receiptAudit.some(row => row.status === 'unknown'), '必须保留最初未知归账的落盘回执');
  const phaseQueries = fixture.store.db.prepare("SELECT checkpoint_id,succeeded_refs_json FROM checkpoint WHERE delivery_batch_id=? AND stage LIKE 'orchestration:phase:%'")
    .all(first.batch_id).flatMap(row => JSON.parse(row.succeeded_refs_json).flatMap(ref => {
      const phase = ref.orchestration_phase;
      return (phase?.evidence_refs ?? []).filter(value => value.startsWith('feishu-query:'))
        .map(reference => ({ reference, checkpoint_id: row.checkpoint_id, attempt_id: phase.result?.attempt_id }));
    }));
  assert.ok(phaseQueries.length > 0, '完整入口的未知查询证据必须在阶段checkpoint中落盘');
  for (const linked of phaseQueries) assert.equal(linked.attempt_id, finalAttempt.delivery_attempt_id);
  const queryReferences = new Set([...phaseQueries.map(row => row.reference),
    ...recoveries.flatMap(result => result.evidence_refs ?? []).filter(value => value.startsWith('feishu-query:'))]);
  const queryAudit = [];
  for (const reference of queryReferences) {
    const path = join(fixture.root, 'feishu', reference.slice(reference.indexOf(':') + 1));
    const bytes = await readFile(path);
    const body = JSON.parse(bytes);
    assert.equal(body.app_ref, 'synthetic-app');
    assert.equal(body.query.target_ref, 'synthetic-target');
    assert.ok([body.query.uuid, body.query.recommendation_id].includes(finalAttempt.recommendation_id));
    assert.ok(Array.isArray(body.responses));
    queryAudit.push({ reference, path, hash: createHash('sha256').update(bytes).digest('hex'),
      recommendation_id: finalAttempt.recommendation_id, attempt_id: finalAttempt.delivery_attempt_id,
      checkpoint_links: phaseQueries.filter(row => row.reference === reference) });
  }
  assert.ok(queryAudit.length > 0);

  const audit = fixture.auditRetained(first.batch_id);
  assert.deepEqual(audit.integrity.map(row => row.integrity_check), ['ok']);
  assert.deepEqual(audit.foreign_key_violations, []);
  assert.equal(audit.causal_business_rows, 1);
  assert.deepEqual(audit.bad_checkpoint_files, []);
  assert.equal(audit.homefeed_source_contains_candidate, true);
  await fixture.writeEvidence({ scenario: lookupMode,
    first: { status: first.status, batch_id: first.batch_id },
    reconciliation: recoveries,
    candidate_id: candidate.candidate_id, content_id: finalAttempt.content_id,
    decision_id: finalAttempt.decision_id, recommendation_id: finalAttempt.recommendation_id,
    attempt_id: finalAttempt.delivery_attempt_id, attempt_status: finalAttempt.status,
    payload_hash: finalAttempt.payload_hash, message_id: finalAttempt.message_id,
    adapter_calls: { send_count: sendCalls, list_count: listCalls, exact_get_count: adapterCalls.gets.length,
      send_request: adapterCalls.sends[0], list_params: adapterCalls.lists.map(call => call.params),
      list_responses: adapterCalls.listResponses },
    persistence_audit: audit, receipt_query_audit: receiptAudit, query_files_audit: queryAudit });
}

test('I04 full-entry timeout由真实Feishu adapter回读处理且不重发', async t => {
  await t.test('HTTP 403回读保持unknown', async subtest => timeoutRecovery(subtest, 'http403'));
  await t.test('不完整分页回读保持unknown', async subtest => timeoutRecovery(subtest, 'incomplete-pagination'));
  await t.test('唯一完整payload匹配回读成功且不重发', async subtest => timeoutRecovery(subtest, 'unique-match'));
  await t.test('完整分页零匹配仍unknown且不授权重发', async subtest => timeoutRecovery(subtest, 'zero-match'));
  await t.test('完整分页多匹配仍unknown且不任取一条', async subtest => timeoutRecovery(subtest, 'multi-match'));
});
