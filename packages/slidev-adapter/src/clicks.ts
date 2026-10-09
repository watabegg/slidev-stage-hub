export interface SlideContent {
  content: string;
}

function assertSupportedClickSyntax(content: string, id: string, page: number): void {
  // Native clickTotals model only bare v-click attributes/wrappers. Reject
  // known alternatives instead of silently reporting incomplete totals.
  const unsupported =
    /\bv-(?:after|clicks)\b|(?:^|\s)v-click(?=[.=:/[\]])|<v-click(?:\s[^>]*|\/)>/m;
  if (unsupported.test(content))
    throw new Error(
      `unsupported click syntax in ${id}:${page}; only bare v-click forms are supported`,
    );
}

/** Inspect the native player's static click-count subset without parser dependencies. */
export function inspectNativeClicks(slides: readonly SlideContent[], id: string): number[] {
  return slides.map((slide, index) => {
    assertSupportedClickSyntax(slide.content, id, index + 1);
    return [...slide.content.matchAll(/\sv-click(?=[\s>])/g)].length;
  });
}
