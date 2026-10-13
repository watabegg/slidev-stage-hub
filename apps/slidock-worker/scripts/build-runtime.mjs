import { themeDirectory, dependencyDirectory } from './environment.mjs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntime } from '@slidock/slidev-adapter/runtime';
import { compileContract, stableJson } from '@slidock/slidev-adapter/static-runtime';
import { snapshotRuntime } from './runtime-snapshot.mjs';
import {
  preserveReleaseAssetInLayoutHelper,
  preserveReleaseAssetInPreloader,
} from './runtime-asset-paths.mjs';

const experiment = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = experiment;
const runtimeRoot = resolve(experiment, 'runtime');
const artifactsRoot = resolve(projectRoot, 'artifacts');
const siteRoot = resolve(artifactsRoot, 'site');
const viteRoot = resolve(artifactsRoot, 'vite-root');
const cacheRoot = resolve(artifactsRoot, 'cache/runtime');
const seed = resolve(runtimeRoot, 'seed.md');
const theme = resolve(themeDirectory());
const dependencyRoot = resolve(dependencyDirectory());
const {
  cliRequire,
  cliVersion,
  clientVersion,
  clientRoot,
  api: { resolveOptions, ViteSlidevPlugin },
} = await resolveRuntime(dependencyRoot);
const { build } = await import(pathToFileURL(cliRequire.resolve('vite')));
const vuePackage = cliRequire.resolve('vue/package.json');
const vueRuntime = resolve(dirname(vuePackage), 'dist/vue.runtime.esm-bundler.js');

const options = await resolveOptions(
  { entry: seed, theme, withoutNotes: true, routerMode: 'history' },
  'build',
);
options.userRoot = cacheRoot;
await mkdir(cacheRoot, { recursive: true });
const baseConfig = options.data.config;
const layouts = await options.utils.getLayouts();
const layoutNames = Object.keys(layouts).sort();
const themeRoots = options.roots.filter((root) => resolve(root) !== runtimeRoot);
const components = await collectComponents(
  themeRoots.map((root) => ({ root: join(root, 'components'), kind: 'theme' })),
);
const frontendRoot = dirname(fileURLToPath(import.meta.resolve('@slidock/slidock/frontend')));
const plugins = (await ViteSlidevPlugin(options))
  .flat(Infinity)
  .filter(Boolean)
  .map((plugin) => {
    if (plugin.name !== 'slidev:context-injection') return plugin;
    const transform =
      typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler;
    return {
      ...plugin,
      transform: {
        ...plugin.transform,
        handler(code, id, ...args) {
          if (id.startsWith(frontendRoot + '/')) return null;
          return transform.call(this, code, id, ...args);
        },
      },
    };
  });
const chunks = [];

function asModuleImports(entries, variablePrefix) {
  return entries
    .map((entry, index) => `import ${variablePrefix}${index} from ${JSON.stringify(entry.file)};`)
    .join('\n');
}

function componentModule(entries) {
  const imports = asModuleImports(entries, '__component');
  const map = entries
    .map((entry, index) => `${JSON.stringify(entry.name)}: __component${index}`)
    .join(',\n');
  return `${imports}\nexport const components = {\n${map}\n};\n`;
}

function layoutModule(entries) {
  const values = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b));
  const imports = values
    .map(([, file], index) => `import __layout${index} from ${JSON.stringify(file)};`)
    .join('\n');
  const map = values
    .map(([name], index) => `${JSON.stringify(name)}: __layout${index}`)
    .join(',\n');
  return `${imports}\nexport const layouts = {\n${map}\n};\n`;
}

const componentNames = components.map((component) => component.name).sort();
const monacoDependencies = [
  ...(Array.isArray(options.data.features.monaco?.deps) ? options.data.features.monaco.deps : []),
  ...(options.data.config.monacoTypesAdditionalPackages || []),
  ...(options.data.config.monacoRunAdditionalDeps || []),
];
const monacoRunDeps = monacoDependencies.length
  ? `${monacoDependencies.map((name, index) => `import * as __dep${index} from ${JSON.stringify(name)};`).join('\n')}\nexport default { ${monacoDependencies.map((name, index) => `${JSON.stringify(name)}: __dep${index}`).join(', ')} };`
  : 'export default {};';
