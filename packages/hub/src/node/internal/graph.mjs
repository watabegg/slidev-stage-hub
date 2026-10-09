import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import {
  categoriesForDecks,
  discoverDecks,
  encodeDeckPath,
  publicFrontmatter,
} from './catalog.mjs';
import { compileContract, stableJson } from './profile-contract.mjs';
import { loadSlidevParser, resolveRuntime } from '@slidev-stage-hub/slidev-adapter/runtime';
import { nativePlayerManifest } from '@slidev-stage-hub/slidev-adapter/native-manifest';
import {
  patchSlidevHtmlEntry,
  patchSlidevImageFrontmatter,
  patchStaticRuntimeModule,
  rewriteSlidevImports,
  stripPrivateSlideData,
} from '@slidev-stage-hub/slidev-adapter/static-runtime';
export async function buildGraph(job) {
  const groupJob = job.group || null;
  const sourceRoot = resolve(job.sourceRoot);
  const workDir = resolve(job.workDir);
  const frontendRoot = resolve(job.frontendRoot);
  const frontendEntry = resolve(job.frontendEntry ?? join(frontendRoot, 'home.ts'));
  const frontendModules = new Set([frontendEntry]);
  const theme = resolve(groupJob?.profile.theme || job.theme);
  const dependencyRoot = resolve(groupJob?.profile.dependencyRoot || job.dependencyRoot);
  const syncBootstrap = job.bootstrap !== 'tla';
  const artifactRoot = workDir;
  const outDir = join(workDir, 'site');
  const {
    cliRequire,
    cliVersion,
    api: { resolveOptions, ViteSlidevPlugin },
  } = await resolveRuntime(dependencyRoot);
  const { build } = await import(pathToFileURL(cliRequire.resolve('vite')));
  const discovered = groupJob?.decks || job.decks || (await discoverDecks(sourceRoot));
  const themePackage = JSON.parse(await readFile(join(theme, 'package.json'), 'utf8'));
  const publicTheme = `${themePackage.name}@${themePackage.version}`;
  const assetBase = groupJob?.assetBase || '/';
  const ids = discovered.map((deck) => deck.id);
  const started = performance.now();
  const decks = [];

  function handler(hook) {
    return typeof hook === 'function' ? hook : hook?.handler;
  }
  function codeOf(result) {
    return typeof result === 'string' ? result : result?.code;
  }
  const scopedNames = new Set(['slidev:loader', 'unplugin-vue-markdown', 'slidev:layout-wrapper']);
  for (const { id, entry, categoryPath } of discovered) {
    const options = await resolveOptions(
      { entry, theme, withoutNotes: true, routerMode: 'history' },
      'build',
    );
    if (groupJob && stableJson(compileContract(options)) !== stableJson(groupJob.compile))
      throw new Error(`Deck ${id} no longer matches its probed compile/setup compatibility group`);
    const frontmatter = publicFrontmatter(options.data.headmatter);
    const themeConfig = options.data.config.themeConfig || {};
    options.data.config.themeConfig = {
      ...themeConfig,
      watabegg: { ...themeConfig.watabegg, navigation: { href: '/', label: 'ホームへ戻る' } },
    };
    for (const slide of options.data.slides) stripPrivateSlideData(slide);
    // Upstream persists generated import-glob modules below userRoot. Keep
    // Keep generated loader modules in this job's work directory, away from sources.
    options.userRoot = join(artifactRoot, 'cache', id);
    await mkdir(options.userRoot, { recursive: true });
    const plugins = (await ViteSlidevPlugin(options)).flat(Infinity).filter(Boolean);
    const sourceIds = new Set(
      options.data.slides.flatMap((slide, i) =>
        ['md', 'frontmatter'].map((type) => `${slide.source.filepath}__slidev_${i + 1}.${type}`),
      ),
    );
    decks.push({
      id,
      categoryPath,
      frontmatter,
      options,
      plugins,
      sourceIds,
      prefix: `/@lab/decks/${encodeDeckPath(id)}`,
    });
  }
  const base = decks[0];
  const common = base.plugins
    .filter((plugin) => !scopedNames.has(plugin.name))
    .map((plugin) => {
      if (plugin.name !== 'slidev:context-injection') return plugin;
      const transform = handler(plugin.transform);
      return {
        ...plugin,
        transform: {
          ...plugin.transform,
          handler(code, id, ...args) {
            if (id.startsWith(frontendRoot + '/') || frontendModules.has(id.split('?')[0]))
              return null;
            return transform.call(this, code, id, ...args);
          },
        },
      };
    });
  const sourceOwner = (id) => decks.find((deck) => deck.sourceIds.has(id.split('?')[0]));
  const namespacedDecks = [...decks].sort(
    (left, right) => right.prefix.length - left.prefix.length,
  );
  const namespacedOwner = (id) => namespacedDecks.find((deck) => id.startsWith(`${deck.prefix}/`));
  const loaders = new Map(
    decks.map((deck) => [deck.id, deck.plugins.find((p) => p.name === 'slidev:loader')]),
  );
  const deckImports = (name) =>
    `{${decks.map((deck) => `${JSON.stringify(deck.id)}: () => import(${JSON.stringify(`${deck.prefix}/${name}`)})`).join(',')}}`;
  const activeImports = (name) =>
    `const loaders = ${deckImports(name)};\nconst value = await loaders[deckId]();\n`;
  const selectionCode = `
export const deckIds = ${JSON.stringify(ids)};
const pathname = location.pathname.split('/').map(segment => decodeURIComponent(segment)).join('/');
export const deckId = [...deckIds].sort((a, b) => b.length - a.length).find(id => pathname.startsWith('/' + id + '/'));
export const deckBase = deckId ? '/' + deckId.split('/').map(encodeURIComponent).join('/') + '/' : '/';
`;
  const adapter = {
    name: 'lab:independent-decks',
    enforce: 'pre',
    resolveId: {
      order: 'pre',
      async handler(id, importer) {
        if (id.startsWith('/@lab/') || id.startsWith('/@slidev/') || sourceOwner(id)) return id;
        if (importer && frontendModules.has(importer.split('?')[0])) {
          // Custom UI dependencies can live anywhere; directory-wide exclusions
          // would also disable context injection in neighboring slide components.
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved && !resolved.external) frontendModules.add(resolved.id.split('?')[0]);
          return resolved;
        }
      },
    },
    async load(id) {
      if (id === '/@lab/selection') return selectionCode;
      if (id === '/@lab/entry')
        return `
import { deckIds, deckId } from '/@lab/selection';
import { showStartupError } from ${JSON.stringify(join(frontendRoot, 'startup-error.ts'))};
${
  syncBootstrap
    ? `async function boot() {
  const configs = await (${deckImports('configs')})[deckId]();
  const selected = await (${deckImports('slides')})[deckId]();
  globalThis.__slidevLabData = { configs: configs.default, slides: selected.slides };
  window.__slidevLab = { deckId, runtimeVersion: ${JSON.stringify(cliVersion)}, theme: ${JSON.stringify(publicTheme)} };
  await import('@slidev/client/main.ts');
  const { mountNavigation } = await import(${JSON.stringify(join(frontendRoot, 'navigation.ts'))});
  mountNavigation(${JSON.stringify(job.navigation ?? {})});
}
if (deckId) boot().catch(showStartupError);
else {`
    : `if (deckId) {
  window.__slidevLab = { deckId, runtimeVersion: ${JSON.stringify(cliVersion)}, theme: ${JSON.stringify(publicTheme)} };
  await import('@slidev/client/main.ts');
  const { mountNavigation } = await import(${JSON.stringify(join(frontendRoot, 'navigation.ts'))});
  mountNavigation(${JSON.stringify(job.navigation ?? {})});
} else {`
}
  document.title = 'Slidev Lab';
  import(${JSON.stringify(frontendEntry)}).catch(showStartupError);
}
`;
      if (id === '/@slidev/configs')
        return syncBootstrap
          ? `export default globalThis.__slidevLabData.configs;`
          : `import { deckId } from '/@lab/selection';\n${activeImports('configs')}export default value.default;`;
      if (id === '/@slidev/slides')
        return syncBootstrap
          ? `export const slides = globalThis.__slidevLabData.slides;`
          : `import { deckId } from '/@lab/selection';\n${activeImports('slides')}export const slides = value.slides;`;
      if (id === '/@slidev/title-renderer')
        return `import { defineAsyncComponent } from 'vue';\nimport { deckId } from '/@lab/selection';\nconst loaders = {${decks.map((deck) => `${JSON.stringify(deck.id)}: () => import(${JSON.stringify(`${deck.prefix}/title-renderer.md`)})`).join(',')}};\nexport default defineAsyncComponent(loaders[deckId]);`;
      const deck = namespacedOwner(id) || sourceOwner(id);
      if (deck) {
        const original = id.startsWith(deck.prefix) ? id.replace(deck.prefix, '/@slidev') : id;
        const result = await handler(loaders.get(deck.id).load).call(this, original);
        let code = codeOf(result);
        if (code !== undefined) {
          const sourceMatch = original.match(/__slidev_(\d+)\.frontmatter$/);
          if (sourceMatch) {
            const slide = deck.options.data.slides[+sourceMatch[1] - 1];
            const images = slide.images || slide.source.images || [];
            const imports = [];
            const urls = images.map((url, index) => {
              if (!url.startsWith('./') && !url.startsWith('../')) return JSON.stringify(url);
              const name = `__labImage${index}`;
              const image = resolve(dirname(slide.source.filepath), url);
              imports.push(`import ${name} from ${JSON.stringify(image + '?url&no-inline')};`);
              return name;
            });
            const imageSignature = `"images":${JSON.stringify(images)}`;
            // Slidev 52 omits the key for empty image lists; the prior replacement was a no-op.
            const patchedCode = code.includes(imageSignature)
              ? patchSlidevImageFrontmatter(code, images, urls, original)
              : code;
            code = imports.join('\n') + '\n' + patchedCode;
          }
          return { code: rewriteSlidevImports(code, deck.prefix), map: { mappings: '' } };
        }
      }
      if (id.startsWith('/@slidev/')) return handler(loaders.get(base.id).load).call(this, id);
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        return patchStaticRuntimeModule({ code, id, clientRoot: base.options.clientRoot });
      },
    },
  };

  // Each deck retains the stock Markdown and layout transforms. Shared physical
  // client/theme files pass through one canonical set of the remaining plugins.
  const scoped = decks.flatMap((deck) =>
    deck.plugins
      .filter((plugin) => scopedNames.has(plugin.name) && plugin.name !== 'slidev:loader')
      .map((plugin) => {
        const transform = handler(plugin.transform);
        return {
          ...plugin,
          name: `${plugin.name}:${deck.id}`,
          transform: {
            ...(typeof plugin.transform === 'object' ? plugin.transform : {}),
            async handler(code, id, ...args) {
              const owner = sourceOwner(id) || namespacedOwner(id);
              if (owner && owner !== deck) return null;
              if (!owner && deck !== base) return null;
              return transform.call(this, code, id, ...args);
            },
          },
        };
      }),
  );

  const chunkGraph = [];
  const graphPlugin = {
    name: 'lab:graph-evidence',
    generateBundle(_options, bundle) {
      for (const value of Object.values(bundle))
        if (value.type === 'chunk')
          chunkGraph.push({
            fileName: value.fileName,
            isEntry: value.isEntry,
            isDynamicEntry: value.isDynamicEntry,
            imports: value.imports,
            dynamicImports: value.dynamicImports,
            css: [...(value.viteMetadata?.importedCss || [])],
            assets: [...(value.viteMetadata?.importedAssets || [])],
            modules: Object.keys(value.modules),
          });
    },
  };
  await mkdir(outDir, { recursive: true });
  const html = patchSlidevHtmlEntry(base.options.utils.indexHtml);
  const nativeBridge = await readFile(
    fileURLToPath(import.meta.resolve('@slidev-stage-hub/protocol/bridge')),
    'utf8',
  );
  // Execute before module/theme listeners, but leave ordinary Web navigation intact.
  const playerHtml = html.replace(
    '<head>',
    `<head><script>if(window.parent!==window && new URLSearchParams(location.search).get('nativeProtocol')==='1'){${nativeBridge}}</script>`,
  );
  const viteRoot = join(workDir, 'vite-root');
  await mkdir(workDir, { recursive: true });
  await mkdir(viteRoot, { recursive: true });
  await writeFile(join(viteRoot, 'index.html'), playerHtml);
  await build({
    configFile: false,
    root: viteRoot,
    cacheDir: join(workDir, 'vite-cache'),
    base: assetBase,
    publicDir: false,
    plugins: [adapter, ...scoped, ...common, graphPlugin],
    build: { outDir, emptyOutDir: true, target: 'esnext', cssCodeSplit: true },
    define: { __VUE_PROD_DEVTOOLS__: false },
    server: {
      fs: {
        allow: [
          sourceRoot,
          frontendRoot,
          dirname(frontendEntry),
          theme,
          base.options.clientRoot,
          base.options.cliRoot,
        ],
      },
    },
  });
  const ownedAssets = new Set();
  const deckAssets = new Map(
    decks.map((deck) => {
      const files = new Set();
      for (const chunk of chunkGraph)
        if (chunk.modules.some((id) => namespacedOwner(id) === deck || sourceOwner(id) === deck)) {
          for (const file of [chunk.fileName, ...chunk.css, ...chunk.assets]) {
            files.add(file);
            ownedAssets.add(file);
          }
        }
      return [deck.id, [...files].sort()];
    }),
  );
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: cliVersion,
    bootstrap: syncBootstrap ? 'preload-then-sync-facades' : 'active-module-top-level-await',
    routeMode: 'history',
    switching: 'document-navigation',
    notes: 'stripped',
    commonAssets: [],
    decks: decks.map((deck) => ({
      id: deck.id,
      runtimeVersion: cliVersion,
      theme: publicTheme,
      profile: groupJob?.assignments[deck.id] || 'default',
      title: deck.options.data.config.title,
      sourcePath: relative(sourceRoot, deck.options.entry),
      entry: `/${encodeDeckPath(deck.id)}/1`,
      pages: deck.options.data.slides.length,
      assets: deckAssets.get(deck.id),
      revision: createHash('sha256')
        .update(
          JSON.stringify(
            deck.options.data.slides.map((slide) => ({
              content: slide.content,
              frontmatter: slide.frontmatter,
            })),
          ),
        )
        .digest('hex'),
      categoryPath: deck.categoryPath,
      frontmatter: deck.frontmatter,
      thumbnail: { src: `/thumbnails/${encodeDeckPath(deck.id)}.png`, width: 1200, height: 675 },
    })),
  };
  if (!groupJob) {
    for (const deck of manifest.decks) {
      deck.assets.push(`thumbnails/${deck.id}.png`);
      deck.assets.sort();
      ownedAssets.add(`thumbnails/${deck.id}.png`);
    }
  }
  const catalog = {
    schemaVersion: 1,
    categories: categoriesForDecks(decks),
    decks: manifest.decks.map(
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
  const { parseSync } = await loadSlidevParser(dependencyRoot);
  await writeFile(
    join(outDir, 'native-player.json'),
    JSON.stringify(await nativePlayerManifest(manifest.decks, sourceRoot, parseSync), null, 2) +
      '\n',
  );
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(join(outDir, '404.html'), await readFile(join(outDir, 'index.html')));
  await writeFile(
    join(artifactRoot, 'chunk-graph.json'),
    JSON.stringify(chunkGraph, null, 2) + '\n',
  );
  const files = [];
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else {
        const bytes = await readFile(path);
        if (bytes.includes(Buffer.from('PRIVATE_NOTE_')))
          throw new Error(`Private notes leaked: ${path}`);
        files.push({
          path: relative(outDir, path),
          rawBytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
        });
      }
    }
  }
  await walk(outDir);
  manifest.commonAssets = files
    .map((file) => file.path)
    .filter((file) => !ownedAssets.has(file))
    .sort();
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestBytes = await readFile(join(outDir, 'manifest.json'));
  Object.assign(
    files.find((file) => file.path === 'manifest.json'),
    { rawBytes: manifestBytes.length, gzipBytes: gzipSync(manifestBytes).length },
  );
  const metrics = {
    elapsedMs: Math.round(performance.now() - started),
    dependencyRoot,
    runtimeVersion: cliVersion,
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
      outDir,
      elapsedMs: metrics.elapsedMs,
      rawBytes: metrics.totalRawBytes,
      gzipBytes: metrics.totalGzipBytes,
      fileCount: metrics.fileCount,
    }),
  );
  return { site: outDir, manifest, catalog, metrics };
}
