import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeProfile } from '../../../dist/node/internal/profile-probe.mjs';

export { probeProfile };

async function runProbeFile(jobPath) {
  if (!jobPath || !isAbsolute(jobPath))
    throw new Error('profile probe requires an absolute job JSON path');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  const sourceRoot = job.sourceRoot || job.fixturesRoot;
  if (!sourceRoot || !isAbsolute(sourceRoot))
    throw new Error('profile probe job requires an absolute sourceRoot or fixturesRoot');
  if (!job.output || !isAbsolute(job.output))
    throw new Error('profile probe job requires an absolute output path');
  await writeFile(job.output, JSON.stringify(await probeProfile({ ...job, sourceRoot }), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runProbeFile(process.argv[2]);
}
