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
  title?: string;
  frontmatter?: Frontmatter;
  slides: RuntimeSlide[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
