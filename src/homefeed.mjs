import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PLATFORM = 'xiaohongshu';
const LIMIT = 200;
const TARGETS = Object.freeze({ daily_follow: 20, manual_follow: 10, additional_follow: 3, explore: 3 });
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

function extractHomefeedPage({ maxItems, seenIds }) {
  const seen = new Set(seenIds.map(value => value.toLowerCase()));
  const observations = [];
  for (const section of document.querySelectorAll('section.note-item')) {
    const links = [...section.querySelectorAll('a[href*="/explore/"]')]
      .map(anchor => new URL(anchor.getAttribute('href'), location.origin));
    const contentId = links.map(link => link.pathname.split('/').at(-1)).find(value => /^[a-f\d]{24}$/i.test(value));
    if (!contentId || seen.has(contentId.toLowerCase())) continue;
    const source = links.find(link => link.pathname.split('/').at(-1)?.toLowerCase() === contentId.toLowerCase() && link.searchParams.has('xsec_token'));
    if (!source || observations.length >= maxItems) continue;
    observations.push({ content_id: contentId, complete_source_url: source.href,
      author_name: section.querySelector('a.author')?.textContent?.trim() || undefined,
      media_kind: section.querySelector('video') ? 'video' : 'unknown' });
    seen.add(contentId.toLowerCase());
  }
  const body = document.body?.innerText ?? '';
  const loginOverlay = document.querySelector('[class*="login-container"],[class*="login-modal"],[class*="login-dialog"],[role="dialog"]');
  const overlayText = loginOverlay?.innerText ?? '';
  let pageState = 'ready';
  if (/^\/login(?:\/|$)/.test(location.pathname) || /扫码登录|登录后查看|登录后继续|手机号登录|设备登录超限|重新登录/.test(overlayText)) pageState = 'login_required';
  else if (/验证码|安全验证|人机验证/.test(body)) pageState = 'captcha';
  else if (/访问过于频繁|操作频繁|稍后再试/.test(body)) pageState = 'rate_limited';
  else if (document.readyState !== 'complete' || !document.querySelector('section.note-item')) pageState = 'loading';
  return { source_page: location.href, observations: pageState === 'ready' ? observations : [], anchor_id: observations.at(-1)?.content_id ?? null, page_state: pageState };
}

