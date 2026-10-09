import {spawn} from 'node:child_process'
import {appendFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
const destination=resolve('../../../artifacts/workers/cloud-tail.jsonl')
mkdirSync(resolve('../../../artifacts/workers'),{recursive:true})
const child=spawn('pnpm',['exec','wrangler','tail','--config','wrangler.cloud.json','--format','json'],{env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'23f5eafcd8c9e8750ac3737b433e1aad'},stdio:['ignore','pipe','pipe']})
let buffer='',depth=0,inString=false,escape=false
child.stdout.on('data',chunk=>{
 for(const char of chunk.toString()){
  if(depth===0){if(char!=='{')continue;buffer='';inString=false;escape=false}
  buffer+=char
  if(inString){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')inString=false}
  else if(char==='"')inString=true
  else if(char==='{')depth++
  else if(char==='}')depth--
  if(depth===0){try{const e=JSON.parse(buffer);const url=e.event?.request?.url;const item={time:e.eventTimestamp,outcome:e.outcome,method:e.event?.request?.method,path:url?new URL(url).pathname:undefined,status:e.event?.response?.status,cpuTime:e.cpuTime,wallTime:e.wallTime,exceptions:e.exceptions?.map(x=>({name:x.name,message:x.message})),fields:Object.keys(e)};appendFileSync(destination,JSON.stringify(item)+'\n');if(item.path?.startsWith('/api/'))console.log(JSON.stringify(item))}catch{}buffer=''}
 }
})
child.stderr.on('data',chunk=>{const text=chunk.toString();if(/error/i.test(text))console.error('Tail CLI reported an error; inspect account/log permission.')})
child.on('exit',code=>{console.log('Tail stopped',code);process.exitCode=code||0})
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill('SIGTERM'))
console.log('Tail process started; only sanitized event fields are saved.')
