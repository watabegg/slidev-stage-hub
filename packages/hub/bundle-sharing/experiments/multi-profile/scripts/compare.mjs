import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(experiment, '../../..');
async function run(extra) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(experiment, '../module-graph/build.mjs')], {
      env: { ...process.env, SLIDEV_LAB_CONFIG: resolve(experiment, 'config.json'), ...extra },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? accept() : reject(new Error(`build exit ${code}`))));
  });
}
await run({ SLIDEV_LAB_ARTIFACT_NAME: 'multi-profile', SLIDEV_LAB_ISOLATE_DECKS: '0' });
await run({ SLIDEV_LAB_ARTIFACT_NAME: 'multi-profile-isolated', SLIDEV_LAB_ISOLATE_DECKS: '1' });
const grouped = JSON.parse(
  await readFile(resolve(root, 'artifacts/multi-profile/build-metrics.json')),
);
const isolated = JSON.parse(
  await readFile(resolve(root, 'artifacts/multi-profile-isolated/build-metrics.json')),
);
const comparison = {
  grouped: {
    rawBytes: grouped.totalRawBytes,
    gzipBytes: grouped.totalGzipBytes,
    files: grouped.fileCount,
    groups: grouped.groupCount,
  },
  isolated: {
    rawBytes: isolated.totalRawBytes,
    gzipBytes: isolated.totalGzipBytes,
    files: isolated.fileCount,
    groups: isolated.groupCount,
  },
  rawReductionPercent: (1 - grouped.totalRawBytes / isolated.totalRawBytes) * 100,
  gzipReductionPercent: (1 - grouped.totalGzipBytes / isolated.totalGzipBytes) * 100,
  deckCount: grouped.deckCount,
  note: 'Same8 fixtures, same adapter/minification/thumbnails; isolated builds one fresh graph/deck. Grouped builds one graph per actual compatibility signature. No hashed asset bytes rewritten.',
};
await writeFile(
  resolve(root, 'artifacts/multi-profile/comparison.json'),
  JSON.stringify(comparison, null, 2) + '\n',
);
console.log(JSON.stringify(comparison, null, 2));
