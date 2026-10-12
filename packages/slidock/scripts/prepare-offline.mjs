import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBuildWorkspace, promoteBuild } from '../dist/node/artifacts.js';
import { prepareOfflineSite } from '../dist/node/offline.js';

const HUB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function prepareOffline(source, target) {
  if (source === target || isInside(source, target) || isInside(target, source))
    throw new Error('source and output must be separate trees');
  const artifactsRoot = join(HUB_ROOT, 'artifacts');
  if (target === artifactsRoot || !isInside(artifactsRoot, target))
    throw new Error('offline output must be under this repository artifacts/');

  return withBuildWorkspace(target, async (workDir) => {
    const staging = join(workDir, 'site');
    await mkdir(staging, { recursive: true });
    await cp(source, staging, { recursive: true });

    const sourceReceiptPath = source + '.receipt.json';
    let stagedReceiptPath;
    if (await exists(sourceReceiptPath)) {
      const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath, 'utf8'));
      if (!record(sourceReceipt)) throw new Error('source receipt must be a JSON object');
      const stagedReceipt = join(workDir, 'receipt.json');
      await writeFile(
        stagedReceipt,
        JSON.stringify({ ...sourceReceipt, output: target }, null, 2) + '\n',
        { mode: 0o600 },
      );
      stagedReceiptPath = stagedReceipt;
    }

    const offline = await prepareOfflineSite({ siteRoot: staging, workDir });
    const metrics = JSON.parse(await readFile(join(workDir, 'offline-metrics.json'), 'utf8'));
    const vendorReport = JSON.parse(await readFile(join(workDir, 'font-vendor.json'), 'utf8'));

    const { siteRoot: _stagingRoot, workDir: _workDir, ...legacyMetrics } = metrics;
    const outputMetrics = { source, target, ...legacyMetrics };
    vendorReport.siteRoot = target;

    await promoteBuild(staging, stagedReceiptPath, target, workDir);

    await writeFile(
      join(dirname(target), 'font-vendor.json'),
      JSON.stringify(vendorReport, null, 2) + '\n',
    );
    await writeFile(
      join(dirname(target), 'offline-metrics.json'),
      JSON.stringify(outputMetrics, null, 2) + '\n',
    );

    return {
      target,
      fileCount: outputMetrics.fileCount,
      rawBytes: outputMetrics.rawBytes,
      gzipBytes: outputMetrics.gzipBytes,
      changedFaviconFiles: outputMetrics.changedFaviconFiles,
      snapshotSha256: offline.snapshotSha256,
      renamedAssets: offline.renamedAssets,
    };
  });
}

async function main() {
  const [sourceArgument, targetArgument] = process.argv.slice(2);
  const source = resolve(sourceArgument || 'artifacts/module-graph/site');
  const target = resolve(targetArgument || 'artifacts/module-graph-offline/site');
  const result = await prepareOffline(source, target);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
