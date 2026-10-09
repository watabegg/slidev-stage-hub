import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HubBuildError } from './config.js';

export async function withBuildWorkspace<T>(
  outDir: string,
  action: (workDir: string) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(outDir), { recursive: true });
  const lockPath = join(dirname(outDir), `.${basename(outDir)}.build-lock`);
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    throw new HubBuildError('OUTPUT_BUSY', `Cannot acquire build lock for ${outDir}`, {
      cause: error,
    });
  }
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(dirname(outDir), `.${basename(outDir)}.build-`));
    return await action(workDir);
  } finally {
    try {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Two filesystem renames cannot be one transaction. Roll back both paths on
// ordinary failures; the build lock excludes competing writers to this output.
export async function promoteBuild(
  site: string,
  receipt: string | undefined,
  outDir: string,
  workDir: string,
): Promise<void> {
  const targets = [outDir, `${outDir}.receipt.json`];
  const sources = [site, receipt];
  const backups = targets.map((_, index) => join(workDir, `previous-${index}`));
  const saved: number[] = [];
  const installed: number[] = [];
  try {
    for (const [index, target] of targets.entries()) {
      if (await exists(target)) {
        await rename(target, backups[index]!);
        saved.push(index);
      }
    }
    for (const [index, target] of targets.entries()) {
      if (sources[index] === undefined) continue;
      await rename(sources[index]!, target);
      installed.push(index);
    }
  } catch (error) {
    try {
      for (const index of installed.reverse())
        await rm(targets[index]!, { recursive: true, force: true });
      for (const index of saved.reverse()) await rename(backups[index]!, targets[index]!);
    } catch (rollback) {
      // Do not let outer workspace cleanup erase the only recoverable copy.
      const recovery = `${outDir}.recovery-${Date.now()}`;
      await rename(workDir, recovery);
      throw new HubBuildError(
        'OUTPUT_RECOVERY',
        `Output rollback failed; recovery files: ${recovery}`,
        { cause: new AggregateError([error, rollback]) },
      );
    }
    throw new HubBuildError('OUTPUT', 'Could not promote the completed Hub build', {
      cause: error,
    });
  }
}
