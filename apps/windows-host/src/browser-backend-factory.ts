import type {
  WindowsHostBrowserMode,
  WindowsHostBrowserRequest,
  WindowsHostBrowserResult,
} from "@rakazo/contracts";
import type { WindowsBrowserBackend } from "./browser-backend.js";
import { loadOpenCliConfiguration, WindowsOpenCliBackend } from "./opencli.js";
import { WindowsPlaywrightCliBackend } from "./playwright-cli.js";
import { loadPlaywrightCliConfiguration } from "./playwright-cli-config.js";

type ResolvedBrowserMode = Exclude<WindowsHostBrowserMode, "auto">;

const RESOLVED_BROWSER_MODES = [
  "opencli",
  "playwright-cli-extension",
  "playwright-cli-cdp",
  "playwright-cli-persistent",
] as const satisfies readonly ResolvedBrowserMode[];

interface RoutedSession {
  botId: string;
  mode: ResolvedBrowserMode;
}

/**
 * Session-aware browser router.
 *
 * Mode is selected on browser/open, then bound to the server-minted session
 * token. "auto" prefers Rakazo's dedicated persistent Playwright profile,
 * then falls back to OpenCLI. CDP and Extension attach to an existing browser
 * are explicit-only because Chrome may require user confirmation.
 */
export class WindowsBrowserBackendRouter implements WindowsBrowserBackend {
  private readonly sessions = new Map<string, RoutedSession>();

  constructor(
    private readonly backends: Record<ResolvedBrowserMode, WindowsBrowserBackend>,
    private readonly defaultMode: WindowsHostBrowserMode = "opencli",
  ) {}

  available(): boolean {
    return RESOLVED_BROWSER_MODES.some((mode) => this.backends[mode].available());
  }

  async browser(
    botId: string,
    request: WindowsHostBrowserRequest,
  ): Promise<WindowsHostBrowserResult> {
    if (request.command === "open") {
      const requestedMode = request.mode ?? this.defaultMode;
      if (requestedMode === "auto") return this.openAuto(botId);

      const mode = requestedMode;
      const backend = this.backends[mode];
      if (!backend.available()) {
        return { ok: false, backendMode: mode, error: `${mode} browser backend is unavailable` };
      }
      const result = await backend.browser(botId, { command: "open" });
      if (result.ok && result.sessionToken) {
        this.sessions.set(result.sessionToken, { botId, mode });
      }
      return { ...result, backendMode: mode };
    }

    const assigned = this.sessions.get(request.sessionToken);
    if (assigned) {
      if (assigned.botId !== botId) throw new Error("Unknown browser session");
      const result = await this.backends[assigned.mode].browser(botId, request);
      if (request.command === "close" && result.ok) this.sessions.delete(request.sessionToken);
      return { ...result, backendMode: assigned.mode };
    }

    if (request.command !== "recover") {
      throw new Error("Unknown browser session; open or recover it first");
    }

    const recovered: Array<{
      mode: ResolvedBrowserMode;
      result: WindowsHostBrowserResult;
    }> = [];

    for (const mode of RESOLVED_BROWSER_MODES) {
      const backend = this.backends[mode];
      if (!backend.available()) continue;
      try {
        const result = await backend.browser(botId, request);
        if (result.ok) recovered.push({ mode, result });
      } catch {
        // Recovery is a probe across known backends. Do not let one unavailable
        // or stale backend prevent another exact token from recovering.
      }
    }

    if (recovered.length === 0) {
      return { ok: false, error: "No recoverable browser session found for this token" };
    }
    if (recovered.length > 1) {
      return {
        ok: false,
        error: "Browser session recovery was ambiguous across multiple backends",
      };
    }

    const match = recovered[0]!;
    this.sessions.set(request.sessionToken, { botId, mode: match.mode });
    return { ...match.result, backendMode: match.mode };
  }

  private async openAuto(botId: string): Promise<WindowsHostBrowserResult> {
    // Existing-browser CDP and Extension attach can require Chrome approval.
    // Never select them implicitly. Autonomous routing uses Rakazo's dedicated
    // persistent profile first, then falls back to OpenCLI.
    const candidates: readonly ResolvedBrowserMode[] = ["playwright-cli-persistent", "opencli"];
    const failures: string[] = [];

    for (const mode of candidates) {
      const backend = this.backends[mode];
      if (!backend.available()) continue;
      try {
        const result = await backend.browser(botId, { command: "open" });
        if (result.ok && result.sessionToken) {
          this.sessions.set(result.sessionToken, { botId, mode });
          return { ...result, backendMode: mode };
        }
        failures.push(`${mode}: ${result.error ?? "open failed"}`);
      } catch (error) {
        failures.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      ok: false,
      error:
        failures.length > 0
          ? `No non-interactive browser backend opened successfully (${failures.join("; ")})`
          : "No non-interactive browser backend is available; select Extension explicitly if browser confirmation is acceptable",
    };
  }
}

export function createWindowsBrowserBackend(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsBrowserBackend {
  const playwright = loadPlaywrightCliConfiguration(env);

  return new WindowsBrowserBackendRouter(
    {
      opencli: new WindowsOpenCliBackend(loadOpenCliConfiguration(env)),
      "playwright-cli-extension": new WindowsPlaywrightCliBackend(
        { ...playwright, mode: "playwright-cli-extension" },
        stateDir,
      ),
      "playwright-cli-cdp": new WindowsPlaywrightCliBackend(
        { ...playwright, mode: "playwright-cli-cdp" },
        stateDir,
      ),
      "playwright-cli-persistent": new WindowsPlaywrightCliBackend(
        {
          ...playwright,
          mode: "playwright-cli-persistent",
          browserChannel: playwright.browserChannel ?? "chrome",
        },
        stateDir,
      ),
    },
    playwright.mode,
  );
}
