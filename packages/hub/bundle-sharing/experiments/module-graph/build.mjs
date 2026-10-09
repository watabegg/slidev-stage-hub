import { resolve } from 'node:path';
import { buildHub } from '../../../dist/node/index.js';
import { legacyOptions } from '../../../scripts/legacy-options.mjs';
import { hubRoot } from '../../../scripts/runtime-environment.mjs';
import { persistDiagnostics } from './profiles.mjs';

const options = await legacyOptions();
const env = process.env;
const artifactName =
  env.SLIDEV_LAB_ARTIFACT_NAME ||
  (options.profiles
    ? 'module-graph'
    : options.bootstrap === 'tla'
      ? 'module-graph-tla'
      : 'module-graph');
const outDir = options.outDir || resolve(hubRoot, 'artifacts', artifactName, 'site');
const result = await persistDiagnostics(await buildHub({ ...options, offline: false, outDir }));

console.log(JSON.stringify({ outDir: result.output, deckCount: result.catalog.decks.length }));
