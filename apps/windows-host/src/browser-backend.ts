import type { WindowsHostBrowserRequest, WindowsHostBrowserResult } from "@rakazo/contracts";

/**
 * Internal Windows browser backend contract.
 *
 * ChatGPT/Rakazo continue to see the stable computer/browser semantics.
 * Implementations (OpenCLI today, Playwright later) stay behind Windows Host.
 */
export interface WindowsBrowserBackend {
  available(): boolean;
  browser(botId: string, request: WindowsHostBrowserRequest): Promise<WindowsHostBrowserResult>;
}
