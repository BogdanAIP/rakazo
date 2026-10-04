import { WindowsHostBrowserRequestSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { type OpenCliRunner, WindowsOpenCliBackend } from "./opencli.js";

function fixture(profile = "quxmf8xh") {
  let tree = '[1] button "Save"\n[2] textbox "Name"';
  const urls = new Map<string, string>();
  const runner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
    const at = argv.indexOf("browser");
    const session = argv[at + 1]!;
    const command = argv.slice(at + 2);
    if (command[0] === "open") {
      urls.set(session, command[1]!);
      return "opened";
    }
    if (command[0] === "close") {
      urls.delete(session);
      return "closed";
    }
    if (command[0] === "state") return tree;
    if (command[0] === "find") return '{"matches_n":1,"entries":[{"role":"button"}]}';
    if (command[0] === "wait") return '{"found":true}';
    if (command[0] === "extract") return "# Example content";
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
    expect(runner.mock.calls.every(([, argv]) => !argv.includes("--profile"))).toBe(true);
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
