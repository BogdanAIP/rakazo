import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";
import type { WindowsBrowserBackend } from "./browser-backend.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_ACTIONS = 4;
const MAX_ACTIVE_SESSIONS = 32;
const MAX_OWNED_TABS = 8;
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

/**
 * Isolate an OpenCLI browser invocation from a stale global OPENCLI_PROFILE.
 * Rakazo uses --profile only when the owner explicitly sets
 * RAKAZO_OPENCLI_PROFILE; otherwise OpenCLI should select its connected
 * default or fail on ambiguity, not silently reuse an outdated environment ID.
 */
export function openCliChildEnvironment(
  argv: string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...source,
    OPENCLI_BROWSER_COMMAND_TIMEOUT: "10",
    // Keep automation visible to the owner; close only owned sessions after tasks.
    OPENCLI_WINDOW: source.RAKAZO_OPENCLI_WINDOW?.trim() || "foreground",
  };
  const profileArgument = argv.indexOf("--profile");
  if (profileArgument >= 0) {
    const selected = argv[profileArgument + 1]?.trim();
    if (!selected) throw new Error("Missing explicitly configured OpenCLI profile");
    childEnv.OPENCLI_PROFILE = selected;
  } else {
    delete childEnv.OPENCLI_PROFILE;
  }
  return childEnv;
}

export async function runOpenCliProcess(entry: string, argv: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: openCliChildEnvironment(argv),
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

interface BrowserSessionState {
  botId: string;
  lastActivity: number;
  ownedPages: Set<string>;
}

function parseOpenCliPageId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { page?: unknown };
    if (typeof parsed.page !== "string") return undefined;
    const pageId = parsed.page.trim();
    if (!pageId || pageId.length > 256) return undefined;
    return pageId;
  } catch {
    return undefined;
  }
}

function browserSessionName(botId: string, token: string): string {
  return `rakazo-${botId}-${token.replace(/-/gu, "")}`;
}

function parseOpenCliPageIds(output: string): string[] | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const seen = new Set<string>();
    const pageIds: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || !("page" in entry)) return undefined;
      const page = (entry as { page?: unknown }).page;
      if (typeof page !== "string") return undefined;
      const pageId = page.trim();
      if (!pageId || pageId.length > 256 || seen.has(pageId)) return undefined;
      seen.add(pageId);
      pageIds.push(pageId);
    }
    return pageIds;
  } catch {
    return undefined;
  }
}

