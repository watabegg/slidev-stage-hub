#!/usr/bin/env node
import { buildNativeUi } from './build-ui.mjs';
// Chromium DOM experiment; the actual WebKit run remains a separate verify.py run.
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
buildNativeUi();
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const stageRoot=path.join(repoRoot,'apps/stage');
const site=path.resolve(process.argv[2] || path.join(stageRoot,'artifacts/site'));
const output=path.resolve(process.argv[3] || path.join(stageRoot,'artifacts/flicker'));
const require=createRequire('/home/watabegg/slidev-watabegg/package.json');
const {chromium}=require('playwright-chromium');
const manifest=JSON.parse(await readFile(path.join(site,'manifest.json'),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome'});
const results={site,baselineCommit:'3d8c6a6',environment:{browser:await browser.version()},runs:{}};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
for(const mode of ['baseline','persistent']){
 console.log(`Measuring ${mode}`);
 const baselineFile=file=>readFile(path.join(repoRoot,'examples/legacy-native-baseline',file),'utf8');
 const bridge=mode==='baseline'?await baselineFile('deck-bridge.js'):await readFile(path.join(stageRoot,'dist/deck-bridge.js'),'utf8');
 let delayedDeck=null, failedDeck=null, failedModules=new Set();
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');let content,file;
   if(failedModules.has(url.pathname.slice(1))){res.writeHead(404,{'content-type':'text/plain','cache-control':'no-store'});res.end('fixture missing module');return;}
   if(url.pathname.startsWith('/app/')){
    file=path.join(stageRoot,'dist',path.basename(url.pathname));
    content=mode==='baseline' && ['index.html','app.js','style.css'].includes(path.basename(file))?await baselineFile(path.basename(file)):await readFile(file);
   }else{
    file=path.join(site,decodeURIComponent(url.pathname));
    try{content=await readFile(file);}catch{
     const deck=manifest.decks.find(d=>url.pathname.startsWith(`/${d.id.split('/').map(encodeURIComponent).join('/')}/`));
     file=deck?path.join(site,deck.id,'index.html'):path.join(site,'index.html');
     try{content=await readFile(file);}catch{file=path.join(site,'index.html');content=await readFile(file);}
    }
    if(path.extname(file)==='.html' && delayedDeck && url.pathname.startsWith(`/${delayedDeck}/`))await new Promise(resolve=>setTimeout(resolve,350));
    if(path.extname(file)==='.html' && failedDeck && url.pathname.startsWith(`/${failedDeck}/`))content='<head></head><body>fixture failed document</body>';
    if(path.extname(file)==='.html')content=content.toString().replace('<head>',`<head><script>${bridge}</script>`);
   }
   res.writeHead(200,{'content-type':mime[path.extname(file)] || 'application/octet-stream'});res.end(content);
  }catch(error){res.writeHead(404);res.end(String(error));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const context=await browser.newContext();const page=await context.newPage();
 page.on('pageerror',error=>console.error(mode,error.message));
 const navigations=[];page.on('request',request=>{if(request.isNavigationRequest() && request.frame()!==page.mainFrame())navigations.push(request.url());});
 await page.addInitScript(({origin,decks})=>{
  let session={deckId:decks[0].id,page:1,clickIndex:0,sessionRevision:0,blackout:false,timer:{elapsedMs:0,startedAt:null}};
  const listeners=[];
  window.__TAURI__={core:{invoke:async(command,args)=>{
   if(command==='snapshot')return {decks,viewerOrigin:origin,session};
   if(command==='transition'){
    const action=args.input.action;
    if(action.kind==='selectDeck'){session={...session,deckId:action.value,page:1,clickIndex:0};}
    if(action.kind==='next'){const total=decks.find(d=>d.id===session.deckId).clickTotals[session.page-1];session=session.clickIndex<total?{...session,clickIndex:session.clickIndex+1}:{...session,page:Math.min(3,session.page+1),clickIndex:0};}
    session={...session,sessionRevision:session.sessionRevision+1};listeners.forEach(listener=>listener({payload:session}));return session;
   }
   if(command==='viewer_ready')return;
   throw new Error(`unexpected command ${command}`);
  }},event:{listen:async(name,listener)=>listeners.push(listener)}};
  window.__flickerSamples=[];
  const sample=()=>{
   const frames=[...document.querySelectorAll('#viewer>iframe')];
   if(frames.length){const active=document.getElementById('deck');let visible=false;try{visible=[...active.contentDocument.querySelectorAll('#slide-content .slidev-page')].some(el=>{const style=active.contentWindow.getComputedStyle(el);return style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)!==0 && !!el.textContent.trim() && !el.textContent.includes('Loading slide...');});}catch{}
   window.__flickerSamples.push({at:performance.now(),blank:!visible,frames:frames.length});}
   requestAnimationFrame(sample);
  };requestAnimationFrame(sample);
 },{origin,decks:manifest.decks.map(d=>({id:d.id,clickTotals:[0,2,0]}))});
 await page.goto(`${origin}/app/index.html?role=audience`);
 const waitRendered=()=>page.waitForFunction(()=>{
  const p=window.__nativePoc,s=p?.getState();if(!s)return false;
  const r=p.rendered.get(`${p.getOrigin()}/${s.deckId}/${s.page}?clicks=${s.clickIndex}&embedded=true`);
  return r?.loaded && r.page===s.page && (!p.frames || r.sessionRevision===s.sessionRevision);
 },{},{timeout:20000});
 try { await waitRendered(); } catch(error) { console.error(await page.evaluate(()=>({state:window.__nativePoc?.getState(),rendered:[...(window.__nativePoc?.rendered || [])],status:document.getElementById('status')?.textContent,frames:[...document.querySelectorAll('iframe')].map(f=>({src:f.src,text:f.contentDocument?.body?.textContent?.slice(0,500)}))})));throw error; }
 await page.evaluate(()=>{window.__flickerSamples=[];});
 const initialNav=navigations.length;const latencies=[];
 for(let i=0;i<4;i++){const start=Date.now();await page.evaluate(()=>window.__nativePoc.action('next'));await waitRendered();latencies.push(Date.now()-start);}
 const sameDeck=await page.evaluate(()=>({samples:window.__flickerSamples,stats:window.__nativePoc.frames?.stats,state:window.__nativePoc.getState()}));
 sameDeck.navigationRequests=navigations.length-initialNav;sameDeck.readyLatenciesMs=latencies;
 sameDeck.documentLoads=navigations.length;
 sameDeck.blankDOMFrames=sameDeck.samples.filter(s=>s.blank).length;sameDeck.sampledFrames=sameDeck.samples.length;delete sameDeck.samples;
 const beforeSwitch=navigations.length;await page.evaluate(()=>{window.__flickerSamples=[];});
 const start=Date.now();await page.evaluate(()=>window.__nativePoc.action('selectDeck','bbb/bbb1'));await waitRendered();
 const switching=await page.evaluate(()=>({blankDOMFrames:window.__flickerSamples.filter(s=>s.blank).length,sampledFrames:window.__flickerSamples.length,frameCount:document.querySelectorAll('#viewer>iframe').length,stats:window.__nativePoc.frames?.stats}));
 switching.readyLatencyMs=Date.now()-start;switching.navigationRequests=navigations.length-beforeSwitch;
 results.runs[mode]={sameDeck,switching};
 if(mode==='persistent'){
  const checks=[];const check=(name,pass)=>{checks.push({name,pass});if(!pass)throw new Error(name);};
  delayedDeck='aaa/aaa2';
  const oldDeck=await page.evaluate(()=>window.__nativePoc.frames.active.deckId);
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','aaa/aaa2'));
  check('old frame visible while B document delayed',await page.evaluate(oldDeck=>window.__nativePoc.frames.active.deckId===oldDeck,oldDeck));
  const blockedRevision=await page.evaluate(()=>window.__nativePoc.getState().sessionRevision);
  await page.evaluate(()=>{const p=window.__nativePoc,s=p.frames.active;s.frame.contentWindow.postMessage({nativeTestKey:'Enter'},'*');});
  await page.waitForTimeout(80);
  check('old-deck keyboard cannot mutate pending deck',await page.evaluate(r=>window.__nativePoc.getState().sessionRevision===r,blockedRevision));
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','bbb/bbb1'));await waitRendered();
  await page.waitForTimeout(400);
  check('rapid A-B-A settles A despite delayed B',await page.evaluate(()=>window.__nativePoc.frames.active.deckId==='bbb/bbb1' && window.__nativePoc.getState().deckId==='bbb/bbb1'));
  await page.evaluate(()=>{const s=window.__nativePoc.frames.standby;s.frame.contentWindow.eval(`parent.postMessage(${JSON.stringify({nativeFailure:{documentToken:s.token,mount:s.mount,message:'stale fixture failure'}})},'*')`);});
  await page.waitForTimeout(50);
  check('cancelled standby failure cannot replace current status',await page.evaluate(()=>!document.getElementById('status').textContent.includes('stale fixture failure')));
  await page.evaluate(async()=>{await window.__nativePoc.action('selectDeck','aaa/aaa2');await window.__nativePoc.action('selectDeck','bbb/bbb2');});await waitRendered();await page.waitForTimeout(400);
  check('rapid B-C settles latest C',await page.evaluate(()=>window.__nativePoc.frames.active.deckId==='bbb/bbb2' && document.querySelectorAll('#viewer>iframe').length===2));
  const rev=await page.evaluate(()=>window.__nativePoc.getState().sessionRevision);
  await page.evaluate(()=>{const p=window.__nativePoc;p.frames.standby.frame.contentWindow.postMessage({nativeTestKey:'Enter'},'*');p.frames.active.frame.contentWindow.eval("parent.postMessage({nativeInput:'next',documentToken:'stale-token'},'*')");});
  await page.waitForTimeout(80);
  check('standby and stale-document input rejected',await page.evaluate(r=>window.__nativePoc.getState().sessionRevision===r,rev));
  const ackCount=await page.evaluate(()=>window.__nativePoc.frames.stats.acknowledgements);
  await page.evaluate(()=>{const p=window.__nativePoc,s=p.frames.active;s.frame.contentWindow.eval(`parent.postMessage(${JSON.stringify({nativeRendered:{deckId:s.deckId,page:1,clickIndex:0,loaded:true,documentToken:s.token,sessionRevision:0}})},'*')`);});
  await page.waitForTimeout(80);
  check('stale render acknowledgement rejected',await page.evaluate(count=>window.__nativePoc.frames.stats.acknowledgements===count,ackCount));
  // Force an actual unavailable document, then wait for the bounded failure.
  failedDeck='aaa/aaa1';delayedDeck=null;
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','aaa/aaa1'));
  await page.waitForFunction(()=>/タイムアウト|runtime hook unavailable/.test(document.getElementById('status').textContent),{},{timeout:18000});
  check('failed new document keeps previous frame visible with error',await page.evaluate(()=>window.__nativePoc.frames.active.deckId==='bbb/bbb2' && !document.getElementById('deck').classList.contains('native-standby')));
  failedDeck=null;
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','aaa/aaa1'));await waitRendered();
  check('restored document retries same failed deck successfully',await page.evaluate(()=>window.__nativePoc.frames.active.deckId==='aaa/aaa1'));
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','bbb/bbb2'));await waitRendered();
  failedModules=new Set(manifest.decks.find(d=>d.id==='aaa/aaa2').assets.filter(asset=>/\/md-[^/]+\.js$/.test(asset)));
  await page.evaluate(()=>window.__nativePoc.action('selectDeck','aaa/aaa2'));
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('slide module failed to load'),{},{timeout:15000});
  check('failed slide module cannot acknowledge or replace old frame',await page.evaluate(()=>window.__nativePoc.frames.active.deckId==='bbb/bbb2'));
  await page.evaluate(()=>{const p=window.__nativePoc,s=p.frames.active;for(const state of [{page:2,clickIndex:1,sessionRevision:100},{page:3,clickIndex:0,sessionRevision:102},{page:1,clickIndex:0,sessionRevision:101}])s.frame.contentWindow.postMessage({nativeState:{deckId:s.deckId,...state}},'*');});
  await page.waitForFunction(()=>window.__nativePoc.frames.active.frame.contentWindow.__slidevLabNative.router.currentRoute.value.path==='/3');
  await page.waitForTimeout(150);
  check('out-of-order states settle newest revision',await page.evaluate(()=>window.__nativePoc.frames.active.frame.contentWindow.__slidevLabNative.router.currentRoute.value.path==='/3'));
  results.runs[mode].raceChecks=checks;
 }
 await page.screenshot({path:await (async()=>{await mkdir(output,{recursive:true});return path.join(output,`${mode}.png`);})()});
 await context.close();await new Promise(resolve=>server.close(resolve));
}
await browser.close();
await writeFile(path.join(output,'result.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
if(results.runs.persistent.sameDeck.navigationRequests!==0 || results.runs.persistent.sameDeck.blankDOMFrames!==0 || results.runs.persistent.switching.blankDOMFrames!==0 || results.runs.persistent.switching.frameCount>2)process.exitCode=1;
