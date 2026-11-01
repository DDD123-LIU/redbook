import {createHash,randomUUID} from 'node:crypto';
const EVENT_NAME = 'im.message.receive_v1';

// 原事件验真与稳定command_id由feedback负责；这里只串行派发并持久化执行边界。
export function createRequestDispatcher({store,owner,feedback,execute,quotaProbe,now=()=>new Date().toISOString(),onResult=()=>{}}){
  if(!store?.db||!owner||typeof feedback?.pendingRequests!=='function'||typeof execute!=='function'||typeof quotaProbe!=='function')throw TypeError('store owner feedback execute quotaProbe required');
  let tail=Promise.resolve(),closed=false,haltedDay=null;
  const businessDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now()));
  const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const stage=command=>`request-dispatch:${digest(command)}`;
  function latest(command){const row=store.db.prepare('SELECT * FROM checkpoint WHERE owner=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(owner,stage(command));if(!row)return null;const data=JSON.parse(row.succeeded_refs_json)[0];if(row.output_hash!==digest(data))throw Error('request dispatch checkpoint damaged');return data;}
  function save(command,value){const data={...value,command_id:command,recorded_at:now()};store.db.prepare('INSERT INTO checkpoint(checkpoint_id,owner,run_id,generation,stage,succeeded_refs_json,output_hash,committed_at) VALUES(?,?,?,0,?,?,?,?)').run(randomUUID(),owner,`dispatch:${command}`,stage(command),JSON.stringify([data]),digest(data),data.recorded_at);return data;}
  function report(result){try{onResult(result);}catch{}return result;}
  async function run(request){
    if(haltedDay===businessDay())return report({status:'stopped',reason:'quota_halted'});
    const command=request?.provenance?.command_id,event=request?.event_id;
    if(request?.status!=='request_pending'||typeof command!=='string'||!command||!event||request.provenance.owner!==owner||request.provenance.event_id!==event)return report({status:'ignored',reason:'not_dispatchable_request'});
    const pending=await feedback.pendingRequests({commandId:command,eventId:event});
    const verified=pending.find(x=>x.status==='request_pending'&&x.event_id===event&&x.provenance?.owner===owner&&x.provenance?.command_id===command);
    if(!verified)return report({status:'ignored',reason:'request_not_verified'});
    const claimed=store.transaction(()=>{
      const old=latest(command);if(old)return {done:old.status==='executing'?save(command,{status:'unknown',event_id:event,reason:'prior_execution_not_resolved',prior:old}):old};
      const batch=store.db.prepare('SELECT delivery_batch_id,status FROM batch WHERE owner=? AND command_id=?').get(owner,command);
      if(batch)return {done:save(command,{status:'existing_batch',event_id:event,batch_id:batch.delivery_batch_id,batch_status:batch.status})};
      return {intent:save(command,{status:'executing',event_id:event,request:verified})};
    });
    if(claimed.done)return report(claimed.done);
    let quota;try{quota=await quotaProbe();}catch(error){quota={reliable:false,error:error.message};}
    if(quota?.reliable!==true||![quota.shortRemainingPercent,quota.weeklyRemainingPercent].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=100)||quota.shortRemainingPercent<4||quota.weeklyRemainingPercent<2){haltedDay=businessDay();return report(save(command,{status:'quota_blocked',event_id:event,quota:quota??null}));}
    let result;try{result=await execute(verified);}catch(error){return report(save(command,{status:'failed',event_id:event,error:{name:error.name,message:error.message}}));}
    return report(save(command,{status:typeof result?.status==='string'?result.status:'unknown',event_id:event,result:result??null}));
  }
  function enqueue(request){if(closed)return Promise.resolve({status:'stopped',reason:'dispatcher_stopped'});const work=tail.then(()=>run(request));tail=work.catch(()=>{});return work;}
  return {enqueue,drain:()=>tail,async stop(){closed=true;await tail;}};
}

function eventParts(data) {
  const envelope = data?.event ?? data;
  return { header: data?.header ?? envelope?.header ?? {}, event: envelope ?? {} };
}

function parsedText(content,type='text') {
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    if(type==='post'){
      const post=parsed.zh_cn??parsed;
      if(post.title||!Array.isArray(post.content)||post.content.some(row=>!Array.isArray(row)||row.some(c=>c.tag!=='text'||typeof c.text!=='string')))return null;
      return post.content.map(row=>row.map(c=>c.text).join('')).join('\n');
    }
    return typeof parsed?.text === 'string' ? parsed.text : null;
  } catch {
    return content;
  }
}

function platformCreatedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric > 100_000_000_000 ? numeric : numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEvent(data, { appRef, chatRef, senderRef, now }) {
  const { header, event } = eventParts(data);
  const message = event.message ?? {};
  const sender = event.sender ?? {};
  const senderId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? sender.open_id ?? sender.user_id ?? null;
  const chatType = message.chat_type ?? message.chat?.chat_type ?? null;
  const messageType = message.message_type ?? message.msg_type ?? null;
  const chatId = message.chat_id ?? null;
  const eventApp = header.app_id ?? event.app_id ?? null;
  if (eventApp && eventApp !== appRef) return { status: 'ignored', reason: 'app_mismatch' };
  if (chatType !== 'p2p' || chatId !== chatRef) return { status: 'ignored', reason: 'chat_mismatch' };
  if (!senderId || senderId !== senderRef || sender.sender_type && sender.sender_type !== 'user') return { status: 'ignored', reason: 'sender_mismatch' };
  if (!['text','post'].includes(messageType)) return { status: 'ignored', reason: 'unsupported_message_type' };
  const text = parsedText(message.content,messageType);
  const eventId = header.event_id ?? event.event_id ?? message.message_id;
  if (!eventId || !message.message_id || typeof text !== 'string') return { status: 'ignored', reason: 'event_incomplete' };
  return {
    status: 'accepted',
    event: {
      event_id: eventId,
      message_id: message.message_id,
      chat_ref: chatId,
      sender_ref: senderId,
      app_ref: appRef,
      text,
      source_message_type:messageType,
      created_at: platformCreatedAt(message.create_time ?? header.create_time),
      platform_create_time: message.create_time ?? header.create_time ?? null,
      received_at: new Date(now()).toISOString(),
      parent_id: message.parent_id ?? message.root_id ?? null,
    },
  };
}

export function createFeishuListener({ Lark, client, wsClient, feedback, appRef, chatRef, senderRef, onResult = result => {}, now = () => new Date().toISOString() }) {
  if (!Lark?.EventDispatcher || !feedback || !appRef || !chatRef || !senderRef) {
    throw new TypeError('Lark.EventDispatcher, feedback, appRef, chatRef and senderRef are required');
  }
  const socket = wsClient ?? client?.wsClient ?? (typeof client?.start === 'function' && typeof client?.close === 'function' ? client : null);
  if (!socket?.start || !socket?.close) throw new TypeError('an injected official WSClient is required');
  const applyFeedback = typeof feedback === 'function' ? feedback : feedback.applyFeedback?.bind(feedback);
  const sendReceipt = feedback.sendReceipt?.bind(feedback);
  if (!applyFeedback || !sendReceipt) throw new TypeError('feedback.applyFeedback and feedback.sendReceipt are required');

  const inFlight = new Set();
  let state = 'idle';
  let startPromise = Promise.resolve();
  let stopPromise = Promise.resolve();

  function report(result) {
    try { onResult(result); } catch { /* 回调失败不能中断官方事件处理。 */ }
  }

  async function process(data) {
    const normalized = normalizeEvent(data, { appRef, chatRef, senderRef, now });
    if (normalized.status !== 'accepted') {
      report({ status: normalized.status, reason: normalized.reason });
      return normalized;
    }
    const event = normalized.event;
    if (!event) return { status: 'ignored', reason: 'event_incomplete' };
    let saved;
    try {
      saved = await applyFeedback(event);
    } catch {
      report({ status: 'save_failed', event_id: event.event_id });
      // 官方 SDK 只会把 handler 抛错映射为失败 ACK；错误内容不携带事件或私有数据。
      throw new Error('feedback_persistence_failed');
    }
    if (saved?.status === 'ignored') {
      report({ status: saved?.status ?? 'save_failed', event_id: event.event_id });
      return saved ?? { status: 'save_failed' };
    }
    if (saved?.status === 'save_failed' || !saved?.outbox_id) {
      report({ status: saved?.status ?? 'save_failed', event_id: event.event_id });
      throw new Error('feedback_persistence_failed');
    }
    let receipt;
    try {
      receipt = await sendReceipt(saved.outbox_id);
    } catch {
      report({ status: 'receipt_unknown', business_status: saved.status, event_id: event.event_id, outbox_id: saved.outbox_id });
      return { status: 'receipt_unknown', business_status: saved.status, outbox_id: saved.outbox_id };
    }
    report({ status: 'processed', business_status: saved.status, event_id: event.event_id, outbox_id: saved.outbox_id, receipt_status: receipt?.status ?? 'unknown' });
    return { status: 'processed', business_status: saved.status, outbox_id: saved.outbox_id, receipt };
  }

  function handle(data) {
    if (!['starting', 'running'].includes(state)) return Promise.resolve({ status: 'ignored', reason: 'listener_stopped' });
    const work = process(data);
    inFlight.add(work);
    work.finally(() => inFlight.delete(work)).catch(() => {});
    return work;
  }

  async function start() {
    if (state === 'running') return;
    if (state === 'starting') return startPromise;
    if (state === 'stopping' || state === 'stopped') throw new Error('listener cannot restart after stop');
    state = 'starting';
    const dispatcher = new Lark.EventDispatcher({}).register({ [EVENT_NAME]: handle });
    try {
      startPromise = Promise.resolve(socket.start({ eventDispatcher: dispatcher })).then(() => { if (state === 'starting') state = 'running'; });
      await startPromise;
    } catch (error) {
      state = 'stopped';
      throw error;
    }
  }

  async function stop() {
    if (state === 'stopped') return;
    if (state === 'stopping') return stopPromise;
    state = 'stopping';
    stopPromise = (async () => {
      try { await socket.close({ force: true }); }
      finally {
        if (startPromise) await startPromise.catch(() => {});
        await Promise.allSettled([...inFlight]);
        state = 'stopped';
      }
    })();
    return stopPromise;
  }

  return { start, stop };
}
