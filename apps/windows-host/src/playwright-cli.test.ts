import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_PLAYWRIGHT_CLI_VERSION,
  inspectPlaywrightCli,
  loadPlaywrightCliConfiguration,
} from "./playwright-cli.js";

function fixture(version = PINNED_PLAYWRIGHT_CLI_VERSION, name = "@playwright/cli") {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-playwright-cli-"));
  const packageDir = path.join(root, "npm", "node_modules", "@playwright", "cli");
  mkdirSync(packageDir, { recursive: true });
  const entry = path.join(packageDir, "playwright-cli.js");
  const packageJson = path.join(packageDir, "package.json");
  writeFileSync(entry, "#!/usr/bin/env node\n", "utf8");
  writeFileSync(packageJson, JSON.stringify({ name, version }), "utf8");
  return { root, entry, packageJson };
}

describe("Playwright CLI discovery", () => {
  it("resolves the scoped official CLI from the Windows npm global directory", () => {
    const config = loadPlaywrightCliConfiguration({
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    });
    expect(config.entry).toBe(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@playwright\\cli\\playwright-cli.js",
    );
    expect(config.packageJson).toBe(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@playwright\\cli\\package.json",
    );
    expect(config.expectedVersion).toBe(PINNED_PLAYWRIGHT_CLI_VERSION);
  });

  it("accepts only the pinned official package", () => {
    const f = fixture();
    expect(
      inspectPlaywrightCli({
        entry: f.entry,
        packageJson: f.packageJson,
        expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
      }),
    ).toEqual({
      available: true,
      entry: f.entry,
      version: PINNED_PLAYWRIGHT_CLI_VERSION,
      reason: null,
    });
  });

  it("fails closed on a different version", () => {
    const f = fixture("0.1.19");
    expect(
      inspectPlaywrightCli({
        entry: f.entry,
        packageJson: f.packageJson,
        expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
      }),
    ).toMatchObject({
      available: false,
      version: "0.1.19",
      reason: `Playwright CLI version must be exactly ${PINNED_PLAYWRIGHT_CLI_VERSION}`,
    });
  });

  it("rejects the deprecated unscoped package identity", () => {
    const f = fixture(PINNED_PLAYWRIGHT_CLI_VERSION, "playwright-cli");
    expect(
      inspectPlaywrightCli({
        entry: f.entry,
        packageJson: f.packageJson,
        expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
      }),
    ).toMatchObject({
      available: false,
      reason: "Playwright CLI package identity does not match @playwright/cli",
    });
  });

  it("never treats missing or relative paths as an available backend", () => {
    expect(
      inspectPlaywrightCli({
        entry: "playwright-cli.js",
        packageJson: "package.json",
        expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
      }),
    ).toMatchObject({ available: false, reason: "Playwright CLI paths must be absolute" });

    const missing = path.join(os.tmpdir(), "rakazo-playwright-cli-missing", "playwright-cli.js");
    expect(
      inspectPlaywrightCli({
        entry: missing,
        packageJson: path.join(path.dirname(missing), "package.json"),
        expectedVersion: PINNED_PLAYWRIGHT_CLI_VERSION,
      }),
    ).toMatchObject({ available: false, reason: "Pinned Playwright CLI entry is not installed" });
  });
});
