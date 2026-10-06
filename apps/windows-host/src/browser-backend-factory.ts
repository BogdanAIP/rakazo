import type { WindowsBrowserBackend } from "./browser-backend.js";
import { WindowsOpenCliBackend, loadOpenCliConfiguration } from "./opencli.js";
import { loadPlaywrightCliConfiguration } from "./playwright-cli-config.js";
import { WindowsPlaywrightCliBackend } from "./playwright-cli.js";

export function createWindowsBrowserBackend(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsBrowserBackend {
  const config = loadPlaywrightCliConfiguration(env);
  switch (config.mode) {
    case "opencli":
      return new WindowsOpenCliBackend(loadOpenCliConfiguration(env));
    case "playwright-cli-cdp":
    case "playwright-cli-extension":
    case "playwright-cli-persistent":
      return new WindowsPlaywrightCliBackend(config, stateDir);
    case "auto":
      // Auto routing is deliberately not enabled yet. Preserve the proven
      // OpenCLI backend rather than guessing which signed-in browser to attach.
      return new WindowsOpenCliBackend(loadOpenCliConfiguration(env));
  }
}

