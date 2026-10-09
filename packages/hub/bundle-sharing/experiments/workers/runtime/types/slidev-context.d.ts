import type { Ref } from 'vue';

export type RuntimeSlideContext = {
  $clicksContext: { setup(): void };
  $frontmatter: Record<string, unknown> & { layout?: string };
  $nav: Ref<{
    slides: Array<{
      meta?: {
        slide?: { title?: string };
      };
    }>;
  }>;
  $page: Ref<number>;
};

export function useSlideContext(): RuntimeSlideContext;

export function frontmatterToProps(
  frontmatter: Record<string, unknown>,
  pageNo: number,
): Record<string, unknown>;
