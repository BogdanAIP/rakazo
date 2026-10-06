import { describe, expect, it } from "vitest";
import { loadPlaywrightCliConfiguration, probePlaywrightCli } from "./playwright-cli-config.js";

describe("Playwright CLI configuration", () => {
  it("keeps OpenCLI as the default browser backend", () => {
    const config = loadPlaywrightCliConfiguration({});
    expect(config).toEqual({
      mode: "opencli",
      entry: null,
      extensionBrowser: null,
      userDataDir: null,
    });
    expect(probePlaywrightCli(config)).toMatchObject({
      mode: "opencli",
      ready: false,
      reason: "Playwright CLI is not selected.",
    });
  });

  it("requires explicit entry and browser for extension attach", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\node_modules\\@playwright\\cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER: "chrome",
    });

    expect(probePlaywrightCli(config, () => true)).toEqual({
      mode: "playwright-cli-extension",
      ready: true,
      entryAvailable: true,
      extensionBrowser: "chrome",
      userDataDirConfigured: false,
      reason: null,
    });
  });

  it("treats extension attach as browser-confirmed rather than token-authenticated", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\playwright-cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER: "msedge",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      ready: true,
      extensionBrowser: "msedge",
      reason: null,
    });
  });

  it("requires a dedicated absolute user-data directory for persistent mode", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-persistent",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\playwright-cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_USER_DATA_DIR: "C:\\Users\\test\\Rakazo\\playwright-profile",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      ready: true,
      userDataDirConfigured: true,
    });
  });

  it("rejects ambiguous browser and unsafe path configuration", () => {
    expect(() =>
      loadPlaywrightCliConfiguration({
        RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
        RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER: "chromium",
      }),
    ).toThrow("chrome or msedge");

    expect(() =>
      loadPlaywrightCliConfiguration({
        RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
        RAKAZO_PLAYWRIGHT_CLI_ENTRY: "relative\\playwright-cli.js",
      }),
    ).toThrow("absolute path");

    expect(() =>
      loadPlaywrightCliConfiguration({
        RAKAZO_BROWSER_BACKEND: "something-else",
      }),
    ).toThrow("RAKAZO_BROWSER_BACKEND");
  });

  it("does not silently activate extension mode from auto", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "auto",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\playwright-cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_EXTENSION_BROWSER: "chrome",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      mode: "auto",
      ready: false,
      reason: expect.stringContaining("intentionally not active"),
    });
  });
});
