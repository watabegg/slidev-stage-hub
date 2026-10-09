import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { categoriesForDecks } from './catalog.mjs';
import { buildGraph } from './graph.mjs';

const jobScript = fileURLToPath(new URL('./job.mjs', import.meta.url));
const probeScript = fileURLToPath(new URL('./profile-probe.mjs', import.meta.url));
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new Error(`${name} must be an absolute path`);
}

function validateCoreJob(job) {
  for (const name of ['sourceRoot', 'workDir', 'dependencyRoot', 'theme', 'frontendRoot'])
    requireAbsolute(job[name], name);
  if (job.bootstrap !== 'sync' && job.bootstrap !== 'tla')
    throw new Error("bootstrap must be 'sync' or 'tla'");
  if (typeof job.offline !== 'boolean' || typeof job.isolateDecks !== 'boolean')
    throw new Error('offline and isolateDecks must be booleans');
  if (job.chromiumExecutable !== undefined)
    requireAbsolute(job.chromiumExecutable, 'chromiumExecutable');
}

function run(script, jobPath, workDir) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, jobPath], {
      cwd: workDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const status = signal ? `signal ${signal}` : `exit ${code}`;
        reject(new Error(`${script} failed (${status})\n${output.slice(-2500)}`));
      } else accept(output);
    });
  });
}

async function measureSite(site) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const bytes = await readFile(file);
        if (bytes.includes(Buffer.from('PRIVATE_NOTE_')))
          throw new Error(`Private notes leaked: ${file}`);
        files.push({
          path: relative(site, file),
          rawBytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
        });
      }
    }
  }
  await walk(site);
  return files;
}

function validateProfileJob(job) {
  if (!job.profiles || !job.decks) throw new Error('Profile mode requires profiles and decks');
  for (const [id, profile] of Object.entries(job.profiles)) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      !profile?.dependencyRoot ||
      !profile?.theme ||
      Object.keys(profile).some((key) => !['dependencyRoot', 'theme'].includes(key))
    )
      throw new Error(`Profile ${id} requires exactly dependencyRoot and theme`);
    requireAbsolute(profile.dependencyRoot, `Profile ${id} dependencyRoot`);
    requireAbsolute(profile.theme, `Profile ${id} theme`);
  }
  if (!Array.isArray(job.decks) || job.decks.length === 0)
    throw new Error('Profile mode requires at least one deck');
  const ids = new Set();
  for (const deck of job.decks) {
    if (!deck || typeof deck.id !== 'string' || !deck.id || ids.has(deck.id))
      throw new Error(`Profile decks must have unique non-empty IDs; invalid ID: ${deck?.id}`);
    ids.add(deck.id);
    requireAbsolute(deck.entry, `Deck ${deck.id} entry`);
    if (
      !Array.isArray(deck.categoryPath) ||
      deck.categoryPath.some((value) => typeof value !== 'string')
    )
      throw new Error(`Deck ${deck.id} categoryPath must be a string array`);
    if (!job.profiles[deck.profile])
      throw new Error(`Deck ${deck.id} requires an existing profile assignment`);
  }
}

