import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => digest(JSON.stringify(value));
const SAFE_REJECTION_CODES = new Set([230001]);
const MESSAGE_CREATE_ERROR_DOC = 'https://open.feishu.cn/document/server-docs/im-v1/message/create';

function responseCode(response) {
  return Number.isInteger(response?.code) ? response.code : null;
}

function responseMessageId(response) {
  return response?.data?.message_id ?? response?.data?.message?.message_id ?? null;
}

function parseContent(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  // 官方post实际回读会补空style；仅去掉这个无格式含义的缺省字段。
  return Object.fromEntries(Object.keys(value).sort().filter(key => !(key === 'style' && Array.isArray(value[key]) && value[key].length === 0)).map(key => [key, stable(value[key])]));
}

function normalizedContent(msgType, content, referenceContent) {
  const parsed = parseContent(content);
  if (msgType === 'post') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const localized = parsed.zh_cn ?? Object.values(parsed).find(value => value && typeof value === 'object' && !Array.isArray(value));
    const post = localized && typeof localized === 'object' ? localized : parsed;
    if (typeof post.title !== 'string' || !Array.isArray(post.content)) return null;
    const reference=parseContent(referenceContent),referencePost=reference?.zh_cn??reference;
    // 平台给图片补实际尺寸；原请求明确指定的尺寸仍必须逐项核对。
    if(referencePost?.content)post.content.forEach((row,r)=>{
      const cells=Array.isArray(row)?row:[row],refRow=referencePost.content[r],refCells=Array.isArray(refRow)?refRow:[refRow];
      cells.forEach((cell,c)=>{const ref=refCells[c];if(cell?.tag!=='img'||ref?.tag!=='img')return;
        for(const key of ['width','height'])if(!Object.hasOwn(ref,key)&&typeof cell[key]==='number'&&cell[key]>0)delete cell[key];
      });
      // 平台将纯文字中的URL拆成链接；仅容许无样式、文字与目标完全相同的自动链接。
      const plain=cell=>!cell.style||Array.isArray(cell.style)&&cell.style.length===0;
      // 平台也会给无协议域名和邮箱加链接；只接受显示文字与目标逐字相同。
      const sameTextLink=cell=>cell.tag==='a'&&cell.text===cell.href&&(/^https?:\/\//.test(cell.href)
        ||/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(cell.href)
        ||/^[a-z\d_%+-]+(?:\.[a-z\d_%+-]+)*@(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(cell.href));
      if(refCells.length===1&&refCells[0]?.tag==='text'&&plain(refCells[0])&&cells.every(cell=>plain(cell)
        &&Object.keys(cell).every(k=>['tag','text','href','style'].includes(k))
        &&(cell.tag==='text'||sameTextLink(cell)))){
        const merged={tag:'text',text:cells.map(cell=>cell.text).join('')};
        post.content[r]=Array.isArray(refRow)?[merged]:merged;
      }
    });
    return JSON.stringify(stable({ title: post.title, content: post.content }));
  }
  if (msgType === 'text') {
    const text = parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? parsed.text : parsed;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

function messageShape(message) {
  if (!message || typeof message !== 'object') return null;
  const body = message.body?.content ?? message.content;
  return {
    message_id: message.message_id ?? message.id ?? null,
    chat_id: message.chat_id ?? null,
    msg_type: message.msg_type ?? message.message_type ?? null,
    content: body,
    create_time: message.create_time ?? null,
    sender: message.sender ?? null,
  };
}

function seconds(value) {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
  const time = typeof value === 'number' ? value : numeric ?? Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return String(Math.floor(time > 10_000_000_000 ? time / 1000 : time));
}

function matchesIdentity(title, query, expectedTitle) {
  const stableId = query.recommendation_id ?? query.uuid;
  if (stableId) return title.includes(`[${stableId}]`);
  if (Number.isInteger(query.ordinal) && query.ordinal > 0) {
    const ordinal = String(query.ordinal).padStart(2, '0');
    return title === expectedTitle && new RegExp(`\\/ ${ordinal} \\[`).test(title);
  }
  return false;
}

function sentByApp(message, appRef) {
  const sender = message?.sender;
  return sender?.sender_type === 'app' && (sender.app_id ?? sender.id ?? message.app_id) === appRef;
}

export function createFeishuTransport({ client, targetRef, appRef, root, now = () => new Date().toISOString() }) {
  if (!client?.im?.message || !targetRef || !appRef || !root) {
    throw new TypeError('client.im.message, targetRef, appRef and private root are required');
  }
  const privateRoot = resolve(root);

  async function saveEvidence(kind, value) {
    const file = resolve(privateRoot, 'feishu', `${kind}-${randomUUID()}.json`);
    if (!file.startsWith(`${resolve(privateRoot)}\\`) && !file.startsWith(`${resolve(privateRoot)}/`)) throw new Error('evidence path escaped private root');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return `feishu-${kind}:${relative(privateRoot, file).replaceAll('\\', '/')}`;
  }

  async function send(request) {
    if (typeof client.im.message.create !== 'function') return { status: 'unknown', reason: 'create_api_unavailable' };
    if (!request || request.receive_id !== targetRef || !['post', 'text'].includes(request.msg_type) || typeof request.content !== 'string') {
      return { status: 'unknown', reason: 'request_binding_invalid' };
    }
    let response;
    try {
      // UUID沿用官方一小时幂等窗口；本函数只调用一次，不把窗口扩展为长期防重保证。
      response = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: request });
    } catch (error) {
      const body = error?.response?.data;
      const code = responseCode(body);
      if (code !== null) {
        let evidence;
        try {
          evidence = await saveEvidence('receipt', {
            observed_at: new Date(now()).toISOString(), app_ref: appRef, target_ref: targetRef,
            request_hash: hashJson(request), request, http_status: error?.response?.status ?? null,
            response: body, official_error_evidence_url: MESSAGE_CREATE_ERROR_DOC,
          });
        } catch {
          return { status: 'unknown', reason: 'receipt_persist_failed' };
        }
        if (SAFE_REJECTION_CODES.has(code) && !responseMessageId(body)) return { status: 'failed', reason: 'platform_rejected', evidence: [evidence] };
        return { status: 'unknown', reason: 'platform_call_uncertain', evidence: [evidence] };
      }
      return { status: 'unknown', reason: 'platform_call_uncertain' };
    }
    const messageId = responseMessageId(response);
    let evidence;
    try {
      evidence = await saveEvidence('receipt', {
        observed_at: new Date(now()).toISOString(), app_ref: appRef, target_ref: targetRef,
        request_hash: hashJson(request), request, response, official_error_evidence_url: MESSAGE_CREATE_ERROR_DOC,
      });
    } catch {
      return { status: 'unknown', reason: 'receipt_persist_failed' };
    }
    if (responseCode(response) === 0 && typeof messageId === 'string' && messageId) return { status: 'succeeded', message_id: messageId, evidence: [evidence] };
    if (SAFE_REJECTION_CODES.has(responseCode(response)) && !messageId) return { status: 'failed', reason: 'platform_rejected', evidence: [evidence] };
    return { status: 'unknown', reason: responseCode(response) === 0 ? 'message_id_missing' : 'platform_response_uncertain', evidence: [evidence] };
  }

  async function lookup(query = {}) {
    if (query.target_ref && query.target_ref !== targetRef) return { status: 'unknown', reason: 'target_binding_mismatch' };
    if (query.message_id) return lookupExact(query);
    return lookupByList(query);
  }

  async function lookupExact(query) {
    let response;
    try { response = await client.im.message.get({ path: { message_id: query.message_id } }); }
    catch { return { status: 'unknown', reason: 'exact_lookup_uncertain' }; }
    const items = response?.data?.items;
    const message = Array.isArray(items) && items.length === 1 ? messageShape(items[0]) : null;
    let evidence;
    try { evidence = await saveEvidence('query', { observed_at: new Date(now()).toISOString(), app_ref: appRef, query: { message_id: query.message_id, target_ref: query.target_ref ?? targetRef }, response }); }
    catch { return { status: 'unknown', reason: 'query_evidence_persist_failed' }; }
    if (responseCode(response) !== 0 || !message || message.message_id !== query.message_id || message.chat_id !== targetRef || (query.target_ref && message.chat_id !== query.target_ref) || !sentByApp(message, appRef)) {
      return { status: 'unknown', reason: 'exact_message_binding_unverified', evidence: [evidence] };
    }
    const expected = query.payload;
    if (!expected || message.msg_type !== expected.msg_type || normalizedContent(message.msg_type, message.content,expected.content) === null || normalizedContent(expected.msg_type, expected.content) !== normalizedContent(message.msg_type, message.content,expected.content)) {
      return { status: 'unknown', reason: 'exact_message_payload_unverified', evidence: [evidence] };
    }
    return { status: 'succeeded', message_id: message.message_id, evidence: [evidence] };
  }

  async function lookupByList(query) {
    const expected = query.payload;
    const target = query.target_ref ?? targetRef;
    const startTime = seconds(query.started_at);
    const endTime = seconds(query.ended_at);
    const expectedContent = expected && normalizedContent(expected.msg_type, expected.content);
    const outboxId = typeof query.outbox_id === 'string' && query.outbox_id.trim() ? query.outbox_id : null;
    const isPost = expected?.msg_type === 'post';
    const isReceiptText = expected?.msg_type === 'text' && outboxId && expectedContent?.split(outboxId).length === 2;
    if ((!isPost && !isReceiptText) || !expectedContent || !startTime || !endTime || isPost && !query.uuid && !query.recommendation_id && !Number.isInteger(query.ordinal) || query.payload_hash && query.payload_hash !== hashJson({ msg_type: expected.msg_type, content: expected.content })) {
      return { status: 'unknown', reason: 'list_lookup_scope_incomplete' };
    }
    let pageToken;
    const seenTokens = new Set();
    const matches = new Map();
    const seenMessages = new Map();
    const responses = [];
    const saveQueryEvidence = async () => {
      return saveEvidence('query', {
        observed_at: new Date(now()).toISOString(), app_ref: appRef,
        query: { target_ref: target, started_at: query.started_at, ended_at: query.ended_at, uuid: query.uuid ?? null, recommendation_id: query.recommendation_id ?? null, ordinal: query.ordinal ?? null, outbox_id: outboxId },
        responses,
      });
    };
    const incomplete = async reason => {
      try { return { status: 'unknown', reason, evidence: [await saveQueryEvidence()] }; }
      catch { return { status: 'unknown', reason: 'query_evidence_persist_failed' }; }
    };
    try {
      for (;;) {
        const params = {
          container_id_type: 'chat', container_id: target, page_size: 50,
          start_time: startTime, end_time: endTime, sort_type: 'ByCreateTimeAsc',
        };
        if (pageToken) params.page_token = pageToken;
        const response = await client.im.message.list({ params });
        responses.push(response);
        if (responseCode(response) !== 0 || !Array.isArray(response?.data?.items)) return incomplete('list_lookup_incomplete');
        for (const item of response.data.items) {
          const message = messageShape(item);
          if (!message || message.chat_id !== target || message.msg_type !== expected.msg_type || typeof message.message_id !== 'string' || !message.message_id || !sentByApp(message, appRef)) continue;
          const seen = seenMessages.get(message.message_id);
          if (seen && JSON.stringify(stable(seen)) !== JSON.stringify(stable(message))) return incomplete('list_message_changed_between_pages');
          seenMessages.set(message.message_id, message);
          const actualTime = seconds(message.create_time);
          if (!actualTime || Number(actualTime) < Number(startTime) || Number(actualTime) > Number(endTime)) continue;
          const actualContent = normalizedContent(message.msg_type, message.content,expected.content);
          if (actualContent !== expectedContent) continue;
          if (isReceiptText && actualContent.split(outboxId).length !== 2) continue;
          const actualPost = parseContent(message.content);
          const expectedPost = parseContent(expected.content);
          const title = message.msg_type === 'post' ? (actualPost?.title ?? actualPost?.zh_cn?.title ?? Object.values(actualPost ?? {}).find(value => value && typeof value === 'object')?.title) : '';
          const expectedTitle = message.msg_type === 'post' ? (expectedPost?.title ?? expectedPost?.zh_cn?.title ?? Object.values(expectedPost ?? {}).find(value => value && typeof value === 'object')?.title) : '';
          if (isReceiptText || matchesIdentity(title ?? '', query, expectedTitle ?? '')) matches.set(message.message_id, message);
        }
        if (response.data.has_more === false) break;
        if (response.data.has_more !== true) return incomplete('list_pagination_incomplete');
        const next = response.data.page_token;
        if (typeof next !== 'string' || !next || seenTokens.has(next)) return incomplete('list_pagination_incomplete');
        seenTokens.add(next);
        pageToken = next;
      }
    } catch {
      return incomplete('list_lookup_uncertain');
    }
    let evidence;
    try { evidence = await saveQueryEvidence(); }
    catch { return { status: 'unknown', reason: 'query_evidence_persist_failed' }; }
    if (matches.size !== 1) return { status: 'unknown', reason: matches.size ? 'list_match_ambiguous' : 'list_match_not_found', evidence: [evidence] };
    return { status: 'succeeded', message_id: matches.keys().next().value, evidence: [evidence] };
  }

  return { send, lookup };
}
