import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WindowsHostProcessResult } from "@rakazo/contracts";
import { WindowsHostReadOnlyBackend } from "./readonly.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUN_MS = 18_000;
const MAX_POLICY_BYTES = 64 * 1024;
type ProcessPermission = { botId: string; cwd: string; argv: string[] };

function validArgv(argv: unknown): argv is string[] {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= 16 &&
    argv.every(
      (arg) =>
        typeof arg === "string" && arg.length <= 4096 && !arg.includes(String.fromCharCode(0)),
    )
  );
}

function processPermissions(stateDir: string): ProcessPermission[] {
  try {
    const file = path.join(stateDir, "native-process-policy.json");
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_POLICY_BYTES) throw new Error();
    const policy = JSON.parse(readFileSync(file, "utf8"));
    if (
      policy?.version !== 1 ||
      !Array.isArray(policy.commands) ||
      policy.commands.length === 0 ||
      policy.commands.length > 64
    )
      throw new Error();
    for (const item of policy.commands) {
      if (
        !item ||
        typeof item.botId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/u.test(item.botId) ||
        typeof item.cwd !== "string" ||
        item.cwd.length > 4096 ||
        !validArgv(item.argv) ||
        !path.win32.isAbsolute(item.argv[0]!) ||
        !/^[a-zA-Z]:/u.test(item.argv[0]!) ||
        !item.argv[0].toLowerCase().endsWith(".exe")
      )
        throw new Error();
    }
    return policy.commands;
  } catch {
    throw new Error("Native process execution requires a valid local command policy");
  }
}

/** Pass only OS startup paths, never the daemon's credentials or Node options. */
export function windowsProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = source.SystemRoot || "C:/Windows";
  return {
    SystemRoot: root,
    WINDIR: root,
    PATH: `${path.win32.join(root, "System32")};${root}`,
    ...(source.TEMP ? { TEMP: source.TEMP } : {}),
    ...(source.TMP ? { TMP: source.TMP } : {}),
  };
}

export type WindowsProcessRunner = (
  argv: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<WindowsHostProcessResult>;

function terminateWindowsTree(pid: number | undefined) {
  if (!pid || process.platform !== "win32") return;
  const killer = spawn(
    path.win32.join(process.env.SystemRoot || "C:/Windows", "System32", "taskkill.exe"),
    ["/pid", String(pid), "/t", "/f"],
    {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: windowsProcessEnvironment(process.env),
    },
  );
  killer.on("error", () => undefined);
  killer.unref();
}

export async function runBoundedWindowsProcess(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<WindowsHostProcessResult> {
  if (process.platform !== "win32") throw new Error("Native process execution requires Windows");
  if (!validArgv(argv)) {
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
      env: windowsProcessEnvironment(process.env),
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
    private readonly stateDir: string,
    private readonly runner: WindowsProcessRunner = runBoundedWindowsProcess,
    private readonly enabled = process.env.RAKAZO_WINDOWS_PROCESS_ENABLED === "true",
  ) {
    this.reader = new WindowsHostReadOnlyBackend(stateDir);
  }

  available(): boolean {
    if (process.platform !== "win32" || !this.enabled) return false;
    try {
      return processPermissions(this.stateDir).length > 0;
    } catch {
      return false;
    }
  }

  async execute(botId: string, argv: string[], cwd = ".", timeoutMs = 10_000) {
    if (!this.enabled) throw new Error("Native Windows process execution is not enabled");
    const permitted = processPermissions(this.stateDir).some(
      (item) =>
        item.botId === botId &&
        item.cwd === cwd &&
        JSON.stringify(item.argv) === JSON.stringify(argv),
    );
    if (!permitted) throw new Error("Windows command is not permitted by the local policy");
    const directory = await this.reader.workspaceDirectory(botId, cwd);
    return this.runner(argv, directory, timeoutMs);
  }
}
