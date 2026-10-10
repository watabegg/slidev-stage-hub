import type { NativeClickMetadata } from './compiler.js';

export interface ReleaseSlide {
  no: number;
  title?: string;
  frontmatter: Record<string, unknown>;
  module: string;
  css: string;
}

export interface ReleaseManifest {
  id: string;
  revision: string;
  profileDigest?: string;
  runtimeId?: string;
  title: string;
  frontmatter: Record<string, unknown>;
  warnings: string[];
  entry: string;
  slides: ReleaseSlide[];
  native?: NativeClickMetadata;
  runtimeVersion?: string;
  theme?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.revision === 'string' &&
    (value.runtimeId === undefined ||
      (typeof value.runtimeId === 'string' && /^[a-f0-9]{64}$/u.test(value.runtimeId))) &&
    typeof value.title === 'string' &&
    isRecord(value.frontmatter) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    typeof value.entry === 'string' &&
    Array.isArray(value.slides) &&
    value.slides.every(isReleaseSlide)
  );
}

function isReleaseSlide(value: unknown): value is ReleaseSlide {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.no) &&
    isRecord(value.frontmatter) &&
    typeof value.module === 'string' &&
    typeof value.css === 'string' &&
    (value.title === undefined || typeof value.title === 'string')
  );
}
