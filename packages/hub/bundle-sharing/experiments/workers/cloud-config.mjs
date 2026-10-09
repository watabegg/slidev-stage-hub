import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises'
import {createHash,randomBytes} from 'node:crypto'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
const here=dirname(fileURLToPath(import.meta.url))
const artifacts=resolve(here,'../../../artifacts/workers')
await mkdir(artifacts,{recursive:true})
const workerPath=resolve(artifacts,'cloud-worker.mjs')
await build({entryPoints:[resolve(here,'worker.mjs')],outfile:workerPath,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers','node:*'],define:{'process.env.NODE_ENV':'"production"'}})
const profileText=await readFile(resolve(artifacts,'site/runtime-manifest.json'),'utf8')
const profile=JSON.parse(profileText)
const digest=createHash('sha256').update(profileText).update(await readFile(workerPath)).digest('hex')
const config={
 '$schema':'./node_modules/wrangler/config-schema.json',name:'slidev-lab-poc',account_id:'23f5eafcd8c9e8750ac3737b433e1aad',main:'worker.mjs',
 compatibility_date:'2026-10-09',compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,
 assets:{directory:'../../../artifacts/workers/site',binding:'STATIC',not_found_handling:'single-page-application',run_worker_first:true},
 r2_buckets:[{binding:'FILES',bucket_name:'slidev-lab-poc-20261009'}],
 durable_objects:{bindings:[{name:'VERSIONS',class_name:'DeckVersions'}]},migrations:[{tag:'v1',new_sqlite_classes:['DeckVersions']}],
 browser:{binding:'BROWSER'},
 vars:{LOCAL_MUTATIONS:'false',PROFILE_DIGEST:digest,PROFILE_LAYOUTS:JSON.stringify(profile.layouts),PROFILE_COMPONENTS:JSON.stringify(profile.components)},
 observability:{enabled:true,traces:{enabled:true}}
}
await writeFile(resolve(here,'wrangler.cloud.json'),JSON.stringify(config,null,2)+'\n')
const tokenFile=resolve(artifacts,'publish-token')
let token
try{token=(await readFile(tokenFile,'utf8')).trim()}catch(error){if(error.code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await writeFile(tokenFile,token+'\n',{mode:0o600})}
await chmod(tokenFile,0o600)
const secretsFile=resolve(artifacts,'cloud-secrets.json')
await writeFile(secretsFile,JSON.stringify({PUBLISH_TOKEN:token}),{mode:0o600});await chmod(secretsFile,0o600)
console.log(JSON.stringify({config:'wrangler.cloud.json',profileDigest:digest,secretsFile,tokenFile}))
