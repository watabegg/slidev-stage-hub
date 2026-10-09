import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { categoriesForDecks, discoverDecks } from './catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
async function run(script, args, env, log) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
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
    child.on('close', async (code) => {
      try {
        await writeFile(log, output);
        if (code !== 0)
          reject(new Error(`${script} failed (${code}); see ${log}\n${output.slice(-2500)}`));
        else accept();
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function buildProfiles({ configPath, root, buildScript }) {
  const started = performance.now();
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || !config.fixturesRoot || !config.profiles || !config.decks)
    throw new Error('Profile config requires schemaVersion:1, fixturesRoot, profiles and decks');
  const configRoot = dirname(configPath);
  const fixturesRoot = resolve(configRoot, config.fixturesRoot);
  const decks = await discoverDecks(fixturesRoot);
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([id, value]) => {
      if (
        !/^[A-Za-z0-9_-]+$/.test(id) ||
        !value?.dependencyRoot ||
        !value?.theme ||
        Object.keys(value).some((key) => !['dependencyRoot', 'theme'].includes(key))
      )
        throw new Error(`Profile ${id} requires exactly dependencyRoot and theme`);
      return [
        id,
        {
          dependencyRoot: resolve(configRoot, value.dependencyRoot),
          theme: resolve(configRoot, value.theme),
        },
      ];
    }),
  );
  for (const deck of decks)
    if (!profiles[config.decks[deck.id]])
      throw new Error(`Deck ${deck.id} requires an existing profile assignment`);
  for (const id of Object.keys(config.decks))
    if (!decks.some((deck) => deck.id === id))
      throw new Error(`Configured deck ${id} was not discovered`);
  const artifactName = process.env.SLIDEV_LAB_ARTIFACT_NAME || 'module-graph';
  const artifactRoot = resolve(root, 'artifacts', artifactName);
  const site = join(artifactRoot, 'site');
  const jobs = join(artifactRoot, 'jobs');
  await mkdir(jobs, { recursive: true });
  const groups = new Map();
  for (const [index, deck] of decks.entries()) {
    const profileId = config.decks[deck.id];
    const output = join(jobs, `probe-${index}.json`);
    const jobFile = join(jobs, `probe-${index}-job.json`);
    await writeFile(
      jobFile,
      JSON.stringify({ profile: profiles[profileId], deck, fixturesRoot, output }),
    );
    // Every probe has fresh CLI module state too. Its cached user/setup roots
    // must not come from a previously inspected deck or theme.
    await run(join(here, 'profile-probe.mjs'), [jobFile], {}, join(jobs, `probe-${index}.log`));
    const probe = JSON.parse(await readFile(output, 'utf8'));
    const signature =
      process.env.SLIDEV_LAB_ISOLATE_DECKS === '1'
        ? createHash('sha256')
            .update(probe.signature + deck.id)
            .digest('hex')
        : probe.signature;
    const id = `g-${signature.slice(0, 16)}`;
    if (!groups.has(id))
      groups.set(id, { id, profile: profiles[profileId], ...probe, decks: [], assignments: {} });
    const group = groups.get(id);
    group.decks.push(deck);
    group.assignments[deck.id] = profileId;
  }
  await rm(site, { recursive: true, force: true });
  await mkdir(site, { recursive: true });
  const allDecks = [];
  const groupDescriptions = [];
  const nativePlayer = { schemaVersion: 1, protocolVersion: 1, decks: [], unsupportedDecks: [] };
  let homeHtml;
  for (const group of groups.values()) {
    const childName = `${artifactName}/groups/${group.id}`;
    const childSite = resolve(root, 'artifacts', childName, 'site');
    const jobFile = join(jobs, `${group.id}.json`);
    await writeFile(
      jobFile,
      JSON.stringify(
        {
          profile: group.profile,
          decks: group.decks,
          assignments: group.assignments,
          compile: group.contract.compile,
          assetBase: `/_profiles/${group.id}/`,
        },
        null,
        2,
      ),
    );
    await run(
      buildScript,
      [],
      {
        SLIDEV_LAB_GROUP_JOB: jobFile,
        SLIDEV_LAB_ARTIFACT_NAME: childName,
        SLIDEV_LAB_BOOTSTRAP: 'sync',
      },
      join(jobs, `${group.id}.log`),
    );
    const prefix = `_profiles/${group.id}`;
    // Vite emitted these exact URLs/hashes. Copy bytes intact; no post-build
    // replacement of hashed JavaScript or CSS is involved.
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
        assets: [...deck.assets.map((file) => `${prefix}/${file}`), deckIndex],
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
  allDecks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  nativePlayer.decks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  nativePlayer.unsupportedDecks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  const { generateThumbnails } = await import(pathToFileURL(join(root, 'scripts/thumbnails.mjs')));
  await generateThumbnails({ siteRoot: site, outputWidth: 1200, outputHeight: 675 });
  for (const deck of allDecks) deck.assets.push(`thumbnails/${deck.id}.png`);
  const ownedAssets = new Set(allDecks.flatMap((deck) => deck.assets));
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
  manifest.commonAssets = files
    .map((file) => file.path)
    .filter((file) => !ownedAssets.has(file))
    .sort();
  await writeFile(join(site, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestBytes = await readFile(join(site, 'manifest.json'));
  Object.assign(
    files.find((file) => file.path === 'manifest.json'),
    { rawBytes: manifestBytes.length, gzipBytes: gzipSync(manifestBytes).length },
  );
  const metrics = {
    elapsedMs: Math.round(performance.now() - started),
    configPath,
    mode:
      process.env.SLIDEV_LAB_ISOLATE_DECKS === '1' ? 'isolated-per-deck' : 'compatibility-groups',
    groupCount: groups.size,
    deckCount: decks.length,
    totalRawBytes: files.reduce((n, f) => n + f.rawBytes, 0),
    totalGzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0),
    fileCount: files.length,
    files,
  };
  await writeFile(
    join(artifactRoot, 'build-metrics.json'),
    JSON.stringify(metrics, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      outDir: site,
      ...Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== 'files')),
    }),
  );
}
