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
import { createHubServer } from '@slidev-stage-hub/server';
import { createFileArtifactStore, createMemoryPublicationStore, startHubServer } from '@slidev-stage-hub/adapter-node';
import { createS3ArtifactStore } from '@slidev-stage-hub/storage-s3';
import { createGcsArtifactStore } from '@slidev-stage-hub/storage-gcs';
import { createPostgresPublicationStore } from '@slidev-stage-hub/state-postgres';
import { createCloudflareOptions } from '@slidev-stage-hub/adapter-cloudflare';
for (const factory of [createS3ArtifactStore,createGcsArtifactStore,createPostgresPublicationStore,createCloudflareOptions]) assert.equal(typeof factory,'function');
const server=createHubServer({artifacts:createFileArtifactStore({root:'./objects'}),publications:createMemoryPublicationStore(),staticAssets:{fetch:async()=>new Response('static')},profile:{digest:'packed-profile'},allowLocalMutations:true});
const http=await startHubServer({server,port:0});
try {
const response=await fetch(http.origin+'/api/decks/packed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({markdown:'# Packed server'})});
assert.equal(response.status,200,await response.clone().text());
const manifest=await response.json(); assert.ok(manifest.published); assert.equal((await fetch(http.origin+manifest.slides[0].module)).status,200);
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
