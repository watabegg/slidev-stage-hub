import { createHash } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES_ROOT = resolve(REPO_ROOT, '../../examples/fixtures');
const DECKS = ['aaa/aaa1', 'aaa/aaa2', 'bbb/bbb1', 'bbb/bbb2'].map((id) => ({
  id,
  sourcePath: relative(REPO_ROOT, join(FIXTURES_ROOT, id, 'slides.md')).split(sep).join('/'),
}));

// These formats are self-contained leaf resources. SVG, CSS, JavaScript, HTML,
// and other potentially dependency-bearing formats are deliberately excluded.
const SAFE_LEAF_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp',
  '.otf', '.ttf', '.woff', '.woff2',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function containsPath(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function parseTitle(markdown) {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s|$)/)?.[1];
  const raw = frontmatter?.match(/^title:\s*(.*?)\s*$/m)?.[1];
  if (!raw) throw new Error('fixture frontmatter has no single-line title');
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    return raw.slice(1, -1).replaceAll("''", "'");
  return raw;
}

function packageRuntimeVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const declared = pkg.devDependencies?.['@slidev/cli'];
    if (declared && /^\d+\.\d+\.\d+/.test(declared)) return declared;
  } catch {}
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/@slidev/cli/package.json'), 'utf8'));
    return pkg.version;
  } catch {}
  return 'unknown';
}

function baselineRootFromArgs(argument) {
  if (argument) return resolve(REPO_ROOT, argument);
  const candidates = [
    resolve(REPO_ROOT, 'artifacts/baseline'),
    resolve(REPO_ROOT, 'bundle-sharing/artifacts/baseline'),
  ];
  return candidates.find((root) => DECKS.every((deck) => existsSync(join(root, deck.id, 'index.html'))))
    ?? candidates.find((root) => DECKS.every((deck) => existsSync(join(root, deck.id.split('/').at(-1), 'index.html'))))
    ?? candidates[0];
}

function findBuildDir(baselineRoot, deck) {
  const flatId = deck.id.split('/').at(-1);
  const candidates = [join(baselineRoot, deck.id), join(baselineRoot, flatId)];
  return candidates.find((path) => existsSync(join(path, 'index.html')));
}

function assertExpectedBase(indexHtml, deck) {
  const expected = `/${deck.id}/`;
  const localAssets = [...indexHtml.matchAll(/(?:src|href)=["'](\/[^"']*assets\/[^"']*)["']/g)].map((match) => match[1]);
  const mismatches = localAssets.filter((url) => !url.startsWith(expected));
  if (mismatches.length)
    throw new Error(`${deck.id} was built with an incompatible base; expected ${expected}, saw ${mismatches[0]}`);
}

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) throw new Error(`symbolic links are not accepted in build inputs: ${path}`);
    }
  }
  visit(root);
  return files;
}

