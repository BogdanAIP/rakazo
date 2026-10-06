import type {
  WindowsHostBrowserRequest,
  WindowsHostBrowserResult,
} from "@rakazo/contracts";

export interface WindowsBrowserBackend {
  available(): boolean;
  browser(botId: string, request: WindowsHostBrowserRequest): Promise<WindowsHostBrowserResult>;
}
