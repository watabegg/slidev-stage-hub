export type NativeSlidevQueryValue = string | number | null | undefined | (string | null)[];

export interface NativeSlidevRuntime {
  router: {
    currentRoute: {
      value: { query: Record<string, NativeSlidevQueryValue> };
    };
    replace(location: {
      path: string;
      query: Record<string, NativeSlidevQueryValue>;
    }): Promise<unknown>;
  };
  slides: Array<{ load?: () => Promise<{ default?: unknown }> } | undefined>;
}

declare global {
  interface Window {
    __nativeSlidevBridge?: boolean;
    __slidevLabNative?: NativeSlidevRuntime;
    __slidevLab?: { runtimeVersion?: string; theme?: string };
  }
}

export {};
