import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const MAX_ACTIVE_SESSIONS = 32;
const SESSION_TOKEN_TTL_MS = 30 * 60_000;
const SAFE_BOT_ID = /^[a-zA-Z0-9_-]{1,100}$/u;

interface PlaywrightCliSessionState {
  botId: string;
  lastActivity: number;
  backendReady: boolean;
}

interface PlaywrightCliJson {
  isError?: boolean;
  error?: string;
  result?: unknown;
  snapshot?: unknown;
  browsers?: unknown;
}

export type PlaywrightCliRunner = (
  entry: string,
  argv: string[],
  cwd: string,
) => Promise<string>;

export async function runPlaywrightCliProcess(
  entry: string,
  argv: string[],
  cwd: string,
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
        PLAYWRIGHT_MCP_WEBMCP: "false",
        PLAYWRIGHT_MCP_CODEGEN: "none",
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
        finish(new Error("Playwright CLI output exceeded the 64 KiB limit"));
        return;
      }
      if (stderr) errors += buffer.toString("utf8");
      else output += buffer.toString("utf8");
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Playwright CLI command timed out"));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (buffer: Buffer) => append(buffer, false));
    child.stderr.on("data", (buffer: Buffer) => append(buffer, true));
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = output.trim() || errors.trim();
        finish(
          new Error(
            `Playwright CLI exited with code ${String(code)}: ${detail.slice(0, 500)}`,
          ),
        );
      } else finish();
    });
  });
}

