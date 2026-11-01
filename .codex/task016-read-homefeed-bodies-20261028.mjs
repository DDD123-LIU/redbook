// 2026-10-28 Codex：当前已登录页面的有限候选逐条正文读取，保存即跳过。
const fs=await import('node:fs/promises');
const {classifyPlatformEvidence,platformEvidence}=await import('file:///D:/HuaweiMoveData/Users/YOUR_USER/Documents/ChatGPT/redbook/.codex/task016-runtime.mjs');
const root='D:/HuaweiMoveData/Users/YOUR_USER/Documents/ChatGPT/redbook/.codex/private/task016-trial-20261028';
const observed=JSON.parse(await fs.readFile(root+'/homefeed-observed.json','utf8'));
let state;try{state=JSON.parse(await fs.readFile(root+'/homepage-bodies.json','utf8'));}catch{state={items:[],stopped:null};}
if(state.stopped)throw Error('global barrier already recorded');
state.read_error_streak??=[];
const p=(await taskSpace(1)).page('p1');
for(const item of observed.items){
 const url=item.urls.find(x=>x.includes('xsec_token='));if(!url)continue;
 const id=new URL(url).pathname.split('/').at(-1);if(state.items.some(x=>x.source_id===id))continue;
 let phase='navigation';
 try{
  try{await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});}
  catch(error){
   // 仅在超时后确已进入本帖时刷新一次；不得把上篇正文认作当前帖，也不绕过平台验证。
   if(!/timed out/i.test(error.message))throw error;
   const current=new URL(await p.url()),expected=new URL(url);
   if(current.origin!==expected.origin||current.pathname!==expected.pathname)throw error;
   const blocked=classifyPlatformEvidence(await p.evaluate(platformEvidence));
   if(blocked){state.stopped={source_id:id,...blocked};break;}
   await p.reload({waitUntil:'domcontentloaded',timeout:30000});
   (state.navigation_recoveries??=[]).push({source_id:id,at:new Date().toISOString(),action:'reload_after_committed_timeout'});
  }
  const barrier=classifyPlatformEvidence(await p.evaluate(platformEvidence));
  if(barrier){state.stopped={source_id:id,...barrier};break;}
  phase='body';
  await p.waitForSelector('#detail-desc',{timeout:10000});
  // 正文先于轮播挂载；等待实际媒体组件，避免把暂时空数组当作无图原帖。
  await p.waitForFunction(()=>Boolean(document.querySelector('.note-slider-img img,.note-container video,.note-container[data-type="video"]')),undefined,{timeout:10000}).catch(()=>{});
  const value=await p.evaluate(()=>({title:document.querySelector('#detail-title')?.innerText??'',body:document.querySelector('#detail-desc')?.innerText??'',author_name:document.querySelector('.interaction-container a.name')?.innerText?.trim()??'',image_candidates:[...document.querySelectorAll('.note-slider-img img')].map(i=>({url:i.currentSrc||i.src,slide_index:i.closest('[data-swiper-slide-index]')?.getAttribute('data-swiper-slide-index')??null})),video_present:Boolean(document.querySelector('.note-container video,.note-container[data-type="video"]'))}));
  const after=classifyPlatformEvidence(await p.evaluate(platformEvidence));if(after){state.stopped={source_id:id,...after};break;}
  state.items.push({source_id:id,url,...value,at:new Date().toISOString(),status:value.video_present?'unsupported_video':value.title.trim()&&value.body.trim()&&value.author_name?'succeeded':'incomplete',imagesSeen:false});
  // 正常提取即打断连续执行异常；内容缺字段、视频或后续未入选都不算采集故障。
  state.read_error_streak=[];
 }catch(e){
  const failure={source_id:id,phase,reason:String(e.message).slice(0,150)};
  state.items.push({...failure,url,status:'failed'});
  const blocked=await p.evaluate(platformEvidence).then(classifyPlatformEvidence).catch(()=>({kind:'page_unavailable'}));
  if(blocked){state.stopped={source_id:id,...blocked};break;}
  state.read_error_streak.push(failure);
  if(state.read_error_streak.length>=5){
   state.stopped={kind:'collection_execution_failed',source_id:id,reason:`连续5篇采集执行异常，${phase}：${failure.reason}`,failures:[...state.read_error_streak]};break;
  }
 }
 await fs.writeFile(root+'/homepage-bodies.json',JSON.stringify(state,null,2));
 console.log({attempted:state.items.length,id,status:state.items.at(-1).status});
}
await fs.writeFile(root+'/homepage-bodies.json',JSON.stringify(state,null,2));console.log({done:state.items.length,stopped:state.stopped});
