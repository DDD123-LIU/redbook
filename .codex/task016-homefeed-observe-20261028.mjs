// 2026-10-28 Codex：仅保存当前已登录首页可见候选，不发送。
const t=await taskSpace(1),p=t.page('p1');
const {classifyPlatformEvidence,platformEvidence}=await import('file:///D:/HuaweiMoveData/Users/YOUR_USER/Documents/ChatGPT/redbook/.codex/task016-runtime.mjs');
const barrier=classifyPlatformEvidence(await p.evaluate(platformEvidence));if(barrier)throw Object.assign(Error(barrier.kind),{kind:barrier.kind});
const platform=await p.evaluate(platformEvidence);
const observation=await p.evaluate(()=>({url:location.href,items:[...document.querySelectorAll('section.note-item')].map(s=>({text:s.innerText,urls:[...s.querySelectorAll('a[href*="/explore/"]')].map(a=>a.href)})).filter(s=>s.urls.length)}));
observation.exhausted=/^(没有更多了|没有更多内容了|已经到底了|暂无更多内容)[。！!]?$/m.test(platform.outsideText.trim());
const fs=await import('node:fs/promises');
await fs.writeFile('D:/HuaweiMoveData/Users/YOUR_USER/Documents/ChatGPT/redbook/.codex/private/task016-trial-20261028/homefeed-observed.json',JSON.stringify({at:new Date().toISOString(),...observation},null,2));
console.log({items:observation.items.length,titles:observation.items.map(x=>x.text.slice(0,90))});
