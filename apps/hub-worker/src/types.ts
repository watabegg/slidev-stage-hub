export interface ScreenshotOptions {
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  waitForSelector: { selector: string; visible: boolean; timeout: number };
  gotoOptions: { waitUntil: 'networkidle0'; timeout: number };
  actionTimeout: number;
  screenshotOptions: {
    type: 'png';
    encoding: 'binary';
    fullPage: false;
    captureBeyondViewport: false;
  };
}

export interface BrowserScreenshotResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface BrowserRunBinding {
  quickAction(action: 'screenshot', options: ScreenshotOptions): Promise<BrowserScreenshotResponse>;
}

/** Wrangler generates Env from wrangler.jsonc; only out-of-band values are added here. */
export type WorkerEnv = Env & {
  BROWSER?: BrowserRunBinding;
  PUBLISH_TOKEN?: string;
  PROFILE_THEME?: string;
  PROFILE_LAYOUTS?: string;
  PROFILE_COMPONENTS?: string;
};
