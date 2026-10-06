import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";
import type { WindowsBrowserBackend } from "./browser-backend.js";
import type { PlaywrightCliConfiguration } from "./playwright-cli-config.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const COMMAND_TIMEOUT_MS = 12_000;
const ATTACH_TIMEOUT_MS = 25_000;
const MAX_ACTIONS = 4;
const MAX_ACTIVE_SESSIONS = 32;
const MAX_TABS = 8;
const SESSION_TOKEN_TTL_MS = 30 * 60_000;
const SAFE_BOT_ID = /^[a-zA-Z0-9_-]{1,100}$/u;

interface BrowserElement {
  ref: string;
  role: string;
  name: string;
}

interface BrowserTab {
  index: number;
  current: boolean;
  title: string;
  url: string;
  pageId: string;
}

interface BrowserObservation {
  url: string;
  title: string;
  tree: string;
  elements: BrowserElement[];
  pageId?: string;
  pageIds: string[];
}

interface PlaywrightCliSessionState {
  botId: string;
  lastActivity: number;
  backendReady: boolean;
  tabs: Map<string, BrowserTab>;
  observation?: BrowserObservation;
}

interface PlaywrightCliJson {
  isError?: boolean;
  error?: string;
  result?: unknown;
  snapshot?: unknown;
  browsers?: unknown;
}

interface SnapshotAnnotation {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PlaywrightCliRunner = (
  entry: string,
  argv: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<string>;

export type PlaywrightTextFileReader = (filePath: string) => Promise<string>;

export async function resolveWindowsDevToolsActivePortEndpoint(
  channel: "chrome" | "msedge",
  localAppData: string | undefined = process.env.LOCALAPPDATA,
  readText: PlaywrightTextFileReader = async (filePath) => readFile(filePath, "utf8"),
): Promise<string | null> {
  if (!localAppData) return null;
  const userDataDir =
    channel === "chrome"
      ? path.join(localAppData, "Google", "Chrome", "User Data")
      : path.join(localAppData, "Microsoft", "Edge", "User Data");
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");

  let raw: string;
  try {
    raw = await readText(activePortFile);
  } catch {
    return null;
  }

  const [portLine, browserPath] = raw.split(/\r?\n/u);
  const port = Number(portLine);
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !browserPath ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath.trim())
  ) {
    return null;
  }
  return `ws://127.0.0.1:${port}${browserPath.trim()}`;
}

async function terminateChildTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

export function playwrightCliNodeOptions(
  existing: string | undefined = process.env.NODE_OPTIONS,
): string {
  const ipv4First = "--dns-result-order=ipv4first";
  const preserved = existing?.replace(/(?:^|\s)--dns-result-order=\S+/gu, " ").trim();
  return preserved ? `${preserved} ${ipv4First}` : ipv4First;
}

export async function runPlaywrightCliProcess(
  entry: string,
  argv: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
  await mkdir(path.join(cwd, ".playwright"), { recursive: true });
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "--json", ...argv], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Playwright's Extension relay binds to "localhost". On Windows hosts where
        // localhost resolves to an unusable ::1 first, Chrome cannot reach the relay.
        // Force IPv4 resolution for the CLI and its detached daemon while preserving
        // any unrelated NODE_OPTIONS inherited from the host.
        NODE_OPTIONS: playwrightCliNodeOptions(),
        PLAYWRIGHT_MCP_WEBMCP: "true",
        PLAYWRIGHT_MCP_CODEGEN: "typescript",
        PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: "true",
        PLAYWRIGHT_MCP_FILE_PATHS: "absolute",
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
        void terminateChildTree(child.pid).finally(() =>
          finish(new Error("Playwright CLI output exceeded the 64 KiB limit")),
        );
        return;
      }
      if (stderr) errors += buffer.toString("utf8");
      else output += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      void terminateChildTree(child.pid).finally(() =>
        finish(new Error("Playwright CLI command timed out; action outcome is uncertain")),
      );
    }, timeoutMs);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = output.trim() || errors.trim();
        finish(
          new Error(`Playwright CLI exited with code ${String(code)}: ${detail.slice(0, 500)}`),
        );
      } else finish();
    });
  });
}

