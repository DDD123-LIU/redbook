// 2026-10-29 Codex：仅由ego lite调用。复用正文读取脚本，刷新继续发现，保留已读材料。
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {classifyPlatformEvidence,platformEvidence} from './task016-runtime.mjs';

export async function collectBrowserRound({root,spaceId,sessionRef,round,exclude,workspace}){
 const bodiesRef=join(root,'homepage-bodies.json');
 // 已停止的材料可能早于collection回执落盘；重入只复用，保留具体故障且不再访问页面。
 if(existsSync(bodiesRef)&&JSON.parse(await readFile(bodiesRef,'utf8')).stopped)return;
 let task;
 try{task=await taskSpace(spaceId);}catch(error){
  if(!/task space not found/.test(error.message))throw error;
  if((await listTaskSpaces()).length)throw Error('missing task space; other spaces are not claimed');
  task=await taskSpace('TASK016 daily runtime');
 }
 const page=task.page('p1');await page.goto('https://www.xiaohongshu.com/explore',{waitUntil:'domcontentloaded',timeout:30000});
 await page.reload({waitUntil:'domcontentloaded',timeout:30000});
 const check=async()=>{const barrier=classifyPlatformEvidence(await page.evaluate(platformEvidence));if(barrier)throw Object.assign(Error(barrier.kind),{kind:barrier.kind});};
 await check();await page.waitForSelector('section.note-item');
 await writeFile(sessionRef,JSON.stringify({spaceId:task.spaceId,pageLabel:'p1',verified_at:new Date().toISOString()}));
 // 每轮使用浏览器刷新取得新推荐，已有seen继续去重，不再向下滚动。
 const sourceRoot=join(workspace,'.codex/private/task016-trial-20261028').replaceAll('\\','/');
 for(const [name,file] of [['observe','task016-homefeed-observe-20261028.mjs'],['bodies','task016-read-homefeed-bodies-20261028.mjs']]){
  const code=(await readFile(join(workspace,'.codex',file),'utf8')).replaceAll(sourceRoot,root.replaceAll('\\','/')).replaceAll('taskSpace(1)',`taskSpace(${task.spaceId})`);
  await writeFile(join(root,name+'.mjs'),code);
 }
 const observedRef=join(root,'homefeed-observed.json');
 if(!existsSync(observedRef)){
  await import(pathToFileURL(join(root,'observe.mjs')).href);
  const observed=JSON.parse(await readFile(observedRef,'utf8')),excluded=new Set(exclude);
  observed.discovered_ids=observed.items.map(item=>new URL(item.urls.find(u=>u.includes('xsec_token='))||item.urls[0]).pathname.split('/').at(-1));
  const remaining=observed.items.filter(item=>{
   const url=item.urls.find(u=>u.includes('xsec_token='));return url&&!excluded.has(new URL(url).pathname.split('/').at(-1));
  });
  observed.exhausted=observed.exhausted===true&&remaining.length<=40;
  observed.items=remaining.slice(0,40);await writeFile(observedRef,JSON.stringify(observed));
 }
 // 连续执行异常跨补量轮累计；同轮重入沿用原材料，不能重复计数或清空停止证据。
 const previousRef=join(root,'..',String(round-1).padStart(4,'0'),'homepage-bodies.json');
 if(!existsSync(bodiesRef)&&round>0&&existsSync(previousRef)){
  const previous=JSON.parse(await readFile(previousRef,'utf8'));
  await writeFile(bodiesRef,JSON.stringify({items:[],stopped:null,read_error_streak:previous.read_error_streak??[]}));
 }
 await import(pathToFileURL(join(root,'bodies.mjs')).href);
}
