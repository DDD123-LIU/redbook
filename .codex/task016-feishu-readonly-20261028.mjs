// 2026-10-28 Codex：只读核实固定飞书会话访问，不发送、不给日志写凭证。
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createFeishuTransport} from '../src/feishu-adapter.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const require=createRequire(resolve('.codex/private/task013-production/runtime.mjs'));
const Lark=require('@larksuiteoapi/node-sdk'),axios=require('axios');
const settings=read('.codex/private/task013-production/runtime.json'),binding=read(settings.bindingPath);
const credentials=Object.fromEntries(settings.credentialFiles.flatMap(p=>readFileSync(p,'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>l.split(/=(.*)/s).slice(0,2))));
if(binding.appRef!==credentials.FEISHU_APP_ID?.trim()||binding.chatRef!==credentials.FEISHU_CHAT_ID?.trim())throw Error('fixed binding mismatch');
const http=axios.create({timeout:30000});
http.interceptors.response.use(response=>response.config['$return_headers']?{data:response.data,headers:response.headers}:response.data);
const client=new Lark.Client({appId:binding.appRef,appSecret:credentials.FEISHU_APP_SECRET.trim(),domain:Lark.Domain.Feishu,httpInstance:http,logger:{trace(){},debug(){},info(){},warn(){},error(){}}});
let result;
try{const response=await client.im.chat.get({path:{chat_id:binding.chatRef}});result={at:new Date().toISOString(),operation:'im.chat.get',code:response.code,accessible:response.code===0,ws_export:typeof Lark.WSClient,sends:0};}
catch(e){result={at:new Date().toISOString(),operation:'im.chat.get',accessible:false,error_code:e.code??'request_failed',error_type:e.name,message:String(e.message).slice(0,200),sends:0};}
writeFileSync(resolve('.codex/private/task016-trial-20261028/feishu-readonly.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(process.argv.includes('--feedback-history')){
 const root=resolve('.codex/private/task016-feedback-20261029');
 const response=await client.im.message.list({params:{container_id_type:'chat',container_id:binding.chatRef,page_size:50,start_time:String(Math.floor(Date.now()/1000)-1800),end_time:String(Math.ceil(Date.now()/1000)),sort_type:'ByCreateTimeAsc'}});
 writeFileSync(root+'/history-response.json',JSON.stringify({at:new Date().toISOString(),response},null,2));
 if(response.code!==0||response.data?.has_more)throw Error('history query incomplete');
 console.log((response.data?.items??[]).filter(m=>m.sender?.id===binding.senderRef).map(m=>({message_id:m.message_id,create_time:m.create_time,msg_type:m.msg_type,parent_id:m.parent_id,root_id:m.root_id,body:m.body})));
}
if(process.argv.includes('--fix01-readback')){
 const root=resolve('.codex/private/task016-fix01-live'),intent=read(`${root}/display-live-intent.json`),prior=read(`${root}/display-live-result.json`);
 const transport=createFeishuTransport({client,targetRef:binding.chatRef,appRef:binding.appRef,root:settings.roots.transport});
 const verified=await transport.lookup({message_id:prior.sent.message_id,payload:intent.payload,target_ref:binding.chatRef});
 writeFileSync(`${root}/display-live-reconciled.json`,JSON.stringify({at:new Date().toISOString(),...verified},null,2));console.log(JSON.stringify(verified));
}
if(process.argv.includes('--readback')||process.argv.includes('--additional-readback')||process.argv.includes('--fix01-production-readback')||process.argv.includes('--manual-readback')||process.argv.includes('--daily-readback')){
 const root=resolve(process.env.TASK016_RUN_ROOT??'.codex/private/task016-trial-20261028'),transport=createFeishuTransport({client,targetRef:binding.chatRef,appRef:binding.appRef,root:settings.roots.transport}),results=[];
 for(const name of (process.argv.includes('--daily-readback')?['daily']:process.argv.includes('--manual-readback')?['manual']:process.argv.includes('--fix01-production-readback')?['fix01']:process.argv.includes('--additional-readback')?['additional']:['real','extra']))for(const sent of read(`${root}/push-${name}.json`).sent){
  const intent=read(`${root}/delivery/intent-${sent.attempt_id}.json`);
  const found=await transport.lookup({message_id:sent.result.message_id,target_ref:binding.chatRef,payload:intent.payload});
  results.push({recommendation_id:sent.recommendation_id,...found});
 }
 writeFileSync(`${root}/${process.argv.includes('--additional-readback')?'exact-additional-readback':'exact-readback'}.json`,JSON.stringify({at:new Date().toISOString(),results},null,2));console.log(JSON.stringify({exact_readback:results.map(x=>({id:x.recommendation_id,status:x.status,reason:x.reason}))}));
}
