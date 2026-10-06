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
 * token. Existing callers that omit mode keep OpenCLI behavior. "auto" is
 * deliberately conservative until BV2 physical benchmarks exist.
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
      const mode = this.resolveOpenMode(request.mode);
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

  private resolveOpenMode(requested?: WindowsHostBrowserMode): ResolvedBrowserMode {
    const mode = requested ?? this.defaultMode;
    if (mode !== "auto") return mode;

    // Keep automatic routing inert until Extension/CDP/Persistent have completed
    // the same physical capability benchmark. Never silently trade capability
    // for backend novelty.
    if (this.backends.opencli.available()) return "opencli";
    throw new Error(
      "Automatic browser routing is not enabled yet and OpenCLI is unavailable; select a mode explicitly",
    );
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
        { ...playwright, mode: "playwright-cli-persistent" },
        stateDir,
      ),
    },
    playwright.mode,
  );
}
