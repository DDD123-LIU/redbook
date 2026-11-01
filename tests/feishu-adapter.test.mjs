import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuTransport } from '../src/feishu-adapter.mjs';
import { createFeishuListener } from '../src/feishu-listener.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const sendRequest = {
  receive_id: 'chat-1',
  msg_type: 'post',
  content: JSON.stringify({ zh_cn: { title: 'batch / 01 [rec-uuid]｜标题', content: [{ tag: 'text', text: '正文' }] } }),
  uuid: 'rec-uuid',
};

test('图片回读补充宽高只在原请求未指定时容许，key和显式尺寸仍严格匹配',async t=>{
 const root=await withRoot(t),expected={title:'图片',content:[[{tag:'img',image_key:'image-1'}]]};
 const actual={title:'图片',content:[[{tag:'img',image_key:'image-1',width:1902,height:994}]]};
 const item={message_id:'image-message',chat_id:'chat-1',msg_type:'post',body:{content:JSON.stringify(actual)},sender:{sender_type:'app',id_type:'app_id',id:'app-1'}};
 const transport=createFeishuTransport({client:{im:{message:{get:async()=>({code:0,data:{items:[item]}})}}},targetRef:'chat-1',appRef:'app-1',root});
 const query=()=>transport.lookup({message_id:item.message_id,payload:{msg_type:'post',content:JSON.stringify(expected)}});
 assert.equal((await query()).status,'succeeded');
 actual.content[0][0].image_key='other';item.body.content=JSON.stringify(actual);assert.equal((await query()).status,'unknown');
 actual.content[0][0].image_key='image-1';item.body.content=JSON.stringify(actual);expected.content[0][0].width=100;
 assert.equal((await query()).status,'unknown');
});

test('正文URL被平台拆为自动链接时保留全文匹配，错误href和非空样式拒绝',async t=>{
 const root=await withRoot(t),expected={title:'链接',content:[[{tag:'text',text:'文 https://example.com/a 末'}]]};
 const actual={title:'链接',content:[[{tag:'text',text:'文 ',style:[]},{tag:'a',text:'https://example.com/a',href:'https://example.com/a',style:[]},{tag:'text',text:' 末',style:[]}]]};
 const item={message_id:'auto-link',chat_id:'chat-1',msg_type:'post',body:{content:JSON.stringify(actual)},sender:{sender_type:'app',id_type:'app_id',id:'app-1'}};
 const transport=createFeishuTransport({client:{im:{message:{get:async()=>({code:0,data:{items:[item]}})}}},targetRef:'chat-1',appRef:'app-1',root});
 const query=()=>transport.lookup({message_id:item.message_id,payload:{msg_type:'post',content:JSON.stringify(expected)}});
 assert.equal((await query()).status,'succeeded');
 actual.content[0][1].href='https://other.example';item.body.content=JSON.stringify(actual);assert.equal((await query()).status,'unknown');
 actual.content[0][1].href=actual.content[0][1].text;actual.content[0][1].style=['bold'];item.body.content=JSON.stringify(actual);assert.equal((await query()).status,'unknown');
});

