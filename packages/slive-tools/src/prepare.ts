import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeckInspection, SlidevParseSync } from '@slidock/slidev-adapter/inspect-deck';
import type { NativeDeck } from '@slidock/protocol/contracts';
import type { LocalStageConfig, StageDeckNotes } from './config.js';
import { StageToolsError, withConfigLock, writeConfigAtomically } from './config.js';
import {
  assertDeckEntryExists,
  canonicalEntryForId,
  checkTreeForPrivateSentinels,
  inspectDeckSource,
  loadSlidevParser,
  readManifestSnapshot,
  resolveManifestSources,
} from './prepare-core.mjs';

type ManifestDeck = {
  id: string;
  sourcePath: string;
  entry: string;
  revision: string;
  pages: number;
};

export type PrepareFallbackDeck = { id: string; sourcePath: string; entry: string };
export type PrepareStageOptions = {
  site: string;
  fixturesRoot: string;
  configPath: string;
  receiptPath?: string;
  legacySourceRoot?: string;
  dependencyRoot?: string;
  fallbackDecks?: PrepareFallbackDeck[];
  onProgress?: (event: { phase: string }) => void;
};
export type PrepareStageResult = {
  config: LocalStageConfig;
  configPath: string;
  siteRoot: string;
};

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function requireAbsolutePath(name: string, value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new StageToolsError('INVALID_INPUT', `${name} must be an absolute path`);
  return path.resolve(value);
}

