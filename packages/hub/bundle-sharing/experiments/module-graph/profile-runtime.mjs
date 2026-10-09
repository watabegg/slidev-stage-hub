import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const supportedVersions = new Set(['52.15.2', '53.0.0']);

export async function resolveRuntime(dependencyRoot) {
  const require = createRequire(join(dependencyRoot, 'package.json'));
  const cliEntry = await realpath(require.resolve('@slidev/cli/dist/index.mjs'));
  const cliRequire = createRequire(cliEntry);
  const cliPackage = cliRequire.resolve('@slidev/cli/package.json');
  const clientPackage = cliRequire.resolve('@slidev/client/package.json');
  const cliVersion = JSON.parse(await readFile(cliPackage, 'utf8')).version;
  const clientVersion = JSON.parse(await readFile(clientPackage, 'utf8')).version;
  if (cliVersion !== clientVersion || !supportedVersions.has(cliVersion)) {
    throw new Error(
      `Internal adapters support exact CLI/client 52.15.2 or 53.0.0 pairs; found ${cliVersion}/${clientVersion}`,
    );
  }
  return {
    cliEntry,
    cliRequire,
    cliVersion,
    clientVersion,
    clientRoot: dirname(clientPackage),
    api: await import(pathToFileURL(cliEntry)),
  };
}

// Conservative: differing compiler/configuration inputs get separate graphs.
// Presentation labels are supplied through each deck's runtime config facade.
const runtimeOnlyFields = new Set([
  'title',
  'slidesTitle',
  'titleTemplate',
  'author',
  'keywords',
  'info',
  'seoMeta',
]);
export function compileContract(options) {
  const config = Object.fromEntries(
    Object.entries(options.data.config).filter(([key]) => !runtimeOnlyFields.has(key)),
  );
  return {
    features: options.data.features,
    config,
    roots: options.roots,
    clientRoot: options.clientRoot,
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