function parseStateOutput(output: string): { tree: string; url?: string } {
  const match = /^URL:\s*(.+?)(?:\r?\n|$)/u.exec(output);
  if (!match) return { tree: output.slice(0, MAX_OUTPUT_BYTES) };

  let url: string | undefined;
  try {
    const parsed = new URL(match[1]!.trim());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      url = parsed.href.slice(0, 4_096);
    }
  } catch {
    // Unknown/legacy state format: preserve the tree and let observe() fall
    // back to the explicit get-url command below.
  }

  const tree = output
    .slice(match[0].length)
    .replace(/^\r?\n/u, "")
    .slice(0, MAX_OUTPUT_BYTES);
  return { tree, ...(url ? { url } : {}) };
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
export class WindowsOpenCliBackend implements WindowsBrowserBackend {
  private readonly observations = new Map<string, BrowserObservation>();
  private readonly sessions = new Map<string, BrowserSessionState>();

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
      this.sessions.set(sessionToken, { botId, lastActivity: now, ownedPages: new Set<string>() });
      return { ok: true, sessionToken };
    }

    const token = request.sessionToken;
    const session = browserSessionName(botId, token);
    const invoke = (...args: string[]) =>
      this.runner(this.config.entry, [
        ...(this.config.profile ? ["--profile", this.config.profile] : []),
        "browser",
        session,
        ...args,
      ]);

    if (request.command === "recover") {
      const now = Date.now();
      const existing = this.sessions.get(token);
      if (existing) {
        if (existing.botId !== botId) {
          throw new Error("Unknown browser session; open a new session first");
        }
        if (now - existing.lastActivity >= SESSION_TOKEN_TTL_MS) {
          this.sessions.delete(token);
          this.observations.delete(token);
          return { ok: false, error: "Browser session expired; open a new session first" };
        }
        existing.lastActivity = now;
        return { ok: true, sessionToken: token, pageIds: [...existing.ownedPages] };
      }

      for (const [existingToken, state] of this.sessions) {
        if (now - state.lastActivity >= SESSION_TOKEN_TTL_MS) {
          this.sessions.delete(existingToken);
          this.observations.delete(existingToken);
        }
      }
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new Error(
          "Too many live browser sessions; close your own session or wait for expiry",
        );
      }

      let listed: string;
      try {
        listed = await invoke("tab", "list");
      } catch {
        return { ok: false, error: "Browser session recovery failed" };
      }
      const pageIds = parseOpenCliPageIds(listed);
      if (!pageIds) {
        return { ok: false, error: "OpenCLI returned an invalid tab list during recovery" };
      }
      if (pageIds.length === 0) {
        return {
          ok: false,
          error: "No recoverable owned browser tabs found for this session token",
        };
      }
      if (pageIds.length > MAX_OWNED_TABS) {
        return { ok: false, error: "OpenCLI returned too many tabs for safe recovery" };
      }

      this.sessions.set(token, {
        botId,
        lastActivity: now,
        ownedPages: new Set(pageIds),
      });
      this.observations.delete(token);
      return { ok: true, sessionToken: token, pageIds };
    }

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
    const rememberPage = (output: string): string | undefined => {
      const pageId = parseOpenCliPageId(output);
      if (pageId) owned.ownedPages.add(pageId);
      return pageId;
    };

    const observe = async (): Promise<BrowserObservation> => {
      const state = parseStateOutput((await invoke("state")).slice(0, MAX_OUTPUT_BYTES));
      const url = (state.url ?? (await invoke("get", "url")).trim()).slice(0, 4_096);
      const title = (await invoke("get", "title")).trim().slice(0, 2_048);
      const snapshot = { tree: state.tree, url, title, elements: parseElements(state.tree) };
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
    if (request.command === "scroll") {
      // Scrolling can trigger lazy rendering. Drop refs before the command so
      // a timeout/uncertain outcome can never leave a trusted stale snapshot.
      this.observations.delete(token);
      await invoke("scroll", request.direction, "--amount", String(request.amount ?? 500));
      return { ok: true };
    }
    if (request.command === "screenshot") {
      const screenshotPath = path.join(os.tmpdir(), `rakazo-opencli-${randomUUID()}.png`);
      if (request.annotate) {
        // OpenCLI annotation refreshes DOM refs internally. Never retain refs
        // minted before that refresh.
        this.observations.delete(token);
      }
      try {
        const options = [screenshotPath];
        if (request.annotate) options.push("--annotate");
        if (request.width !== undefined) options.push("--width", String(request.width));
        if (request.height !== undefined) options.push("--height", String(request.height));
        await invoke("screenshot", ...options);
        const imageInfo = await stat(screenshotPath);
        if (imageInfo.size === 0 || imageInfo.size > MAX_SCREENSHOT_BYTES) {
          throw new Error("OpenCLI screenshot exceeded the 4 MiB PNG limit");
        }
        const image = await readFile(screenshotPath);
        if (image.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX) {
          throw new Error("OpenCLI screenshot did not produce a PNG");
        }
        return {
          ok: true,
          imageBase64: image.toString("base64"),
          mimeType: "image/png",
        };
      } finally {
        await unlink(screenshotPath).catch(() => undefined);
      }
    }
    if (request.command === "tabNew") {
      if (owned.ownedPages.size >= MAX_OWNED_TABS) {
        throw new Error("Too many owned browser tabs in this session");
      }
      let targetUrl: string | undefined;
      if (request.url) {
        const parsed = new URL(request.url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Only HTTP(S) browser navigation is allowed");
        }
        targetUrl = parsed.href;
      }
      this.observations.delete(token);
      try {
        const output = await invoke("tab", "new", ...(targetUrl ? [targetUrl] : []));
        const pageId = rememberPage(output);
        if (!pageId) {
          return {
            ok: false,
            uncertain: true,
            error: "OpenCLI created a tab but did not return a valid page identity",
          };
        }
        return { ok: true, pageId };
      } catch (error) {
        return {
          ok: false,
          uncertain: true,
          error:
            error instanceof Error ? error.message.slice(0, 500) : "Browser tab creation failed",
        };
      }
    }
    if (request.command === "tabSelect") {
      if (!owned.ownedPages.has(request.pageId)) {
        throw new Error("Unknown browser tab for this session");
      }
      this.observations.delete(token);
      try {
        await invoke("tab", "select", request.pageId);
        return { ok: true, pageId: request.pageId };
      } catch (error) {
        return {
          ok: false,
          uncertain: true,
          error:
            error instanceof Error ? error.message.slice(0, 500) : "Browser tab selection failed",
        };
      }
    }
    if (request.command === "tabClose") {
      if (!owned.ownedPages.has(request.pageId)) {
        throw new Error("Unknown browser tab for this session");
      }
      this.observations.delete(token);
      try {
        await invoke("tab", "close", request.pageId);
        owned.ownedPages.delete(request.pageId);
        return { ok: true, pageId: request.pageId };
      } catch (error) {
        // A failed/uncertain close must not leave a reusable ownership grant.
        // The whole owned OpenCLI session can still be closed safely later.
        owned.ownedPages.delete(request.pageId);
        return {
          ok: false,
          uncertain: true,
          error: error instanceof Error ? error.message.slice(0, 500) : "Browser tab close failed",
        };
      }
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
      const opened = await invoke("open", url.href);
      const pageId = rememberPage(opened);
      return { ok: true, ...(pageId ? { pageId } : {}), ...(await observe()) };
    }
    if (request.command === "snapshot") {
      return { ok: true, ...(await observe()) };
    }
    if (request.command === "playwright") {
      return {
        ok: false,
        error: "Raw Playwright CLI commands require a Playwright browser backend",
      };
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
