import { describe, expect, it, vi } from "vitest";
import { type PlaywrightCliRunner, WindowsPlaywrightCliBackend } from "./playwright-cli.js";
import type { PlaywrightCliConfiguration } from "./playwright-cli-config.js";

const cdpConfig: PlaywrightCliConfiguration = {
  mode: "playwright-cli-cdp",
  entry: process.execPath,
  browserChannel: "chrome",
  userDataDir: null,
};

function fakeRunner(
  handler: (argv: string[], timeoutMs?: number) => string | Promise<string>,
): PlaywrightCliRunner {
  return vi.fn(async (_entry, argv, _cwd, timeoutMs) => await handler(argv, timeoutMs));
}

function currentTab(title = "Example", url = "https://example.com/") {
  return JSON.stringify({ result: `- 0: (current) [${title}](${url})` });
}

function exampleSnapshot(name = "Continue") {
  return JSON.stringify({
    snapshot: [
      {
        role: "generic",
        active: true,
        ref: "e1",
        children: [{ role: "button", name, ref: "e2" }],
      },
    ],
  });
}

describe("WindowsPlaywrightCliBackend", () => {
  it("mints a Rakazo bearer token without touching the browser", async () => {
    const runner = fakeRunner(() => {
      throw new Error("runner must not be called");
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), runner);
    const result = await backend.browser("bot-a", { command: "open" });

    expect(result.ok).toBe(true);
    expect(result.sessionToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("attaches through CDP and returns structured snapshot plus tab identity", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      const command = argv[1];
      if (command === "attach")
        return JSON.stringify({ session: "x", pid: 1, endpoint: "chrome", result: {} });
      if (command === "tab-list") return currentTab();
      if (command === "snapshot") return exampleSnapshot();
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), runner);
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
    expect(result.pageId).toMatch(/^pw-0-[0-9a-f]{12}$/u);
    expect(result.pageIds).toEqual([result.pageId]);
  });

  it("supports browser-confirmed Extension attach as a first-class mode", async () => {
    const runner = fakeRunner((argv, timeoutMs) => {
      const command = argv[1];
      if (command === "attach") {
        expect(argv).toContain("--extension=chrome");
        expect(timeoutMs).toBe(25_000);
        return JSON.stringify({ session: "x", pid: 1, endpoint: "chrome", result: {} });
      }
      if (command === "tab-list") return currentTab("Signed in");
      if (command === "snapshot") return exampleSnapshot("Account");
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(
      { ...cdpConfig, mode: "playwright-cli-extension" },
      process.cwd(),
      runner,
    );

    expect(backend.available()).toBe(true);
    const opened = await backend.browser("bot-a", { command: "open" });
    const result = await backend.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });
    expect(result.ok).toBe(true);
  });

  it("opens a dedicated Persistent profile and closes only that session", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      const command = argv[1];
      if (command === "open") return JSON.stringify({ result: {} });
      if (command === "tab-list") return JSON.stringify({ result: "- 0: (current) [](about:blank)" });
      if (command === "snapshot") return JSON.stringify({ snapshot: [] });
      if (command === "close") return JSON.stringify({ status: "closed" });
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(
      {
        ...cdpConfig,
        mode: "playwright-cli-persistent",
        userDataDir: "C:\\Rakazo\\playwright-profile",
      },
      process.cwd(),
      runner,
    );
    const opened = await backend.browser("bot-a", { command: "open" });
    await backend.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });
    await backend.browser("bot-a", { command: "close", sessionToken: opened.sessionToken! });

    expect(
      calls.some(
        (argv) =>
          argv.includes("open") &&
          argv.includes("--profile=C:\\Rakazo\\playwright-profile") &&
          argv.includes("--browser=chrome"),
      ),
    ).toBe(true);
    expect(calls.some((argv) => argv.includes("close"))).toBe(true);
  });

  it("navigates and performs bounded semantic actions after a fresh observation", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      const command = argv[1];
      if (command === "attach") return JSON.stringify({ result: {} });
      if (command === "goto") return JSON.stringify({ result: {} });
      if (command === "tab-list") return currentTab();
      if (command === "snapshot") return exampleSnapshot();
      if (command === "click") return JSON.stringify({ result: {} });
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: opened.sessionToken!,
      url: "https://example.com/",
    });
    const result = await backend.browser("bot-a", {
      command: "act",
      sessionToken: opened.sessionToken!,
      actions: [{ kind: "click", ref: "e2" }],
    });

    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(calls.some((argv) => argv[1] === "goto" && argv[2] === "https://example.com/")).toBe(
      true,
    );
    expect(calls.some((argv) => argv[1] === "click" && argv[2] === "e2")).toBe(true);
  });

  it("creates, selects and closes only tab identities observed by the session", async () => {
    let tabs = "- 0: (current) [One](https://one.example/)";
    const runner = fakeRunner((argv) => {
      const command = argv[1];
      if (command === "attach") return JSON.stringify({ result: {} });
      if (command === "tab-list") return JSON.stringify({ result: tabs });
      if (command === "tab-new") {
        tabs =
          "- 0: [One](https://one.example/)\n- 1: (current) [Two](https://two.example/)";
        return JSON.stringify({ result: tabs });
      }
      if (command === "tab-select") {
        tabs =
          "- 0: (current) [One](https://one.example/)\n- 1: [Two](https://two.example/)";
        return JSON.stringify({ result: tabs });
      }
      if (command === "tab-close") {
        tabs = "- 0: (current) [One](https://one.example/)";
        return JSON.stringify({ result: tabs });
      }
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    const created = await backend.browser("bot-a", {
      command: "tabNew",
      sessionToken: opened.sessionToken!,
      url: "https://two.example/",
    });
    expect(created.ok).toBe(true);
    expect(created.pageId).toMatch(/^pw-1-/u);

    const pageOne = created.pageIds!.find((id) => id.startsWith("pw-0-"))!;
    const selected = await backend.browser("bot-a", {
      command: "tabSelect",
      sessionToken: opened.sessionToken!,
      pageId: pageOne,
    });
    expect(selected).toMatchObject({ ok: true, pageId: pageOne });

    const pageTwo = selected.pageIds!.find((id) => id.startsWith("pw-1-"))!;
    const closed = await backend.browser("bot-a", {
      command: "tabClose",
      sessionToken: opened.sessionToken!,
      pageId: pageTwo,
    });
    expect(closed.ok).toBe(true);
    expect(closed.pageIds).toHaveLength(1);
  });

  it("uses detach instead of closing an externally owned CDP browser", async () => {
    const calls: string[][] = [];
    const runner = fakeRunner((argv) => {
      calls.push(argv);
      const command = argv[1];
      if (command === "attach") return JSON.stringify({ result: {} });
      if (command === "tab-list") return currentTab();
      if (command === "snapshot") return exampleSnapshot();
      if (command === "detach") return JSON.stringify({ status: "detached" });
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), runner);
    const opened = await backend.browser("bot-a", { command: "open" });
    await backend.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });
    await backend.browser("bot-a", { command: "close", sessionToken: opened.sessionToken! });

    expect(calls.some((argv) => argv[1] === "detach")).toBe(true);
    expect(calls.some((argv) => argv[1] === "close")).toBe(false);
  });

  it("recovers only the deterministic session derived from mode, bot and bearer token", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const runner = fakeRunner((argv) => {
      if (argv[0] === "list") {
        return JSON.stringify({
          browsers: [
            {
              name: expect.stringContaining("rakazo-pw-cdp-"),
              status: "open",
            },
          ],
        });
      }
      if (argv[1] === "tab-list") return currentTab();
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });

    const botHash = (await import("node:crypto"))
      .createHash("sha256")
      .update("bot-a")
      .digest("hex")
      .slice(0, 12);
    const expectedName = `rakazo-pw-cdp-${botHash}-${token.replace(/-/gu, "")}`;
    const preciseRunner = fakeRunner((argv) => {
      if (argv[0] === "list") {
        return JSON.stringify({
          browsers: [{ name: expectedName, status: "open", attached: true }],
        });
      }
      if (argv[1] === "tab-list") return currentTab();
      throw new Error(`unexpected args: ${argv.join(" ")}`);
    });
    const backend = new WindowsPlaywrightCliBackend(cdpConfig, process.cwd(), preciseRunner);
    const result = await backend.browser("bot-a", {
      command: "recover",
      sessionToken: token,
    });

    expect(result).toMatchObject({ ok: true, sessionToken: token });
    expect(runner).not.toHaveBeenCalled();
  });
});