const virtual = new Map([
  ['/@lab/selection', selectionModule()],
  ['/@lab/base-config', `export default ${JSON.stringify(baseConfig)};`],
  ['/@lab/layouts', layoutModule(layouts)],
  ['/@lab/components', componentModule(components)],
  [
    '/@lab/register',
    `
import LabSlideLayout from ${JSON.stringify(resolve(runtimeRoot, 'LabSlideLayout.vue'))};
import { components } from '/@lab/components';
export function registerSlidevLab(app) {
  app.component('LabSlideLayout', LabSlideLayout);
  for (const [name, component] of Object.entries(components)) app.component(name, component);
}
`,
  ],
  ['/@slidev/configs', 'export default globalThis.__slidevLabData.configs;'],
  ['/@slidev/slides', 'export const slides = globalThis.__slidevLabData.slides;'],
  [
    '/@slidev/title-renderer',
    `export { default } from ${JSON.stringify(resolve(runtimeRoot, 'TitleRenderer.vue'))};`,
  ],
  ['/@slidev/monaco-run-deps', monacoRunDeps],
]);

const adapter = {
  name: 'slidev-lab-runtime-adapter',
  enforce: 'pre',
  resolveId: {
    order: 'pre',
    handler(id) {
      if (virtual.has(id) || id === '/@lab/entry') return id;
    },
  },
  load(id) {
    if (virtual.has(id)) return virtual.get(id);
    if (id === '/@lab/entry') return `import ${JSON.stringify(resolve(runtimeRoot, 'entry.ts'))};`;
  },
  transform: {
    order: 'pre',
    handler(code, id) {
      const sourceId = id.split('?')[0];
      if (sourceId === join(clientRoot, 'layoutHelper.ts'))
        return preserveReleaseAssetInLayoutHelper(code);
      if (sourceId === join(clientRoot, 'composables/usePreloadImages.ts'))
        return preserveReleaseAssetInPreloader(code);
      if (sourceId !== join(clientRoot, 'setup/main.ts') && sourceId !== join(clientRoot, 'env.ts'))
        return;
      if (!code.includes('import.meta.env.BASE_URL'))
        throw new Error(`Slidev 53 router-base signature changed: ${sourceId}`);

      let transformed = `import { deckBase as __labDeckBase } from '/@lab/selection';\n${code.replaceAll('import.meta.env.BASE_URL', '__labDeckBase')}`;
      if (sourceId === join(clientRoot, 'setup/main.ts')) {
        if (!code.includes('app.use(router)'))
          throw new Error('Slidev 53 setup/main router-install signature changed');
        transformed = `import { slides as __labNativeSlides } from '#slidev/slides';\nimport { unref as __labUnref } from 'vue';\nimport { registerSlidevLab as __labRegisterSlidevLab } from '/@lab/register';\n${transformed}`;
        const setup = `
  const __labRevision = (window as any).__workersPoc?.revision as string | undefined
  if (__labRevision) {
    router.beforeEach((to) => to.query.revision === __labRevision ? true : {
      path: to.path,
      query: { ...to.query, revision: __labRevision },
      hash: to.hash,
      replace: true,
    })
  }
  ;(window as any).__slidevLabRouter = router
  ;(window as any).__slidevLabNative = { router, slides: __labUnref(__labNativeSlides) }
  __labRegisterSlidevLab(app)
`;
        transformed = transformed.replace('  app.use(router)', `${setup}  app.use(router)`);
      }
      return transformed;
    },
  },
};

const graphPlugin = {
  name: 'slidev-lab-runtime-graph',
  generateBundle(_output, bundle) {
    for (const value of Object.values(bundle)) {
      if (value.type !== 'chunk') continue;
      chunks.push({
        file: value.fileName,
        entry: value.isEntry,
        imports: value.imports,
        dynamicImports: value.dynamicImports,
        exports: value.exports,
        modules: Object.keys(value.modules),
      });
    }
  },
};

