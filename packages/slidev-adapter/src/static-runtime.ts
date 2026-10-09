import { join } from 'node:path';

export type SlideForSanitizing = {
  note?: string;
  frontmatterRaw?: string;
  content: string;
  source: {
    note?: string;
    frontmatterRaw?: string;
    content: string;
  };
};

export function stripPrivateSlideData(slide: SlideForSanitizing): void {
  slide.note = '';
  slide.source.note = '';
  slide.frontmatterRaw = '';
  slide.source.frontmatterRaw = '';
  slide.content = slide.content.replace(/<!--[\s\S]*?-->/g, '');
  slide.source.content = slide.source.content.replace(/<!--[\s\S]*?-->/g, '');
}

export function rewriteSlidevImports(code: string, deckPrefix: string): string {
  return code.replace(/(["'])\/@slidev\//g, `$1${deckPrefix}/`);
}

export function patchSlidevImageFrontmatter(
  code: string,
  images: unknown[],
  urls: string[],
  id: string,
): string {
  const signature = `"images":${JSON.stringify(images)}`;
  if (!code.includes(signature))
    throw new Error(`Slidev image frontmatter signature changed: ${id}`);
  return code.replace(signature, `"images":[${urls.join(',')}]`);
}

export function patchStaticRuntimeModule({
  code,
  id,
  clientRoot,
}: {
  code: string;
  id: string;
  clientRoot: string;
}): string | undefined {
  const mainFile = join(clientRoot, 'setup/main.ts');
  const envFile = join(clientRoot, 'env.ts');
  const rootFile = join(clientRoot, 'setup/root.ts');

  if (id === mainFile || id === envFile) {
    if (!code.includes('import.meta.env.BASE_URL'))
      throw new Error(`Slidev router-base signature changed: ${id}`);
    let transformed =
      `import { deckBase as __labDeckBase } from '/@lab/selection';\n` +
      code.replaceAll('import.meta.env.BASE_URL', '__labDeckBase');
    if (id === mainFile) {
      if (!code.includes('app.use(router)'))
        throw new Error(`Slidev native-router signature changed: ${id}`);
      transformed =
        `import { slides as __labNativeSlides } from '#slidev/slides';\nimport { unref as __labUnref } from 'vue';\n` +
        transformed.replace(
          'app.use(router)',
          'app.use(router)\n  if (window.__nativeSlidevBridge) window.__slidevLabNative = { router, slides: __labUnref(__labNativeSlides) }',
        );
    }
    return transformed;
  }

  if (id === rootFile) {
    if (
      !code.includes('`${slidesTitle} - shared`') ||
      !code.includes('`${slidesTitle} - drawings`')
    )
      throw new Error(`Slidev sync-channel signature changed: ${id}`);
    return (
      `import { deckId as __labDeckId } from '/@lab/selection';\n` +
      code
        .replace('`${slidesTitle} - shared`', '`${__labDeckId} - shared`')
        .replace('`${slidesTitle} - drawings`', '`${__labDeckId} - drawings`')
    );
  }
}

export function patchSlidevHtmlEntry(html: string): string {
  const entryPattern = /<script type="module" src="[^"]+"><\/script>/;
  if (!entryPattern.test(html)) throw new Error('Slidev HTML entry signature changed');
  const transformed = html
    .replace(entryPattern, '<script type="module" src="/@lab/entry"></script>')
    .replace(/<link\b[^>]*\bas="image"[^>]*>/g, '');
  if (!transformed.includes('/@lab/entry')) throw new Error('Slidev HTML entry signature changed');
  return transformed;
}
