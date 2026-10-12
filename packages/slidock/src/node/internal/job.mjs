import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngine } from './profiles.mjs';

export async function runJobFile(jobPath) {
  if (typeof jobPath !== 'string' || !isAbsolute(jobPath))
    throw new Error('Hub job entry requires an absolute JSON job path');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  return buildEngine(job);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Hub job entry requires an absolute JSON job path');
  await runJobFile(process.argv[2]);
}