await mkdir(viteRoot, { recursive: true });
let html = options.utils.indexHtml;
html = html.replace(
  /<script type="module" src="[^"]+"><\/script>/,
  '<script type="module" src="/@lab/entry"></script>',
);
html = html.replace(/<link\b[^>]*\bas="image"[^>]*>/gi, '');
html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>Slidock</title>');
const favicon = await readFile(fileURLToPath(import.meta.resolve('@slidock/slidock/icon.svg')));
html = html.replace(/<link\b[^>]*\brel=["'](?:shortcut\s+)?icon["'][^>]*>/gi, '');
html = html.replace(
  '<head>',
  `<head><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${favicon.toString('base64')}">`,
);
if (!html.includes('/@lab/entry')) throw new Error('Slidev HTML entry signature changed');
const nativeBridge = await readFile(
  fileURLToPath(import.meta.resolve('@slidock/protocol/bridge')),
  'utf8',
);
html = html.replace(
  '<head>',
  `<head><script>if(window.parent!==window && new URLSearchParams(location.search).get('nativeProtocol')==='1'){${nativeBridge}}</script>`,
);
await writeFile(join(viteRoot, 'index.html'), html);

await build({
  configFile: false,
  root: viteRoot,
  base: './',
  publicDir: false,
  plugins: [adapter, ...plugins, graphPlugin],
  resolve: { alias: [{ find: /^vue$/, replacement: vueRuntime }] },
  build: {
    outDir: siteRoot,
    emptyOutDir: true,
    target: 'esnext',
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        index: join(viteRoot, 'index.html'),
        runtimeVue: join(runtimeRoot, 'vue.ts'),
        runtimeBridge: join(runtimeRoot, 'bridge.ts'),
      },
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'runtimeVue') return '_runtime/vue.js';
          if (chunk.name === 'runtimeBridge') return '_runtime/bridge.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  define: { __VUE_PROD_DEVTOOLS__: false },
  server: { fs: { allow: [projectRoot, theme, runtimeRoot, clientRoot, options.cliRoot] } },
});

const compilerModules = [...new Set(chunks.flatMap((chunk) => chunk.modules))].filter((id) =>
  /(?:^|[/\\])@vue[/\\]compiler-|(?:^|[/\\])vue[/\\]dist[/\\]vue\.esm-bundler\.js/.test(id),
);
if (compilerModules.length)
  throw new Error(
    `Unexpected Vue compiler modules in browser bundle: ${compilerModules.join(', ')}`,
  );
const vueEntry = chunks.find((chunk) => chunk.file === '_runtime/vue.js');
const bridgeEntry = chunks.find((chunk) => chunk.file === '_runtime/bridge.js');
if (
  !vueEntry?.exports?.includes('createElementVNode') ||
  !bridgeEntry?.exports?.includes('slideSetup')
)
  throw new Error('The compiler-facing runtime entrypoints are missing required ESM exports');

const files = await collectFiles(siteRoot);
const fileDigests = [];
for (const file of files) {
  const bytes = await readFile(file);
  fileDigests.push({
    path: `/${relative(siteRoot, file).split('\\').join('/')}`,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

const themeInfo = await fingerprintTheme(theme, themeRoots);
const compilerContract = compileContract(options);
compilerContract.roots = compilerContract.roots.map((root) =>
  resolve(root) === resolve(theme)
    ? 'theme'
    : resolve(root) === runtimeRoot
      ? 'runtime-source'
      : relative(projectRoot, root).split('\\').join('/'),
);
compilerContract.clientRoot = '@slidev/client';
if (compilerContract.config?.theme)
  compilerContract.config.theme = `${themeInfo.name}@${themeInfo.version}`;
const profile = {
  schemaVersion: 1,
  runtimeSnapshotRecipeVersion: 1,
  cliVersion,
  clientVersion,
  theme: themeInfo,
  seed: {
    path: relative(projectRoot, seed).split('\\').join('/'),
    sha256: sha256(await readFile(seed)),
  },
  compilerContract,
  layouts: layoutNames,
  components: componentNames,
  browserGraph: {
    chunks: chunks.map(({ file, entry, imports, dynamicImports, exports }) => ({
      file,
      entry,
      imports,
      dynamicImports,
      exports,
    })),
    containsVueCompiler: false,
  },
  files: fileDigests,
};
const profileDigest = sha256(stableJson(profile));
const runtime = await snapshotRuntime({ siteRoot, id: profileDigest });
const runtimeIndex = await readFile(join(siteRoot, 'index.html'), 'utf8');
if (!/<head(?:\s[^>]*)?>/iu.test(runtimeIndex))
  throw new Error('Built runtime index.html has no head element for the job status entry');
const jobsIndex = runtimeIndex
  .replace(/<base\b[^>]*>/giu, '')
  .replace(/(<head(?:\s[^>]*)?>)/iu, '$1<base href="/">');
await writeFile(join(siteRoot, 'jobs.html'), jobsIndex);
const runtimeManifest = { ...profile, profileDigest, runtime };
await writeFile(
  join(siteRoot, 'runtime-manifest.json'),
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      outDir: siteRoot,
      cliVersion,
      clientVersion,
      profileDigest,
      layoutCount: layoutNames.length,
      componentCount: componentNames.length,
      bundleFiles: fileDigests.length,
      browserChunks: chunks.map(({ file, entry }) => ({ file, entry })),
      vueCompilerModules: compilerModules,
    },
    null,
    2,
  ),
);

function selectionModule() {
  return `
function decode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}
const segments = location.pathname.split('/').filter(Boolean).map(decode)
const page = segments.at(-1)
export const deckId = segments.length > 1 && /^\\d+$/.test(page) ? segments.slice(0, -1).join('/') : ''
export const deckBase = deckId ? '/' + deckId.split('/').map(encodeURIComponent).join('/') + '/' : '/'
`;
}

async function collectComponents(sources) {
  const chosen = new Map();
  for (const source of sources) {
    for (const file of await walkFiles(source.root)) {
      if (extname(file).toLowerCase() !== '.vue') continue;
      const stem = file.slice(0, -extname(file).length).split(/[\\/]/).at(-1);
      const name = stem
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('');
      if (!name) continue;
      const previous = chosen.get(name);
      if (!previous || source.kind === 'theme') chosen.set(name, { name, file, kind: source.kind });
    }
  }
  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function walkFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function collectFiles(directory) {
  return (await walkFiles(directory)).sort((a, b) => a.localeCompare(b));
}

async function fingerprintTheme(themePath, roots) {
  const sourceFiles = (await walkFiles(themePath)).filter((file) => {
    const relativePath = relative(themePath, file).split('\\').join('/');
    if (
      relativePath
        .split('/')
        .some((part) => ['.git', 'node_modules', 'docs', 'example', 'tests'].includes(part))
    )
      return false;
    return /\.(?:vue|ts|js|mjs|cjs|css|scss|sass|json|svg|yaml|yml)$/.test(relativePath);
  });
  const sourceHash = createHash('sha256');
  for (const file of sourceFiles) {
    sourceHash.update(relative(themePath, file).split('\\').join('/'));
    sourceHash.update('\0');
    sourceHash.update(await readFile(file));
    sourceHash.update('\0');
  }
  let gitHead = '';
  let gitStatus = '';
  try {
    if (!existsSync(join(themePath, '.git')))
      throw new Error('installed package, not a theme checkout');
    gitHead = execFileSync('git', ['-C', themePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    gitStatus = execFileSync('git', ['-C', themePath, 'status', '--short'], {
      encoding: 'utf8',
    }).trim();
  } catch {}
  const pkg = JSON.parse(await readFile(join(themePath, 'package.json'), 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    sourcePath: 'configured-theme',
    gitHead,
    dirty: Boolean(gitStatus),
    statusDigest: sha256(gitStatus),
    sourceDigest: sourceHash.digest('hex'),
    rootCount: roots.length,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
