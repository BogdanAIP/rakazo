import { describe, expect, it, vi } from "vitest";
import type { PlaywrightCliConfiguration } from "./playwright-cli-config.js";
import { WindowsPlaywrightCliBackend, type PlaywrightCliRunner } from "./playwright-cli.js";

const cdpConfig: PlaywrightCliConfiguration = {
  mode: "playwright-cli-cdp",
  entry: "C:\\Rakazo\\playwright-cli.js",
  browserChannel: "chrome",
  userDataDir: null,
};

function fakeRunner(
  handler: (argv: string[]) => string | Promise<string>,
): PlaywrightCliRunner {
  return vi.fn(async (_entry, argv) => await handler(argv));
}

describe("WindowsPlaywrightCliBackend", () => {
  it("mints a Rakazo bearer token without touching the browser", async () => {
    const runner = fakeRunner(() => {
      throw new Error("runner must not be called");
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, "C:\\Rakazo\\state", runner);
    const result = await backend.browser("bot-a", { command: "open" });

    expect(result.ok).toBe(true);
    expect(result.sessionToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("attaches through CDP and returns a structured snapshot", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      if (argv.includes("attach"))
        return JSON.stringify({ session: "x", pid: 1, endpoint: "chrome", result: {} });
      if (argv.includes("snapshot"))
        return JSON.stringify({
          snapshot: [
            {
              role: "generic",
              active: true,
              ref: "e1",
              children: [{ role: "button", name: "Continue", ref: "e2" }],
            },
          ],
        });
      if (argv.includes("tab-list"))
        return JSON.stringify({ result: "- 0: (current) [Example](https://example.com/)" });
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, "C:\\Rakazo\\state", runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    const result = await backend.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });

    expect(calls.some((argv) => argv.includes("--cdp=chrome"))).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      url: "https://example.com/",
      title: "Example",
      elements: [
        { ref: "e1", role: "generic", name: "element" },
        { ref: "e2", role: "button", name: "Continue" },
      ],
    });
    expect(result.tree).toContain('"Continue"');
  });

  it("uses detach instead of closing the external Chrome browser", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      if (argv.includes("attach"))
        return JSON.stringify({ session: "x", pid: 1, endpoint: "chrome", result: {} });
      if (argv.includes("snapshot"))
        return JSON.stringify({ snapshot: [{ role: "heading", name: "Hi", ref: "e1" }] });
      if (argv.includes("tab-list"))
        return JSON.stringify({ result: "- 0: (current) [Hi](https://example.com/)" });
      if (argv.includes("detach")) return JSON.stringify({ session: "x", status: "detached" });
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, "C:\\Rakazo\\state", runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    await backend.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });
    const closed = await backend.browser("bot-a", {
      command: "close",
      sessionToken: opened.sessionToken!,
    });

    expect(closed).toEqual({ ok: true });
    expect(calls.some((argv) => argv.includes("detach"))).toBe(true);
    expect(calls.some((argv) => argv.includes("close"))).toBe(false);
  });

  it("does not expose mutating Playwright commands in the read-only slice", async () => {
    const runner = fakeRunner(() => {
      throw new Error("runner must not be called");
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, "C:\\Rakazo\\state", runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    const result = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: opened.sessionToken!,
      url: "https://example.com/",
    });

    expect(result).toEqual({
      ok: false,
      error: "This Playwright backend slice is read-only; use OpenCLI or wait for BV2-04",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("recovers only the deterministic session derived from bot and bearer token", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const expectedName = `rakazo-bot-a-${token.replace(/-/gu, "")}`;
    const runner = fakeRunner((argv) => {
      expect(argv).toEqual(["list"]);
      return JSON.stringify({
        browsers: [
          {
            name: expectedName,
            status: "open",
            attached: true,
          },
        ],
      });
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, "C:\\Rakazo\\state", runner);
    const result = await backend.browser("bot-a", {
      command: "recover",
      sessionToken: token,
    });

    expect(result).toEqual({ ok: true, sessionToken: token });
  });

  it("keeps extension mode unavailable until interactive approval is implemented", () => {
    const backend = new WindowsPlaywrightCliBackend(
      { ...cdpConfig, mode: "playwright-cli-extension" },
      "C:\\Rakazo\\state",
      fakeRunner(() => "{}"),
    );
    expect(backend.available()).toBe(false);
  });
});
