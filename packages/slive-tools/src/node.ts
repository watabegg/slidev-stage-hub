export {
  canonicalEntryForId,
  inspectDeckSource,
  loadSlidevParser,
  readManifestIfPresent,
  resolveManifestSources,
  validateManifest,
} from './prepare-core.mjs';
export { fetchPlayerDocument, normalizeOrigin, validatePlayerDocument } from './connect-core.mjs';
export { readAuthHeadersFile } from './auth-headers.mjs';