function modeSlug(mode: PlaywrightCliConfiguration["mode"]): string {
  switch (mode) {
    case "playwright-cli-extension":
      return "ext";
    case "playwright-cli-cdp":
      return "cdp";
    case "playwright-cli-persistent":
      return "persist";
    default:
      return "unknown";
  }
}

function browserSessionName(
  mode: PlaywrightCliConfiguration["mode"],
  botId: string,
  token: string,
): string {
  const botHash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `rakazo-pw-${modeSlug(mode)}-${botHash}-${token.replace(/-/gu, "")}`;
}

function parseJson(output: string): PlaywrightCliJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Playwright CLI returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Playwright CLI returned an invalid JSON envelope");
  }
  const value = parsed as PlaywrightCliJson;
  if (value.isError) {
    throw new Error(
      typeof value.error === "string" ? value.error.slice(0, 500) : "Playwright CLI command failed",
    );
  }
  return value;
}

function snapshotTree(snapshot: unknown): string {
  return JSON.stringify(snapshot ?? [], null, 2).slice(0, MAX_OUTPUT_BYTES);
}

function snapshotElements(snapshot: unknown): BrowserElement[] {
  const result: BrowserElement[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (result.length >= 500) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const ref = typeof record.ref === "string" ? record.ref : undefined;
    if (ref && /^e\d{1,6}$/u.test(ref) && !seen.has(ref)) {
      seen.add(ref);
      result.push({
        ref,
        role: typeof record.role === "string" ? record.role.slice(0, 200) : "element",
        name: typeof record.name === "string" ? record.name.slice(0, 200) : "element",
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(snapshot);
  return result;
}

function tabPageId(index: number, title: string, url: string): string {
  const digest = createHash("sha256")
    .update(String(index))
    .update("\0")
    .update(title)
    .update("\0")
    .update(url)
    .digest("hex")
    .slice(0, 12);
  return `pw-${index}-${digest}`;
}

function parseTabs(result: unknown): BrowserTab[] {
  if (typeof result !== "string") throw new Error("Playwright CLI returned an invalid tab list");
  const tabs: BrowserTab[] = [];
  for (const rawLine of result.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^- (\d+): (?:(\(current\)) )?\[(.*)\]\((.*)\)$/u.exec(line);
    if (!match) throw new Error("Playwright CLI returned an unrecognized tab list");
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index > 1_000) {
      throw new Error("Playwright CLI returned an invalid tab index");
    }
    const title = (match[3] ?? "").slice(0, 2_048);
    const url = (match[4] ?? "").slice(0, 4_096);
    tabs.push({
      index,
      current: Boolean(match[2]),
      title,
      url,
      pageId: tabPageId(index, title, url),
    });
  }
  if (tabs.length > MAX_TABS) throw new Error("Playwright CLI returned too many tabs");
  return tabs;
}

function snapshotAnnotations(snapshot: unknown): SnapshotAnnotation[] {
  const annotations: SnapshotAnnotation[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (annotations.length >= 80) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const ref = typeof record.ref === "string" ? record.ref : undefined;
    const box =
      record.box && typeof record.box === "object" && !Array.isArray(record.box)
        ? (record.box as Record<string, unknown>)
        : undefined;
    if (
      ref &&
      /^e\d{1,6}$/u.test(ref) &&
      box &&
      !seen.has(ref) &&
      [box.x, box.y, box.width, box.height].every(
        (part) => typeof part === "number" && Number.isFinite(part),
      )
    ) {
      const x = Number(box.x);
      const y = Number(box.y);
      const width = Number(box.width);
      const height = Number(box.height);
      if (
        width > 0 &&
        height > 0 &&
        Math.abs(x) <= 100_000 &&
        Math.abs(y) <= 100_000 &&
        width <= 100_000 &&
        height <= 100_000
      ) {
        seen.add(ref);
        annotations.push({ ref, x, y, width, height });
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(snapshot);
  return annotations;
}

function annotationOverlayScript(annotations: SnapshotAnnotation[]): string {
  const data = JSON.stringify(annotations);
  return `() => {
    document.querySelectorAll('[data-rakazo-annotation-root]').forEach((node) => node.remove());
    const data = ${data};
    const root = document.createElement('div');
    root.setAttribute('data-rakazo-annotation-root', '1');
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    for (const item of data) {
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'fixed',
        left: item.x + 'px',
        top: item.y + 'px',
        width: item.width + 'px',
        height: item.height + 'px',
        border: '2px solid #ff2d55',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      });
      const label = document.createElement('span');
      label.textContent = item.ref;
      Object.assign(label.style, {
        position: 'absolute',
        left: '-2px',
        top: '-18px',
        padding: '1px 4px',
        background: '#ff2d55',
        color: '#fff',
        font: '12px/16px monospace',
        whiteSpace: 'nowrap',
      });
      box.appendChild(label);
      root.appendChild(box);
    }
    document.documentElement.appendChild(root);
    return data.length;
  }`;
}

const REMOVE_ANNOTATION_OVERLAY_SCRIPT =
  "() => document.querySelectorAll('[data-rakazo-annotation-root]').forEach((node) => node.remove())";

function listedBrowsers(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Playwright CLI implementation of the existing Windows browser-session contract.
 *
 * The public surface remains Rakazo computer/browser. Raw Playwright eval,
 * WebMCP, storage/network mutation and arbitrary uploads are not projected as
 * implicit capabilities here.
 */
export class WindowsPlaywrightCliBackend implements WindowsBrowserBackend {
  private readonly sessions = new Map<string, PlaywrightCliSessionState>();

  constructor(
    private readonly config: PlaywrightCliConfiguration,
    private readonly stateDir: string,
    private readonly runner: PlaywrightCliRunner = runPlaywrightCliProcess,
  ) {}

  available(): boolean {
    if (
      !this.config.entry ||
      (!path.isAbsolute(this.config.entry) && !path.win32.isAbsolute(this.config.entry)) ||
      !existsSync(this.config.entry)
    ) {
      return false;
    }
    if (this.config.mode === "playwright-cli-cdp") {
      return Boolean(this.config.cdpEndpoint || this.config.browserChannel);
    }
    if (this.config.mode === "playwright-cli-extension") {
      return Boolean(this.config.browserChannel);
    }
    if (this.config.mode === "playwright-cli-persistent") return Boolean(this.config.userDataDir);
    return false;
  }

  async browser(
    botId: string,
    request: WindowsHostBrowserRequest,
  ): Promise<WindowsHostBrowserResult> {
    if (!SAFE_BOT_ID.test(botId)) throw new Error("Invalid browser bot identity");
    if (!this.available()) throw new Error("Configured Playwright CLI backend is unavailable");

    if (request.command === "open") {
      await this.cleanupExpired();
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new Error(
          "Too many live browser sessions; close your own session or wait for expiry",
        );
      }
      const sessionToken = randomUUID();
      this.sessions.set(sessionToken, {
        botId,
        lastActivity: Date.now(),
        backendReady: false,
        tabs: new Map(),
      });
      return { ok: true, sessionToken };
    }

    if (request.command === "recover") {
      return this.recover(botId, request.sessionToken);
    }

    const state = this.sessions.get(request.sessionToken);
    if (!state || state.botId !== botId) throw new Error("Unknown browser session; open first");
    if (Date.now() - state.lastActivity >= SESSION_TOKEN_TTL_MS) {
      this.sessions.delete(request.sessionToken);
      throw new Error("Browser session expired; open a new session first");
    }
    state.lastActivity = Date.now();

    const session = browserSessionName(this.config.mode, botId, request.sessionToken);

    if (request.command === "close") {
      try {
        if (state.backendReady) {
          if (
            this.config.mode === "playwright-cli-cdp" ||
            this.config.mode === "playwright-cli-extension"
          ) {
            parseJson(await this.invoke(session, ["detach"]));
          } else {
            parseJson(await this.invoke(session, ["close"]));
          }
        }
      } finally {
        this.sessions.delete(request.sessionToken);
      }
      return { ok: true };
    }

    await this.ensureBackendSession(session, state);

    if (request.command === "playwright") {
      state.observation = undefined;
      const payload = parseJson(
        await this.invoke(session, request.argv, request.timeoutMs ?? COMMAND_TIMEOUT_MS),
      );
      const value = payload.result ?? payload.snapshot ?? payload.browsers ?? payload;
      const content =
        typeof value === "string" ? value : JSON.stringify(value ?? null);

      const rawCommand = request.argv[0]?.toLowerCase();
      if (rawCommand === "close" || rawCommand === "detach" || rawCommand === "delete-data") {
        state.backendReady = false;
        state.tabs.clear();
      } else if (rawCommand === "close-all" || rawCommand === "kill-all") {
        this.sessions.clear();
      }

      return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
    }

    if (request.command === "navigate") {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Only HTTP(S) browser navigation is allowed");
      }
      state.observation = undefined;
      parseJson(await this.invoke(session, ["goto", url.href]));
      return { ok: true, ...(await this.observe(session, state)) };
    }

    if (request.command === "snapshot") {
      return { ok: true, ...(await this.observe(session, state)) };
    }

    if (request.command === "find") {
      try {
        const payload = parseJson(await this.invoke(session, ["snapshot", request.css]));
        return { ok: true, content: snapshotTree(payload.snapshot) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 500) : "Browser find failed",
        };
      }
    }

    if (request.command === "wait") {
      return this.waitFor(session, request.kind, request.value, request.timeoutMs ?? 9_000);
    }

    if (request.command === "extract") {
      const args = request.selector
        ? ["eval", '(element) => element.innerText || element.textContent || ""', request.selector]
        : ["eval", '() => document.body.innerText || ""'];
      const payload = parseJson(await this.invoke(session, args));
      const content = typeof payload.result === "string" ? payload.result : "";
      const start = request.start ?? 0;
      return { ok: true, content: content.slice(start, start + MAX_OUTPUT_BYTES) };
    }

    if (request.command === "scroll") {
      state.observation = undefined;
      const amount = request.amount ?? 500;
      const deltaY = request.direction === "down" ? amount : -amount;
      parseJson(await this.invoke(session, ["mousewheel", "0", String(deltaY)]));
      return { ok: true };
    }

    if (request.command === "screenshot") {
      return this.screenshot(session, state, request);
    }

    if (request.command === "tabNew") {
      state.observation = undefined;
      const args = ["tab-new"];
      if (request.url) {
        const url = new URL(request.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error("Only HTTP(S) browser navigation is allowed");
        }
        args.push(url.href);
      }
      parseJson(await this.invoke(session, args));
      const tabs = await this.refreshTabs(session, state);
      const current = tabs.find((tab) => tab.current);
      if (!current) {
        return {
          ok: false,
          uncertain: true,
          error: "Playwright created a tab but lost current-tab identity",
        };
      }
      return { ok: true, pageId: current.pageId, pageIds: tabs.map((tab) => tab.pageId) };
    }

    if (request.command === "tabSelect") {
      const tab = await this.requireFreshTab(session, state, request.pageId);
      state.observation = undefined;
      parseJson(await this.invoke(session, ["tab-select", String(tab.index)]));
      const tabs = await this.refreshTabs(session, state);
      const selected = tabs.find((candidate) => candidate.current);
      if (!selected || selected.url !== tab.url || selected.title !== tab.title) {
        return {
          ok: false,
          uncertain: true,
          error: "Playwright selected a different tab than requested",
        };
      }
      return {
        ok: true,
        pageId: selected.pageId,
        pageIds: tabs.map((candidate) => candidate.pageId),
      };
    }

    if (request.command === "tabClose") {
      const tab = await this.requireFreshTab(session, state, request.pageId);
      state.observation = undefined;
      try {
        parseJson(await this.invoke(session, ["tab-close", String(tab.index)]));
        const tabs = await this.refreshTabs(session, state);
        return {
          ok: true,
          pageId: request.pageId,
          pageIds: tabs.map((candidate) => candidate.pageId),
        };
      } catch (error) {
        state.tabs.delete(request.pageId);
        return {
          ok: false,
          uncertain: true,
          error: error instanceof Error ? error.message.slice(0, 500) : "Browser tab close failed",
        };
      }
    }

    if (request.actions.length > MAX_ACTIONS) {
      throw new Error("At most four browser actions may be executed per command");
    }
    const previous = state.observation;
    if (!previous) throw new Error("Observe this browser session before acting");

    let completed = 0;
    let mutationStarted = false;
    try {
      for (const action of request.actions) {
        const current = await this.observe(session, state);
        const expected = previous.elements.find((element) => element.ref === action.ref);
        const actual = current.elements.find((element) => element.ref === action.ref);
        if (
          !expected ||
          !actual ||
          expected.role !== actual.role ||
          expected.name !== actual.name ||
          current.url !== previous.url ||
          current.pageId !== previous.pageId
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

        mutationStarted = true;
        if (action.kind === "click") {
          parseJson(await this.invoke(session, ["click", action.ref]));
        } else if (action.kind === "fill") {
          parseJson(await this.invoke(session, ["fill", action.ref, action.text]));
        } else {
          parseJson(await this.invoke(session, ["click", action.ref]));
          parseJson(await this.invoke(session, ["type", action.text]));
        }
        completed += 1;
        mutationStarted = false;
      }
      return { ok: true, completed, ...(await this.observe(session, state)) };
    } catch (error) {
      state.observation = undefined;
      return {
        ok: false,
        completed,
        uncertain:
          completed > 0 ||
          mutationStarted ||
          (error instanceof Error && /outcome is uncertain/u.test(error.message)),
        error: error instanceof Error ? error.message.slice(0, 500) : "Browser action failed",
      };
    }
  }

  private workspaceDir() {
    return path.join(this.stateDir, "playwright-cli");
  }

  private invoke(session: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
    return this.runner(
      this.config.entry!,
      [`-s=${session}`, ...args],
      this.workspaceDir(),
      timeoutMs,
    );
  }

  private invokeGlobal(args: string[]) {
    return this.runner(this.config.entry!, args, this.workspaceDir(), COMMAND_TIMEOUT_MS);
  }

  private async ensureBackendSession(session: string, state: PlaywrightCliSessionState) {
    if (state.backendReady) return;

    if (this.config.mode === "playwright-cli-cdp") {
      const discoveredEndpoint = this.config.browserChannel
        ? await resolveWindowsDevToolsActivePortEndpoint(this.config.browserChannel)
        : null;
      const cdpTarget = this.config.cdpEndpoint ?? discoveredEndpoint ?? this.config.browserChannel;
      if (!cdpTarget) throw new Error("Playwright CDP endpoint or browser channel is missing");
      try {
        parseJson(await this.invoke(session, ["attach", `--cdp=${cdpTarget}`], ATTACH_TIMEOUT_MS));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/iu.test(message)) {
          throw new Error(
            "Playwright CDP attach timed out. Existing-profile Chrome remote debugging can stall on discarded background tabs; retry after reactivating those tabs, or use Extension/Persistent mode.",
          );
        }
        throw error;
      }
    } else if (this.config.mode === "playwright-cli-extension") {
      if (!this.config.browserChannel) throw new Error("Playwright browser channel is missing");
      parseJson(
        await this.invoke(
          session,
          ["attach", `--extension=${this.config.browserChannel}`],
          ATTACH_TIMEOUT_MS,
        ),
      );
    } else if (this.config.mode === "playwright-cli-persistent") {
      if (!this.config.userDataDir) throw new Error("Playwright user-data directory is missing");
      const args = ["open", "about:blank", `--profile=${this.config.userDataDir}`];
      if (this.config.browserChannel) args.push(`--browser=${this.config.browserChannel}`);
      parseJson(await this.invoke(session, args, ATTACH_TIMEOUT_MS));
    } else {
      throw new Error("Playwright CLI backend is not selected");
    }

    state.backendReady = true;
    await this.refreshTabs(session, state);
  }

  private async recover(botId: string, sessionToken: string): Promise<WindowsHostBrowserResult> {
    const existing = this.sessions.get(sessionToken);
    if (existing) {
      if (existing.botId !== botId) throw new Error("Unknown browser session");
      if (Date.now() - existing.lastActivity >= SESSION_TOKEN_TTL_MS) {
        this.sessions.delete(sessionToken);
        return { ok: false, error: "Browser session expired; open a new session first" };
      }
      existing.lastActivity = Date.now();
      return { ok: true, sessionToken, pageIds: [...existing.tabs.keys()] };
    }

    const session = browserSessionName(this.config.mode, botId, sessionToken);
    const listed = parseJson(await this.invokeGlobal(["list"]));
    const match = listedBrowsers(listed.browsers).find(
      (entry) => entry.name === session && entry.status === "open",
    );
    if (!match) return { ok: false, error: "No recoverable Playwright browser session found" };
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new Error("Too many live browser sessions; close your own session or wait for expiry");
    }

    const state: PlaywrightCliSessionState = {
      botId,
      lastActivity: Date.now(),
      backendReady: true,
      tabs: new Map(),
    };
    this.sessions.set(sessionToken, state);
    try {
      const tabs = await this.refreshTabs(session, state);
      return { ok: true, sessionToken, pageIds: tabs.map((tab) => tab.pageId) };
    } catch {
      this.sessions.delete(sessionToken);
      return { ok: false, error: "Recoverable Playwright session could not be reconciled" };
    }
  }

  private rememberTabs(state: PlaywrightCliSessionState, tabs: BrowserTab[]) {
    state.tabs = new Map(tabs.map((tab) => [tab.pageId, tab]));
    return tabs;
  }

  private async refreshTabs(session: string, state: PlaywrightCliSessionState) {
    const payload = parseJson(await this.invoke(session, ["tab-list"]));
    return this.rememberTabs(state, parseTabs(payload.result));
  }

  private async requireFreshTab(
    session: string,
    state: PlaywrightCliSessionState,
    pageId: string,
  ): Promise<BrowserTab> {
    const authorized = state.tabs.get(pageId);
    if (!authorized) throw new Error("Unknown or stale browser tab for this session");
    const tabs = await this.refreshTabs(session, state);
    const current = tabs.find((tab) => tab.pageId === pageId);
    if (!current || current.url !== authorized.url || current.title !== authorized.title) {
      throw new Error("Stale browser tab identity; take a fresh snapshot");
    }
    return current;
  }

  private async observe(
    session: string,
    state: PlaywrightCliSessionState,
  ): Promise<BrowserObservation> {
    const before = await this.refreshTabs(session, state);
    const currentBefore = before.find((tab) => tab.current);
    if (!currentBefore) throw new Error("Playwright did not identify a current browser tab");

    const snapshot = parseJson(await this.invoke(session, ["snapshot"]));
    const after = await this.refreshTabs(session, state);
    const currentAfter = after.find((tab) => tab.current);
    if (!currentAfter || currentAfter.pageId !== currentBefore.pageId) {
      state.observation = undefined;
      throw new Error("Browser tab changed during observation; take another snapshot");
    }

    const observation: BrowserObservation = {
      url: currentAfter.url,
      title: currentAfter.title,
      tree: snapshotTree(snapshot.snapshot),
      elements: snapshotElements(snapshot.snapshot),
      pageId: currentAfter.pageId,
      pageIds: after.map((tab) => tab.pageId),
    };
    state.observation = observation;
    return observation;
  }

  private async waitFor(
    session: string,
    kind: "selector" | "text",
    value: string,
    timeoutMs: number,
  ): Promise<WindowsHostBrowserResult> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "Browser wait condition was not met";
    while (Date.now() < deadline) {
      try {
        if (kind === "selector") {
          const payload = parseJson(await this.invoke(session, ["snapshot", value]));
          return { ok: true, content: snapshotTree(payload.snapshot) };
        }
        const payload = parseJson(await this.invoke(session, ["find", value, "--max-results=1"]));
        const content = typeof payload.result === "string" ? payload.result : "";
        if (content && !/^No matches found/iu.test(content.trim())) {
          return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
        }
        lastError = content || lastError;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(200);
    }
    return { ok: false, error: lastError.slice(0, 500) };
  }

  private async screenshot(
    session: string,
    state: PlaywrightCliSessionState,
    request: Extract<WindowsHostBrowserRequest, { command: "screenshot" }>,
  ): Promise<WindowsHostBrowserResult> {
    if ((request.width === undefined) !== (request.height === undefined)) {
      return {
        ok: false,
        error: "Playwright screenshot resizing requires both width and height",
      };
    }
    if (request.width !== undefined && request.height !== undefined) {
      state.observation = undefined;
      parseJson(
        await this.invoke(session, ["resize", String(request.width), String(request.height)]),
      );
    }

    let overlayInstalled = false;
    if (request.annotate) {
      state.observation = undefined;
      const snapshot = parseJson(await this.invoke(session, ["snapshot", "--boxes"]));
      const annotations = snapshotAnnotations(snapshot.snapshot);
      if (annotations.length > 0) {
        parseJson(await this.invoke(session, ["eval", annotationOverlayScript(annotations)]));
        overlayInstalled = true;
      }
    }

    const fileName = `rakazo-playwright-${randomUUID()}.png`;
    const screenshotPath = path.join(this.workspaceDir(), fileName);
    try {
      parseJson(await this.invoke(session, ["screenshot", `--filename=${fileName}`, "--type=png"]));
      const imageInfo = await stat(screenshotPath);
      if (imageInfo.size === 0 || imageInfo.size > MAX_SCREENSHOT_BYTES) {
        throw new Error("Playwright screenshot exceeded the 4 MiB PNG limit");
      }
      const image = await readFile(screenshotPath);
      if (image.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX) {
        throw new Error("Playwright screenshot did not produce a PNG");
      }
      return { ok: true, imageBase64: image.toString("base64"), mimeType: "image/png" };
    } finally {
      await unlink(screenshotPath).catch(() => undefined);
      if (overlayInstalled) {
        try {
          parseJson(await this.invoke(session, ["eval", REMOVE_ANNOTATION_OVERLAY_SCRIPT]));
        } catch {
          // The screenshot itself is already bounded and complete. Drop all
          // observation refs if cleanup could not be confirmed.
          state.observation = undefined;
        }
      }
    }
  }

  private async cleanupExpired() {
    const now = Date.now();
    for (const [token, state] of [...this.sessions]) {
      if (now - state.lastActivity < SESSION_TOKEN_TTL_MS) continue;
      this.sessions.delete(token);
      if (!state.backendReady) continue;
      const session = browserSessionName(this.config.mode, state.botId, token);
      try {
        if (
          this.config.mode === "playwright-cli-cdp" ||
          this.config.mode === "playwright-cli-extension"
        ) {
          await this.invoke(session, ["detach"]);
        } else {
          await this.invoke(session, ["close"]);
        }
      } catch {
        // Playwright's daemon idle timeout remains the final cleanup bound.
      }
    }
  }
}
