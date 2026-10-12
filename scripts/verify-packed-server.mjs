import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packServer } from './pack-server.mjs';
import { runProcess } from './pack-cli.mjs';
const destination = await mkdtemp(join(tmpdir(), 'hub-server-install-'));
const output = resolve('artifacts/portability');
await mkdir(output, { recursive: true });
try {
  const result = await packServer(destination);
  const install = await runProcess('pnpm', ['install', '--ignore-scripts'], { cwd: destination });
  await writeFile(join(output, 'packed-install.log'), install.stdout + install.stderr);
  if (install.code !== 0) throw new Error('Private server package installation failed');
  await writeFile(
    join(destination, 'verify.mjs'),
    `
import assert from 'node:assert/strict';
import { createHubServer, runPublicationJob } from '@slidock/server';
import { createFileArtifactStore, createMemoryPublicationJobStore, startHubServer } from '@slidock/adapter-node';
import { createS3ArtifactStore } from '@slidock/storage-s3';
import { createGcsArtifactStore } from '@slidock/storage-gcs';
import { createPostgresPublicationStore } from '@slidock/state-postgres';
import { createPlaywrightThumbnailRenderer } from '@slidock/renderer-playwright';
import { createCloudflareOptions } from '@slidock/adapter-cloudflare';
for (const factory of [createS3ArtifactStore,createGcsArtifactStore,createPostgresPublicationStore,createCloudflareOptions,createPlaywrightThumbnailRenderer]) assert.equal(typeof factory,'function');
const jobs=createMemoryPublicationJobStore();
const options={artifacts:createFileArtifactStore({root:'./objects'}),publications:jobs.publications,jobs,staticAssets:{fetch:async()=>new Response('static')},profile:{digest:'packed-profile'},allowLocalMutations:true};
const server=createHubServer(options);
const http=await startHubServer({server,port:0});
try {
const response=await fetch(http.origin+'/api/decks/packed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({markdown:'# Packed server'})});
assert.equal(response.status,200,await response.clone().text());
const manifest=await response.json(); assert.ok(manifest.published); assert.equal((await fetch(http.origin+manifest.slides[0].module)).status,200);
const jobId=crypto.randomUUID();
const accepted=await fetch(http.origin+'/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId,deckId:'packed',markdown:'# Packed job',thumbnail:'none',viewToken:'A'.repeat(43)})});
assert.equal(accepted.status,202,await accepted.clone().text());
assert.equal(await runPublicationJob(options),true);
const status=await fetch(http.origin+'/api/jobs/'+jobId+'?deckId=packed');
assert.equal(status.status,200); assert.equal((await status.json()).job.status,'succeeded');
} finally {await http.close();}
console.log('Packed server publication passed');
`,
  );
  const probe = await runProcess(process.execPath, ['verify.mjs'], { cwd: destination });
  await writeFile(join(output, 'packed-probe.log'), probe.stdout + probe.stderr);
  if (probe.code !== 0) throw new Error('Private server package verification failed');
  await writeFile(
    join(output, 'packed.json'),
    JSON.stringify({ status: 'passed', packages: result.packages, cloudDeployed: false }, null, 2) +
      '\n',
  );
  console.log('Packed server installation and HTTP publication passed');
} finally {
  await rm(destination, { recursive: true, force: true });
}
