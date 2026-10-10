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