test('无协议域名自动链接保留逐字正文；错链接、样式、缺字及危险协议仍拒绝',async t=>{
 const root=await withRoot(t),expected={title:'正文',content:[[{tag:'text',text:'前 Conversion.ai 后'}],[{tag:'a',text:'原文入口',href:'https://source.example/original'}]]};
 const actual={title:'正文',content:[[{tag:'text',text:'前 ',style:[]},{tag:'a',text:'Conversion.ai',href:'Conversion.ai',style:[]},{tag:'text',text:' 后',style:[]}],[{tag:'a',text:'原文入口',href:'https://source.example/original'}]]};
 const item={message_id:'domain-link',chat_id:'chat-1',msg_type:'post',body:{content:JSON.stringify(actual)},sender:{sender_type:'app',id_type:'app_id',id:'app-1'}};
 const transport=createFeishuTransport({client:{im:{message:{get:async()=>({code:0,data:{items:[item]}})}}},targetRef:'chat-1',appRef:'app-1',root});
 const query=()=>{item.body.content=JSON.stringify(actual);return transport.lookup({message_id:item.message_id,payload:{msg_type:'post',content:JSON.stringify(expected)}});};
 assert.equal((await query()).status,'succeeded');
 actual.content[0][1].href='other.ai';assert.equal((await query()).status,'unknown');
 actual.content[0][1].href='Conversion.ai';actual.content[0][1].style=['bold'];assert.equal((await query()).status,'unknown');
 actual.content[0][1].style=[];actual.content[0][2].text='后';assert.equal((await query()).status,'unknown');
 actual.content[0][2].text=' 后';actual.content[1][0].href='https://source.example/wrong';assert.equal((await query()).status,'unknown');
 actual.content[1][0].href='https://source.example/original';
 for(const text of ['javascript:alert(1)','file:///tmp/file']){expected.content[0][0].text='前 '+text+' 后';actual.content[0][1].text=text;actual.content[0][1].href=text;assert.equal((await query()).status,'unknown');}
});

test('正文邮箱被飞书自动转同文链接时匹配，改目标、改字、样式仍拒绝',async t=>{
 const root=await withRoot(t),email='i-yangkedan@stepfun.com';
 const expected={title:'招聘',content:[[{tag:'text',text:`简历：${email}\n后文`}]]};
 const actual={title:'招聘',content:[[{tag:'text',text:'简历：',style:[]},{tag:'a',text:email,href:email,style:[]},{tag:'text',text:'\n后文',style:[]}]]};
 const item={message_id:'email-message',chat_id:'chat-1',msg_type:'post',body:{},sender:{sender_type:'app',id:'app-1'}};
 const transport=createFeishuTransport({client:{im:{message:{get:async()=>({code:0,data:{items:[item]}})}}},targetRef:'chat-1',appRef:'app-1',root});
 const query=()=>{item.body.content=JSON.stringify(actual);return transport.lookup({message_id:item.message_id,payload:{msg_type:'post',content:JSON.stringify(expected)}});};
 assert.equal((await query()).status,'succeeded');
 for(const href of ['other@stepfun.com',`mailto:${email}`,`javascript:${email}`]){actual.content[0][1].href=href;assert.equal((await query()).status,'unknown');}
 actual.content[0][1].href=email;actual.content[0][1].style=['bold'];assert.equal((await query()).status,'unknown');
 actual.content[0][1].style=[];actual.content[0][2].text='后文';assert.equal((await query()).status,'unknown');
});

test('平台post回读附加空style时匹配原payload，非空style差异仍unknown',async t=>{
 const root=await withRoot(t),post=JSON.parse(sendRequest.content).zh_cn;
 // 2026-10-24真实合成回读：平台为每个组件添加style:[]及content_v2。
 const actual={...post,content:post.content.map(row=>Array.isArray(row)?row.map(c=>({...c,style:[]})):{...row,style:[]}),content_v2:[]};
 const item={message_id:'message-style',chat_id:'chat-1',msg_type:'post',body:{content:JSON.stringify(actual)},sender:{sender_type:'app',id_type:'app_id',id:'app-1'}};
 const transport=createFeishuTransport({client:{im:{message:{get:async()=>({code:0,data:{items:[item]}})}}},targetRef:'chat-1',appRef:'app-1',root});
 assert.equal((await transport.lookup({message_id:item.message_id,payload:sendRequest})).status,'succeeded');
 if(Array.isArray(actual.content[0]))actual.content[0][0].style=['bold'];else actual.content[0].style=['bold'];item.body.content=JSON.stringify(actual);
 assert.equal((await transport.lookup({message_id:item.message_id,payload:sendRequest})).status,'unknown');
});

