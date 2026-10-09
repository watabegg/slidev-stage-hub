import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@slidev-stage-hub/slidev-adapter/runtime';

// Installed by the workspace lockfile; no dependency on another checkout's store.
const dependencyRoot = fileURLToPath(
  new URL('../../../../../../examples/slidev52/', import.meta.url),
);
const { cliEntry, cliVersion, clientVersion } = await resolveRuntime(dependencyRoot);
console.log(JSON.stringify({ dependencyRoot, cliEntry, cliVersion, clientVersion }, null, 2));
