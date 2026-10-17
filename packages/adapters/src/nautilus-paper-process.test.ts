import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NautilusPaperProcess } from "./nautilus-paper-process.js";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function child(ready = true) {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  if (ready)
    process.stdin.on("data", (data: Buffer) => {
      if (JSON.parse(data.toString()).action === "initialize")
        process.stdout.write(`${JSON.stringify({ status: "ready", engineVersion: "1.231.0" })}\n`);
    });
  mock.spawn.mockReturnValueOnce(process);
  return process;
}
const config = {
  accountId: "fixture-paper",
  engineVersion: "1.231.0",
  initialBalanceQuote: "1000",
  leverage: 1,
  instruments: [],
} as const;
const options = { pythonCommand: "fixture-python", scriptPath: "fixture-script" };
const batch = { sequence: 1, quotes: [], commands: [], funding: [] };

describe("private-safe native PAPER diagnostics", () => {
  it("distinguishes a process exit and retains its first cause without exposing stderr", async () => {
    const c = child();
    const process = await NautilusPaperProcess.start(options, config);
    const result = process.apply(batch);
    const rejected = expect(result).rejects.toThrow("process_exited, exit=7");
    await Promise.resolve();
    c.stderr.write("fixture-private-traceback-and-path");
    c.emit("exit", 7, null);
    await rejected;
    await expect(process.apply(batch)).rejects.toThrow("process_exited, exit=7");
    expect(c.kill).toHaveBeenCalledTimes(1);
  });

  it("distinguishes request timeout from native exit", async () => {
    vi.useFakeTimers();
    child(false);
    const result = NautilusPaperProcess.start(options, config);
    const rejected = expect(result).rejects.toThrow("request_timeout");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
  });

  it("does not return spawn error paths or diagnostics", async () => {
    const c = child(false);
    const result = NautilusPaperProcess.start(options, config);
    const rejected = expect(result).rejects.toThrow("spawn_failed");
    c.emit("error", new Error("fixture-private-spawn-path"));
    await rejected;
  });
});