test('listener接受只有文字的飞书post指令，保留来源类型，不猜测图文输入',async()=>{
 let dispatch;const Lark={EventDispatcher:class{register(map){dispatch=map['im.message.receive_v1'];return this;}}};const events=[];
 const listener=createFeishuListener({Lark,wsClient:{async start(){},close(){}},feedback:{async applyFeedback(e){events.push(e);return {status:'query',outbox_id:'out'};},async sendReceipt(){return {status:'succeeded'};}},appRef:'app',chatRef:'chat',senderRef:'sender'});await listener.start();
 const message={message_id:'incoming-post',chat_id:'chat',chat_type:'p2p',message_type:'post',create_time:'1792778778323',content:JSON.stringify({title:'',content:[[{tag:'text',text:'更正 1 踩 修订1',style:[]}]]})};
 await dispatch({header:{app_id:'app',event_id:'event-post'},event:{sender:{sender_id:{open_id:'sender'},sender_type:'user'},message}});assert.equal(events[0]?.text,'更正 1 踩 修订1');assert.equal(events[0]?.source_message_type,'post');
 message.content=JSON.stringify({title:'',content:[[{tag:'img',image_key:'image'}]]});await dispatch({header:{app_id:'app',event_id:'event-image'},event:{sender:{sender_id:{open_id:'sender'},sender_type:'user'},message}});assert.equal(events.length,1);await listener.stop();
});

test('send只调用一次官方create，成功回执写入私有证据文件', async t => {
  const root = await withRoot(t);
  const calls = [];
  const client = { im: { message: { create: async input => { calls.push(input); return { code: 0, data: { message_id: 'msg-1' } }; } } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root, now: () => '2026-10-24T00:00:00.000Z' });

  const result = await transport.send(sendRequest);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { params: { receive_id_type: 'chat_id' }, data: sendRequest });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message_id, 'msg-1');
  assert.equal(result.evidence[0].startsWith('feishu-receipt:'), true);
  const receipt = await readFile(join(root, result.evidence[0].slice('feishu-receipt:'.length)), 'utf8');
  assert.match(receipt, /msg-1/);
  assert.match(receipt, /rec-uuid/);
});

test('发送请求目标错绑时不调用平台', async t => {
  const root = await withRoot(t);
  let calls = 0;
  const client = { im: { message: { create: async () => { calls += 1; return { code: 0, data: { message_id: 'msg' } }; } } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await transport.send({ ...sendRequest, receive_id: 'other-chat' })).status, 'unknown');
  assert.equal(calls, 0);
});

test('非零响应、缺ID和异常均unknown且不会重试', async t => {
  const root = await withRoot(t);
  for (const create of [
    async () => ({ code: 123, msg: 'rejected' }),
    async () => ({ code: 0, data: {} }),
    async () => { throw new Error('network failed'); },
  ]) {
    let calls = 0;
    const transport = createFeishuTransport({
      client: { im: { message: { create: async input => { calls += 1; return create(input); } } } },
      targetRef: 'chat-1', appRef: 'app-1', root,
    });
    assert.equal((await transport.send(sendRequest)).status, 'unknown');
    assert.equal(calls, 1);
  }
});

