import { parseSync } from '@slidev/parser';
import {
  compileStyle,
  compileTemplate,
  parse as parseSfc,
} from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';
import type { BindingMetadata } from '@vue/compiler-sfc';
import { createGenerator } from '@unocss/core';
import { presetWind3 } from '@unocss/preset-wind3';
import { createMarkdownExit } from 'markdown-exit';
import { inspectNativeClicks, type SlideContent } from '@slidev-stage-hub/slidev-adapter/clicks';

const RUNTIME_VUE_MODULE = '/_runtime/vue.js';
const RUNTIME_BRIDGE_MODULE = '/_runtime/bridge.js';
const SLIDE_CONTEXT_BINDINGS = {
  $slidev: 'setup-maybe-ref',
  $nav: 'setup-maybe-ref',
  $clicksContext: 'setup-maybe-ref',
  $clicks: 'setup-maybe-ref',
  $page: 'setup-maybe-ref',
  $route: 'setup-maybe-ref',
  $renderContext: 'setup-maybe-ref',
  $frontmatter: 'setup-maybe-ref',
  $scale: 'setup-maybe-ref',
  $zoom: 'setup-maybe-ref',
  // Vue's string enum rejects its own literal values at the type level.
} as unknown as BindingMetadata;
const MAX_SLIDES = 100;
const PLAIN_CODE_WARNING =
  'Fenced code is rendered as plain Markdown; Slidev syntax highlighting and code-block transforms are not included.';
const PLAIN_MATH_WARNING =
  'Dollar-delimited math ($...$ or $$...$$) remains plain text in Workers output; no math renderer is applied.';
const PRIVATE_FRONTMATTER_KEY = /^(?:(?:speaker|presenter|private)[_-]?)?notes?$/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const NAMED_SLOT_RE = /^ {0,3}::([\w-]+)::[ \t]*$/;
const SUPPORTED_NAMED_SLOTS = new Set(['default', 'left', 'right']);
const NATIVE_CLICK_UNSUPPORTED =
  'This deck uses click behavior that the native player does not support.';
const markdown = createMarkdownExit({ html: true });
const unoPromise = createGenerator({ presets: [presetWind3()] });

export class DeckCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckCompileError';
  }
}

export interface CompiledSlide {
  no: number;
  title?: string;
  frontmatter: Record<string, unknown>;
  code: string;
  css: string;
}

export type NativeClickMetadata = { clickTotals: number[] } | { unsupportedReason: string };

export interface CompileDeckResult {
  title: string;
  frontmatter: Record<string, unknown>;
  slides: CompiledSlide[];
  warnings: string[];
  native: NativeClickMetadata;
}

export interface CompileDeckInput {
  markdown: string;
  deckId: string;
  assetBase?: string;
}

interface NamedSlotSection {
  name: string;
  content: string;
}

interface SlideSections {
  hasNamedSlots: boolean;
  sections: NamedSlotSection[];
}

