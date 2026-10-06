import type {
  WindowsHostBrowserMode,
  WindowsHostBrowserRequest,
  WindowsHostBrowserResult,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WindowsBrowserBackend } from "./browser-backend.js";
import { WindowsBrowserBackendRouter } from "./browser-backend-factory.js";
import {
  browserModeHasStableParity,
  missingStableBrowserCapabilities,
} from "./browser-capabilities.js";

type ResolvedMode = Exclude<WindowsHostBrowserMode, "auto">;

function fakeBackend(
  name: string,
  options: { available?: boolean; recover?: boolean } = {},
): WindowsBrowserBackend {
  let tokenCounter = 0;
  return {
    available: () => options.available !== false,
    browser: vi.fn(async (_botId: string, request: WindowsHostBrowserRequest) => {
      if (request.command === "open") {
        tokenCounter += 1;
        return {
          ok: true,
          sessionToken: `00000000-0000-4000-8000-00000000000${tokenCounter}`,
        } as WindowsHostBrowserResult;
      }
      if (request.command === "recover") {
        return options.recover
          ? { ok: true, sessionToken: request.sessionToken }
          : { ok: false, error: `${name} did not own this session` };
      }
      return { ok: true };
    }),
  };
}

function router(
  overrides: Partial<Record<ResolvedMode, WindowsBrowserBackend>> = {},
  defaultMode: WindowsHostBrowserMode = "opencli",
) {
  return new WindowsBrowserBackendRouter(
    {
      opencli: overrides.opencli ?? fakeBackend("opencli"),
      "playwright-cli-extension": overrides["playwright-cli-extension"] ?? fakeBackend("extension"),
      "playwright-cli-cdp": overrides["playwright-cli-cdp"] ?? fakeBackend("cdp"),
      "playwright-cli-persistent":
        overrides["playwright-cli-persistent"] ?? fakeBackend("persistent"),
    },
    defaultMode,
  );
}

describe("browser capability parity", () => {
  it("keeps the stable browser contract fully enabled across selectable backends", () => {
    for (const mode of [
      "opencli",
      "playwright-cli-extension",
      "playwright-cli-cdp",
      "playwright-cli-persistent",
    ] as const) {
      expect(browserModeHasStableParity(mode)).toBe(true);
      expect(missingStableBrowserCapabilities(mode)).toEqual([]);
    }
  });
});

describe("WindowsBrowserBackendRouter", () => {
  it("keeps OpenCLI as the default for existing callers", async () => {
    const opencli = fakeBackend("opencli");
    const cdp = fakeBackend("cdp");
    const subject = router({ opencli, "playwright-cli-cdp": cdp });

    const opened = await subject.browser("bot-a", { command: "open" });

    expect(opened).toMatchObject({ ok: true, backendMode: "opencli" });
    expect(opencli.browser).toHaveBeenCalledTimes(1);
    expect(cdp.browser).not.toHaveBeenCalled();
  });

  it("selects an explicit Playwright mode per session", async () => {
    const cdp = fakeBackend("cdp");
    const subject = router({ "playwright-cli-cdp": cdp });

    const opened = await subject.browser("bot-a", {
      command: "open",
      mode: "playwright-cli-cdp",
    });
    const snapshot = await subject.browser("bot-a", {
      command: "snapshot",
      sessionToken: opened.sessionToken!,
    });

    expect(opened.backendMode).toBe("playwright-cli-cdp");
    expect(snapshot.backendMode).toBe("playwright-cli-cdp");
    expect(cdp.browser).toHaveBeenCalledTimes(2);
  });

  it("does not silently route auto away from OpenCLI before benchmarks", async () => {
    const opencli = fakeBackend("opencli", { available: false });
    const cdp = fakeBackend("cdp");
    const subject = router({ opencli, "playwright-cli-cdp": cdp }, "auto");

    await expect(subject.browser("bot-a", { command: "open", mode: "auto" })).rejects.toThrow(
      "Automatic browser routing is not enabled yet",
    );
    expect(cdp.browser).not.toHaveBeenCalled();
  });

  it("recovers an unambiguous backend and rebinds the token", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const opencli = fakeBackend("opencli");
    const persistent = fakeBackend("persistent", { recover: true });
    const subject = router({ opencli, "playwright-cli-persistent": persistent });

    const recovered = await subject.browser("bot-a", {
      command: "recover",
      sessionToken: token,
    });
    const snapshot = await subject.browser("bot-a", { command: "snapshot", sessionToken: token });

    expect(recovered).toEqual({
      ok: true,
      sessionToken: token,
      backendMode: "playwright-cli-persistent",
    });
    expect(snapshot.backendMode).toBe("playwright-cli-persistent");
  });

  it("fails closed when recovery is ambiguous", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const subject = router({
      opencli: fakeBackend("opencli", { recover: true }),
      "playwright-cli-cdp": fakeBackend("cdp", { recover: true }),
    });

    const recovered = await subject.browser("bot-a", {
      command: "recover",
      sessionToken: token,
    });

    expect(recovered).toEqual({
      ok: false,
      error: "Browser session recovery was ambiguous across multiple backends",
    });
  });
});
