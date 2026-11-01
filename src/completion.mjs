// 2026-10-24 Codex：复用既有订阅完成校验，避免分析与偏好证据模块循环依赖。
export function completionEvents(stdout) {
 try{return stdout.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}catch{return null;}
}
export function verifyCompletion(receipt) {
 const list=completionEvents(receipt.stdout??'');
 return receipt.exitCode===0&&!receipt.timedOut&&list!==null&&list.filter(x=>x.type==='turn.completed').length===1&&!list.some(x=>x.type==='error'||x.type==='turn.failed'||x.type==='item.completed'&&['command_execution','mcp_tool_call','web_search'].includes(x.item?.type));
}
