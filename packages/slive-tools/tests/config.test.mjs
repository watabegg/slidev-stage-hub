import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { StageToolsError, withConfigLock, writeConfigAtomically } from '../dist/config.js';

test('config updates hold an exclusive private lock and release it after success or failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stage-tools-lock-'));
  const configPath = path.join(directory, 'local-config.json');
  const config = {
    schemaVersion: 1,
    decks: [],
    notes: {},
    approvedSourceRoot: directory,
    viewerOrigin: 'https://slides.example.com',
  };
  try {
    await withConfigLock(configPath, async (canonicalPath) => {
      assert.equal(canonicalPath, configPath);
      assert.equal((await lstat(`${configPath}.lock`)).mode & 0o777, 0o600);
      await assert.rejects(
        withConfigLock(configPath, async () => {}),
        (error) => error instanceof StageToolsError && error.code === 'CONFIG_LOCKED',
      );
      await writeConfigAtomically(canonicalPath, config);
    });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);

    await assert.rejects(
      withConfigLock(configPath, async () => {
        throw new Error('injected config update failure');
      }),
      /injected config update failure/,
    );
    await assert.rejects(lstat(`${configPath}.lock`), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