test('仅官方明确参数拒绝230001归failed并保留未送达依据', async t => {
  const root = await withRoot(t);
  const responses = [
    { code: 230001, msg: 'Your request contains an invalid request parameter.' },
    Object.assign(new Error('HTTP 400'), { response: { status: 400, data: { code: 230001, msg: 'Your request contains an invalid request parameter.' } } }),
  ];
  for (const outcome of responses) {
    let calls = 0;
    const transport = createFeishuTransport({
      client: { im: { message: { create: async () => { calls += 1; if (outcome instanceof Error) throw outcome; return outcome; } } } },
      targetRef: 'chat-1', appRef: 'app-1', root,
    });
    const result = await transport.send(sendRequest);
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(result.evidence[0].startsWith('feishu-receipt:'), true);
    const receipt = JSON.parse(await readFile(join(root, result.evidence[0].slice('feishu-receipt:'.length)), 'utf8'));
    assert.equal(receipt.response.code, 230001);
    assert.match(receipt.official_error_evidence_url, /^https:\/\/open\.feishu\.cn\//);
  }
});

test('其他权限拒绝码或含message_id的230001仍unknown', async t => {
  const root = await withRoot(t);
  for (const response of [
    { code: 230013, msg: 'Bot has NO availability to this user.' },
    { code: 230001, msg: 'invalid parameter', data: { message_id: 'unexpected-id' } },
  ]) {
    const transport = createFeishuTransport({ client: { im: { message: { create: async () => response } } }, targetRef: 'chat-1', appRef: 'app-1', root });
    assert.equal((await transport.send(sendRequest)).status, 'unknown');
  }
});

test('按message_id精确核对chat、类型与完整post内容', async t => {
  const root = await withRoot(t);
  const returned = { title: 'batch / 01 [rec-uuid]｜标题', content: [{ tag: 'text', text: '正文' }] };
  const client = { im: { message: {
    get: async ({ path }) => ({ code: 0, data: { items: [{ message_id: path.message_id, chat_id: 'chat-1', msg_type: 'post', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: JSON.stringify({ title: returned.title, content: returned.content }) } }] } }),
  } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  const result = await transport.lookup({ message_id: 'msg-2', target_ref: 'chat-1', payload: sendRequest });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message_id, 'msg-2');
  assert.equal(result.evidence.length, 1);
});

test('按message_id核对完整text内容并保留换行差异', async t => {
  const root = await withRoot(t);
  const request = { receive_id: 'chat-1', msg_type: 'text', content: JSON.stringify({ text: '一行\n二行' }), uuid: 'text-id' };
  const client = {
    im: { message: { get: async () => ({
      code: 0,
      data: { items: [{ message_id: 'text-message', chat_id: 'chat-1', msg_type: 'text', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: JSON.stringify({ text: '一行\n二行' }) } }] },
    }) } },
  };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await transport.lookup({ message_id: 'text-message', target_ref: 'chat-1', payload: request })).status, 'succeeded');
  assert.equal((await transport.lookup({ message_id: 'text-message', target_ref: 'chat-1', payload: { ...request, content: JSON.stringify({ text: '一行\n另一行' }) } })).status, 'unknown');
});

test('精确ID回读存在chat或payload不匹配时unknown', async t => {
  const root = await withRoot(t);
  const client = { im: { message: { get: async () => ({ code: 0, data: { items: [{ message_id: 'msg-3', chat_id: 'other', msg_type: 'post', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: '{}' } }] } }) } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await transport.lookup({ message_id: 'msg-3', target_ref: 'chat-1', payload: sendRequest })).status, 'unknown');
});

test('精确get缺items或返回多条时unknown', async t => {
  const root = await withRoot(t);
  for (const data of [{}, { items: [] }, { items: [
    { message_id: 'msg-2', chat_id: 'chat-1', msg_type: 'post', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: sendRequest.content } },
    { message_id: 'msg-2', chat_id: 'chat-1', msg_type: 'post', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: sendRequest.content } },
  ] }]) {
    const transport = createFeishuTransport({ client: { im: { message: { get: async () => ({ code: 0, data }) } } }, targetRef: 'chat-1', appRef: 'app-1', root });
    assert.equal((await transport.lookup({ message_id: 'msg-2', target_ref: 'chat-1', payload: sendRequest })).status, 'unknown');
  }
});

