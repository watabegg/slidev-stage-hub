import { resolve } from 'node:path';
import { buildHub } from '../dist/node/index.js';
import { legacyOptions } from './legacy-options.mjs';
import { hubRoot } from './runtime-environment.mjs';

const options = await legacyOptions();
const outDir = options.outDir || resolve(hubRoot, 'artifacts/module-graph-offline/site');
const result = await buildHub({ ...options, offline: true, outDir });

console.log(JSON.stringify({ outDir: result.output, deckCount: result.catalog.decks.length }));
