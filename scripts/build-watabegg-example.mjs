import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildHub } from '@slidev-stage-hub/hub';
import { repositoryRoot } from './runtime-environment.mjs';
const require = createRequire(import.meta.url);
const result = await buildHub({
  sourceRoot: join(repositoryRoot, 'examples/watabegg'),
  outDir: join(repositoryRoot, 'packages/hub/artifacts/example-watabegg-offline/site'),
  theme: dirname(require.resolve('slidev-theme-watabegg/package.json')),
  chromiumExecutable: process.env.CHROMIUM_EXECUTABLE,
  onProgress: ({ phase }) => console.log(`Hub: ${phase}`),
});
console.log(result.output);
