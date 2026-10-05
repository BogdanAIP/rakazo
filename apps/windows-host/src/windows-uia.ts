import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type WindowsHostUiaSnapshot,
  WindowsHostUiaSnapshotSchema,
} from "@rakazo/contracts";

const UIA_SCRIPT = fileURLToPath(new URL("../scripts/windows-uia.ps1", import.meta.url));
const MAX_UIA_BYTES = 512 * 1024;
const UIA_TIMEOUT_MS = 10_000;

export type WindowsUiaRunner = () => Promise<WindowsHostUiaSnapshot>;

export function windowsUiaAvailable(
  platform = process.platform,
  enabled = process.env.RAKAZO_WINDOWS_UIA_ENABLED === "true",
  script = UIA_SCRIPT,
): boolean {
  return platform === "win32" && enabled && existsSync(script);
}

export async function runWindowsUiaSnapshot(): Promise<WindowsHostUiaSnapshot> {
  if (!windowsUiaAvailable()) throw new Error("Windows UI Automation is not enabled for this host");
  return new Promise<WindowsHostUiaSnapshot>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", UIA_SCRIPT],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, snapshot?: WindowsHostUiaSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (snapshot) resolve(snapshot);
      else reject(new Error("Windows UI Automation returned no snapshot"));
    };
    const append = (buffer: Buffer, isError: boolean) => {
      bytes += buffer.byteLength;
      if (bytes > MAX_UIA_BYTES) {
        child.kill();
        finish(new Error("Windows UI Automation output exceeded 512 KiB"));
        return;
      }
      if (isError) stderr += buffer.toString("utf8");
      else stdout += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Windows UI Automation snapshot timed out"));
    }, UIA_TIMEOUT_MS);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `Windows UI Automation failed (${String(code)}): ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        finish(undefined, WindowsHostUiaSnapshotSchema.parse(JSON.parse(stdout.trim())));
      } catch {
        finish(new Error("Windows UI Automation returned invalid JSON"));
      }
    });
  });
}

export class WindowsUiaBackend {
  constructor(
    private readonly runner: WindowsUiaRunner = runWindowsUiaSnapshot,
    private readonly isAvailable: () => boolean = windowsUiaAvailable,
  ) {}

  available(): boolean {
    return this.isAvailable();
  }

  async snapshot(): Promise<WindowsHostUiaSnapshot> {
    if (!this.available()) throw new Error("Physical Windows UI Automation is not enabled");
    return WindowsHostUiaSnapshotSchema.parse(await this.runner());
  }
}
