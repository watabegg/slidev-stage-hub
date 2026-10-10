import type { BrowserRunBinding } from '@slidev-stage-hub/adapter-cloudflare';

/** Wrangler generates Env from wrangler.jsonc; only out-of-band values are added here. */
export type WorkerEnv = Env & {
  BROWSER?: BrowserRunBinding;
  PUBLISH_TOKEN?: string;
  PROFILE_THEME?: string;
  PROFILE_LAYOUTS?: string;
  PROFILE_COMPONENTS?: string;
};
