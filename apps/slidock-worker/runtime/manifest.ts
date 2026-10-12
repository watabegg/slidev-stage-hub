export type Frontmatter = Record<string, unknown>;

export type RuntimeSlide = {
  no: number;
  title?: string;
  frontmatter?: Frontmatter;
  module: string;
  css?: string;
};

export type DeckManifest = {
  id: string;
  revision: string;
  runtimeId?: string;
  title?: string;
  frontmatter?: Frontmatter;
  runtimeVersion?: string;
  theme?: string;
  slides: RuntimeSlide[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve only same-origin modules in the immutable release path format. */
export function validatedRevisionModuleUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^\/releases\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/[a-f0-9]{64}\/(?:[1-9]|[1-9]\d|100)\.js(?![\s\S])/u.test(
      value,
    )
  ) {
    throw new Error('Invalid revision module URL');
  }
  return value;
}

export function selectRequestedRevision(url: URL, metaRevision: string | null): string | undefined {
  return url.searchParams.get('revision') || metaRevision || undefined;
}

/** Only same-release modules may enter the dynamic Slidev route loader. */
export function validateDeckManifest(
  value: unknown,
  id: string,
  expectedRuntimeId?: string,
): DeckManifest {
  if (
    !isRecord(value) ||
    value.id !== id ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    (value.runtimeId !== undefined &&
      (typeof value.runtimeId !== 'string' || !/^[a-f0-9]{64}$/.test(value.runtimeId))) ||
    (expectedRuntimeId !== undefined &&
      (!/^[a-f0-9]{64}$/.test(expectedRuntimeId) || value.runtimeId !== expectedRuntimeId)) ||
    !Array.isArray(value.slides) ||
    value.slides.length < 1 ||
    value.slides.length > 100 ||
    (value.frontmatter !== undefined && !isRecord(value.frontmatter))
  )
    throw new Error('Invalid deck manifest');
  const prefix = `/releases/${id}/${value.revision}/`;
  for (const [index, slide] of value.slides.entries()) {
    if (
      !isRecord(slide) ||
      slide.no !== index + 1 ||
      slide.module !== `${prefix}${index + 1}.js` ||
      (slide.css !== undefined && slide.css !== `${prefix}${index + 1}.css`) ||
      (slide.frontmatter !== undefined && !isRecord(slide.frontmatter))
    )
      throw new Error('Invalid revision module path');
  }
  // Structural checks above establish the fields consumed by the route loader.
  return value as DeckManifest;
}