export function createHomefeed({ store, root, owner, coordination = null, now = () => new Date().toISOString(), uuid = randomUUID, candidateLimit = LIMIT }) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('writable store is required');
  if (!root || !owner) throw new TypeError('private root and owner are required');
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1) throw new TypeError('candidateLimit must be a positive safe integer');
  coordination = coordination ? Object.freeze({ ...coordination }) : null;
  const privateRoot = resolve(root);
  const at = () => iso(now());

  function assertCoordinator(batchId = coordination?.batchId) {
    if (coordination && (coordination.owner !== owner || coordination.batchId !== batchId)) throw new Error('homefeed coordinator owner or batch mismatch');
    store.assertCoordinator(coordination, { now: at() });
  }

  function businessDay() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
  }

  function loadSnapshot(batchId) {
    const row = store.db.prepare("SELECT * FROM checkpoint WHERE owner=? AND delivery_batch_id=? AND stage=? ORDER BY rowid DESC LIMIT 1")
      .get(owner, batchId, `homefeed:${batchId}`);
    if (!row) return { observed_ids: [], no_new_advances: 0, anchor_id: null, stop_reason: null, page_keys: [] };
    const refs = JSON.parse(row.succeeded_refs_json);
    const ref = refs.at(-1);
    if (!ref) throw new Error('homefeed checkpoint has no snapshot reference');
    const snapshotPath = ref.startsWith('file:') ? ref.slice(5) : ref;
    const raw = readFileSync(snapshotPath, 'utf8');
    if (hash(raw) !== row.output_hash) throw new Error('homefeed checkpoint snapshot hash mismatch');
    return JSON.parse(raw);
  }

  async function persistPage(batchId, token, page, pageKey, addedIds, maxItems = candidateLimit, metadata = {}) {
    const previous = await loadSnapshot(batchId);
    const seen = new Set(previous.observed_ids);
    const existingIds = new Set(store.db.prepare('SELECT co.source_content_id FROM candidate c JOIN content co USING(content_id) WHERE c.discovery_batch_id=?').all(batchId).map(row => row.source_content_id));
    const remaining = Math.min(Math.max(0, candidateLimit - existingIds.size), maxItems);
    const acceptedIds = [];
    for (const id of addedIds) if (!existingIds.has(id) && acceptedIds.length < remaining && !acceptedIds.includes(id)) acceptedIds.push(id);
    for (const id of acceptedIds) seen.add(id);
    const duplicatePage = previous.page_keys.includes(pageKey);
    const ready = page.page_state === 'ready';
    const noNew = !ready ? previous.no_new_advances
      : acceptedIds.length > 0 ? 0
        : page.advanced === true && !duplicatePage ? previous.no_new_advances + 1 : previous.no_new_advances;
    // 调用方明确扩大预算时，仅解除旧预算停止；平台结束和停滞原因继续保留。
    const priorStop = previous.stop_reason === 'unique_limit' && seen.size < candidateLimit ? null : previous.stop_reason;
    const stopReason = priorStop ?? (page.ended === true ? 'page_ended'
      : seen.size >= candidateLimit ? 'unique_limit' : noNew >= 3 ? 'three_no_new_advances' : null);
    const snapshot = {
      observed_ids: [...seen], no_new_advances: noNew, anchor_id: page.anchor_id ?? previous.anchor_id,
      stop_reason: stopReason, refresh_state: metadata.refreshState ?? previous.refresh_state,
      page_keys: duplicatePage || metadata.marker ? previous.page_keys : [...previous.page_keys, pageKey],
      coverage: { page_state: page.page_state, pages: (previous.coverage?.pages ?? 0) + (duplicatePage || metadata.marker ? 0 : 1), failures: (previous.coverage?.failures ?? 0) + (ready || metadata.marker ? 0 : 1) },
    };
    const ref = resolve(privateRoot, 'homefeed', batchId, `${hash(pageKey)}.json`);
    const snapshotRef = resolve(privateRoot, 'homefeed', batchId, `state-${uuid()}.json`);
    const raw = `${JSON.stringify(snapshot)}\n`;
    const pageReceipt = `${JSON.stringify(page)}\n`;
    const pageReceiptHash = hash(pageReceipt);
    const rawRef = `file:${ref}`;
    await mkdir(dirname(ref), { recursive: true });
    await writeFile(ref, pageReceipt, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    try {
      assertCoordinator(batchId);
    } catch (error) {
      if (!/coordinator/i.test(error.message) || !coordination || coordination.owner !== owner || coordination.batchId !== batchId) throw error;
      store.assertCoordinator(coordination, { accountingOnly: true });
      store.transaction(() => {
        store.assertCoordinator(coordination, { accountingOnly: true });
        store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
          VALUES(?,?,?,?,?,?,'[]',?,'[]','[]',?,?,1,?)`).run(uuid(), owner, token.runId, token.generation,
          batchId, `homefeed-late:${batchId}`, JSON.stringify([rawRef]), hash(JSON.stringify(page)), pageReceiptHash, at());
      });
      throw error;
    }
    await writeFile(snapshotRef, raw, { flag: 'wx' });
    const rawHash = hash(raw);
    const current = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    if (current.owner !== owner || current.run_id !== token.runId || current.generation !== token.generation || current.state !== 'running' || current.stop_requested) throw new Error('homefeed execution slot is no longer owned');
    store.transaction(() => {
      assertCoordinator(batchId);
      const batch = store.db.prepare('SELECT status FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId, owner);
      if (!batch || batch.status === 'closed_day') throw new Error('batch is missing or closed for a new business day');
      for (const observation of page.observations.filter(item => existingIds.has(item.content_id.toLowerCase()) || acceptedIds.includes(item.content_id.toLowerCase()))) {
        if (!validId(observation.content_id)) throw new TypeError('observation content_id must be a 24-hex platform ID');
        let parsed;
        try { parsed = new URL(observation.complete_source_url); } catch { throw new TypeError('complete_source_url must be a valid URL'); }
        const match = parsed.pathname.match(/^\/explore\/([a-f\d]{24})$/i);
        if (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(parsed.hostname.toLowerCase()) || !match || match[1].toLowerCase() !== observation.content_id.toLowerCase()) throw new TypeError('complete_source_url must identify this homefeed post');
        store.db.prepare(`INSERT INTO content(content_id,platform,source_content_id,source_url_ref,author_id,author_name,source_state,last_observed_at,created_at)
          VALUES(?,?,?,?,? ,?,'available',?,?) ON CONFLICT(platform,source_content_id) DO UPDATE SET author_id=coalesce(excluded.author_id,content.author_id), author_name=coalesce(excluded.author_name,content.author_name), last_observed_at=excluded.last_observed_at`).run(
          uuid(), PLATFORM, observation.content_id.toLowerCase(), rawRef, observation.author_id ?? null, observation.author_name ?? null, page.observed_at, at());
        const content = store.db.prepare('SELECT content_id FROM content WHERE platform=? AND source_content_id=?').get(PLATFORM, observation.content_id.toLowerCase());
        store.db.prepare(`INSERT INTO candidate(candidate_id,content_id,discovery_batch_id,source,discovered_at,source_evidence_ref,cursor_ref,eligibility_state)
          VALUES(?,?,?,'homefeed',?,?,?,'unknown') ON CONFLICT(discovery_batch_id,content_id) DO NOTHING`).run(uuid(), content.content_id, batchId, page.observed_at, rawRef, null);
      }
      const count = store.db.prepare('SELECT count(*) n FROM candidate c JOIN batch b ON b.delivery_batch_id=c.discovery_batch_id WHERE b.owner=? AND c.discovery_batch_id=?').get(owner, batchId).n;
      if (count > candidateLimit) throw new Error('homefeed unique candidate budget exceeded');
      store.db.prepare(`INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,delivery_batch_id,stage,pending_ids_json,succeeded_refs_json,failed_refs_json,unknown_refs_json,input_hash,output_hash,stop_requested,committed_at)
        VALUES(?,?,?,?,?,?, '[]', ?, ?, '[]', ?, ?, 0, ?)`)
        .run(uuid(), owner, current.run_id, current.generation, batchId, `homefeed:${batchId}`, JSON.stringify([rawRef, `file:${snapshotRef}`]),
          ready ? '[]' : JSON.stringify([rawRef]), hash(JSON.stringify(page)), rawHash, at());
    });
    return { ...state(batchId), evidence_refs: [rawRef, `file:${snapshotRef}`] };
  }

  function claim(batchId) {
    assertCoordinator(batchId);
    const current = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    if (current.owner !== null || current.run_id !== null || !['idle', 'stopped'].includes(current.state) || current.stop_requested) throw new Error('execution slot is active; homefeed will not take it over');
    const runId = uuid();
    const result = store.casSlot({ owner, runId, generation: current.generation + 1, batchId, coordination, stopRequested: false,
      expectedOwner: null, expectedRunId: null, expectedGeneration: current.generation, expectedStopRequested: false,
      expectedState: current.state, expectedRevision: current.revision, nextState: 'running', updatedAt: at() });
    if (result.status !== 'succeeded') throw new Error('homefeed execution slot claim was rejected');
    const runDir = resolve(privateRoot, 'runs');
    mkdirSync(runDir, { recursive: true });
    try {
      writeFileSync(resolve(runDir, `${runId}.json`), `${JSON.stringify({ pid: process.pid, batchId, owner, generation: current.generation + 1, started_at: at(), state: 'running' })}\n`, { flag: 'wx' });
    } catch (error) {
      store.casSlot({ owner: null, runId: null, generation: current.generation + 1, stopRequested: false,
        expectedOwner: owner, expectedRunId: runId, expectedGeneration: current.generation + 1, expectedStopRequested: false,
        expectedState: 'running', expectedRevision: current.revision + 1, nextState: 'stopped', updatedAt: at() });
      throw error;
    }
    return { runId, generation: current.generation + 1 };
  }

  function release(token) {
    const current = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    if (current.owner !== owner || current.run_id !== token.runId || current.generation !== token.generation) return;
    store.casSlot({ owner: null, runId: null, generation: current.generation, stopRequested: false,
      expectedOwner: owner, expectedRunId: token.runId, expectedGeneration: token.generation, expectedStopRequested: Boolean(current.stop_requested),
      expectedState: current.state, expectedRevision: current.revision, nextState: 'stopped', updatedAt: at() });
    const runPath = resolve(privateRoot, 'runs', `${token.runId}.json`);
    try {
      const run = JSON.parse(readFileSync(runPath, 'utf8'));
      writeFileSync(runPath, `${JSON.stringify({ ...run, state: 'stopped', stopped_at: at() })}\n`);
    } catch { /* DB槽释放成功时，证据文件更新失败不回滚状态。 */ }
  }

  function recover({ confirmedStoppedRunId, evidenceRef } = {}) {
    if (!confirmedStoppedRunId || !evidenceRef) throw new TypeError('confirmedStoppedRunId and evidenceRef are required');
    const runPath = resolve(privateRoot, 'runs', `${confirmedStoppedRunId}.json`);
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    const current = store.db.prepare("SELECT * FROM execution_slot WHERE slot_key='main'").get();
    if (run.owner !== owner || run.pid === process.pid || run.state !== 'running' || current.owner !== owner
      || current.run_id !== confirmedStoppedRunId || current.generation !== run.generation || current.batch_id !== run.batchId) {
      throw new Error('homefeed recovery metadata does not match the active slot');
    }
    try { process.kill(run.pid, 0); throw new Error('homefeed run process is still alive or its exit is unknown'); }
    catch (error) { if (error.message.includes('still alive or its exit')) throw error; if (error.code !== 'ESRCH') throw new Error('homefeed run process exit could not be confirmed'); }
    const result = store.casSlot({ owner: null, runId: null, generation: current.generation, stopRequested: false,
      expectedOwner: owner, expectedRunId: confirmedStoppedRunId, expectedGeneration: current.generation,
      expectedStopRequested: Boolean(current.stop_requested), expectedState: current.state,
      expectedRevision: current.revision, nextState: 'stopped', updatedAt: at() });
    if (result.status !== 'succeeded') throw new Error('homefeed recovery lost the execution slot');
    writeFileSync(runPath, `${JSON.stringify({ ...run, state: 'recovered', recovered_at: at(), recovery_evidence_ref: evidenceRef })}\n`);
    return { status: 'recovered', run_id: confirmedStoppedRunId, evidence_refs: [evidenceRef, `file:${runPath}`] };
  }

  function beginBatch(options = {}) {
    const { kind, commandId, explicitRequest } = options;
    const target=options.target??TARGETS[kind];
    if(options.target!==undefined&&!((kind==='daily_follow'&&[10,20].includes(target))||(kind==='manual_follow'&&target===10)))throw new TypeError('invalid recommendation target');
    if (!Object.hasOwn(TARGETS, kind)) throw new TypeError('kind must be daily_follow, manual_follow, additional_follow or explore');
    if (kind !== 'daily_follow' && (explicitRequest !== true || !commandId)) throw new TypeError('explicitRequest and commandId are required for explore/additional_follow');
    const batchResult = batch => ({ batch_id: batch.delivery_batch_id, kind: batch.kind, target: batch.target, business_day: batch.business_day, status: batch.status });
    const existingCommand = () => {
      const existing = store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId);
      if (!existing) return null;
      if (existing.kind !== kind) throw new Error('commandId is already bound to a different batch kind');
      return batchResult(existing);
    };
    if (kind !== 'daily_follow') {
      const existing = existingCommand();
      if (existing) return existing;
    }
    // 独立主动批已撤销；仅保留上方历史command原批查询，不创建新批。
    if (kind === 'manual_follow') throw new Error('manual recommendations disabled');
    const day = businessDay();
    const prior = store.db.prepare("SELECT * FROM batch WHERE owner=? AND kind='daily_follow' AND status<>'closed_day' ORDER BY created_at DESC LIMIT 1").get(owner);
    if (kind === 'daily_follow' && prior?.business_day === day) {
      if(options.target!==undefined&&prior.target!==target)throw Error('existing daily batch target differs; preserve historical batch');
      return { batch_id: prior.delivery_batch_id, kind, target: prior.target, business_day: day, status: prior.status };
    }
    const batchId = uuid();
    const batch = store.transaction(() => {
      if (kind !== 'daily_follow') {
        const duplicate = existingCommand();
        if (duplicate) return store.db.prepare('SELECT * FROM batch WHERE owner=? AND command_id=?').get(owner, commandId);
      }
      if (kind === 'daily_follow' && prior && prior.business_day !== day) {
        store.db.prepare("UPDATE batch SET status='closed_day',revision=revision+1,updated_at=? WHERE delivery_batch_id=? AND status<>'closed_day'").run(at(), prior.delivery_batch_id);
        store.db.prepare("UPDATE candidate SET eligibility_state='hold' WHERE discovery_batch_id=?").run(prior.delivery_batch_id);
      }
      store.db.prepare(`INSERT INTO batch(delivery_batch_id,owner,command_id,kind,business_day,target,created_at,status,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?)`).run(batchId, owner, commandId ?? null, kind, day, target, at(), at());
      return store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=?').get(batchId);
    });
    return batchResult(batch);
  }

  function state(batchId) {
    const batch = store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId, owner);
    if (!batch) return null;
    const checkpoint = store.db.prepare("SELECT output_hash,succeeded_refs_json FROM checkpoint WHERE owner=? AND delivery_batch_id=? AND stage=? ORDER BY rowid DESC LIMIT 1").get(owner, batchId, `homefeed:${batchId}`);
    const refs = checkpoint ? JSON.parse(checkpoint.succeeded_refs_json) : [];
    const found = store.db.prepare('SELECT co.source_content_id FROM candidate c JOIN content co USING(content_id) WHERE c.discovery_batch_id=? ORDER BY c.discovered_at,c.candidate_id').all(batchId).map(row => row.source_content_id);
    const snapshotRef = refs.at(-1)?.replace(/^file:/, '');
    const snapshotRaw = snapshotRef ? readFileSync(snapshotRef, 'utf8') : null;
    if (snapshotRaw && hash(snapshotRaw) !== checkpoint.output_hash) throw new Error('homefeed checkpoint snapshot hash mismatch');
    const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : {};
    return { batch_id: batchId, status: batch.status, observed_ids: found, unique_count: found.length,
      no_new_advances: snapshot.no_new_advances ?? 0, anchor_id: snapshot.anchor_id ?? null, stop_reason: snapshot.stop_reason ?? null,
      refresh_state: snapshot.refresh_state ?? null,
      coverage: { expected: batch.target, discovered: found.length, ...(snapshot.coverage ?? {}) }, evidence_refs: refs, checkpoint_hash: checkpoint?.output_hash ?? null };
  }

  async function recordPage(batchId, page) {
    validatePage(page);
    const token = claim(batchId);
    try { return await persistPage(batchId, token, page, hash(JSON.stringify({ page: page.source_page, anchor: page.anchor_id, ids: page.observations.map(item => item.content_id), advanced: page.advanced, observed_at: page.observed_at })), page.page_state === 'ready' ? [...new Set(page.observations.map(item => item.content_id.toLowerCase()))] : []); }
    finally { release(token); }
  }

  async function refreshHomefeed(batchId, tab, options = {}) {
    assertCoordinator(batchId);
    if (!tab || typeof tab !== 'object') throw new TypeError('caller-provided tab is required');
    const maxPages = Math.max(1, Math.min(10, Math.floor(options.maxPages ?? 1)));
    const maxItems = Math.max(1, Math.min(candidateLimit, Math.floor(options.maxItems ?? candidateLimit)));
    const token = claim(batchId);
    const evidence = [];
    try {
      const pageApi = tab.playwright ?? tab.page ?? tab;
      const reload = pageApi.reload?.bind(pageApi);
      const evaluate = pageApi.evaluate?.bind(pageApi);
      if (!reload || !evaluate) throw new TypeError('tab must provide supported reload() and evaluate() methods');
      let existing = await loadSnapshot(batchId);
      if (!existing.refresh_state || existing.refresh_state === 'failed') {
        assertCoordinator(batchId);
        await saveRefreshMarker(batchId, token, 'pending');
        try { assertCoordinator(batchId); await reload(); assertCoordinator(batchId); } catch (error) { if (/coordinator/i.test(error.message)) throw error; await saveFailure(batchId, token, existing, 'reload_failed', evidence); return { ...state(batchId), evidence_refs: evidence }; }
        await saveRefreshMarker(batchId, token, 'succeeded');
        existing = await loadSnapshot(batchId);
      } else if (existing.refresh_state === 'pending') {
        await saveFailure(batchId, token, existing, 'refresh_interrupted_unknown', evidence);
        return { ...state(batchId), evidence_refs: evidence };
      }
      let addedThisCall = 0;
      for (let index = 0; index < maxPages; index++) {
        const before = await loadSnapshot(batchId);
        const remainingCall = Math.min(maxItems - addedThisCall, candidateLimit - before.observed_ids.length);
        if (before.stop_reason || remainingCall <= 0) break;
        const shouldAdvance = options.advance === true && Boolean(before.anchor_id);
        if (shouldAdvance) {
          try {
            assertCoordinator(batchId);
            if (tab.playwright?.locator) await tab.playwright.locator('body').first().press('PageDown');
            else if (typeof pageApi.press === 'function') await pageApi.press('body', 'PageDown');
            else throw new TypeError('tab does not expose a supported PageDown operation');
          } catch (error) {
            if (/coordinator/i.test(error.message)) throw error;
            await saveFailure(batchId, token, before, 'advance_failed', evidence); break;
          }
        }
        let dom;
        try { assertCoordinator(batchId); dom = await evaluate(extractHomefeedPage, { maxItems: remainingCall, seenIds: before.observed_ids }); } catch (error) {
          if (/coordinator/i.test(error.message)) throw error;
          await saveFailure(batchId, token, before, 'read_failed', evidence, tab);
          break;
        }
        const page = { ...dom, observations: dom.page_state === 'ready' ? dom.observations : [], observed_at: at(), advanced: shouldAdvance, read_method: tab.playwright ? 'playwright.evaluate' : 'ego.page.evaluate' };
        validatePage(page);
        const result = await persistPage(batchId, token, page, hash(JSON.stringify({ page: page.source_page, anchor: page.anchor_id, ids: page.observations.map(item => item.content_id), advanced: page.advanced, observed_at: page.observed_at })), [...new Set(page.observations.map(item => item.content_id.toLowerCase()))], remainingCall);
        addedThisCall += Math.max(0, result.unique_count - before.observed_ids.length);
        evidence.push(...result.evidence_refs);
      }
      return { ...state(batchId), evidence_refs: [...new Set(evidence)] };
    } finally { release(token); }
  }

  function validatePage(page) {
    if (!page || !page.source_page || !page.observed_at || !page.page_state || !Array.isArray(page.observations) || typeof page.advanced !== 'boolean' || !page.read_method) throw new TypeError('invalid homefeed page');
    const source = new URL(page.source_page);
    const path = source.pathname.replace(/\/$/, '') || '/';
    if (page.page_state === 'ready' && (!['xiaohongshu.com', 'www.xiaohongshu.com'].includes(source.hostname.toLowerCase()) || !['/explore', '/'].includes(path))) throw new TypeError('source_page must be the homefeed explore page');
    if (page.page_state !== 'ready' && page.observations.length) throw new TypeError('failed page cannot contain observations');
    if (page.page_state === 'ready') for (const item of page.observations) {
      const link = new URL(item.complete_source_url);
      if (!link.searchParams.has('xsec_token')) throw new TypeError('complete_source_url must include xsec_token');
    }
  }

  async function saveFailure(batchId, token, prior, reason, refs, tab) {
    const page = { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at(), page_state: reason, observations: [], anchor_id: prior.anchor_id, advanced: false, read_method: tab?.playwright ? 'playwright.evaluate' : 'ego.page.evaluate', failure: reason };
    const result = await persistPage(batchId, token, page, hash(`${reason}:${page.observed_at}`), [], candidateLimit,
      { refreshState: reason === 'reload_failed' ? 'failed' : undefined });
    refs.push(...result.evidence_refs);
  }

  async function saveRefreshMarker(batchId, token, refreshState) {
    const previous = await loadSnapshot(batchId);
    const page = { source_page: 'https://www.xiaohongshu.com/explore', observed_at: at(), page_state: `refresh_${refreshState}`, observations: [], anchor_id: previous.anchor_id, advanced: false, read_method: 'caller-tab.reload' };
    await persistPage(batchId, token, page, hash(`refresh:${refreshState}:${page.observed_at}`), [], candidateLimit, { refreshState, marker: true });
  }

  function getBatch(batchId) { return store.db.prepare('SELECT * FROM batch WHERE delivery_batch_id=? AND owner=?').get(batchId, owner) ?? null; }
  return { beginBatch, getBatch, state, recordPage, refreshHomefeed, recover };
}
