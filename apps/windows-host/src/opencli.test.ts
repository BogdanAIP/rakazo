import { describe, expect, it, vi } from "vitest";
import { type OpenCliRunner, WindowsOpenCliBackend } from "./opencli.js";

function fixture(profile = "quxmf8xh") {
  let tree = '[1] button "Save"\n[2] textbox "Name"';
  let url = "https://example.com/form";
  const runner = vi.fn<OpenCliRunner>(async (_entry, argv) => {
    const command = argv.slice(4);
    if (command[0] === "open") {
      url = command[1]!;
      return "opened";
    }
    if (command[0] === "state") return tree;
    if (command[0] === "get" && command[1] === "url") return url;
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

describe("WindowsOpenCliBackend", () => {
  it("requires an explicit Chrome profile instead of guessing between signed-in users", async () => {
    const { runner } = fixture("");
    const backend = new WindowsOpenCliBackend({ entry: process.execPath, profile: "" }, runner);
    expect(backend.available()).toBe(false);
    await expect(backend.browser("bot-a", { command: "snapshot" })).rejects.toThrow(
      "OpenCLI is unavailable",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses a per-bot browser session with explicit profile and returns Rakazo element refs", async () => {
    const { backend, runner } = fixture();
    const result = await backend.browser("bot-a", {
      command: "navigate",
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
      "rakazo-bot-a",
      "open",
      "https://example.com/form",
    ]);
  });

  it("rejects unsafe navigation and malformed bot identifiers", async () => {
    const { backend, runner } = fixture();
    await expect(backend.browser("../escape", { command: "snapshot" })).rejects.toThrow("identity");
    await expect(
      backend.browser("bot-a", {
        command: "navigate",
        url: "file:///C:/Users/secret",
      }),
    ).rejects.toThrow("HTTP(S)");
    expect(runner).not.toHaveBeenCalled();
  });

  it("performs bounded browser actions only after a fresh observation", async () => {
    const { backend, runner } = fixture();
    await backend.browser("bot-a", { command: "snapshot" });
    const result = await backend.browser("bot-a", {
      command: "act",
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(runner).toHaveBeenCalledWith(process.execPath, [
      "--profile",
      "quxmf8xh",
      "browser",
      "rakazo-bot-a",
      "click",
      "1",
    ]);
  });

  it("fails closed when a numeric reference changes after the snapshot", async () => {
    const { backend, runner, changeTree } = fixture();
    await backend.browser("bot-a", { command: "snapshot" });
    changeTree('[1] button "Delete"');
    const result = await backend.browser("bot-a", {
      command: "act",
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(runner.mock.calls.some(([, argv]) => argv.includes("click"))).toBe(false);
  });

  it("enforces origin checks before entering content", async () => {
    const { backend, runner } = fixture();
    await backend.browser("bot-a", { command: "snapshot" });
    const result = await backend.browser("bot-a", {
      command: "act",
      actions: [{ kind: "fill", ref: "e2", text: "harmless", origin: "https://other.example" }],
    });
    expect(result).toMatchObject({ ok: false, completed: 0 });
    expect(runner.mock.calls.some(([, argv]) => argv.includes("fill"))).toBe(false);
  });
});
