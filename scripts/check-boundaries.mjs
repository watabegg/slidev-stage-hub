import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { compileTemplate, parse as parseSfc } from '@vue/compiler-sfc';
import postcss from 'postcss';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.vue',
]);
const SKIP_DIRECTORY_NAMES = new Set([
  '.git',
  'artifacts',
  'dist',
  'generated',
  'node_modules',
  'results',
  'target',
]);
const BUILTINS = new Set(
  builtinModules.flatMap((name) => {
    const normalized = name.replace(/^node:/, '');
    return [normalized, `node:${normalized}`];
  }),
);

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function relativePath(root, value) {
  return posixPath(path.relative(root, value)) || '.';
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isNodeBuiltin(specifier) {
  if (typeof specifier !== 'string') return false;
  return BUILTINS.has(specifier);
}

function parseWorkspacePatterns(workspaceText) {
  const lines = workspaceText.split(/\r?\n/);
  const patterns = [];
  let inPackages = false;
  let baseIndent = 0;

  for (const line of lines) {
    const section = line.match(/^(\s*)packages\s*:\s*(?:#.*)?$/);
    if (section) {
      inPackages = true;
      baseIndent = section[1].length;
      continue;
    }
    if (!inPackages) continue;
    const listItem = line.match(/^(\s*)-\s*(['"]?)([^'"]+?)\2\s*(?:#.*)?$/);
    if (listItem) {
      patterns.push(listItem[3].trim());
      continue;
    }
    if (line.trim() && !line.trimStart().startsWith('#')) {
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= baseIndent) inPackages = false;
    }
  }

  return patterns;
}

async function expandWorkspacePattern(root, pattern) {
  const negative = pattern.startsWith('!');
  const normalized = (negative ? pattern.slice(1) : pattern)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment.includes('**') ||
        segment.includes('?') ||
        segment.includes('[') ||
        segment.includes(']'),
    )
  ) {
    throw new Error(
      `Unsupported pnpm workspace glob pattern "${pattern}"; this checker supports exact path segments and single-segment * only.`,
    );
  }
  let dirs = [root];

  for (const segment of segments) {
    const next = [];
    for (const dir of dirs) {
      if (segment === '*') {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) next.push(path.join(dir, entry.name));
        }
      } else {
        next.push(path.join(dir, segment));
      }
    }
    dirs = next;
  }

  const packageDirs = [];
  for (const dir of dirs) {
    try {
      if ((await stat(path.join(dir, 'package.json'))).isFile()) packageDirs.push(dir);
    } catch {
      // A workspace glob can match an empty directory before it becomes a package.
    }
  }
  return { negative, dirs: packageDirs };
}

async function discoverPackages(root) {
  const rootManifestPath = path.join(root, 'package.json');
  const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'));
  const packageDirs = new Set([root]);
  let workspaceText = '';
  try {
    workspaceText = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    // A standalone fixture without a workspace file is treated as a single package.
  }

  const patterns = parseWorkspacePatterns(workspaceText);
  const included = new Set();
  const excluded = new Set();
  for (const pattern of patterns) {
    const expanded = await expandWorkspacePattern(root, pattern);
    for (const dir of expanded.dirs) {
      (expanded.negative ? excluded : included).add(dir);
    }
  }
  for (const dir of included) if (!excluded.has(dir)) packageDirs.add(dir);

  const packages = [];
  for (const dir of packageDirs) {
    const manifest =
      dir === root
        ? rootManifest
        : JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    packages.push({
      dir,
      relativeDir: relativePath(root, dir),
      manifest,
      name: manifest.name ?? (dir === root ? '<root>' : relativePath(root, dir)),
      dependencies: new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    });
  }
  packages.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
  return packages;
}

function packageForPath(packages, fullPath) {
  return (
    packages
      .filter((pkg) => isInside(pkg.dir, fullPath))
      .sort((a, b) => b.dir.length - a.dir.length)[0] ?? null
  );
}

function shouldSkipDirectory(dir) {
  return SKIP_DIRECTORY_NAMES.has(path.basename(dir));
}

async function collectFiles(root, packages) {
  const files = new Set();
  const childPackageDirs = packages.filter((pkg) => pkg.dir !== root).map((pkg) => pkg.dir);

  async function walk(dir, ownerDir) {
    if (shouldSkipDirectory(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (childPackageDirs.some((pkgDir) => pkgDir !== ownerDir && pkgDir === fullPath)) continue;
        if (!shouldSkipDirectory(fullPath)) await walk(fullPath, ownerDir);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.add(fullPath);
      }
    }
  }

  for (const pkg of packages) {
    if (pkg.dir === root) {
      const scriptsDir = path.join(root, 'scripts');
      await walk(scriptsDir, root);
      let entries = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        // The package manifest read already diagnosed a missing root.
      }
      for (const entry of entries) {
        if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.add(path.join(root, entry.name));
        }
      }
    } else {
      await walk(pkg.dir, pkg.dir);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function importHasRuntimeBindings(clause) {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return (
    clause.namedBindings.elements.length === 0 ||
    clause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportHasRuntimeBindings(declaration) {
  if (declaration.isTypeOnly) return false;
  if (!declaration.exportClause) return true;
  if (ts.isNamedExports(declaration.exportClause)) {
    return (
      declaration.exportClause.elements.length === 0 ||
      declaration.exportClause.elements.some((element) => !element.isTypeOnly)
    );
  }
  return true;
}

function boundNames(name, names = []) {
  if (ts.isIdentifier(name)) {
    names.push(name);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) boundNames(element.name, names);
    }
  }
  return names;
}

function resolvesToRuntimeManifest(fileName, specifier, root) {
  if (!specifier.startsWith('.')) return false;
  const basePath = path.resolve(path.dirname(fileName), specifier);
  const manifestPath = path.resolve(root, 'apps/hub-worker/runtime/manifest.ts');
  return basePath === manifestPath || `${basePath}.ts` === manifestPath;
}

function hasOtherBinding(source, localName, expectedImport) {
  let conflict = false;
  const checkName = (name, declaration) => {
    if (declaration !== expectedImport && ts.isIdentifier(name) && name.text === localName)
      conflict = true;
  };

  function visit(node) {
    if (ts.isImportSpecifier(node)) checkName(node.name, node);
    else if (ts.isNamespaceImport(node)) checkName(node.name, node);
    else if (ts.isImportClause(node) && node.name) checkName(node.name, node);
    else if (ts.isImportEqualsDeclaration(node)) checkName(node.name, node);
    else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      for (const name of boundNames(node.name)) checkName(name, node);
    } else if (ts.isBindingElement(node)) {
      for (const name of boundNames(node.name)) checkName(name, node);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      if (node.name) checkName(node.name, node);
    } else if (ts.isTypeParameterDeclaration(node)) {
      checkName(node.name, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return conflict;
}

function exportedRuntimeResolver(sourceText, fileName) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return source.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'validatedRevisionModuleUrl' &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function runtimeResolverBindings(source, fileName, runtimeResolver) {
  const bindings = new Map();
  if (!runtimeResolver.exported) return bindings;

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToRuntimeManifest(fileName, statement.moduleSpecifier.text, runtimeResolver.root)
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (
        element.isTypeOnly ||
        (element.propertyName ?? element.name).text !== 'validatedRevisionModuleUrl'
      )
        continue;
      const localName = element.name.text;
      const candidates = bindings.get(localName) ?? [];
      candidates.push(element);
      bindings.set(localName, candidates);
    }
  }

  for (const [localName, candidates] of bindings) {
    if (candidates.length !== 1 || hasOtherBinding(source, localName, candidates[0]))
      bindings.delete(localName);
  }
  return bindings;
}

function collectReferencesFromAst(sourceText, fileName, scriptKind, runtimeResolver = {}) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const references = [];
  const runtimeResolverImports = runtimeResolver.root
    ? runtimeResolverBindings(source, fileName, runtimeResolver)
    : new Map();

  const add = (specifier, kind, runtime = true) => {
    references.push({ specifier, kind, runtime });
  };

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, 'import', importHasRuntimeBindings(node.importClause));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, 'export', exportHasRuntimeBindings(node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, 'import-equals', !node.isTypeOnly);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, 'type-import', false);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        const resolverName =
          isDynamicImport &&
          node.arguments.length === 1 &&
          argument &&
          ts.isCallExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          runtimeResolverImports.has(argument.expression.text)
            ? argument.expression.text
            : null;
        if (resolverName) add(null, 'validated-runtime-import');
        else if (argument && isStringLiteral(argument))
          add(argument.text, isDynamicImport ? 'dynamic-import' : 'require');
        else add(null, isDynamicImport ? 'dynamic-import' : 'require');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

