// 2026-10-28 Codex：只准备已入围帖的实际配图，不将图片发送给模型。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {decodeImage} from '../src/analysis.mjs';
export async function prepareDisplayImages(source,root){
 if(source.video_present)throw Error('video display not validated in FIX01');
 const declared=new Map();
 for(const image of source.image_candidates??[]){
  if(image.slide_index===null||!/^\d+$/.test(image.slide_index))throw Error('image order unverified');
  const index=Number(image.slide_index),url=new URL(image.url);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.xhscdn.com'))throw Error('unexpected observed image source');
  if(!declared.has(index))declared.set(index,url.href);
 }
 const ordered=[...declared].sort((a,b)=>a[0]-b[0]);
 if(!ordered.length||ordered.some(([index],i)=>index!==i))throw Error('complete image order unavailable');
 const folder=join(root,'materials',source.source_id+'-images');mkdirSync(folder,{recursive:true});
 const result=[];
 for(const [index,url] of ordered){
  const original=join(folder,`${index}.original`),path=join(folder,`${index}.png`);
  if(!existsSync(original)){const response=await fetch(url,{signal:AbortSignal.timeout(20000)});if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))throw Error('image fetch failed');writeFileSync(original,Buffer.from(await response.arrayBuffer()),{flag:'wx'});}
  if(!existsSync(path))execFileSync('C:/Users/YOUR_USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',['-c','from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],"PNG")',original,path],{windowsHide:true});
  const size=await decodeImage(path),hash=createHash('sha256').update(readFileSync(path)).digest('hex');result.push({index,path,hash,...size});
 }
 const manifest=join(folder,'manifest.json');if(!existsSync(manifest))writeFileSync(manifest,JSON.stringify({source_id:source.source_id,ordered_images:result,model_seen:false},null,2),{flag:'wx'});
 return result;
}
