import { generateThumbnails as generate } from './internal/thumbnails.mjs';

export interface Thumbnail {
  id: string;
  src: string;
  width: number;
  height: number;
}

export interface GenerateThumbnailsOptions {
  siteRoot: string;
  outputWidth?: number;
  outputHeight?: number;
  chromiumExecutable?: string;
}

export async function generateThumbnails(options: GenerateThumbnailsOptions): Promise<Thumbnail[]> {
  return generate(options);
}