function cssImportSpecifier(params) {
  const value = params.trim();
  const quoted = value.match(/^(['"])(.*?)\1/);
  if (quoted) return quoted[2];
  const url = value.match(/^url\(\s*(?:(['"])(.*?)\1|([^\s)]+))\s*\)/i);
  return url ? (url[2] ?? url[3] ?? null) : null;
}

function isCssRelativeImport(specifier) {
  return (
    !specifier.startsWith('/') &&
    !specifier.startsWith('@') &&
    !specifier.startsWith('#') &&
    !/^[a-z][a-z\d+.-]*:/i.test(specifier)
  );
}

function collectCssReferences(sourceText, fileName) {
  const references = [];
  const root = postcss.parse(sourceText, { from: fileName });
  root.walkAtRules('import', (rule) => {
    const specifier = cssImportSpecifier(rule.params);
    if (specifier) references.push({ specifier, kind: 'css-import', runtime: true });
  });
  return references;
}

function parseVueSource(sourceText, fileName, runtimeResolver) {
  const result = parseSfc(sourceText, { filename: fileName });
  if (result.errors.length) throw result.errors[0];
  const references = [];
  for (const block of [result.descriptor.script, result.descriptor.scriptSetup]) {
    if (!block) continue;
    if (block.src) references.push({ specifier: block.src, kind: 'vue-script-src', runtime: true });
    if (block.src) continue;
    const lang = block.lang?.toLowerCase();
    const kind =
      lang === 'tsx'
        ? ts.ScriptKind.TSX
        : lang === 'jsx'
          ? ts.ScriptKind.JSX
          : lang === 'js' || lang === 'mjs'
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
    references.push(...collectReferencesFromAst(block.content, fileName, kind, runtimeResolver));
  }
  const template = result.descriptor.template;
  if (template?.src) {
    references.push({ specifier: template.src, kind: 'vue-template-src', runtime: true });
  } else if (template) {
    const compiled = compileTemplate({
      source: template.content,
      filename: fileName,
      id: fileName,
    });
    if (compiled.errors.length) throw compiled.errors[0];
    references.push(
      ...collectReferencesFromAst(
        compiled.code,
        `${fileName}?template`,
        ts.ScriptKind.TS,
        runtimeResolver,
      ),
    );
  }
  for (const style of result.descriptor.styles) {
    if (style.src) references.push({ specifier: style.src, kind: 'vue-style-src', runtime: true });
    else references.push(...collectCssReferences(style.content, fileName));
  }
  return references;
}

async function parseFile(fullPath, runtimeResolver) {
  const sourceText = await readFile(fullPath, 'utf8');
  if (path.extname(fullPath).toLowerCase() === '.css') {
    return collectCssReferences(sourceText, fullPath);
  }
  if (path.extname(fullPath).toLowerCase() === '.vue')
    return parseVueSource(sourceText, fullPath, runtimeResolver);
  const extension = path.extname(fullPath).toLowerCase();
  const kind =
    extension === '.jsx'
      ? ts.ScriptKind.JSX
      : extension === '.js' || extension === '.mjs' || extension === '.cjs'
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return collectReferencesFromAst(sourceText, fullPath, kind, runtimeResolver);
}

async function resolveExistingFile(basePath) {
  const candidates = [basePath];
  if (!path.extname(basePath)) {
    for (const extension of [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.vue',
      '.css',
      '.html',
      '.json',
    ]) {
      candidates.push(`${basePath}${extension}`);
    }
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep checking extension and index candidates.
    }
  }
  for (const extension of [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
    '.css',
    '.html',
  ]) {
    const candidate = path.join(basePath, `index${extension}`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // The import may name an asset or unresolved third-party module.
    }
  }
  return null;
}

function workspaceTargetForSpecifier(packages, specifier) {
  specifier = specifier.split(/[?#]/, 1)[0];
  return (
    packages
      .filter(
        (pkg) =>
          pkg.name &&
          pkg.name !== '<root>' &&
          (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)),
      )
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

function exportSubpath(pkg, specifier) {
  specifier = specifier.split(/[?#]/, 1)[0];
  return specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
}

function flattenExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenExportTargets);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([condition]) => condition !== 'types')
      .flatMap(([, target]) => flattenExportTargets(target));
  }
  return [];
}

function targetsForSubpath(exportsField, subpath) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField))
    return subpath === '.' ? flattenExportTargets(exportsField) : [];
  if (!exportsField || typeof exportsField !== 'object') return [];
  const keys = Object.keys(exportsField);
  if (!keys.some((key) => key.startsWith('.')))
    return subpath === '.' ? flattenExportTargets(exportsField) : [];
  if (Object.hasOwn(exportsField, subpath)) return flattenExportTargets(exportsField[subpath]);

  const matches = keys
    .filter((key) => key.includes('*'))
    .map((key) => {
      const [prefix, suffix = ''] = key.split('*');
      if (
        !subpath.startsWith(prefix) ||
        !subpath.endsWith(suffix) ||
        subpath.length < prefix.length + suffix.length
      )
        return null;
      return {
        key,
        capture: subpath.slice(prefix.length, subpath.length - suffix.length || undefined),
        prefixLength: prefix.length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.prefixLength - a.prefixLength);
  if (!matches.length) return [];
  const { key, capture } = matches[0];
  return flattenExportTargets(exportsField[key]).map((target) => target.replaceAll('*', capture));
}

async function resolveWorkspaceExportTargets(root, pkg, specifier) {
  const subpath = exportSubpath(pkg, specifier);
  const targets = targetsForSubpath(pkg.manifest.exports, subpath);
  const resolved = [];
  for (const target of targets) {
    if (!target.startsWith('./')) continue;
    const fullPath = await resolveExistingFile(path.resolve(pkg.dir, target));
    if (fullPath && isInside(root, fullPath)) resolved.push(fullPath);
  }
  return [...new Set(resolved)];
}

function exceptionKey(item) {
  return `${item.file}\0${item.specifier}\0${item.rule}`;
}

async function normalizeExceptions(input, filePath, violations) {
  let entries = input;
  if (entries === undefined) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      entries = Array.isArray(parsed) ? parsed : parsed.exceptions;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        violations.push({
          file: 'boundary-exceptions.json',
          specifier: 'parse',
          rule: 'invalid-exceptions',
          detail: error.message,
        });
      }
      entries = [];
    }
  }
  if (!Array.isArray(entries)) {
    violations.push({
      file: 'boundary-exceptions.json',
      specifier: 'schema',
      rule: 'invalid-exceptions',
      detail: 'Expected an array or an object with an exceptions array.',
    });
    return [];
  }

  const keys = new Set();
  const normalizedEntries = [];
  entries.forEach((entry, index) => {
    const file = typeof entry?.file === 'string' ? entry.file.replaceAll('\\', '/') : '';
    const validPath =
      file !== '' &&
      !file.startsWith('/') &&
      !file.split('/').includes('..') &&
      path.posix.normalize(file) === file;
    const valid =
      validPath &&
      typeof entry.specifier === 'string' &&
      typeof entry.rule === 'string' &&
      typeof entry.owner === 'string' &&
      entry.owner.trim() !== '' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== '' &&
      Number.isInteger(entry.removeStep) &&
      entry.removeStep >= 2 &&
      entry.removeStep <= 8;
    if (!valid) {
      violations.push({
        file: file || `boundary-exceptions.json#${index + 1}`,
        specifier: entry?.specifier ?? 'invalid',
        rule: 'invalid-exception',
        detail:
          'Each exception needs a relative exact file, string specifier and rule, owner, reason, and integer removeStep from 2 through 8.',
      });
      return;
    }
    const normalized = { ...entry, file };
    const key = exceptionKey(normalized);
    if (keys.has(key)) {
      violations.push({
        file,
        specifier: entry.specifier,
        rule: 'invalid-exception',
        detail: 'Duplicate exception key.',
      });
      return;
    }
    keys.add(key);
    normalizedEntries.push(normalized);
  });
  return normalizedEntries;
}

function isProductionFile(root, fullPath) {
  const file = relativePath(root, fullPath);
  return (
    file.startsWith('apps/stage/src/') ||
    file.startsWith('apps/hub-worker/src/') ||
    file.startsWith('apps/hub-worker/runtime/') ||
    file.startsWith('packages/hub/frontend/') ||
    file.startsWith('packages/hub/src/frontend/') ||
    file.startsWith('packages/hub/src/client/') ||
    file.startsWith('packages/protocol/src/')
  );
}

function isProductionSourceFile(root, fullPath) {
  const file = relativePath(root, fullPath);
  return (
    /^(?:apps|packages)\/[^/]+\/(?:src|runtime)\//.test(file) || isProductionFile(root, fullPath)
  );
}

function isExperimentPath(root, fullPath) {
  const relative = path.relative(root, path.resolve(fullPath));
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep).includes('experiments')
  );
}

function addViolation(violations, violation) {
  const key = exceptionKey(violation);
  if (!violations.some((existing) => exceptionKey(existing) === key)) violations.push(violation);
}

function findCycles(packages, edges, violations) {
  const adjacency = new Map(packages.map((pkg) => [pkg, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge);
  for (const outgoing of adjacency.values()) {
    outgoing.sort((a, b) =>
      `${a.to.name}:${a.file}:${a.specifier}`.localeCompare(
        `${b.to.name}:${b.file}:${b.specifier}`,
      ),
    );
  }

  const state = new Map();
  const stack = [];
  const reportedCycles = new Set();
  function visit(pkg) {
    state.set(pkg, 1);
    stack.push(pkg);
    for (const edge of adjacency.get(pkg) ?? []) {
      if (state.get(edge.to) === 1) {
        const cycleStart = stack.indexOf(edge.to);
        const cyclePackages = stack.slice(cycleStart);
        const cycleKey = [...new Set(cyclePackages.map((item) => item.name))].sort().join('\0');
        if (reportedCycles.has(cycleKey)) continue;
        reportedCycles.add(cycleKey);
        const cycle = [...cyclePackages, edge.to].map((item) => item.name).join(' -> ');
        addViolation(violations, {
          file: edge.file,
          specifier: edge.specifier,
          rule: 'workspace-cycle',
          detail: `Workspace dependency cycle: ${cycle}`,
        });
      } else if (!state.has(edge.to)) {
        visit(edge.to);
      }
    }
    stack.pop();
    state.set(pkg, 2);
  }
  for (const pkg of packages) if (!state.has(pkg)) visit(pkg);
}

function declaredDependencyEdges(packages) {
  const edges = [];
  const byName = new Map(
    packages.filter((pkg) => pkg.name && pkg.name !== '<root>').map((pkg) => [pkg.name, pkg]),
  );
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      const target = byName.get(dependency);
      if (!target) continue;
      edges.push({
        from: pkg,
        to: target,
        file: pkg.relativeDir === '.' ? 'package.json' : `${pkg.relativeDir}/package.json`,
        specifier: dependency,
      });
    }
  }
  return edges;
}

export async function checkBoundaries({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  exceptions,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const violations = [];
  const exceptionEntries = await normalizeExceptions(
    exceptions,
    path.join(absoluteRoot, 'scripts/boundary-exceptions.json'),
    violations,
  );
  const exceptionsByKey = new Map(exceptionEntries.map((entry) => [exceptionKey(entry), entry]));
  const usedKeys = new Set();
  const packages = await discoverPackages(absoluteRoot);
  const graphEdges = declaredDependencyEdges(packages);
  const files = await collectFiles(absoluteRoot, packages);
  const parsed = new Map();
  const runtimeManifestPath = path.resolve(absoluteRoot, 'apps/hub-worker/runtime/manifest.ts');
  let runtimeResolverExported = false;
  try {
    runtimeResolverExported = exportedRuntimeResolver(
      await readFile(runtimeManifestPath, 'utf8'),
      runtimeManifestPath,
    );
  } catch {
    // Fixtures and partial workspaces may omit the Workers runtime entirely.
  }
  const runtimeResolver = { root: absoluteRoot, exported: runtimeResolverExported };

  for (const fullPath of files) {
    const file = relativePath(absoluteRoot, fullPath);
    const owner = packageForPath(packages, fullPath);
    if (!owner) continue;
    let refs;
    try {
      refs = await parseFile(fullPath, runtimeResolver);
    } catch (error) {
      addViolation(violations, {
        file,
        specifier: '<parse>',
        rule: 'source-parse-error',
        detail: String(error?.message ?? error),
      });
      refs = [];
    }
    const enriched = [];
    for (const ref of refs) {
      const item = {
        ...ref,
        fromFile: fullPath,
        file,
        owner,
        targets: [],
        experimentCandidates: [],
        workspaceTarget: null,
      };
      const experimentCandidates = [];
      const isRelativePath = ref.specifier?.startsWith('./') || ref.specifier?.startsWith('../');
      const cssRelativePath = ref.kind === 'css-import' && isCssRelativeImport(ref.specifier ?? '');
      if (ref.specifier !== null && (isRelativePath || cssRelativePath)) {
        const relativeSpecifier = (isRelativePath ? ref.specifier : `./${ref.specifier}`).split(
          /[?#]/,
          1,
        )[0];
        const targetPath = path.resolve(path.dirname(fullPath), relativeSpecifier);
        experimentCandidates.push(targetPath);
        const targetFile = await resolveExistingFile(targetPath);
        if (targetFile) {
          item.targets.push(targetFile);
          const targetOwner = packageForPath(packages, targetFile);
          if (targetOwner && targetOwner !== owner) {
            graphEdges.push({ from: owner, to: targetOwner, file, specifier: ref.specifier });
            addViolation(violations, {
              file,
              specifier: ref.specifier,
              rule: 'cross-package-relative-import',
              detail: `Relative import crosses from ${owner.name} into ${targetOwner.name}.`,
            });
          }
        }
      } else if (ref.specifier !== null && !ref.specifier.startsWith('#')) {
        const targetPackage = workspaceTargetForSpecifier(packages, ref.specifier);
        if (targetPackage) {
          item.workspaceTarget = targetPackage;
          // Package self-references through exports are not inter-package cycles.
          if (owner !== targetPackage)
            graphEdges.push({ from: owner, to: targetPackage, file, specifier: ref.specifier });
          if (owner !== targetPackage && !owner.dependencies.has(targetPackage.name)) {
            addViolation(violations, {
              file,
              specifier: ref.specifier,
              rule: 'workspace-undeclared-dependency',
              detail: `${owner.name} imports ${targetPackage.name} without declaring it in package.json dependencies.`,
            });
          }
          const exportTargets = await resolveWorkspaceExportTargets(
            absoluteRoot,
            targetPackage,
            ref.specifier,
          );
          item.targets.push(...exportTargets);
          if (!exportTargets.length) {
            addViolation(violations, {
              file,
              specifier: ref.specifier,
              rule: 'workspace-private-import',
              detail: `${ref.specifier} is not exposed by ${targetPackage.name}'s package exports.`,
            });
            const subpath = exportSubpath(targetPackage, ref.specifier);
            const fallback =
              subpath === '.'
                ? await resolveExistingFile(
                    path.join(
                      targetPackage.dir,
                      targetPackage.manifest.module ?? targetPackage.manifest.main ?? 'index',
                    ),
                  )
                : await resolveExistingFile(path.resolve(targetPackage.dir, `.${subpath}`));
            if (fallback) item.targets.push(fallback);
            experimentCandidates.push(
              subpath === '.'
                ? path.resolve(
                    targetPackage.dir,
                    targetPackage.manifest.module ?? targetPackage.manifest.main ?? 'index',
                  )
                : path.resolve(targetPackage.dir, `.${subpath}`),
            );
          }
        }
      }
      item.experimentCandidates = experimentCandidates;
      enriched.push(item);
    }
    parsed.set(fullPath, enriched);
  }

  findCycles(packages, graphEdges, violations);

  const visitedExperimentSources = new Set();
  function walkProductionExperiments(fullPath) {
    const normalized = path.resolve(fullPath);
    if (visitedExperimentSources.has(normalized)) return;
    visitedExperimentSources.add(normalized);

    for (const ref of parsed.get(normalized) ?? []) {
      for (const target of [...ref.targets, ...ref.experimentCandidates]) {
        if (isExperimentPath(absoluteRoot, target)) {
          addViolation(violations, {
            file: ref.file,
            specifier: ref.specifier ?? '<non-literal>',
            rule: 'production-experiment-import',
            detail: 'Production source dependency graphs must not reach an experiments directory.',
          });
          continue;
        }
        if (isInside(absoluteRoot, target) && parsed.has(target)) walkProductionExperiments(target);
      }
    }
  }
  for (const fullPath of files) {
    if (
      isProductionSourceFile(absoluteRoot, fullPath) &&
      !isExperimentPath(absoluteRoot, fullPath)
    ) {
      walkProductionExperiments(fullPath);
    }
  }

  const visitedProduction = new Set();
  async function walkProduction(fullPath) {
    const normalized = path.resolve(fullPath);
    if (visitedProduction.has(normalized)) return;
    visitedProduction.add(normalized);
    const refs = parsed.get(normalized) ?? [];
    for (const ref of refs) {
      if (!ref.runtime) continue;
      if (ref.kind === 'validated-runtime-import') continue;
      if (ref.specifier === null) {
        addViolation(violations, {
          file: ref.file,
          specifier: '<non-literal>',
          rule: 'production-nonliteral-import',
          detail: `${ref.kind} in the browser production dependency graph is not statically resolvable.`,
        });
        continue;
      }
      if (ref.kind !== 'css-import' && isNodeBuiltin(ref.specifier)) {
        addViolation(violations, {
          file: ref.file,
          specifier: ref.specifier,
          rule: 'production-node-builtin',
          detail: 'Browser production code reaches a Node.js builtin module.',
        });
        continue;
      }
      for (const target of ref.targets) {
        if (isInside(absoluteRoot, target) && parsed.has(target)) await walkProduction(target);
      }
    }
  }
  for (const fullPath of files)
    if (isProductionFile(absoluteRoot, fullPath)) await walkProduction(fullPath);

  const violationsByKey = new Map();
  for (const violation of violations) {
    const key = exceptionKey(violation);
    const exception = exceptionsByKey.get(key);
    if (
      exception &&
      violation.rule !== 'invalid-exception' &&
      violation.rule !== 'invalid-exceptions'
    ) {
      usedKeys.add(key);
      continue;
    }
    violationsByKey.set(key, violation);
  }

  for (const entry of exceptionEntries) {
    const key = exceptionKey(entry);
    if (!usedKeys.has(key)) {
      violationsByKey.set(`stale\0${key}`, {
        file: entry.file,
        specifier: entry.specifier,
        rule: 'stale-exception',
        detail: `Migration exception owned by ${entry.owner} was not used; remove it or update its exact key.`,
      });
    }
  }

  const resultViolations = [...violationsByKey.values()].sort((a, b) =>
    `${a.file}\0${a.specifier}\0${a.rule}`.localeCompare(`${b.file}\0${b.specifier}\0${b.rule}`),
  );
  const exceptionsUsed = exceptionEntries.filter((entry) => usedKeys.has(exceptionKey(entry)));
  const runtimeResolutions = [...parsed.values()]
    .flat()
    .filter((reference) => reference.kind === 'validated-runtime-import').length;
  return { violations: resultViolations, exceptionsUsed, runtimeResolutions };
}

export function boundaryCheckExitCode(result) {
  return result.violations.length || result.exceptionsUsed.length ? 1 : 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const result = await checkBoundaries({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  for (const violation of result.violations) {
    console.error(
      `FAIL ${violation.rule} ${violation.file} -> ${violation.specifier}: ${violation.detail}`,
    );
  }
  for (const exception of result.exceptionsUsed) {
    console.log(
      `ALLOW ${exception.rule} ${exception.file} -> ${exception.specifier} (owner: ${exception.owner}, remove Step ${exception.removeStep})`,
    );
  }
  console.log(
    `Boundary check: ${result.violations.length} violation(s), ${result.exceptionsUsed.length} migration exception(s) used, ${result.runtimeResolutions} validated runtime resolution(s).`,
  );
  process.exitCode = boundaryCheckExitCode(result);
}
