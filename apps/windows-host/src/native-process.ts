import { spawn } from "node:child_process";
import type { WindowsHostProcessResult } from "@rakazo/contracts";
import { WindowsHostReadOnlyBackend } from "./readonly.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUN_MS = 18_000;

export type WindowsProcessRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<WindowsHostProcessResult>;

function terminateWindowsTree(pid: number | undefined) {
  if (!pid || process.platform !== "win32") return;
  const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  killer.on("error", () => undefined);
  killer.unref();
}

export async function runBoundedWindowsProcess(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<WindowsHostProcessResult> {
  if (process.platform !== "win32") throw new Error("Native process execution requires Windows");
  if (!argv.length || argv.length > 16 || argv.some((arg) => arg.length > 4096)) {
    throw new Error("Invalid Windows process arguments");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_RUN_MS) {
    throw new Error("Invalid native process timeout");
  }
  return new Promise<WindowsHostProcessResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ stdout, stderr, code: code ?? -1 });
    };
    const append = (buffer: Buffer, isError: boolean) => {
      bytes += buffer.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminateWindowsTree(child.pid);
        child.kill();
        finish(
          new Error("Windows process output exceeded 64 KiB; verify termination before retry"),
        );
        return;
      }
      if (isError) stderr += buffer.toString("utf8");
      else stdout += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      terminateWindowsTree(child.pid);
      child.kill();
      finish(new Error("Windows process timed out; verify termination before retry"));
    }, timeoutMs);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? -1));
  });
}

export class WindowsProcessBackend {
  private readonly reader: WindowsHostReadOnlyBackend;
  constructor(
    stateDir: string,
    private readonly runner: WindowsProcessRunner = runBoundedWindowsProcess,
    private readonly enabled = process.env.RAKAZO_WINDOWS_PROCESS_ENABLED === "true",
  ) {
    this.reader = new WindowsHostReadOnlyBackend(stateDir);
  }

  available(): boolean {
    return process.platform === "win32" && this.enabled;
  }

  async execute(botId: string, argv: string[], cwd = ".", timeoutMs = 10_000) {
    if (!this.enabled) throw new Error("Native Windows process execution is not enabled");
    const directory = await this.reader.workspaceDirectory(botId, cwd);
    return this.runner(argv, directory, timeoutMs);
  }
}
