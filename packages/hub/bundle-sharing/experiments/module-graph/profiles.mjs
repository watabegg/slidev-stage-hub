import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildHub } from '../../../dist/node/index.js';
import { legacyOptions } from '../../../scripts/legacy-options.mjs';
import { hubRoot } from '../../../scripts/runtime-environment.mjs';

export async function persistDiagnostics(result) {
  const artifactRoot = dirname(result.output);
  const writePrivateJson = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await chmod(path, 0o600);
  };

  if (result.diagnostics?.chunkGraph)
    await writePrivateJson(join(artifactRoot, 'chunk-graph.json'), result.diagnostics.chunkGraph);
  for (const [id, graph] of Object.entries(result.diagnostics?.groups || {}))
    await writePrivateJson(join(artifactRoot, 'groups', id, 'chunk-graph.json'), graph);
  return result;
}

export async function buildProfiles({ configPath, root = hubRoot } = {}) {
  const env = {
    ...process.env,
    ...(configPath ? { SLIDEV_LAB_CONFIG: resolve(configPath) } : {}),
  };
  const options = await legacyOptions(env);
  const artifactName = env.SLIDEV_LAB_ARTIFACT_NAME || 'module-graph';
  const outDir = options.outDir || resolve(root, 'artifacts', artifactName, 'site');
  return persistDiagnostics(await buildHub({ ...options, offline: false, outDir }));
}
