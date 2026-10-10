import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