function makeReadOnlyHardLink(source, destination) {
  const temporary = `${destination}.dedup-${process.pid}`;
  try {
    linkSync(source, temporary);
    chmodSync(temporary, 0o444);
    unlinkSync(destination);
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function shareExactLeafFiles(siteRoot, deckFiles) {
  const canonicalByHash = new Map();
  const sharedGroups = [];
  const failures = [];

  for (const { deck, sourceDir } of deckFiles) {
    const targetDeckDir = join(siteRoot, deck.id);
    for (const sourcePath of walkFiles(sourceDir)) {
      if (!SAFE_LEAF_EXTENSIONS.has(extname(sourcePath).toLowerCase())) continue;
      const bytes = readFileSync(sourcePath);
      if (bytes.length === 0) continue;
      const hash = sha256(bytes);
      const destination = join(targetDeckDir, relative(sourceDir, sourcePath));
      const prior = canonicalByHash.get(hash);
      if (!prior || prior.bytes.length !== bytes.length || !prior.bytes.equals(bytes)) {
        canonicalByHash.set(hash, {
          bytes,
          deckId: deck.id,
          path: destination,
          hash,
          groupIndex: null,
        });
        continue;
      }
      if (prior.deckId === deck.id) continue;

      try {
        makeReadOnlyHardLink(prior.path, destination);
        if (prior.groupIndex === null) {
          prior.groupIndex = sharedGroups.length;
          sharedGroups.push({ sha256: hash, bytes: bytes.length, paths: [relative(siteRoot, prior.path)] });
        }
        sharedGroups[prior.groupIndex].paths.push(relative(siteRoot, destination));
      } catch (error) {
        failures.push({ path: relative(siteRoot, destination), reason: error.message });
      }
    }
  }

  return { sharedGroups, failures };
}

function exactDuplicateAudit(deckFiles) {
  const byHash = new Map();
  for (const { deck, sourceDir } of deckFiles) {
    for (const path of walkFiles(sourceDir)) {
      const bytes = readFileSync(path);
      const hash = sha256(bytes);
      const group = byHash.get(hash) ?? { bytes, paths: [], deckIds: new Set() };
      if (!group.bytes.equals(bytes)) continue;
      group.paths.push({ deckId: deck.id, path: relative(sourceDir, path).split(sep).join('/') });
      group.deckIds.add(deck.id);
      byHash.set(hash, group);
    }
  }

  const reasonFor = (path) => {
    const extension = extname(path).toLowerCase();
    if (extension === '.css') return 'CSS was left separate because cascade order and scoped/global selector interaction are not proven safe.';
    if (['.js', '.mjs'].includes(extension)) return 'JavaScript was left separate because relative imports, dynamic imports, and embedded asset URLs require dependency-aware analysis.';
    if (extension === '.svg') return 'SVG was left separate because XML can reference external resources and is not classified as a self-contained leaf here.';
    if (['.html', '.htm'].includes(extension)) return 'HTML entries were left separate because each document carries deck-specific routing and base paths.';
    return 'This resource type is outside the allowlist of self-contained leaf resources.';
  };

  return [...byHash.entries()]
    .filter(([, group]) => group.deckIds.size > 1)
    .filter(([, group]) => !SAFE_LEAF_EXTENSIONS.has(extname(group.paths[0].path).toLowerCase()))
    .map(([hash, group]) => ({
      sha256: hash,
      bytes: group.bytes.length,
      reason: reasonFor(group.paths[0].path),
      paths: group.paths,
    }));
}

function measurePaths(paths) {
  let pathBytes = 0;
  let pathGzipBytes = 0;
  let uniqueInodeBytes = 0;
  let uniqueInodeGzipBytes = 0;
  let fileCount = 0;
  const seenInodes = new Set();

  for (const path of paths) {
    const bytes = readFileSync(path);
    const info = statSync(path);
    const key = `${info.dev}:${info.ino}`;
    const gzipBytes = gzipSync(bytes).length;
    pathBytes += bytes.length;
    pathGzipBytes += gzipBytes;
    fileCount++;
    if (!seenInodes.has(key)) {
      seenInodes.add(key);
      uniqueInodeBytes += bytes.length;
      uniqueInodeGzipBytes += gzipBytes;
    }
  }

  return { fileCount, pathBytes, pathGzipBytes, uniqueInodeBytes, uniqueInodeGzipBytes };
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function createCatalog(decks) {
  const entries = decks.map((deck) =>
    `      <li><a href="${deck.entry}">${escapeHtml(deck.title)}</a> <code>${escapeHtml(deck.id)}</code></li>`,
  ).join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Slidev Lab catalog</title>
  <style>body{font:16px system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem}li{margin:1rem 0}code{color:#555}</style>
</head>
<body>
  <h1>Slidev Lab catalog</h1>
  <ul>
${entries}
  </ul>
</body>
</html>
`;
}

function collectPrivateSentinels() {
  const sentinels = new Set();
  for (const deck of DECKS) {
    const source = readFileSync(resolve(REPO_ROOT, deck.sourcePath), 'utf8');
    for (const match of source.matchAll(/PRIVATE_NOTE_[A-Za-z0-9_]+/g)) sentinels.add(match[0]);
  }
  return [...sentinels];
}

function assertNoPrivateSentinels(siteRoot) {
  const sentinels = collectPrivateSentinels().map((value) => Buffer.from(value));
  for (const path of walkFiles(siteRoot)) {
    const bytes = readFileSync(path);
    for (const sentinel of sentinels) {
      if (bytes.includes(sentinel)) throw new Error(`private notes sentinel found in public output: ${relative(siteRoot, path)}`);
    }
  }
}

function main() {
  const [baselineArgument, outputArgument] = process.argv.slice(2);
  const baselineRoot = baselineRootFromArgs(baselineArgument);
  const siteRoot = resolve(REPO_ROOT, outputArgument || 'artifacts/dedup/site');
  const outputArtifactRoot = dirname(siteRoot);
  if (containsPath(baselineRoot, siteRoot) || containsPath(siteRoot, baselineRoot))
    throw new Error(`output and baseline paths must not overlap: ${baselineRoot} / ${siteRoot}`);
  const runtimeVersion = packageRuntimeVersion();

  const deckFiles = DECKS.map((deck) => {
    const sourceDir = findBuildDir(baselineRoot, deck);
    if (!sourceDir) throw new Error(`missing standard build for ${deck.id} under ${baselineRoot}`);
    const indexHtml = readFileSync(join(sourceDir, 'index.html'), 'utf8');
    assertExpectedBase(indexHtml, deck);
    const source = readFileSync(resolve(REPO_ROOT, deck.sourcePath), 'utf8');
    return {
      deck: {
        ...deck,
        title: parseTitle(source),
        revision: sha256(Buffer.from(source)),
        entry: `/${deck.id}/1`,
        runtimeVersion,
      },
      sourceDir,
    };
  });

  if (existsSync(siteRoot)) rmSync(siteRoot, { recursive: true, force: true });
  mkdirSync(siteRoot, { recursive: true });

  for (const { deck, sourceDir } of deckFiles) {
    const targetDeckDir = join(siteRoot, deck.id);
    mkdirSync(targetDeckDir, { recursive: true });
    for (const sourcePath of walkFiles(sourceDir)) {
      const destination = join(targetDeckDir, relative(sourceDir, sourcePath));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(sourcePath, destination);
    }
  }

  const sharing = shareExactLeafFiles(siteRoot, deckFiles);
  for (const { deck } of deckFiles) {
    const deckRoot = join(siteRoot, deck.id);
    deck.assets = walkFiles(deckRoot)
      .map((path) => relative(siteRoot, path).split(sep).join('/'))
      .filter((path) => !path.endsWith('.html'))
      .map((path) => `/${path}`);
  }

  const manifest = { decks: deckFiles.map(({ deck }) => deck) };
  writeFileSync(join(siteRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(siteRoot, 'index.html'), createCatalog(manifest.decks));
  assertNoPrivateSentinels(siteRoot);

  const baselinePaths = deckFiles.flatMap(({ sourceDir }) => walkFiles(sourceDir));
  const rejectedExactDuplicates = exactDuplicateAudit(deckFiles);
  const candidatePaths = walkFiles(siteRoot);
  const candidateDeckPaths = deckFiles.flatMap(({ deck }) => walkFiles(join(siteRoot, deck.id)));
  const baseline = measurePaths(baselinePaths);
  const candidateDecks = measurePaths(candidateDeckPaths);
  const candidateSite = measurePaths(candidatePaths);
  const metrics = {
    createdAt: new Date().toISOString(),
    baselineRoot: relative(REPO_ROOT, baselineRoot),
    siteRoot: relative(REPO_ROOT, siteRoot),
    runtimeVersion,
    method: {
      sharedFormats: [...SAFE_LEAF_EXTENSIONS].sort(),
      equality: 'SHA-256 match followed by exact byte comparison',
      physicalAccounting: 'sum file content bytes by unique device/inode; excludes filesystem metadata and block allocation',
      gzip: 'Node zlib gzipSync default level per file path; path totals model separate URL responses, inode totals count each shared file once',
    },
    baseline,
    candidateDecks,
    candidateSite,
    sharedGroups: sharing.sharedGroups,
    rejectedExactDuplicates,
    hardlinkFailures: sharing.failures,
    catalogAndManifestBytes: measurePaths([join(siteRoot, 'index.html'), join(siteRoot, 'manifest.json')]),
  };
  mkdirSync(outputArtifactRoot, { recursive: true });
  writeFileSync(join(outputArtifactRoot, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify({
    baseline: {
      files: baseline.fileCount,
      pathRawBytes: baseline.pathBytes,
      pathGzipBytes: baseline.pathGzipBytes,
      uniquePhysicalRawBytes: baseline.uniqueInodeBytes,
    },
    candidateDecks: {
      files: candidateDecks.fileCount,
      pathRawBytes: candidateDecks.pathBytes,
      pathGzipBytes: candidateDecks.pathGzipBytes,
      uniquePhysicalRawBytes: candidateDecks.uniqueInodeBytes,
      uniqueInodeRawSavings: baseline.uniqueInodeBytes - candidateDecks.uniqueInodeBytes,
    },
    candidateSite: {
      pathRawBytes: candidateSite.pathBytes,
      pathGzipBytes: candidateSite.pathGzipBytes,
      uniquePhysicalRawBytes: candidateSite.uniqueInodeBytes,
    },
    sharedGroupCount: sharing.sharedGroups.length,
    sharedAliasCount: sharing.sharedGroups.reduce((sum, group) => sum + group.paths.length - 1, 0),
    sharedUniqueRawSavings: sharing.sharedGroups.reduce((sum, group) => sum + group.bytes * (group.paths.length - 1), 0),
    rejectedExactDuplicateCount: rejectedExactDuplicates.length,
    hardlinkFailures: sharing.failures.length,
    siteRoot: relative(REPO_ROOT, siteRoot),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`dedup failed: ${error.message}`);
  process.exitCode = 1;
}
