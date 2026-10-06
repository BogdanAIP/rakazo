export const STABLE_BROWSER_OPERATIONS = [
  "open",
  "recover",
  "navigate",
  "snapshot",
  "find",
  "wait",
  "extract",
  "scroll",
  "screenshot",
  "screenshot.annotate",
  "screenshot.resize",
  "tabNew",
  "tabSelect",
  "tabClose",
  "act.click",
  "act.fill",
  "act.type",
  "close",
] as const;

export type StableBrowserOperation = (typeof STABLE_BROWSER_OPERATIONS)[number];

export type BrowserCapabilityState = "enabled" | "gated" | "unsupported";

export const BROWSER_CAPABILITY_MATRIX = {
  opencli: {
    stable: Object.fromEntries(
      STABLE_BROWSER_OPERATIONS.map((operation) => [operation, "enabled" as const]),
    ) as Record<StableBrowserOperation, BrowserCapabilityState>,
    extra: {
      console: "unsupported",
      network: "unsupported",
      tracing: "unsupported",
      storage: "unsupported",
      cookies: "unsupported",
      downloads: "unsupported",
      uploads: "unsupported",
      eval: "unsupported",
      runCode: "unsupported",
      webmcp: "unsupported",
    },
  },
  "playwright-cli-extension": {
    stable: {
      open: "enabled",
      recover: "enabled",
      navigate: "enabled",
      snapshot: "enabled",
      find: "enabled",
      wait: "enabled",
      extract: "enabled",
      scroll: "enabled",
      screenshot: "enabled",
      "screenshot.annotate": "enabled",
      "screenshot.resize": "enabled",
      tabNew: "enabled",
      tabSelect: "enabled",
      tabClose: "enabled",
      "act.click": "enabled",
      "act.fill": "enabled",
      "act.type": "enabled",
      close: "enabled",
    },
    extra: {
      console: "gated",
      network: "gated",
      tracing: "gated",
      storage: "gated",
      cookies: "gated",
      downloads: "gated",
      uploads: "gated",
      eval: "gated",
      runCode: "gated",
      webmcp: "gated",
    },
  },
  "playwright-cli-cdp": {
    stable: {
      open: "enabled",
      recover: "enabled",
      navigate: "enabled",
      snapshot: "enabled",
      find: "enabled",
      wait: "enabled",
      extract: "enabled",
      scroll: "enabled",
      screenshot: "enabled",
      "screenshot.annotate": "enabled",
      "screenshot.resize": "enabled",
      tabNew: "enabled",
      tabSelect: "enabled",
      tabClose: "enabled",
      "act.click": "enabled",
      "act.fill": "enabled",
      "act.type": "enabled",
      close: "enabled",
    },
    extra: {
      console: "gated",
      network: "gated",
      tracing: "gated",
      storage: "gated",
      cookies: "gated",
      downloads: "gated",
      uploads: "gated",
      eval: "gated",
      runCode: "gated",
      webmcp: "gated",
    },
  },
  "playwright-cli-persistent": {
    stable: {
      open: "enabled",
      recover: "enabled",
      navigate: "enabled",
      snapshot: "enabled",
      find: "enabled",
      wait: "enabled",
      extract: "enabled",
      scroll: "enabled",
      screenshot: "enabled",
      "screenshot.annotate": "enabled",
      "screenshot.resize": "enabled",
      tabNew: "enabled",
      tabSelect: "enabled",
      tabClose: "enabled",
      "act.click": "enabled",
      "act.fill": "enabled",
      "act.type": "enabled",
      close: "enabled",
    },
    extra: {
      console: "gated",
      network: "gated",
      tracing: "gated",
      storage: "gated",
      cookies: "gated",
      downloads: "gated",
      uploads: "gated",
      eval: "gated",
      runCode: "gated",
      webmcp: "gated",
    },
  },
} as const;

export type BrowserCapabilityMode = keyof typeof BROWSER_CAPABILITY_MATRIX;

export function missingStableBrowserCapabilities(mode: BrowserCapabilityMode): StableBrowserOperation[] {
  return STABLE_BROWSER_OPERATIONS.filter(
    (operation) => BROWSER_CAPABILITY_MATRIX[mode].stable[operation] !== "enabled",
  );
}

export function browserModeHasStableParity(mode: BrowserCapabilityMode): boolean {
  return missingStableBrowserCapabilities(mode).length === 0;
}
