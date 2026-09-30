import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WindowsHostGuiRequestSchema, WindowsHostGuiResultSchema, type WindowsHostGuiRequest, type WindowsHostGuiResult } from "@rakazo/contracts";

const GUI_SCRIPT = fileURLToPath(new URL("../scripts/windows-gui.ps1", import.meta.url));
const MAX_GUI_BYTES = 8 * 1024 * 1024;
const GUI_TIMEOUT_MS = 22_000;

/** The executor is a fixed, checked-in script, not a general PowerShell API. */
export type WindowsGuiRunner = (request: WindowsHostGuiRequest) => Promise<WindowsHostGuiResult>;

export function windowsGuiAvailable(
  platform = process.platform,
  enabled = process.env.RAKAZO_WINDOWS_GUI_ENABLED === "true",
  script = GUI_SCRIPT,
): boolean {
  return platform === "win32" && enabled && existsSync(script);
}

export async function runWindowsGui(request: WindowsHostGuiRequest): Promise<WindowsHostGuiResult> {
  if (!windowsGuiAvailable()) throw new Error("Windows GUI is not enabled for this host");
  if (request.command === "act") {
    const waitMs = request.actions.reduce(
      (sum, action) => sum + (action.kind === "wait" ? action.ms : 0),
      0,
    );
    if (waitMs + (request.settleMs ?? 0) > 10_000) {
      throw new Error("Windows action batch exceeds the 10-second wait budget");
    }
  }
  return new Promise<WindowsHostGuiResult>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", GUI_SCRIPT,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let byteCount = 0;
    let settled = false;
    const finish = (error?: Error, result?: WindowsHostGuiResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Windows GUI returned no result"));
    };
    const append = (buffer: Buffer, isError: boolean) => {
      byteCount += buffer.byteLength;
      if (byteCount > MAX_GUI_BYTES) {
        child.kill();
        finish(new Error("Windows GUI result exceeds the 8 MiB limit"));
        return;
      }
      if (isError) stderr += buffer.toString("utf8");
      else stdout += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Windows GUI timed out; action outcome is uncertain"));
    }, GUI_TIMEOUT_MS);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error("Windows GUI failed (" + String(code) + "): " + stderr.slice(0, 500)));
        return;
      }
      try {
        finish(undefined, WindowsHostGuiResultSchema.parse(JSON.parse(stdout.trim())));
      } catch {
        finish(new Error("Windows GUI returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(WindowsHostGuiRequestSchema.parse(request)), "utf8");
  });
}

export class WindowsGuiBackend {
  constructor(
    private readonly runner: WindowsGuiRunner = runWindowsGui,
    private readonly isAvailable: () => boolean = windowsGuiAvailable,
  ) {}

  available(): boolean {
    return this.isAvailable();
  }

  async execute(request: WindowsHostGuiRequest): Promise<WindowsHostGuiResult> {
    if (!this.available()) throw new Error("Physical Windows GUI is not enabled");
    return WindowsHostGuiResultSchema.parse(await this.runner(WindowsHostGuiRequestSchema.parse(request)));
  }
}
