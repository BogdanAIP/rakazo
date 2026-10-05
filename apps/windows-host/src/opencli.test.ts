import { writeFileSync } from "node:fs";
import { WindowsHostBrowserRequestSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { type OpenCliRunner, WindowsOpenCliBackend } from "./opencli.js";

function fixture(profile = "quxmf8xh") {
  let tree = '[1] button "Save"\n[2] textbox "Name"';
  const urls = new Map<string, string>();
  const tabs = new Map<string, Set<string>>();
  const selected = new Map<string, string>();
  let nextPage = 1;
  const createPage = (session: string): string => {
    const pageId = `page-${nextPage++}`;
    const owned = tabs.get(session) ?? new Set<string>();
    owned.add(pageId);
    tabs.set(session, owned);
    selected.set(session, pageId);
    return pageId;
  };
  const runner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
    const at = argv.indexOf("browser");
    const session = argv[at + 1]!;
    const command = argv.slice(at + 2);
    if (command[0] === "open") {
      urls.set(session, command[1]!);
      const page = selected.get(session) ?? createPage(session);
      return JSON.stringify({ url: command[1], page });
    }
    if (command[0] === "close") {
      urls.delete(session);
      tabs.delete(session);
      selected.delete(session);
      return "closed";
    }
    if (command[0] === "tab" && command[1] === "list") {
      const owned = [...(tabs.get(session) ?? new Set<string>())];
      return JSON.stringify(
        owned.map((page, index) => ({
          index,
          page,
          url: urls.get(session) ?? "about:blank",
          title: `Tab ${index + 1}`,
          active: selected.get(session) === page,
        })),
      );
    }
    if (command[0] === "tab" && command[1] === "new") {
      const page = createPage(session);
      if (command[2]) urls.set(session, command[2]);
      return JSON.stringify({ page, url: command[2] ?? null });
    }
    if (command[0] === "tab" && command[1] === "select") {
      const page = command[2]!;
      if (!tabs.get(session)?.has(page)) throw new Error("Unknown fixture page");
      selected.set(session, page);
      return JSON.stringify({ selected: page });
    }
    if (command[0] === "tab" && command[1] === "close") {
      const page = command[2]!;
      if (!tabs.get(session)?.delete(page)) throw new Error("Unknown fixture page");
      if (selected.get(session) === page) selected.delete(session);
      return JSON.stringify({ closed: page });
    }
    if (command[0] === "state")
      return `URL: ${urls.get(session) ?? "https://example.com/form"}\n\n${tree}`;
    if (command[0] === "find") return '{"matches_n":1,"entries":[{"role":"button"}]}';
    if (command[0] === "wait") return '{"found":true}';
    if (command[0] === "extract") return "# Example content";
    if (command[0] === "scroll") return "Scrolled";
    if (command[0] === "screenshot") {
      writeFileSync(command[1]!, Buffer.from("89504e470d0a1a0a00000000", "hex"));
      return "Screenshot saved";
    }
    if (command[0] === "get" && command[1] === "url") {
      return urls.get(session) ?? "https://example.com/form";
    }
    if (command[0] === "get" && command[1] === "title") return "Example form";
    if (["click", "fill", "type"].includes(command[0] ?? "")) return "ok";
    throw new Error("Unexpected OpenCLI request");
  });
  const backend = new WindowsOpenCliBackend({ entry: process.execPath, profile }, runner);
  return {
    backend,
    runner,
    changeTree: (value: string) => {
      tree = value;
    },
  };
}

async function openSession(backend: WindowsOpenCliBackend, botId: string): Promise<string> {
  const opened = await backend.browser(botId, { command: "open" });
  expect(opened.ok).toBe(true);
  if (!opened.sessionToken) throw new Error("Host did not mint browser token");
  return opened.sessionToken;
}

function sessionName(botId: string, token: string): string {
  return "rakazo-" + botId + "-" + token.replace(/-/gu, "");
}