function isInside(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function validateFallbackDecks(
  fallbackDecks: PrepareFallbackDeck[] | undefined,
): PrepareFallbackDeck[] {
  if (!Array.isArray(fallbackDecks) || fallbackDecks.length === 0)
    throw new Error('a public manifest is missing and fallbackDecks were not provided');
  return fallbackDecks.map((deck) => {
    if (!deck || typeof deck !== 'object') throw new Error('fallback deck must be an object');
    const entry = canonicalEntryForId(deck.id);
    if (deck.entry !== entry) throw new Error(`fallback deck ${deck.id} entry must be ${entry}`);
    if (typeof deck.sourcePath !== 'string' || deck.sourcePath.length === 0)
      throw new Error(`fallback deck ${deck.id} must have a non-empty sourcePath`);
    return { id: deck.id, sourcePath: deck.sourcePath, entry };
  });
}

async function validateVersionsRoot(versionsRoot: string): Promise<void> {
  try {
    const info = await fs.lstat(versionsRoot);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`version output path must be a real directory: ${versionsRoot}`);
    if ((await fs.realpath(versionsRoot)) !== versionsRoot)
      throw new Error(`version output path resolves outside its config directory: ${versionsRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Validate every input before publishing a version directory or changing the config pointer. */
export async function prepareStage(options: PrepareStageOptions): Promise<PrepareStageResult> {
  let stagingRoot: string | undefined;
  let publishedRoot: string | undefined;
  let configWasWritten = false;
  try {
    const siteInput = requireAbsolutePath('site', options.site);
    const fixturesRootInput = requireAbsolutePath('fixturesRoot', options.fixturesRoot);
    const requestedConfigPath = requireAbsolutePath('configPath', options.configPath);
    const receiptPath =
      options.receiptPath === undefined
        ? undefined
        : requireAbsolutePath('receiptPath', options.receiptPath);
    const legacySourceRoot =
      options.legacySourceRoot === undefined
        ? undefined
        : requireAbsolutePath('legacySourceRoot', options.legacySourceRoot);
    const dependencyRoot =
      options.dependencyRoot === undefined
        ? packageRoot
        : requireAbsolutePath('dependencyRoot', options.dependencyRoot);

    return await withConfigLock(requestedConfigPath, async (configPath) => {
      await options.onProgress?.({ phase: 'validate' });
      const sourceSite = await fs.realpath(siteInput);
      if (!(await fs.stat(sourceSite)).isDirectory())
        throw new Error(`source site is not a directory: ${sourceSite}`);

      const manifestSnapshot = (await readManifestSnapshot(siteInput, receiptPath)) as {
        bytes: Buffer | null;
        manifest: { schemaVersion: 1; decks: ManifestDeck[] } | null;
      };
      const { manifest } = manifestSnapshot;
      const manifestMode = manifest !== null;
      const declaredDecks = manifestMode
        ? manifest.decks
        : validateFallbackDecks(options.fallbackDecks);
      const resolved = (await resolveManifestSources(
        declaredDecks,
        legacySourceRoot,
        fixturesRootInput,
      )) as {
        approvedRoot: string;
        sources: Array<(ManifestDeck | PrepareFallbackDeck) & { source: string }>;
      };
      const { approvedRoot, sources } = resolved;
      const versionsRoot = path.join(path.dirname(configPath), 'versions');
      await validateVersionsRoot(versionsRoot);
      if (pathsOverlap(sourceSite, versionsRoot))
        throw new Error('source site and version output directory must not overlap');
      if (pathsOverlap(approvedRoot, versionsRoot))
        throw new Error('approved source root and version output directory must not overlap');
      if (receiptPath && isInside(sourceSite, receiptPath))
        throw new Error('receiptPath must not be inside the source site');

      const parser = (await loadSlidevParser(dependencyRoot)) as { parseSync: SlidevParseSync };
      const decks: NativeDeck[] = [];
      const notes: Record<string, StageDeckNotes> = {};
      for (const sourceDeck of sources) {
        await assertDeckEntryExists(sourceSite, sourceDeck.id);
        const bytes = await fs.readFile(sourceDeck.source);
        const text = bytes.toString('utf8');
        const inspection = inspectDeckSource({
          id: sourceDeck.id,
          source: sourceDeck.source,
          text,
          parseSync: parser.parseSync,
          expectedPages: manifestMode ? (sourceDeck as ManifestDeck).pages : undefined,
          legacyFallback: !manifestMode,
        }) as DeckInspection;
        const revision = createHash('sha256').update(bytes).digest('hex');
        decks.push({
          id: sourceDeck.id,
          revision: manifestMode ? (sourceDeck as ManifestDeck).revision : revision,
          entry: manifestMode
            ? (sourceDeck as ManifestDeck).entry
            : canonicalEntryForId(sourceDeck.id),
          clickTotals: inspection.clickTotals,
        });
        notes[sourceDeck.id] = { source: sourceDeck.source, revision, slots: inspection.slots };
      }
      await checkTreeForPrivateSentinels(sourceSite);

      const versionId = randomUUID();
      stagingRoot = path.join(versionsRoot, `.preparing-${versionId}`);
      publishedRoot = path.join(versionsRoot, versionId);
      const stagingSite = path.join(stagingRoot, 'site');
      const publishedSite = path.join(publishedRoot, 'site');
      const config: LocalStageConfig = {
        schemaVersion: 1,
        decks,
        notes,
        approvedSourceRoot: approvedRoot,
        siteRoot: publishedSite,
      };

      await options.onProgress?.({ phase: 'copy' });
      await fs.mkdir(versionsRoot, { recursive: true });
      await fs.mkdir(stagingRoot);
      await fs.cp(sourceSite, stagingSite, { recursive: true, errorOnExist: true, force: false });
      await checkTreeForPrivateSentinels(stagingSite);
      for (const sourceDeck of sources) await assertDeckEntryExists(stagingSite, sourceDeck.id);
      const sourceManifestAfterCopy = await readOptionalFile(
        path.join(sourceSite, 'manifest.json'),
      );
      const copiedManifest = await readOptionalFile(path.join(stagingSite, 'manifest.json'));
      if (
        !sameBytes(sourceManifestAfterCopy, manifestSnapshot.bytes) ||
        !sameBytes(copiedManifest, manifestSnapshot.bytes)
      )
        throw new Error('public manifest changed while the site was being prepared');
      await fs.writeFile(
        path.join(stagingRoot, 'site-provenance.json'),
        `${JSON.stringify({ sourceSite, preparedAt: new Date().toISOString(), decks }, null, 2)}\n`,
      );
      await options.onProgress?.({ phase: 'promote' });
      await fs.rename(stagingRoot, publishedRoot);
      stagingRoot = undefined;
      await writeConfigAtomically(configPath, config);
      configWasWritten = true;
      return { config, configPath, siteRoot: publishedSite };
    });
  } catch (error) {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (publishedRoot && !configWasWritten)
      await fs.rm(publishedRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof StageToolsError) throw error;
    throw new StageToolsError(
      'PREPARE_FAILED',
      error instanceof Error ? error.message : 'stage preparation failed',
      { cause: error },
    );
  }
}

async function readOptionalFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}