interface ProtectedContent {
  masked: string;
  fences: string[];
  restore(value: string): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compile a supported subset of Slidev 53 markdown into standalone Vue ESM.
 * This adapter deliberately has no filesystem, process, Vite, or code-evaluation
 * dependency so its module can be bundled into a Workers compiler.
 */
export async function compileDeck({
  markdown: source,
  deckId,
  assetBase = defaultAssetBase(deckId),
}: CompileDeckInput): Promise<CompileDeckResult> {
  if (typeof source !== 'string') throw new DeckCompileError('markdown must be a string');
  validateDeckId(deckId);
  const normalizedAssetBase = normalizeAssetBase(assetBase);
  const parsed = parseSync(source, `${deckId}.md`);
  if (!parsed.slides.length) throw new DeckCompileError(`Deck "${deckId}" has no slides`);
  if (parsed.slides.length > MAX_SLIDES) {
    throw new DeckCompileError(
      `Deck "${deckId}" has ${parsed.slides.length} slides; the Workers compiler limit is ${MAX_SLIDES}`,
    );
  }

  const parsedSlides = parsed.slides;
  let hasOrdinaryFencedCode = false;
  let hasDollarMath = false;
  const slideSections: SlideSections[] = [];
  for (let index = 0; index < parsedSlides.length; index++) {
    const slide = parsedSlides[index];
    const parseErrors = slide.frontmatterDoc?.errors;
    if (parseErrors?.length) {
      throw new DeckCompileError(
        `Slide ${index + 1} has invalid frontmatter: ${parseErrors[0].message}`,
      );
    }
    if (slide.frontmatter?.src) {
      throw new DeckCompileError(
        `Slide ${index + 1} uses Slidev's src include; source includes are not supported by the Workers compiler`,
      );
    }
    const protectedContent = protectFencedCode(slide.content);
    slideSections.push(splitNamedSlotSections(slide.content, index + 1, protectedContent));
    hasDollarMath ||= containsDollarMath(protectedContent.masked);
    for (const fenceInfo of protectedContent.fences) {
      const language = fenceInfo.match(/^[^\s{]+/)?.[0]?.toLowerCase();
      if (language === 'mermaid' || language === 'plantuml' || language === 'puml') {
        throw new DeckCompileError(
          `Slide ${index + 1} uses a ${language} fence; diagram rendering is not supported by the Workers compiler`,
        );
      }
      if (/\bmonaco(?:-run)?\b/i.test(fenceInfo)) {
        throw new DeckCompileError(
          `Slide ${index + 1} uses Monaco fence metadata; interactive code blocks are not supported by the Workers compiler`,
        );
      }
      if (/\btwoslash\b/i.test(fenceInfo)) {
        throw new DeckCompileError(
          `Slide ${index + 1} uses Twoslash fence metadata; code annotations are not supported by the Workers compiler`,
        );
      }
      if (/\bmagic[\s_-]*move\b/i.test(fenceInfo)) {
        throw new DeckCompileError(
          `Slide ${index + 1} uses Magic Move fence metadata; code transitions are not supported by the Workers compiler`,
        );
      }
      hasOrdinaryFencedCode = true;
    }
  }

  const slides: CompiledSlide[] = [];
  for (let index = 0; index < parsedSlides.length; index++) {
    const parsedSlide = parsedSlides[index];
    const no = index + 1;
    const pageId = stableHash(`${deckId}\0${no}`);
    slides.push(
      await compileSlide({
        content: parsedSlide.content,
        title:
          typeof parsedSlide.title === 'string' ? cleanPublicString(parsedSlide.title) : undefined,
        deckId,
        no,
        pageId,
        assetBase: normalizedAssetBase,
        sections: slideSections[index],
        frontmatter: resolveFrontmatterImages(
          publicSlideFrontmatter(parsedSlide.frontmatter),
          normalizedAssetBase,
          deckId,
          no,
        ),
      }),
    );
  }

  const first = parsedSlides[0];
  const titleSource =
    typeof first.title === 'string'
      ? first.title
      : typeof first.frontmatter?.title === 'string'
        ? first.frontmatter.title
        : deckId;
  const title = cleanPublicString(titleSource);
  const warnings: string[] = [];
  if (hasOrdinaryFencedCode) warnings.push(PLAIN_CODE_WARNING);
  if (hasDollarMath) warnings.push(PLAIN_MATH_WARNING);
  return {
    title,
    frontmatter: resolveFrontmatterImages(
      publicSlideFrontmatter(first.frontmatter),
      normalizedAssetBase,
      deckId,
      1,
    ),
    slides,
    warnings,
    native: inspectNativeMetadata(parsedSlides, deckId, slides),
  };
}

function inspectNativeMetadata(
  slides: readonly (SlideContent & { frontmatter?: unknown })[],
  deckId: string,
  compiledSlides: readonly CompiledSlide[],
): NativeClickMetadata {
  const usesConfiguredClicks = slides.some((slide) => {
    if (!isRecord(slide.frontmatter)) return false;
    if (Object.hasOwn(slide.frontmatter, 'clicks')) return true;
    return (
      isRecord(slide.frontmatter.defaults) && Object.hasOwn(slide.frontmatter.defaults, 'clicks')
    );
  });
  if (usesConfiguredClicks) return { unsupportedReason: NATIVE_CLICK_UNSUPPORTED };

  // Native playback only implements the adapter's bare v-click subset and its
  // own layout. Mark uncertain source as unsupported instead of publishing
  // click totals that would silently differ from the Web presentation.
  if (
    slides.some(({ content }) => /\bv-click\s*=|\bv-clicks\b|<v-click\b/u.test(content)) ||
    compiledSlides.some(({ code }) =>
      /resolveDynamicComponent\(|resolveComponent\("(?!LabSlideLayout")[^"\\]+"\)/u.test(code),
    )
  ) {
    return { unsupportedReason: NATIVE_CLICK_UNSUPPORTED };
  }

  try {
    const clickTotals = inspectNativeClicks(slides, deckId);
    const visibleSlides = slides.map(({ content }) => ({ content: maskNativeExamples(content) }));
    const visibleClickTotals = inspectNativeClicks(visibleSlides, deckId);
    if (clickTotals.some((total, index) => visibleClickTotals[index] !== total)) {
      return { unsupportedReason: NATIVE_CLICK_UNSUPPORTED };
    }

    const hasClicks = clickTotals.some((total) => total > 0);
    const hasConditionalOrRepeatedContent = visibleSlides.some(({ content }) =>
      /<[^>]*\bv-(?:for|if|else(?:-if)?)(?=[\s=/>])/u.test(content),
    );
    if (hasClicks && hasConditionalOrRepeatedContent) {
      return { unsupportedReason: NATIVE_CLICK_UNSUPPORTED };
    }

    return { clickTotals };
  } catch {
    return { unsupportedReason: NATIVE_CLICK_UNSUPPORTED };
  }
}

function maskNativeExamples(source: string): string {
  const withoutFences = protectFencedCode(source).masked;
  const withoutComments = withoutFences.replace(HTML_COMMENT_RE, (comment) =>
    blankPreservingLines(comment),
  );
  return withoutComments.replace(
    /(^|[^\\])(`+)(?!`)([\s\S]*?)\2(?!`)/gu,
    (match, prefix) => `${prefix}${blankPreservingLines(match.slice(prefix.length))}`,
  );
}

function blankPreservingLines(value: string): string {
  return value.replace(/[^\n]/gu, ' ');
}

async function compileSlide({
  content: _content,
  sections,
  title,
  deckId,
  no,
  pageId,
  assetBase,
  frontmatter,
}: {
  content: string;
  sections: SlideSections;
  title?: string;
  deckId: string;
  no: number;
  pageId: string;
  assetBase: string;
  frontmatter: Record<string, unknown>;
}): Promise<CompiledSlide> {
  const styles = [];
  const renderedSections = [];
  for (const section of sections.sections) {
    const extracted = extractStyles(section.content, deckId, no);
    styles.push(...extracted.styles);
    let html = markdown.render(extracted.markdown);
    html = html.replace(HTML_COMMENT_RE, '');
    html = rewriteMarkupSources(html, assetBase, deckId, no);
    html = protectCodeElements(html);

    if (/<\s*script\b/i.test(html)) {
      throw new DeckCompileError(
        `Slide ${no} contains a <script> block; scripts are not supported by the Workers compiler`,
      );
    }
    if (/<\s*\/?\s*template\b/i.test(html)) {
      throw new DeckCompileError(
        `Slide ${no} contains a raw <template> tag; raw Vue template blocks are not supported in slide content`,
      );
    }

    renderedSections.push({ name: section.name, html });
  }

  const templateContent = sections.hasNamedSlots
    ? renderedSections
        .map((section) => `<template #${section.name}>${section.html}</template>`)
        .join('\n')
    : (renderedSections[0]?.html ?? '');
  const htmlForStyles = sections.hasNamedSlots
    ? templateContent
    : (renderedSections[0]?.html ?? '');

  const filename = `/${encodeURIComponent(deckId)}/${no}.vue`;
  const sfcSource = `<template>\n<LabSlideLayout>${templateContent}</LabSlideLayout>\n</template>\n${styles.map((style) => style.source).join('\n')}`;
  const parsedSfc = parseSfc(sfcSource, { filename });
  if (parsedSfc.errors.length) throw compileError(`Slide ${no} SFC parse`, parsedSfc.errors);
  if (parsedSfc.descriptor.script || parsedSfc.descriptor.scriptSetup) {
    throw new DeckCompileError(`Slide ${no} contains an unsupported script block`);
  }

  const scoped = parsedSfc.descriptor.styles.some((style) => style.scoped);
  const template = compileTemplate({
    source: parsedSfc.descriptor.template?.content ?? '<LabSlideLayout />',
    filename,
    id: pageId,
    scoped,
    compilerOptions: {
      mode: 'module',
      hoistStatic: false,
      runtimeModuleName: RUNTIME_VUE_MODULE,
      bindingMetadata: SLIDE_CONTEXT_BINDINGS,
    },
    transformAssetUrls: false,
  });
  if (template.errors.length) throw compileError(`Slide ${no} Vue template`, template.errors);

  const compiledStyles = [];
  for (const style of parsedSfc.descriptor.styles) {
    const result = compileStyle({
      source: style.content,
      filename,
      id: `data-v-${pageId}`,
      scoped: style.scoped,
      isProd: true,
    });
    if (result.errors.length) throw compileError(`Slide ${no} CSS`, result.errors);
    if (result.code.trim()) compiledStyles.push(result.code.trim());
  }

  const uno = await unoPromise;
  const generated = await uno.generate(htmlForStyles, { preflights: false });
  const css = [generated.css.trim(), ...compiledStyles].filter(Boolean).join('\n');
  const scopeId = scoped ? `\n__slide.__scopeId = "data-v-${pageId}"\n` : '\n';
  const code = [
    `import { slideSetup } from ${JSON.stringify(RUNTIME_BRIDGE_MODULE)}`,
    template.code,
    'const __slide = { setup: slideSetup, render }',
    `${scopeId}export default __slide`,
  ].join('\n');

  return { no, title, frontmatter, code, css };
}

function splitNamedSlotSections(
  source: string,
  no: number,
  protectedContent: ProtectedContent = protectFencedCode(source),
): SlideSections {
  const lines = protectedContent.masked.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const slots = new Map<string, string>();
  let activeName = 'default';
  let activeWasMarked = false;
  let sawMarker = false;
  let buffered: string[] = [];

  function appendSection(): void {
    const maskedContent = buffered.join('');
    const content = protectedContent.restore(maskedContent);
    if (content.trim() || activeWasMarked) {
      const previous = slots.get(activeName);
      slots.set(activeName, previous === undefined ? content : `${previous}\n${content}`);
    }
    buffered = [];
  }

  for (const line of lines) {
    const marker = NAMED_SLOT_RE.exec(line.replace(/\r?\n$/, ''));
    if (!marker) {
      buffered.push(line);
      continue;
    }

    const name = marker[1];
    if (!SUPPORTED_NAMED_SLOTS.has(name)) {
      throw new DeckCompileError(
        `Slide ${no} uses unsupported named slot "${name}"; supported Slidev shorthand slots are ::left::, ::right::, and ::default::`,
      );
    }
    appendSection();
    sawMarker = true;
    activeName = name;
    activeWasMarked = true;
  }
  appendSection();

  if (!sawMarker) return { hasNamedSlots: false, sections: [{ name: 'default', content: source }] };
  return {
    hasNamedSlots: true,
    sections: [...slots].map(([name, content]) => ({ name, content })),
  };
}

function protectCodeElements(html: string): string {
  return html.replace(/<code(?=[\s>])([^>]*)>/gi, (match, attributes) => {
    if (/(?:^|\s)v-pre(?:\s|=|$)/i.test(attributes)) return match;
    return `<code v-pre${attributes}>`;
  });
}

function containsDollarMath(protectedMarkdown: string): boolean {
  const withoutCode = protectedMarkdown
    .replace(/(`+)[\s\S]*?\1/g, (match) => ' '.repeat(match.length))
    .replace(HTML_COMMENT_RE, '')
    .replace(/<style(?=[\s>])[^>]*>[\s\S]*?<\/style\s*>/gi, '');

  for (let index = 0; index < withoutCode.length; index++) {
    if (withoutCode[index] !== '$' || isEscaped(withoutCode, index)) continue;
    const isBlock = withoutCode[index + 1] === '$';
    const delimiterLength = isBlock ? 2 : 1;
    if (
      !isBlock &&
      (!withoutCode[index + 1] ||
        /\s/.test(withoutCode[index + 1]) ||
        withoutCode[index + 1] === '$')
    )
      continue;

    for (let end = index + delimiterLength; end < withoutCode.length; end++) {
      if (withoutCode[end] !== '$' || isEscaped(withoutCode, end)) continue;
      if (isBlock) {
        if (withoutCode[end + 1] === '$' && end > index + delimiterLength) return true;
        continue;
      }
      if (withoutCode[end + 1] !== '$' && end > index + 1 && !/\s/.test(withoutCode[end - 1]))
        return true;
    }
  }
  return false;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function extractStyles(
  source: string,
  deckId: string,
  no: number,
): { markdown: string; styles: Array<{ source: string; scoped: boolean }> } {
  const protectedContent = protectFencedCode(source);
  const styles: Array<{ source: string; scoped: boolean }> = [];
  const withoutStyles = protectedContent.masked.replace(
    /<style(?=[\s>])([^>]*)>([\s\S]*?)<\/style\s*>/gi,
    (_match, rawAttributes, css) => {
      const attributes = parseStyleAttributes(rawAttributes, deckId, no);
      styles.push({ source: `<style${rawAttributes}>${css}</style>`, scoped: attributes.scoped });
      return '\n\n';
    },
  );
  if (/<style(?=[\s>])/i.test(withoutStyles)) {
    throw new DeckCompileError(`Slide ${no} has an unclosed <style> block`);
  }
  return { markdown: protectedContent.restore(withoutStyles), styles };
}

function parseStyleAttributes(
  rawAttributes: string,
  deckId: string,
  no: number,
): { scoped: boolean } {
  let scoped = false;
  const attributes = rawAttributes.trim();
  const attributeRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attributeRe.exec(attributes))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name === 'scoped') scoped = true;
    else if (name === 'lang' && value?.toLowerCase() === 'css') continue;
    else if (name === 'type' && value?.toLowerCase() === 'text/css') continue;
    else
      throw new DeckCompileError(
        `Slide ${no} uses unsupported <style ${name}> in deck "${deckId}"`,
      );
  }
  return { scoped };
}

function protectFencedCode(source: string): ProtectedContent {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const blocks: string[] = [];
  const fences: string[] = [];
  const masked: string[] = [];
  let markerPrefix = '\uE000SLIDEV_WORKERS_FENCE_';
  while (source.includes(markerPrefix)) markerPrefix += '_';

  for (let index = 0; index < lines.length;) {
    const opening = FENCE_OPEN_RE.exec(lines[index]);
    if (!opening) {
      masked.push(lines[index]);
      index++;
      continue;
    }

    const fence = opening[1];
    const fenceChar = fence[0];
    const fenceLength = fence.length;
    const info = lines[index].slice(opening[0].length).trim();
    const block = [lines[index++]];
    let closed = false;
    while (index < lines.length) {
      const line = lines[index++];
      block.push(line);
      const closing = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
        closed = true;
        break;
      }
    }

    // An unclosed code fence still owns the remainder of the source.
    const token = `${markerPrefix}${blocks.length}__`;
    blocks.push(block.join(''));
    fences.push(info);
    masked.push(token + (block.at(-1)?.endsWith('\n') ? '\n' : ''));
    if (!closed) break;
  }

  return {
    masked: masked.join(''),
    fences,
    restore(value) {
      return value.replace(
        new RegExp(`${escapeRegExp(markerPrefix)}(\\d+)__`, 'g'),
        (token, index) => {
          return blocks[Number(index)] ?? token;
        },
      );
    },
  };
}

function rewriteMarkupSources(html: string, assetBase: string, deckId: string, no: number): string {
  return html.replace(
    /(<[A-Za-z][^>]*)(\s+src\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, opening, attribute, quoted, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const resolved = resolveAssetUrl(value, assetBase, deckId, no);
      const replacement =
        quoted[0] === '"' || quoted[0] === "'"
          ? `${quoted[0]}${escapeHtmlAttribute(resolved)}${quoted[0]}`
          : escapeHtmlAttribute(resolved);
      return `${opening}${attribute}${replacement}`;
    },
  );
}

function resolveAssetUrl(value: string, assetBase: string, deckId: string, no: number): string {
  const url = value.trim();
  if (url.startsWith('/') && !url.startsWith('//')) {
    const path = url.split(/[?#]/, 1)[0];
    for (const segment of path.split('/')) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new DeckCompileError(
          `Slide ${no} has an invalid image URL in deck "${deckId}": ${url}`,
        );
      }
      if (decoded === '..')
        throw new DeckCompileError(`Slide ${no} image URL escapes deck "${deckId}": ${url}`);
    }
    return url;
  }
  if (
    !url ||
    url.startsWith('#') ||
    url.startsWith('?') ||
    /^[a-z][a-z\d+.-]*:/i.test(url) ||
    url.startsWith('//')
  ) {
    return url;
  }

  const match = /^([^?#]*)([?#][\s\S]*)?$/.exec(url);
  if (!match)
    throw new DeckCompileError(`Slide ${no} has an invalid image URL in deck "${deckId}": ${url}`);
  const rawPath = match[1];
  const suffix = match[2] ?? '';
  const normalized: string[] = [];
  for (const rawSegment of rawPath.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    let decoded;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new DeckCompileError(
        `Slide ${no} has an invalid image URL in deck "${deckId}": ${url}`,
      );
    }
    if (decoded === '..') {
      if (!normalized.length)
        throw new DeckCompileError(`Slide ${no} image URL escapes deck "${deckId}": ${url}`);
      normalized.pop();
    } else if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new DeckCompileError(`Slide ${no} has an unsafe image URL in deck "${deckId}": ${url}`);
    } else {
      normalized.push(encodeURIComponent(decoded));
    }
  }
  return `${assetBase}${normalized.join('/')}${suffix}`;
}

function normalizeAssetBase(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[?#\\\0]/.test(value)
  ) {
    throw new DeckCompileError(
      'assetBase must be an absolute same-origin path without a query or fragment',
    );
  }
  const segments = value.split('/');
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new DeckCompileError('assetBase contains an invalid encoded path segment');
    }
    if (
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new DeckCompileError('assetBase contains an unsafe path segment');
    }
  }
  return value.endsWith('/') ? value : `${value}/`;
}

function defaultAssetBase(deckId: string): string {
  validateDeckId(deckId);
  return `/sources/${deckId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}/`;
}

function validateDeckId(deckId: string): void {
  if (typeof deckId !== 'string' || !deckId || deckId.includes('\\') || deckId.includes('\0')) {
    throw new DeckCompileError('deckId must be a non-empty slash-separated string');
  }
  if (deckId.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new DeckCompileError('deckId must not contain empty or traversal path segments');
  }
}

function publicSlideFrontmatter(frontmatter: unknown): Record<string, unknown> {
  const value = safePublicValue(frontmatter);
  return isRecord(value) ? value : {};
}

function resolveFrontmatterImages(
  frontmatter: Record<string, unknown>,
  assetBase: string,
  deckId: string,
  no: number,
): Record<string, unknown> {
  for (const key of ['image', 'backgroundImage']) {
    if (typeof frontmatter[key] === 'string') {
      frontmatter[key] = resolveAssetUrl(frontmatter[key], assetBase, deckId, no);
    }
  }
  if (Array.isArray(frontmatter.images)) {
    frontmatter.images = frontmatter.images.map((image: unknown) => {
      if (!isRecord(image) || typeof image.src !== 'string') return image;
      return { ...image, src: resolveAssetUrl(image.src, assetBase, deckId, no) };
    });
  }
  if (
    typeof frontmatter.background === 'string' &&
    /^(?:\.\.?\/|[^/]+\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$))/i.test(
      frontmatter.background,
    )
  ) {
    frontmatter.background = resolveAssetUrl(frontmatter.background, assetBase, deckId, no);
  }
  return frontmatter;
}

function safePublicValue(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanPublicString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return undefined;

  const branch = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value
      .map((item: unknown) => safePublicValue(item, branch))
      .filter((item) => item !== undefined);
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (PRIVATE_FRONTMATTER_KEY.test(key)) return [];
      const cleanValue = safePublicValue(item, branch);
      return cleanValue === undefined ? [] : [[key, cleanValue]];
    }),
  );
}

function cleanPublicString(value: string): string {
  return value.replace(HTML_COMMENT_RE, '').trim();
}

function stableHash(value: string): string {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function compileError(stage: string, errors: readonly unknown[]): DeckCompileError {
  const details = errors
    .map((error) =>
      isRecord(error) && typeof error.message === 'string' ? error.message : String(error),
    )
    .join('; ');
  return new DeckCompileError(`${stage} failed: ${details}`);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