describe("WindowsOpenCliBackend", () => {
  it("exposes bounded read-only find, wait and extract on the owned OpenCLI session", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    const session = sessionName("bot-a", token);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "find",
        sessionToken: token,
        css: "button.save",
      }).success,
    ).toBe(true);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "wait",
        sessionToken: token,
        kind: "time",
        value: "100",
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "wait",
        sessionToken: token,
        kind: "selector",
        value: ".done",
        timeoutMs: 12000,
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "find",
        sessionToken: token,
        css: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "eval",
        sessionToken: token,
        js: "document.cookie",
      }).success,
    ).toBe(false);
    expect(
      await backend.browser("bot-a", {
        command: "find",
        sessionToken: token,
        css: "button.save",
      }),
    ).toMatchObject({ ok: true, content: expect.stringContaining('"matches_n":1') });
    expect(
      await backend.browser("bot-a", {
        command: "wait",
        sessionToken: token,
        kind: "selector",
        value: ".done",
        timeoutMs: 2500,
      }),
    ).toMatchObject({ ok: true, content: '{"found":true}' });
    expect(
      await backend.browser("bot-a", {
        command: "extract",
        sessionToken: token,
        selector: "main",
        start: 200,
      }),
    ).toMatchObject({ ok: true, content: "# Example content" });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "find",
      "--css",
      "button.save",
      "--limit",
      "20",
      "--text-max",
      "120",
    ]);
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "wait",
      "selector",
      ".done",
      "--timeout",
      "2500",
    ]);
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "extract",
      "--chunk-size",
      "16000",
      "--selector",
      "main",
      "--start",
      "200",
    ]);
  });

  it("exposes bounded scroll and screenshot without caller-controlled file paths", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    const session = sessionName("bot-a", token);

    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "scroll",
        sessionToken: token,
        direction: "down",
        amount: 0,
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "scroll",
        sessionToken: token,
        direction: "down",
        amount: 5001,
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "screenshot",
        sessionToken: token,
        width: 100,
      }).success,
    ).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "screenshot",
        sessionToken: token,
        height: 5000,
      }).success,
    ).toBe(false);

    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    expect(
      await backend.browser("bot-a", {
        command: "scroll",
        sessionToken: token,
        direction: "down",
        amount: 750,
      }),
    ).toEqual({ ok: true });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "scroll",
      "down",
      "--amount",
      "750",
    ]);
    await expect(
      backend.browser("bot-a", {
        command: "act",
        sessionToken: token,
        actions: [{ kind: "click", ref: "e1" }],
      }),
    ).rejects.toThrow("Observe this browser session");

    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    const screenshot = await backend.browser("bot-a", {
      command: "screenshot",
      sessionToken: token,
      width: 800,
      height: 600,
    });
    expect(screenshot).toMatchObject({
      ok: true,
      mimeType: "image/png",
      imageBase64: Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64"),
    });
    const shotCall = runner.mock.calls.find(([, argv]) => argv.includes("screenshot"));
    expect(shotCall).toBeTruthy();
    const shotArgs = shotCall![1];
    const screenshotIndex = shotArgs.indexOf("screenshot");
    expect(shotArgs[screenshotIndex + 1]).toMatch(/rakazo-opencli-[a-f0-9-]+\.png$/u);
    expect(shotArgs.slice(screenshotIndex + 2)).toEqual(["--width", "800", "--height", "600"]);

    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    expect(
      await backend.browser("bot-a", {
        command: "screenshot",
        sessionToken: token,
        annotate: true,
      }),
    ).toMatchObject({ ok: true, mimeType: "image/png" });
    await expect(
      backend.browser("bot-a", {
        command: "act",
        sessionToken: token,
        actions: [{ kind: "click", ref: "e1" }],
      }),
    ).rejects.toThrow("Observe this browser session");
  });

  it("creates, selects and closes only tabs recorded for the same task session", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    const session = sessionName("bot-a", token);

    const initial = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: token,
      url: "https://example.com/initial",
    });
    expect(initial).toMatchObject({ ok: true, pageId: "page-1" });

    const created = await backend.browser("bot-a", {
      command: "tabNew",
      sessionToken: token,
      url: "https://example.com/second",
    });
    expect(created).toEqual({ ok: true, pageId: "page-2" });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "tab",
      "new",
      "https://example.com/second",
    ]);

    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    expect(
      await backend.browser("bot-a", {
        command: "tabSelect",
        sessionToken: token,
        pageId: "page-1",
      }),
    ).toEqual({ ok: true, pageId: "page-1" });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "tab",
      "select",
      "page-1",
    ]);
    await expect(
      backend.browser("bot-a", {
        command: "act",
        sessionToken: token,
        actions: [{ kind: "click", ref: "e1" }],
      }),
    ).rejects.toThrow("Observe this browser session");

    expect(
      await backend.browser("bot-a", {
        command: "tabClose",
        sessionToken: token,
        pageId: "page-2",
      }),
    ).toEqual({ ok: true, pageId: "page-2" });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      session,
      "tab",
      "close",
      "page-2",
    ]);
    const calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "tabSelect",
        sessionToken: token,
        pageId: "page-2",
      }),
    ).rejects.toThrow("Unknown browser tab");
    expect(runner).toHaveBeenCalledTimes(calls);
  });

  it("caps caller-created owned tabs before invoking OpenCLI again", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    for (let index = 0; index < 8; index += 1) {
      expect(
        await backend.browser("bot-a", {
          command: "tabNew",
          sessionToken: token,
        }),
      ).toMatchObject({ ok: true, pageId: `page-${index + 1}` });
    }
    const calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "tabNew",
        sessionToken: token,
      }),
    ).rejects.toThrow("Too many owned browser tabs");
    expect(runner).toHaveBeenCalledTimes(calls);
  });

  it("never accepts a page identity owned by another token or an unsafe tab URL", async () => {
    const { backend, runner } = fixture("");
    const a = await openSession(backend, "bot-a");
    const b = await openSession(backend, "bot-a");
    const first = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: a,
      url: "https://example.com/a",
    });
    const second = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: b,
      url: "https://example.com/b",
    });
    expect(first.pageId).toBeTruthy();
    expect(second.pageId).toBeTruthy();
    expect(first.pageId).not.toBe(second.pageId);

    let calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "tabSelect",
        sessionToken: b,
        pageId: first.pageId!,
      }),
    ).rejects.toThrow("Unknown browser tab");
    expect(runner).toHaveBeenCalledTimes(calls);

    calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "tabNew",
        sessionToken: b,
        url: "file:///C:/Users/secret",
      }),
    ).rejects.toThrow("HTTP(S)");
    expect(runner).toHaveBeenCalledTimes(calls);

    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "tabSelect",
        sessionToken: b,
        pageId: "",
      }).success,
    ).toBe(false);
  });

  it("fails closed when tab creation does not return a trackable page identity", async () => {
    const runner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
      const command = argv.slice(argv.indexOf("browser") + 2);
      if (command[0] === "tab" && command[1] === "new") return "{}";
      throw new Error("Unexpected OpenCLI request");
    });
    const backend = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    const token = await openSession(backend, "bot-a");
    expect(await backend.browser("bot-a", { command: "tabNew", sessionToken: token })).toEqual({
      ok: false,
      uncertain: true,
      error: "OpenCLI created a tab but did not return a valid page identity",
    });
    const calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "tabClose",
        sessionToken: token,
        pageId: "untracked-page",
      }),
    ).rejects.toThrow("Unknown browser tab");
    expect(runner).toHaveBeenCalledTimes(calls);
  });

  it("recovers tabs only from the exact token-derived OpenCLI session after host state loss", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    const first = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: token,
      url: "https://example.com/first",
    });
    const second = await backend.browser("bot-a", {
      command: "tabNew",
      sessionToken: token,
      url: "https://example.com/second",
    });
    expect(first.pageId).toBe("page-1");
    expect(second.pageId).toBe("page-2");

    const restarted = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    expect(
      await restarted.browser("bot-a", {
        command: "recover",
        sessionToken: token,
      }),
    ).toEqual({
      ok: true,
      sessionToken: token,
      pageIds: ["page-1", "page-2"],
    });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      sessionName("bot-a", token),
      "tab",
      "list",
    ]);
    expect(
      await restarted.browser("bot-a", {
        command: "tabSelect",
        sessionToken: token,
        pageId: "page-2",
      }),
    ).toEqual({ ok: true, pageId: "page-2" });

    expect(
      WindowsHostBrowserRequestSchema.safeParse({
        command: "bind",
        sessionToken: token,
      }).success,
    ).toBe(false);
  });

  it("does not mint recovery ownership for an empty or cross-bot OpenCLI session", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: token,
      url: "https://example.com/owned",
    });

    const restarted = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    expect(
      await restarted.browser("bot-b", {
        command: "recover",
        sessionToken: token,
      }),
    ).toEqual({
      ok: false,
      error: "No recoverable owned browser tabs found for this session token",
    });
    await expect(
      restarted.browser("bot-b", {
        command: "tabSelect",
        sessionToken: token,
        pageId: "page-1",
      }),
    ).rejects.toThrow("Unknown browser session");

    const unknownToken = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      await restarted.browser("bot-a", {
        command: "recover",
        sessionToken: unknownToken,
      }),
    ).toEqual({
      ok: false,
      error: "No recoverable owned browser tabs found for this session token",
    });
    await expect(
      restarted.browser("bot-a", {
        command: "snapshot",
        sessionToken: unknownToken,
      }),
    ).rejects.toThrow("Unknown browser session");
  });

  it("fails closed when recovery returns too many or malformed page identities", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const tooManyRunner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
      const command = argv.slice(argv.indexOf("browser") + 2);
      if (command[0] === "tab" && command[1] === "list") {
        return JSON.stringify(
          Array.from({ length: 9 }, (_, index) => ({
            page: `page-${index + 1}`,
          })),
        );
      }
      throw new Error("Unexpected OpenCLI request");
    });
    const tooMany = new WindowsOpenCliBackend(
      { entry: process.execPath, profile: "" },
      tooManyRunner,
    );
    expect(await tooMany.browser("bot-a", { command: "recover", sessionToken: token })).toEqual({
      ok: false,
      error: "OpenCLI returned too many tabs for safe recovery",
    });
    await expect(
      tooMany.browser("bot-a", {
        command: "tabSelect",
        sessionToken: token,
        pageId: "page-1",
      }),
    ).rejects.toThrow("Unknown browser session");

    const malformedRunner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
      const command = argv.slice(argv.indexOf("browser") + 2);
      if (command[0] === "tab" && command[1] === "list") {
        return JSON.stringify([{ page: "duplicate" }, { page: "duplicate" }]);
      }
      throw new Error("Unexpected OpenCLI request");
    });
    const malformed = new WindowsOpenCliBackend(
      { entry: process.execPath, profile: "" },
      malformedRunner,
    );
    expect(await malformed.browser("bot-a", { command: "recover", sessionToken: token })).toEqual({
      ok: false,
      error: "OpenCLI returned an invalid tab list during recovery",
    });
  });

  it("denies read-only operations using another task's session token before invoking OpenCLI", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    await expect(
      backend.browser("bot-b", {
        command: "find",
        sessionToken: token,
        css: "button",
      }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-b", {
        command: "extract",
        sessionToken: token,
      }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-b", {
        command: "wait",
        sessionToken: token,
        kind: "text",
        value: "Ready",
      }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-b", {
        command: "scroll",
        sessionToken: token,
        direction: "down",
      }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-b", {
        command: "screenshot",
        sessionToken: token,
      }),
    ).rejects.toThrow("Unknown browser session");
    expect(runner).not.toHaveBeenCalled();
  });

  it("lets OpenCLI resolve the only/default connected Chrome profile", async () => {
    const { backend, runner } = fixture("");
    const token = await openSession(backend, "bot-a");
    const response = await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    expect(response).toMatchObject({ ok: true, url: "https://example.com/form" });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "browser",
      sessionName("bot-a", token),
      "state",
    ]);
    expect(
      runner.mock.calls.some(([, argv]) => argv.at(-2) === "get" && argv.at(-1) === "url"),
    ).toBe(false);
    expect(
      runner.mock.calls.some(([, argv]) => argv.at(-2) === "get" && argv.at(-1) === "title"),
    ).toBe(true);
    expect(runner.mock.calls.every(([, argv]) => !argv.includes("--profile"))).toBe(true);
  });

  it("falls back to get url when OpenCLI state lacks the v1.8.6 URL header", async () => {
    const runner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
      const command = argv.slice(argv.indexOf("browser") + 2);
      if (command[0] === "state") return '[1] button "Save"';
      if (command[0] === "get" && command[1] === "url") return "https://legacy.example/form";
      if (command[0] === "get" && command[1] === "title") return "Legacy form";
      throw new Error("Unexpected OpenCLI request");
    });
    const backend = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    const token = await openSession(backend, "bot-a");
    expect(
      await backend.browser("bot-a", { command: "snapshot", sessionToken: token }),
    ).toMatchObject({
      ok: true,
      url: "https://legacy.example/form",
      title: "Legacy form",
    });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("fails without guessing or clicking when OpenCLI reports ambiguous profiles", async () => {
    const runner = vi.fn<OpenCliRunner>(async () => {
      throw new Error("Multiple browser profiles connected; choose one first");
    });
    const backend = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    const token = await openSession(backend, "bot-a");
    await expect(
      backend.browser("bot-a", { command: "snapshot", sessionToken: token }),
    ).rejects.toThrow("Multiple browser profiles");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toEqual(["browser", sessionName("bot-a", token), "state"]);
  });

  it("returns opaque unique tokens and uses the explicit Chrome profile", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    expect(WindowsHostBrowserRequestSchema.safeParse({ command: "snapshot" }).success).toBe(false);
    expect(
      WindowsHostBrowserRequestSchema.safeParse({ command: "snapshot", sessionToken: token })
        .success,
    ).toBe(true);
    const result = await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: token,
      url: "https://example.com/form",
    });
    expect(result).toMatchObject({
      ok: true,
      url: "https://example.com/form",
      title: "Example form",
      elements: [
        { ref: "e1", role: "button", name: '"Save"' },
        { ref: "e2", role: "textbox", name: '"Name"' },
      ],
    });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "--profile",
      "quxmf8xh",
      "browser",
      sessionName("bot-a", token),
      "open",
      "https://example.com/form",
    ]);
  });

  it("rejects malformed bot identity, unknown tokens and unsafe navigation before CLI", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    await expect(
      backend.browser("../escape", { command: "snapshot", sessionToken: token }),
    ).rejects.toThrow("identity");
    await expect(
      backend.browser("bot-b", { command: "snapshot", sessionToken: token }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-a", {
        command: "snapshot",
        sessionToken: "8defde6b-2123-4659-ac4d-339ad5413d94",
      }),
    ).rejects.toThrow("Unknown browser session");
    await expect(
      backend.browser("bot-a", {
        command: "navigate",
        sessionToken: token,
        url: "file:///C:/Users/secret",
      }),
    ).rejects.toThrow("HTTP(S)");
    expect(runner).not.toHaveBeenCalled();
  });

  it("performs bounded actions only after a fresh per-session observation", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    const result = await backend.browser("bot-a", {
      command: "act",
      sessionToken: token,
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "--profile",
      "quxmf8xh",
      "browser",
      sessionName("bot-a", token),
      "click",
      "1",
    ]);
  });

  it("fails closed when a numeric reference changes after the snapshot", async () => {
    const { backend, runner, changeTree } = fixture();
    const token = await openSession(backend, "bot-a");
    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    changeTree('[1] button "Delete"');
    const result = await backend.browser("bot-a", {
      command: "act",
      sessionToken: token,
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(runner.mock.calls.some(([, argv]) => argv.includes("click"))).toBe(false);
  });

  it("does not allow closing or navigating another task's session, even on the same bot", async () => {
    const { backend, runner } = fixture();
    const [a, b] = await Promise.all([
      openSession(backend, "bot-a"),
      openSession(backend, "bot-a"),
    ]);
    expect(a).not.toBe(b);
    expect(sessionName("bot-a", a)).not.toBe(sessionName("bot-a", b));
    await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: a,
      url: "https://example.com/a",
    });
    await backend.browser("bot-a", {
      command: "navigate",
      sessionToken: b,
      url: "https://example.com/b",
    });
    expect((await backend.browser("bot-a", { command: "snapshot", sessionToken: a })).url).toBe(
      "https://example.com/a",
    );
    expect((await backend.browser("bot-a", { command: "snapshot", sessionToken: b })).url).toBe(
      "https://example.com/b",
    );
    expect(await backend.browser("bot-a", { command: "close", sessionToken: a })).toEqual({
      ok: true,
    });
    expect((await backend.browser("bot-a", { command: "snapshot", sessionToken: b })).url).toBe(
      "https://example.com/b",
    );
    await expect(
      backend.browser("bot-a", { command: "snapshot", sessionToken: a }),
    ).rejects.toThrow("Unknown browser session");
    const closeCalls = runner.mock.calls.filter(([, argv]) => argv.at(-1) === "close");
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]![1]).toContain(sessionName("bot-a", a));
    expect(closeCalls[0]![1]).not.toContain(sessionName("bot-a", b));
  });

  it("clears stale element refs when the owner closes the session", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    expect(await backend.browser("bot-a", { command: "close", sessionToken: token })).toEqual({
      ok: true,
    });
    const calls = runner.mock.calls.length;
    await expect(
      backend.browser("bot-a", {
        command: "act",
        sessionToken: token,
        actions: [{ kind: "click", ref: "e1" }],
      }),
    ).rejects.toThrow("Unknown browser session");
    expect(runner).toHaveBeenCalledTimes(calls);
  });

  it("expires forgotten bearer tokens without accepting commands for a stale session", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
      const { backend, runner } = fixture();
      const token = await openSession(backend, "bot-a");
      vi.setSystemTime(new Date("2026-10-03T00:31:00Z"));
      await expect(
        backend.browser("bot-a", {
          command: "snapshot",
          sessionToken: token,
        }),
      ).rejects.toThrow("expired");
      expect(runner).not.toHaveBeenCalled();
      expect(await openSession(backend, "bot-a")).not.toBe(token);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces origin checks before entering content", async () => {
    const { backend, runner } = fixture();
    const token = await openSession(backend, "bot-a");
    await backend.browser("bot-a", { command: "snapshot", sessionToken: token });
    const result = await backend.browser("bot-a", {
      command: "act",
      sessionToken: token,
      actions: [{ kind: "fill", ref: "e2", text: "harmless", origin: "https://other.example" }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0 });
    expect(runner.mock.calls.some(([, argv]) => argv.includes("fill"))).toBe(false);
  });
});
