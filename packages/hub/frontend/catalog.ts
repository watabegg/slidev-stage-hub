// Public JSON emitted by the shared and multi-profile builders.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type PublicFrontmatter = Partial<Record<
  'title' | 'subtitle' | 'author' | 'date' | 'description' | 'tags',
  JsonValue
>>

export interface CatalogCategory {
  id: string
  name: string
  path: string[]
  parentId: string | null
}

export interface CatalogDeck {
  id: string
  title: string
  entry: string
  pages: number
  revision: string
  categoryPath: string[]
  frontmatter: PublicFrontmatter
  thumbnail: { src: string; width: number; height: number }
  runtimeVersion: string
  theme: string
  profile: string
}

export interface Catalog {
  schemaVersion: 1
  categories: CatalogCategory[]
  decks: CatalogDeck[]
}
