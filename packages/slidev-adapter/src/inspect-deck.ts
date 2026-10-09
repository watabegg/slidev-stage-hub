export type SlidevParseSync = (
  text: string,
  source: string,
  options: { preserveCR: true },
) => unknown;

type ParsedSlide = {
  content: string;
  index: number;
  start: number;
  raw: string;
  note?: string;
};

type ParsedDeck = { slides: ParsedSlide[] };

export type NoteSlot = { start: number; end: number };

export type DeckInspection = {
  pages: number;
  slots: Array<NoteSlot | null>;
  clickTotals: number[];
};

function assertSupportedClickSyntax(content: string, id: string, page: number) {
  // Native clickTotals model only bare v-click attributes/wrappers. Reject
  // known alternatives instead of silently reporting incomplete totals.
  const unsupported =
    /\bv-(?:after|clicks)\b|(?:^|\s)v-click(?=[.=:/[\]])|<v-click(?:\s[^>]*|\/)>/m;
  if (unsupported.test(content))
    throw new Error(
      `unsupported click syntax in ${id}:${page}; only bare v-click forms are supported`,
    );
}

export function inspectDeckSource({
  id,
  source,
  text,
  parseSync,
  expectedPages,
  legacyFallback = false,
}: {
  id: string;
  source: string;
  text: string;
  parseSync: SlidevParseSync;
  expectedPages?: number;
  legacyFallback?: boolean;
}): DeckInspection {
  const parsed = parseSync(text, source, { preserveCR: true }) as ParsedDeck | null | undefined;
  if (!Array.isArray(parsed?.slides) || parsed.slides.length === 0)
    throw new Error(`parser returned no slides for ${id}`);
  if (expectedPages !== undefined && parsed.slides.length !== expectedPages)
    throw new Error(
      `public artifact/source page count differs for ${id}: manifest=${expectedPages}, source=${parsed.slides.length}`,
    );
  if (legacyFallback && parsed.slides.length !== 3)
    throw new Error(`fixture bounds changed: ${id}`);

  const lines = text.split('\n');
  let offset = 0;
  const lineOffsets = lines.map((line) => {
    const current = offset;
    offset += line.length + 1;
    return current;
  });

  const slots = parsed.slides.map((slide) => {
    assertSupportedClickSyntax(slide.content, id, slide.index + 1);
    if (slide.note === undefined) return null;
    const match = [...slide.raw.matchAll(/<!--([\s\S]*?)-->/g)].at(-1);
    if (!match || match[1].trim() !== slide.note)
      throw new Error(`ambiguous notes ${id}:${slide.index + 1}`);
    const start = lineOffsets[slide.start] + match.index + 4;
    return {
      start: Buffer.byteLength(text.slice(0, start)),
      end: Buffer.byteLength(text.slice(0, start + match[1].length)),
    };
  });
  const clickTotals = parsed.slides.map(
    (slide) => [...slide.content.matchAll(/\sv-click(?=[\s>])/g)].length,
  );
  if (legacyFallback && JSON.stringify(clickTotals) !== '[0,2,0]')
    throw new Error(`fixture click bounds changed: ${id}`);

  return { pages: parsed.slides.length, slots, clickTotals };
}