function browserSessionName(botId: string, token: string): string {
  return `rakazo-${botId}-${token.replace(/-/gu, "")}`;
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

function snapshotElements(snapshot: unknown): Array<{ ref: string; role: string; name: string }> {
  const result: Array<{ ref: string; role: string; name: string }> = [];
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

function currentTabMetadata(result: unknown): { url: string; title: string } {
  if (typeof result !== "string") return { url: "", title: "" };
  const line = result
    .split(/\r?\n/u)
    .find((candidate) => /^- \d+: \(current\) /u.test(candidate.trim()));
  if (!line) return { url: "", title: "" };
  const match = /^- \d+: \(current\) \[(.*)\]\((.*)\)$/u.exec(line.trim());
  if (!match) return { url: "", title: "" };
  return {
    title: (match[1] ?? "").slice(0, 2_048),
    url: (match[2] ?? "").slice(0, 4_096),
  };
}

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
 * Bounded Playwright CLI implementation of the existing Windows browser-session contract.
 *
 * BV2-03 deliberately exposes read-only semantic operations only. Navigation,
 * DOM mutation and tab mutation stay disabled until owned-tab semantics are
 * proven in BV2-04.
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
    )
      return false;
    if (this.config.mode === "playwright-cli-cdp") return Boolean(this.config.browserChannel);
    if (this.config.mode === "playwright-cli-persistent") return Boolean(this.config.userDataDir);
    // Extension attach needs an explicit interactive approval flow, which is
    // intentionally not activated by this read-only backend slice.
    return false;
  }

  async browser(
    botId: string,
    request: WindowsHostBrowserRequest,
  ): Promise<WindowsHostBrowserResult> {
    if (!SAFE_BOT_ID.test(botId)) throw new Error("Invalid browser bot identity");
    if (!this.config.entry) throw new Error("Playwright CLI entry is not configured");

    if (request.command === "open") {
      await this.cleanupExpired();
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new Error("Too many live browser sessions; close your own session or wait for expiry");
      }
      const sessionToken = randomUUID();
      this.sessions.set(sessionToken, {
        botId,
        lastActivity: Date.now(),
        backendReady: false,
      });
      return { ok: true, sessionToken };
    }

    if (request.command === "recover") {
      const existing = this.sessions.get(request.sessionToken);
      if (existing) {
        if (existing.botId !== botId) throw new Error("Unknown browser session");
        if (Date.now() - existing.lastActivity >= SESSION_TOKEN_TTL_MS) {
          this.sessions.delete(request.sessionToken);
          return { ok: false, error: "Browser session expired; open a new session first" };
        }
        existing.lastActivity = Date.now();
        return { ok: true, sessionToken: request.sessionToken };
      }

      const session = browserSessionName(botId, request.sessionToken);
      const listed = parseJson(await this.invokeGlobal("list"));
      const match = listedBrowsers(listed.browsers).find(
        (entry) => entry.name === session && entry.status === "open",
      );
      if (!match) return { ok: false, error: "No recoverable Playwright browser session found" };
      if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
        throw new Error("Too many live browser sessions; close your own session or wait for expiry");
      }
      this.sessions.set(request.sessionToken, {
        botId,
        lastActivity: Date.now(),
        backendReady: true,
      });
      return { ok: true, sessionToken: request.sessionToken };
    }

    const state = this.sessions.get(request.sessionToken);
    if (!state || state.botId !== botId) throw new Error("Unknown browser session; open first");
    if (Date.now() - state.lastActivity >= SESSION_TOKEN_TTL_MS) {
      this.sessions.delete(request.sessionToken);
      throw new Error("Browser session expired; open a new session first");
    }
    state.lastActivity = Date.now();

    if (
      request.command === "navigate" ||
      request.command === "scroll" ||
      request.command === "tabNew" ||
      request.command === "tabSelect" ||
      request.command === "tabClose" ||
      request.command === "act"
    ) {
      return {
        ok: false,
        error: "This Playwright backend slice is read-only; use OpenCLI or wait for BV2-04",
      };
    }

    const session = browserSessionName(botId, request.sessionToken);

    if (request.command === "close") {
      if (state.backendReady) {
        try {
          if (this.config.mode === "playwright-cli-cdp")
            await this.invoke(session, "detach");
          else await this.invoke(session, "close");
        } finally {
          this.sessions.delete(request.sessionToken);
        }
      } else {
        this.sessions.delete(request.sessionToken);
      }
      return { ok: true };
    }

    await this.ensureBackendSession(session, state);

    if (request.command === "snapshot") {
      return { ok: true, ...(await this.observe(session)) };
    }

    if (request.command === "find") {
      try {
        const payload = parseJson(await this.invoke(session, "snapshot", request.css));
        return { ok: true, content: snapshotTree(payload.snapshot) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 500) : "Browser find failed",
        };
      }
    }

    if (request.command === "wait") {
      const deadline = Date.now() + (request.timeoutMs ?? 9_000);
      let lastError = "Browser wait condition was not met";
      while (Date.now() < deadline) {
        try {
          if (request.kind === "selector") {
            const payload = parseJson(await this.invoke(session, "snapshot", request.value));
            return { ok: true, content: snapshotTree(payload.snapshot) };
          }
          const payload = parseJson(
            await this.invoke(session, "find", request.value, "--max-results=1"),
          );
          const content = typeof payload.result === "string" ? payload.result : "";
          if (content && !/^No matches found/iu.test(content.trim()))
            return { ok: true, content: content.slice(0, MAX_OUTPUT_BYTES) };
          lastError = content || lastError;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await sleep(200);
      }
      return { ok: false, error: lastError.slice(0, 500) };
    }

    if (request.command === "extract") {
      const payload = parseJson(
        await this.invoke(session, "snapshot", ...(request.selector ? [request.selector] : [])),
      );
      const content = snapshotTree(payload.snapshot);
      const start = request.start ?? 0;
      return { ok: true, content: content.slice(start, start + MAX_OUTPUT_BYTES) };
    }

    if (request.command === "screenshot") {
      if (request.annotate || request.width !== undefined || request.height !== undefined) {
        return {
          ok: false,
          error: "Annotated/resized Playwright screenshots are deferred until BV2-04",
        };
      }
      const fileName = `rakazo-playwright-${randomUUID()}.png`;
      const screenshotPath = path.join(this.workspaceDir(), fileName);
      try {
        parseJson(await this.invoke(session, "screenshot", `--filename=${fileName}`));
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
      }
    }

    throw new Error("Unsupported Playwright browser command");
  }

  private workspaceDir() {
    return path.join(this.stateDir, "playwright-cli");
  }

  private invoke(session: string, ...args: string[]) {
    return this.runner(
      this.config.entry!,
      [`-s=${session}`, ...args],
      this.workspaceDir(),
    );
  }

  private invokeGlobal(...args: string[]) {
    return this.runner(this.config.entry!, args, this.workspaceDir());
  }

  private async ensureBackendSession(session: string, state: PlaywrightCliSessionState) {
    if (state.backendReady) return;
    if (this.config.mode === "playwright-cli-cdp") {
      if (!this.config.browserChannel) throw new Error("Playwright browser channel is missing");
      parseJson(await this.invoke(session, "attach", `--cdp=${this.config.browserChannel}`));
    } else if (this.config.mode === "playwright-cli-persistent") {
      if (!this.config.userDataDir) throw new Error("Playwright user-data directory is missing");
      parseJson(
        await this.invoke(
          session,
          "open",
          "about:blank",
          `--profile=${this.config.userDataDir}`,
        ),
      );
    } else if (this.config.mode === "playwright-cli-extension") {
      throw new Error(
        "Playwright extension attach requires interactive browser approval and is not active yet",
      );
    } else {
      throw new Error("Playwright CLI backend is not selected");
    }
    state.backendReady = true;
  }

  private async observe(session: string) {
    const snapshot = parseJson(await this.invoke(session, "snapshot"));
    const tabs = parseJson(await this.invoke(session, "tab-list"));
    const metadata = currentTabMetadata(tabs.result);
    return {
      ...metadata,
      tree: snapshotTree(snapshot.snapshot),
      elements: snapshotElements(snapshot.snapshot),
    };
  }

  private async cleanupExpired() {
    const now = Date.now();
    for (const [token, state] of [...this.sessions]) {
      if (now - state.lastActivity < SESSION_TOKEN_TTL_MS) continue;
      this.sessions.delete(token);
      if (!state.backendReady) continue;
      const session = browserSessionName(state.botId, token);
      try {
        if (this.config.mode === "playwright-cli-cdp") await this.invoke(session, "detach");
        else await this.invoke(session, "close");
      } catch {
        // Playwright's own daemon idle timeout remains the final cleanup bound.
      }
    }
  }
}