test('无ID时跨完整分页唯一匹配编号、目标和payload才成功', async t => {
  const root = await withRoot(t);
  const calls = [];
  const item = { message_id: 'msg-4', chat_id: 'chat-1', msg_type: 'post', create_time: '1792800000', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: JSON.stringify({ title: 'batch / 01 [rec-uuid]｜标题', content: [{ tag: 'text', text: '正文' }] }) } };
  const client = { im: { message: { list: async input => {
    calls.push(input);
    return calls.length === 1
      ? { code: 0, data: { items: [], has_more: true, page_token: 'next' } }
      : { code: 0, data: { items: [item], has_more: false } };
  } } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  const result = await transport.lookup({ target_ref: 'chat-1', payload: sendRequest, recommendation_id: 'rec-uuid', ordinal: 1, started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message_id, 'msg-4');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.page_token, 'next');
});

test('零匹配、多匹配、分页令牌重复或权限错误均unknown', async t => {
  const root = await withRoot(t);
  const item = { message_id: 'msg-5', chat_id: 'chat-1', msg_type: 'post', create_time: '1792800000', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: JSON.stringify({ title: 'batch / 01 [rec-uuid]｜标题', content: [{ tag: 'text', text: '正文' }] }) } };
  for (const list of [
    async () => ({ code: 0, data: { items: [], has_more: false } }),
    async () => ({ code: 0, data: { items: [item, { ...item, message_id: 'msg-6' }], has_more: false } }),
    async ({ params }) => ({ code: 0, data: { items: [], has_more: true, page_token: params.page_token ?? 'loop' } }),
    async () => ({ code: 0, data: { items: [] } }),
    async () => ({ code: 99991663, msg: 'forbidden' }),
    async () => { throw new Error('timeout'); },
  ]) {
    const transport = createFeishuTransport({ client: { im: { message: { list } } }, targetRef: 'chat-1', appRef: 'app-1', root });
    const result = await transport.lookup({ target_ref: 'chat-1', payload: sendRequest, recommendation_id: 'rec-uuid', ordinal: 1, started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' });
    assert.equal(result.status, 'unknown');
  }
});

test('列表跨页重复同一ID只计一次，不同ID仍判多匹配', async t => {
  const root = await withRoot(t);
  const item = { message_id: 'msg-same', chat_id: 'chat-1', msg_type: 'post', create_time: '1792800000', sender: { sender_type: 'app', app_id: 'app-1' }, body: { content: JSON.stringify({ title: 'batch / 01 [rec-uuid]｜标题', content: [{ tag: 'text', text: '正文' }] }) } };
  for (const secondPage of [[item], [{ ...item, message_id: 'msg-other' }]]) {
    let calls = 0;
    const list = async () => {
      calls += 1;
      return calls === 1
        ? { code: 0, data: { items: [item], has_more: true, page_token: 'next' } }
        : { code: 0, data: { items: secondPage, has_more: false } };
    };
    const transport = createFeishuTransport({ client: { im: { message: { list } } }, targetRef: 'chat-1', appRef: 'app-1', root });
    const result = await transport.lookup({ target_ref: 'chat-1', payload: sendRequest, recommendation_id: 'rec-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' });
    assert.equal(result.status, secondPage[0].message_id === 'msg-same' ? 'succeeded' : 'unknown');
  }
});

test('无ID时只有带唯一outbox_id且完整匹配的text回执才核实成功', async t => {
  const root = await withRoot(t);
  const outboxId = 'outbox-123';
  const request = { receive_id: 'chat-1', msg_type: 'text', content: JSON.stringify({ text: `已保存。\n回执ID：${outboxId}` }), uuid: 'receipt-uuid' };
  const message = { message_id: 'receipt-message', chat_id: 'chat-1', msg_type: 'text', create_time: '1792800000', sender: { sender_type: 'app', id: 'app-1' }, body: { content: request.content } };
  const client = { im: { message: { list: async () => ({ code: 0, data: { items: [message], has_more: false } }) } } };
  const transport = createFeishuTransport({ client, targetRef: 'chat-1', appRef: 'app-1', root });
  const result = await transport.lookup({ outbox_id: outboxId, target_ref: 'chat-1', payload: request, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.message_id, 'receipt-message');

  assert.equal((await transport.lookup({ target_ref: 'chat-1', payload: request, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' })).status, 'unknown');

  const duplicatedMarkerText = JSON.stringify({ text: `已保存。\n回执ID：${outboxId}\n再次引用：${outboxId}` });
  const duplicatedMarkerClient = { im: { message: { list: async () => ({ code: 0, data: { items: [{ ...message, body: { content: duplicatedMarkerText } }], has_more: false } }) } } };
  const duplicatedMarkerTransport = createFeishuTransport({ client: duplicatedMarkerClient, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await duplicatedMarkerTransport.lookup({ outbox_id: outboxId, target_ref: 'chat-1', payload: { ...request, content: duplicatedMarkerText }, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' })).status, 'unknown');

  const missingTextClient = { im: { message: { list: async () => ({ code: 0, data: { items: [{ ...message, body: { content: JSON.stringify({ text: '已保存。' }) } }], has_more: false } }) } } };
  const missingMarker = createFeishuTransport({ client: missingTextClient, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await missingMarker.lookup({ outbox_id: outboxId, target_ref: 'chat-1', payload: request, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' })).status, 'unknown');

  const userCopyClient = { im: { message: { list: async () => ({ code: 0, data: { items: [{ ...message, sender: { sender_type: 'user', id: 'app-1' } }], has_more: false } }) } } };
  const userCopyTransport = createFeishuTransport({ client: userCopyClient, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await userCopyTransport.lookup({ outbox_id: outboxId, target_ref: 'chat-1', payload: request, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' })).status, 'unknown');

  const incompletePagesClient = { im: { message: { list: async () => ({ code: 0, data: { items: [message], has_more: true, page_token: 'next' } }) } } };
  const incompletePagesTransport = createFeishuTransport({ client: incompletePagesClient, targetRef: 'chat-1', appRef: 'app-1', root });
  assert.equal((await incompletePagesTransport.lookup({ outbox_id: outboxId, target_ref: 'chat-1', payload: request, uuid: 'receipt-uuid', started_at: '2026-10-24T00:00:00.000Z', ended_at: '2026-10-24T23:59:59.000Z' })).status, 'unknown');
});

test('listener只处理固定本人p2p会话，保存失败不发回执，停止等待在途事件', async () => {
  const handlers = {};
  const closeCalls = [];
  const wsClient = {
    start: async ({ eventDispatcher }) => { handlers.handler = eventDispatcher.handlers['im.message.receive_v1']; },
    close: async options => { closeCalls.push(options); },
  };
  class EventDispatcher {
    constructor() { this.handlers = {}; }
    register(value) { Object.assign(this.handlers, value); return this; }
  }
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const applied = [];
  const receipts = [];
  const results = [];
  const feedback = {
    async applyFeedback(event) { applied.push(event); await waiting; return { status: 'save_failed', outbox_id: 'out-1' }; },
    async sendReceipt(id) { receipts.push(id); },
  };
  const listener = createFeishuListener({ Lark: { EventDispatcher }, wsClient, feedback, appRef: 'app-1', chatRef: 'chat-1', senderRef: 'user-1', onResult: result => results.push(result), now: () => '2026-10-24T12:00:00.000Z' });
  await listener.start();
  const handling = handlers.handler({ header: { event_id: 'event-1', app_id: 'app-1' }, event: { sender: { sender_id: { open_id: 'user-1' } }, message: { message_id: 'in-1', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text', create_time: '1792800000000', parent_id: 'parent-1', content: JSON.stringify({ text: '1 赞' }) } } });
  assert.equal(applied.length, 1);
  const stopping = listener.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closeCalls, [{ force: true }]);
  release();
  await assert.rejects(handling, /feedback_persistence_failed/);
  await stopping;
  assert.equal(receipts.length, 0);
  assert.equal(applied[0].text, '1 赞');
  assert.equal(applied[0].message_id, 'in-1');
  assert.equal(applied[0].parent_id, 'parent-1');
  assert.equal(applied[0].created_at, new Date(1792800000000).toISOString());
  assert.equal(applied[0].received_at, '2026-10-24T12:00:00.000Z');
  assert.notEqual(applied[0].created_at, applied[0].received_at);
  assert.equal(results.some(result => 'text' in result), false);
});

test('listener过滤非本人事件且重复事件沿用原outbox恢复回执', async () => {
  const handlers = {};
  const wsClient = { start: async ({ eventDispatcher }) => { handlers.handler = eventDispatcher.handlers['im.message.receive_v1']; }, close: async () => {} };
  class EventDispatcher { constructor() { this.handlers = {}; } register(value) { Object.assign(this.handlers, value); return this; } }
  const receipts = [];
  const order = [];
  let calls = 0;
  const feedback = {
    async applyFeedback(event) { order.push('save'); calls += 1; return { status: calls === 1 ? 'query_saved' : 'duplicate', outbox_id: 'out-original', event_id: event.event_id }; },
    async sendReceipt(id) { order.push('receipt'); receipts.push(id); return { status: 'succeeded' }; },
  };
  const listener = createFeishuListener({ Lark: { EventDispatcher }, wsClient, feedback, appRef: 'app-1', chatRef: 'chat-1', senderRef: 'user-1' });
  await listener.start();
  const event = { header: { event_id: 'event-2', app_id: 'app-1' }, event: { sender: { sender_id: { open_id: 'user-1' } }, message: { message_id: 'in-2', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '查询' }) } } };
  await handlers.handler({ ...event, event: { ...event.event, sender: { sender_id: { open_id: 'other-user' } } } });
  await handlers.handler({ ...event, event: { ...event.event, message: { ...event.event.message, chat_type: 'group' } } });
  const queryResult = await handlers.handler(event);
  await handlers.handler(event);
  assert.equal(calls, 2);
  assert.deepEqual(receipts, ['out-original', 'out-original']);
  assert.deepEqual(order, ['save', 'receipt', 'save', 'receipt']);
  assert.equal(queryResult.business_status, 'query_saved');
  assert.equal(queryResult.receipt.status, 'succeeded');
  await listener.stop();
});

test('SDK handleEventData对未保存失败回500，对已保存但回执失败回200', async () => {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve('@larksuiteoapi/node-sdk', { paths: [resolve('.codex/private/node_modules')] });
  const { EventDispatcher, WSClient } = require(sdkEntry);
  const logger = { debug() {}, error() {}, info() {}, trace() {}, warn() {} };
  class QuietEventDispatcher extends EventDispatcher {
    constructor(params) { super({ ...params, logger }); }
  }
  const event = {
    schema: '2.0',
    header: { event_id: 'evt-ack', app_id: 'app-1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'user-1' } },
      message: { message_id: 'message-ack', chat_id: 'chat-1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '1 赞' }) },
    },
  };
  async function ackForFeedback(feedback) {
    const socket = Object.create(WSClient.prototype);
    const acknowledgements = [];
    socket.dataCache = { mergeData: ({ data }) => JSON.parse(new TextDecoder().decode(data)) };
    socket.logger = logger;
    socket.sendMessage = data => acknowledgements.push(JSON.parse(new TextDecoder().decode(data.payload)));
    socket.start = async ({ eventDispatcher }) => { socket.eventDispatcher = eventDispatcher; };
    socket.close = async () => {};
    const listener = createFeishuListener({ Lark: { EventDispatcher: QuietEventDispatcher }, wsClient: socket, feedback, appRef: 'app-1', chatRef: 'chat-1', senderRef: 'user-1' });
    await listener.start();
    await socket.handleEventData({
      headers: [
        { key: 'type', value: 'event' }, { key: 'message_id', value: 'sdk-message' },
        { key: 'sum', value: '1' }, { key: 'seq', value: '0' }, { key: 'trace_id', value: 'trace' },
      ],
      payload: new TextEncoder().encode(JSON.stringify(event)),
    });
    await listener.stop();
    return acknowledgements[0]?.code;
  }
  assert.equal(await ackForFeedback({ async applyFeedback() { return { status: 'save_failed' }; }, async sendReceipt() {} }), 500);
  assert.equal(await ackForFeedback({ async applyFeedback() { return { status: 'query_saved', outbox_id: 'out-ack' }; }, async sendReceipt() { throw new Error('private receipt failure'); } }), 200);
});
