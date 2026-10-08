import { describe, expect, it } from "vitest";
import { loadPlaywrightCliConfiguration, probePlaywrightCli } from "./playwright-cli-config.js";

describe("Playwright CLI configuration", () => {
  it("defaults to non-interactive auto routing with a dedicated Playwright profile", () => {
    const config = loadPlaywrightCliConfiguration({
      USERPROFILE: "C:\\Users\\test",
    });
    expect(config).toMatchObject({
      mode: "auto",
      browserChannel: null,
      cdpEndpoint: null,
      userDataDir: "C:\\Users\\test\\RakazoData\\playwright-profile",
    });
    expect(config.entry).toContain("@playwright");
    expect(config.entry).toMatch(/playwright-cli\.js$/u);
    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      mode: "auto",
      ready: true,
      reason: null,
    });
  });

  it("enables visible Persistent login only with explicit opt-in", () => {
    expect(loadPlaywrightCliConfiguration({ USERPROFILE: "C:\\Users\\test" }).headed).toBe(false);
    expect(loadPlaywrightCliConfiguration({
      USERPROFILE: "C:\\Users\\test",
      RAKAZO_PLAYWRIGHT_HEADED: "true",
    }).headed).toBe(true);
  });
  it("requires explicit entry and browser for CDP attach", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-cdp",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\node_modules\\@playwright\\cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "chrome",
    });

    expect(probePlaywrightCli(config, () => true)).toEqual({
      mode: "playwright-cli-cdp",
      ready: true,
      entryAvailable: true,
      browserChannel: "chrome",
      cdpEndpointConfigured: false,
      userDataDirConfigured: false,
      reason: null,
    });
  });

  it("accepts an explicit CDP endpoint without channel discovery", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-cdp",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\playwright-cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_CDP_ENDPOINT: "http://127.0.0.1:9222",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      ready: true,
      browserChannel: null,
      cdpEndpointConfigured: true,
      reason: null,
    });
    expect(config.cdpEndpoint).toBe("http://127.0.0.1:9222/");
  });

  it("requires explicit entry and browser for extension attach", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\node_modules\\@playwright\\cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "chrome",
    });

    expect(probePlaywrightCli(config, () => true)).toEqual({
      mode: "playwright-cli-extension",
      ready: true,
      entryAvailable: true,
      browserChannel: "chrome",
      cdpEndpointConfigured: false,
      userDataDirConfigured: false,
      reason: null,
    });
  });

  it("treats extension attach as browser-confirmed rather than token-authenticated", () => {
    const config = loadPlaywrightCliConfiguration({
      RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
      RAKAZO_PLAYWRIGHT_CLI_ENTRY: "C:\\Rakazo\\playwright-cli\\playwright-cli.js",
      RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "msedge",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      ready: true,
      browserChannel: "msedge",
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

  it("rejects ambiguous browser, unsafe path and invalid CDP endpoint configuration", () => {
    expect(() =>
      loadPlaywrightCliConfiguration({
        RAKAZO_BROWSER_BACKEND: "playwright-cli-extension",
        RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "chromium",
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
        RAKAZO_BROWSER_BACKEND: "playwright-cli-cdp",
        RAKAZO_PLAYWRIGHT_CDP_ENDPOINT: "file:///C:/Chrome",
      }),
    ).toThrow("http(s) or ws(s)");

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
      RAKAZO_PLAYWRIGHT_BROWSER_CHANNEL: "chrome",
    });

    expect(probePlaywrightCli(config, () => true)).toMatchObject({
      mode: "auto",
      ready: true,
      reason: null,
    });
  });
});

describe("Playwright auto fallback probe", () => {
  it("remains ready when Playwright CLI is unavailable because OpenCLI is the fallback", () => {
    const config = loadPlaywrightCliConfiguration({ USERPROFILE: "C:\\Users\\test" });
    expect(probePlaywrightCli(config, () => false)).toMatchObject({
      mode: "auto",
      ready: true,
      reason: expect.stringContaining("fall back to OpenCLI"),
    });
  });
});