async function buildProfiles(job) {
  validateProfileJob(job);
  const started = performance.now();
  const sourceRoot = resolve(job.sourceRoot);
  const workDir = resolve(job.workDir);
  await mkdir(workDir, { recursive: true });
  const jobs = await mkdtemp(join(workDir, '.profile-jobs-'));
  try {
    const decks = [...job.decks].sort((left, right) => compare(left.id, right.id));
    const groups = new Map();
    for (const [index, deck] of decks.entries()) {
      const profile = job.profiles[deck.profile];
      const output = join(jobs, `probe-${index}.json`);
      const jobFile = join(jobs, `probe-${index}-job.json`);
      await writeFile(jobFile, JSON.stringify({ profile, deck, sourceRoot, output }));
      await run(probeScript, jobFile, workDir);
      const probe = JSON.parse(await readFile(output, 'utf8'));
      const signature = job.isolateDecks
        ? createHash('sha256')
            .update(probe.signature + deck.id)
            .digest('hex')
        : probe.signature;
      const id = `g-${signature.slice(0, 16)}`;
      if (!groups.has(id))
        groups.set(id, {
          id,
          profile,
          ...probe,
          decks: [],
          assignments: {},
        });
      const group = groups.get(id);
      group.decks.push(deck);
      group.assignments[deck.id] = deck.profile;
    }

    const site = join(workDir, 'site');
    await rm(site, { recursive: true, force: true });
    await mkdir(site, { recursive: true });
    const allDecks = [];
    const groupDescriptions = [];
    const nativePlayer = { schemaVersion: 1, protocolVersion: 1, decks: [], unsupportedDecks: [] };
    let homeHtml;
    for (const group of groups.values()) {
      const groupWorkDir = join(workDir, 'groups', group.id);
      const childJob = {
        kind: 'group',
        sourceRoot,
        workDir: groupWorkDir,
        dependencyRoot: group.profile.dependencyRoot,
        theme: group.profile.theme,
        frontendRoot: job.frontendRoot,
        offline: job.offline,
        chromiumExecutable: job.chromiumExecutable,
        bootstrap: 'sync',
        isolateDecks: job.isolateDecks,
        group: {
          profile: group.profile,
          decks: group.decks,
          assignments: group.assignments,
          compile: group.contract.compile,
          assetBase: `/_profiles/${group.id}/`,
        },
      };
      const jobFile = join(jobs, `${group.id}.json`);
      await writeFile(jobFile, JSON.stringify(childJob, null, 2));
      await mkdir(groupWorkDir, { recursive: true });
      await run(jobScript, jobFile, groupWorkDir);
      const childSite = join(groupWorkDir, 'site');
      const prefix = `_profiles/${group.id}`;
      // Preserve each group's emitted Vite bytes and hashed filenames exactly.
      await cp(childSite, join(site, prefix), { recursive: true });
      const manifest = JSON.parse(await readFile(join(childSite, 'manifest.json'), 'utf8'));
      const player = JSON.parse(await readFile(join(childSite, 'native-player.json'), 'utf8'));
      nativePlayer.decks.push(...player.decks);
      nativePlayer.unsupportedDecks.push(...player.unsupportedDecks);
      const html = await readFile(join(childSite, 'index.html'), 'utf8');
      homeHtml ||= html;
      for (const deck of manifest.decks) {
        const deckIndex = `${deck.id}/index.html`;
        await mkdir(dirname(join(site, deckIndex)), { recursive: true });
        await writeFile(join(site, deckIndex), html);
        allDecks.push({
          ...deck,
          group: group.id,
          assets: [
            ...deck.assets.map((file) => `${prefix}/${file}`),
            deckIndex,
            `thumbnails/${deck.id}.png`,
          ],
        });
      }
      groupDescriptions.push({
        id: group.id,
        runtimeVersion: group.runtimeVersion,
        theme: group.theme,
        profiles: [...new Set(Object.values(group.assignments))],
        decks: group.decks.map((deck) => deck.id),
        assetBase: `/${prefix}/`,
        compatibility: group.signature,
      });
      console.log(
        `Built ${group.id}: Slidev ${group.runtimeVersion}, ${group.theme}, ${group.decks.length} decks`,
      );
    }
    allDecks.sort((left, right) => compare(left.id, right.id));
    nativePlayer.decks.sort((left, right) => compare(left.id, right.id));
    nativePlayer.unsupportedDecks.sort((left, right) => compare(left.id, right.id));
    await writeFile(join(site, 'native-player.json'), JSON.stringify(nativePlayer, null, 2) + '\n');
    const versions = [...new Set(allDecks.map((deck) => deck.runtimeVersion))];
    const manifest = {
      schemaVersion: 1,
      runtimeVersion: versions.length === 1 ? versions[0] : 'multiple',
      bootstrap: 'preload-then-sync-facades',
      routeMode: 'history',
      switching: 'document-navigation',
      notes: 'stripped',
      groups: groupDescriptions,
      commonAssets: [],
      decks: allDecks,
    };
    const catalog = {
      schemaVersion: 1,
      categories: categoriesForDecks(allDecks),
      decks: allDecks.map(
        ({
          id,
          title,
          entry,
          pages,
          revision,
          categoryPath,
          frontmatter,
          thumbnail,
          runtimeVersion,
          theme,
          profile,
        }) => ({
          id,
          title,
          entry,
          pages,
          revision,
          categoryPath,
          frontmatter,
          thumbnail,
          runtimeVersion,
          theme,
          profile,
        }),
      ),
    };
    await writeFile(join(site, 'index.html'), homeHtml);
    await writeFile(join(site, '404.html'), homeHtml);
    await writeFile(join(site, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(site, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    const files = await measureSite(site);
    const ownedAssets = new Set(allDecks.flatMap((deck) => deck.assets));
    manifest.commonAssets = files
      .map((file) => file.path)
      .filter((file) => !ownedAssets.has(file))
      .sort();
    await writeFile(join(site, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const manifestBytes = await readFile(join(site, 'manifest.json'));
    const manifestFile = files.find((file) => file.path === 'manifest.json');
    Object.assign(manifestFile, {
      rawBytes: manifestBytes.length,
      gzipBytes: gzipSync(manifestBytes).length,
    });
    const metrics = {
      elapsedMs: Math.round(performance.now() - started),
      mode: job.isolateDecks ? 'isolated-per-deck' : 'compatibility-groups',
      groupCount: groups.size,
      deckCount: decks.length,
      totalRawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
      totalGzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
      fileCount: files.length,
      files,
    };
    await writeFile(join(workDir, 'build-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    console.log(
      JSON.stringify({
        outDir: site,
        ...Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'files')),
      }),
    );
    return { site, manifest, catalog, nativePlayer, metrics };
  } finally {
    await rm(jobs, { recursive: true, force: true });
  }
}

export async function buildEngine(job) {
  if (job?.kind !== 'build' && job?.kind !== 'group')
    throw new Error(`Unsupported Hub build job kind: ${job?.kind}`);
  validateCoreJob(job);
  if (job?.kind === 'group') {
    if (!job.group?.profile || !Array.isArray(job.group.decks) || !job.group.compile)
      throw new Error('Group job requires group.profile, group.decks, and group.compile');
    return buildGraph(job);
  }
  if (job.profiles !== undefined) {
    if (job.decks === undefined)
      throw new Error('Profile mode requires profiles and decks together');
    return buildProfiles(job);
  }
  return buildGraph(job);
}
