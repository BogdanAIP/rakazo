import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PINNED_PLAYWRIGHT_CLI_VERSION = "0.1.22";

export interface PlaywrightCliConfiguration {
  entry: string;
  packageJson: string;
  expectedVersion: string;
}

export interface PlaywrightCliDiscovery {
  available: boolean;
  entry: string;
  version: string | null;
  reason: string | null;
}

export function loadPlaywrightCliConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightCliConfiguration {
  const appData =
    env.APPDATA?.trim() ||
    path.join(os.homedir(), "AppData", "Roaming");
  const packageDir = path.join(
    appData,
    "npm",
    "node_modules",
    "@playwright",
    "cli",
  );

  return {
    entry:
      env.RAKAZO_PLAYWRIGHT_CLI_ENTRY?.trim() ||
      path.join(packageDir, "playwright-cli.js"),
    packageJson:
      env.RAKAZO_PLAYWRIGHT_CLI_PACKAGE_JSON?.trim() ||
      path.join(packageDir, "package.json"),
    expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
  };
}

export function inspectPlaywrightCli(
  config: PlaywrightCliConfiguration = loadPlaywrightCliConfiguration(),
): PlaywrightCliDiscovery {
  if (!path.isAbsolute(config.entry) || !path.isAbsolute(config.packageJson)) {
    return {
      available: false,
      entry: config.entry,
      version: null,
      reason: "Playwright CLI paths must be absolute",
    };
  }
  if (!existsSync(config.entry)) {
    return {
      available: false,
      entry: config.entry,
      version: null,
      reason: "Pinned Playwright CLI entry is not installed",
    };
  }
  if (!existsSync(config.packageJson)) {
    return {
      available: false,
      entry: config.entry,
      version: null,
      reason: "Playwright CLI package metadata is missing",
    };
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(config.packageJson, "utf8"));
  } catch {
    return {
      available: false,
      entry: config.entry,
      version: null,
      reason: "Playwright CLI package metadata is invalid",
    };
  }

  if (!metadata || typeof metadata !== "object") {
    return {
      available: false,
      entry: config.entry,
      version: null,
      reason: "Playwright CLI package metadata is invalid",
    };
  }
  const record = metadata as Record<string, unknown>;
  if (record.name !== "@playwright/cli") {
    return {
      available: false,
      entry: config.entry,
      version: typeof record.version === "string" ? record.version : null,
      reason: "Playwright CLI package identity does not match @playwright/cli",
    };
  }

  const version = typeof record.version === "string" ? record.version : null;
  if (version !== config.expectedVersion) {
    return {
      available: false,
      entry: config.entry,
      version,
      reason: `Playwright CLI version must be exactly ${config.expectedVersion}`,
    };
  }

  return {
    available: true,
    entry: config.entry,
    version,
    reason: null,
  };
}

export function playwrightCliAvailable(
  config: PlaywrightCliConfiguration = loadPlaywrightCliConfiguration(),
): boolean {
  return inspectPlaywrightCli(config).available;
}
