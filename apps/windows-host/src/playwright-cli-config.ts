import { existsSync } from "node:fs";
import path from "node:path";

export const WINDOWS_BROWSER_BACKEND_MODES = [
  "opencli",
  "playwright-cli-extension",
  "playwright-cli-persistent",
  "auto",
] as const;

export type WindowsBrowserBackendMode = (typeof WINDOWS_BROWSER_BACKEND_MODES)[number];
export type PlaywrightExtensionBrowser = "chrome" | "msedge";

export interface PlaywrightCliConfiguration {
  mode: WindowsBrowserBackendMode;
  entry: string | null;
  extensionBrowser: PlaywrightExtensionBrowser | null;
  userDataDir: string | null;
}

export interface PlaywrightCliProbe {
  mode: WindowsBrowserBackendMode;
  ready: boolean;
  entryAvailable: boolean;
  extensionBrowser: PlaywrightExtensionBrowser | null;
  userDataDirConfigured: boolean;
  reason: string | null;
}

function parseMode(value: string | undefined): WindowsBrowserBackendMode {
  const mode = value?.trim() || "opencli";
  if ((WINDOWS_BROWSER_BACKEND_MODES as readonly string[]).includes(mode)) {
    return mode as WindowsBrowserBackendMode;
  }
  throw new Error(
    `RAKAZO_BROWSER_BACKEND must be one of: ${WINDOWS_BROWSER_BACKEND_MODES.join(", ")}`,
  );
}

function optionalAbsolutePath(value: string | undefined, label: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const windowsAbsolute = path.win32.isAbsolute(trimmed);
  if (!path.isAbsolute(trimmed) && !windowsAbsolute) {
    throw new Error(`${label} must be an absolute path`);
  }
  return windowsAbsolute ? path.win32.normalize(trimmed) : path.normalize(trimmed);
}

function optionalExtensionBrowser(value: string | undefined): PlaywrightExtensionBrowser | null {
  const browser = value?.trim();
  if (!browser) return null;
  if (browser === "chrome" || browser === "msedge") return browser;
  throw new Error("RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER must be chrome or msedge");
}

export function loadPlaywrightCliConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightCliConfiguration {
  return {
    mode: parseMode(env.RAKAZO_BROWSER_BACKEND),
    entry: optionalAbsolutePath(env.RAKAZO_PLAYWRIGHT_CLI_ENTRY, "RAKAZO_PLAYWRIGHT_CLI_ENTRY"),
    extensionBrowser: optionalExtensionBrowser(env.RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER),
    userDataDir: optionalAbsolutePath(
      env.RAKAZO_PLAYWRIGHT_USER_DATA_DIR,
      "RAKAZO_PLAYWRIGHT_USER_DATA_DIR",
    ),
  };
}

export function probePlaywrightCli(
  config: PlaywrightCliConfiguration,
  fileExists: (path: string) => boolean = existsSync,
): PlaywrightCliProbe {
  const entryAvailable = Boolean(config.entry && fileExists(config.entry));
  const userDataDirConfigured = Boolean(config.userDataDir);

  let ready = false;
  let reason: string | null = null;

  switch (config.mode) {
    case "opencli":
      reason = "Playwright CLI is not selected.";
      break;
    case "playwright-cli-extension":
      if (!entryAvailable) reason = "Pinned Playwright CLI entry is unavailable.";
      else if (!config.extensionBrowser) reason = "Explicit extension browser is required.";
      else ready = true;
      break;
    case "playwright-cli-persistent":
      if (!entryAvailable) reason = "Pinned Playwright CLI entry is unavailable.";
      else if (!userDataDirConfigured)
        reason = "Dedicated Playwright user-data directory is required.";
      else ready = true;
      break;
    case "auto":
      reason =
        "Auto routing is intentionally not active yet; configure an explicit backend for Browser v2.";
      break;
  }

  return {
    mode: config.mode,
    ready,
    entryAvailable,
    extensionBrowser: config.extensionBrowser,
    userDataDirConfigured,
    reason,
  };
}
