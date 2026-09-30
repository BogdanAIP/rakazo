import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_ACTIONS = 4;
const SAFE_BOT_ID = /^[a-zA-Z0-9_-]{1,100}$/u;

export interface OpenCliConfiguration {
  entry: string;
  profile: string;
}

export type OpenCliRunner = (entry: string, argv: string[]) => Promise<string>;

/**
 * Resolve the installed OpenCLI JavaScript entry, not opencli.cmd. Using the
 * current Node executable with argv avoids cmd.exe, PowerShell interpolation
 * and exposing the daemon's protected HTTP endpoint over the network.
 */
export function loadOpenCliConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OpenCliConfiguration {
  const profile = env.RAKAZO_OPENCLI_PROFILE?.trim() ?? "";
  const entry =
    env.RAKAZO_OPENCLI_ENTRY?.trim() ||
    path.join(
      env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "npm",
      "node_modules",
      "@jackwener",
      "opencli",
      "dist",
      "src",
      "main.js",
    );
  return { entry, profile };
}

export function openCliAvailable(config = loadOpenCliConfiguration()): boolean {
  return Boolean(config.profile && path.isAbsolute(config.entry) && existsSync(config.entry));
}

export async function runOpenCliProcess(entry: string, argv: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLI_BROWSER_COMMAND_TIMEOUT: "10",
        OPENCLI_WINDOW: process.env.RAKAZO_OPENCLI_WINDOW?.trim() || "foreground",
      },
    });
    let output = "";
    let errors = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const append = (buffer: Buffer, stderr: boolean) => {
      bytes += buffer.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("OpenCLI output exceeded the 64 KiB limit"));
        return;
      }
      if (stderr) errors += buffer.toString("utf8");
      else output += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("OpenCLI command timed out; action outcome is uncertain"));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`OpenCLI exited with code ${String(code)}: ${errors.slice(0, 500)}`));
      } else finish();
    });
  });
}

interface BrowserObservation {
  url: string;
  title: string;
  tree: string;
  elements: Array<{ ref: string; role: string; name: string }>;
}

function parseElements(tree: string): BrowserObservation["elements"] {
  const seen = new Set<string>();
  const elements: BrowserObservation["elements"] = [];
  for (const line of tree.split(/\r?\n/u)) {
    const match = /^\s*\[(\d{1,6})\]\s*(\S*)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const ref = `e${match[1]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    elements.push({
      ref,
      role: match[2] || "element",
      name: (match[3] || match[2] || "element").slice(0, 200),
    });
  }
  return elements.slice(0, 500);
}

/**
 * A backend of the Rakazo Windows host. It reuses the user's explicit Chrome
 * profile via the installed OpenCLI extension; it is NOT a second public MCP.
 */
export class WindowsOpenCliBackend {
  private readonly observations = new Map<string, BrowserObservation>();

  constructor(
    private readonly config: OpenCliConfiguration = loadOpenCliConfiguration(),
    private readonly runner: OpenCliRunner = runOpenCliProcess,
  ) {}

  available(): boolean {
    return openCliAvailable(this.config);
  }

  async browser(
    botId: string,
    request: WindowsHostBrowserRequest,
  ): Promise<WindowsHostBrowserResult> {
    if (!SAFE_BOT_ID.test(botId)) throw new Error("Invalid browser bot identity");
    if (!this.available()) {
      throw new Error(
        "OpenCLI is unavailable: set RAKAZO_OPENCLI_PROFILE and a valid RAKAZO_OPENCLI_ENTRY",
      );
    }
    const session = `rakazo-${botId}`;
    const invoke = (...args: string[]) =>
      this.runner(this.config.entry, [
        "--profile",
        this.config.profile,
        "browser",
        session,
        ...args,
      ]);

    const observe = async (): Promise<BrowserObservation> => {
      const tree = (await invoke("state")).slice(0, MAX_OUTPUT_BYTES);
      const url = (await invoke("get", "url")).trim();
      const title = (await invoke("get", "title")).trim();
      const snapshot = { tree, url, title, elements: parseElements(tree) };
      this.observations.set(botId, snapshot);
      return snapshot;
    };

    if (request.command === "navigate") {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only HTTP(S) browser navigation is allowed");
      }
      await invoke("open", url.href);
      return { ok: true, ...(await observe()) };
    }
    if (request.command === "snapshot") {
      return { ok: true, ...(await observe()) };
    }

    if (request.actions.length > MAX_ACTIONS) {
      throw new Error("At most four browser actions may be executed per command");
    }
    const previous = this.observations.get(botId);
    if (!previous) throw new Error("Observe this browser session before acting");
    let completed = 0;
    try {
      for (const action of request.actions) {
        const current = await observe();
        const expected = previous.elements.find((element) => element.ref === action.ref);
        const actual = current.elements.find((element) => element.ref === action.ref);
        if (
          !expected ||
          !actual ||
          expected.role !== actual.role ||
          expected.name !== actual.name ||
          current.url !== previous.url
        ) {
          throw new Error("Stale browser reference; take a fresh snapshot");
        }
        if (
          action.kind !== "click" &&
          action.origin &&
          new URL(current.url).origin !== action.origin
        ) {
          throw new Error("Browser origin changed; action rejected");
        }
        const target = action.ref.slice(1);
        if (action.kind === "click") await invoke("click", target);
        else await invoke(action.kind, target, action.text);
        completed += 1;
      }
      return { ok: true, completed, ...(await observe()) };
    } catch (error) {
      this.observations.delete(botId);
      return {
        ok: false,
        completed,
        uncertain:
          completed > 0 || (error instanceof Error && /outcome is uncertain/u.test(error.message)),
        error: error instanceof Error ? error.message.slice(0, 500) : "Browser action failed",
      };
    }
  }
}
