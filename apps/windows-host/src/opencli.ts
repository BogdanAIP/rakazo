import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_ACTIONS = 4;
const MAX_ACTIVE_SESSIONS = 32;
// OpenCLI releases inactive owned tabs itself after ten minutes. A longer
// host-side TTL bounds abandoned bearer capabilities without racing that cleanup.
const SESSION_TOKEN_TTL_MS = 30 * 60_000;
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
  // A single connected OpenCLI browser profile is resolved by OpenCLI itself.
  // Multiple profiles without a configured default must fail inside OpenCLI,
  // never guess a signed-in account in the Rakazo backend.
  return Boolean(path.isAbsolute(config.entry) && existsSync(config.entry));
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
        // Keep automation visible to the owner; close only owned sessions after tasks.
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
  private readonly sessions = new Map<string, { botId: string; lastActivity: number }>();

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
        "OpenCLI is unavailable: provide a valid RAKAZO_OPENCLI_ENTRY or install the existing OpenCLI entry",
      );
    }

    // The stdio MCP server currently has no trusted per-chat identity. Mint an
    // unguessable explicit bearer per browser task, instead of sharing botId.
    // Never list capabilities or accept a caller-chosen OpenCLI session name.
    if (request.command === "open") {
      const now = Date.now();
      for (const [token, state] of this.sessions) {
        if (now - state.lastActivity >= SESSION_TOKEN_TTL_MS) {
          this.sessions.delete(token);
          this.observations.delete(token);
        }
      }
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new Error(
          "Too many live browser sessions; close your own session or wait for expiry",
        );
      }
      const sessionToken = randomUUID();
      this.sessions.set(sessionToken, { botId, lastActivity: now });
      return { ok: true, sessionToken };
    }

    const token = request.sessionToken;
    const owned = this.sessions.get(token);
    if (!owned || owned.botId !== botId) {
      throw new Error("Unknown browser session; open a new session first");
    }
    if (Date.now() - owned.lastActivity >= SESSION_TOKEN_TTL_MS) {
      this.sessions.delete(token);
      this.observations.delete(token);
      throw new Error("Browser session expired; open a new session first");
    }
    owned.lastActivity = Date.now();
    const session = "rakazo-" + botId + "-" + token.replace(/-/gu, "");
    const invoke = (...args: string[]) =>
      this.runner(this.config.entry, [
        ...(this.config.profile ? ["--profile", this.config.profile] : []),
        "browser",
        session,
        ...args,
      ]);

    const observe = async (): Promise<BrowserObservation> => {
      const tree = (await invoke("state")).slice(0, MAX_OUTPUT_BYTES);
      const url = (await invoke("get", "url")).trim();
      const title = (await invoke("get", "title")).trim();
      const snapshot = { tree, url, title, elements: parseElements(tree) };
      this.observations.set(token, snapshot);
      return snapshot;
    };

    // No raw eval, arbitrary tab ownership, or shell execution exposed here.
    // All three read-only operations use this task's server-minted session.
    if (request.command === "find") {
      const content = await invoke(
        "find",
        "--css",
        request.css,
        "--limit",
        "20",
        "--text-max",
        "120",
      );
      return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
    }
    if (request.command === "wait") {
      const content = await invoke(
        "wait",
        request.kind,
        request.value,
        "--timeout",
        String(request.timeoutMs ?? 9_000),
      );
      return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
    }
    if (request.command === "extract") {
      const options = ["--chunk-size", "16000"];
      if (request.selector) options.push("--selector", request.selector);
      if (request.start !== undefined) options.push("--start", String(request.start));
      const content = await invoke("extract", ...options);
      return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
    }
    if (request.command === "close") {
      // An explicit token is required: no global window/profile/tab cleanup.
      // OpenCLI may retain its OWN reusable blank tab; never remove or ungroup
      // Chrome tabs by their visible group name, which is not proof of ownership.
      await invoke("close");
      this.observations.delete(token);
      this.sessions.delete(token);
      return { ok: true };
    }

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
    const previous = this.observations.get(token);
    if (!previous) throw new Error("Observe this browser session before acting");
    let completed = 0;
    try {
      for (const action of request.actions) {
        const current = await observe();
        const expected = previous.elements.find((element) => element.ref === action.ref);
        const actual = current.elements.find((element) => action.ref === element.ref);
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
      this.observations.delete(token);
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
