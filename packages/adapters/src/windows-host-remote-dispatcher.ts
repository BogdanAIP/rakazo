import {
  WindowsHostCommandResultSchema,
  type WindowsHostCommandRequest,
  type WindowsHostCommandResult,
  WindowsHostInternalDispatchSchema,
} from "@rakazo/contracts";
import type { WindowsHostCommandDispatcher } from "./windows-host-sandbox.js";

const DISPATCH_TIMEOUT_MS = 30_000;

/** Worker -> API only. Windows connects to API outbound and never accepts HTTP. */
export class RemoteWindowsHostCommandDispatcher implements WindowsHostCommandDispatcher {
  private readonly endpoint: string;

  constructor(
    apiOrigin: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const origin = new URL(apiOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
      throw new Error("Invalid Rakazo internal API URL");
    }
    if (internalToken.length < 32) {
      throw new Error("RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN must contain at least 32 characters");
    }
    this.endpoint = new URL("/api/windows-host/internal/dispatch", origin).toString();
  }

  async dispatch(
    hostId: string,
    request: WindowsHostCommandRequest,
    signal?: AbortSignal,
    timeoutMs = DISPATCH_TIMEOUT_MS,
    ownerUserId?: string,
  ): Promise<WindowsHostCommandResult> {
    if (!ownerUserId) throw new Error("Windows host dispatch requires an owner");
    const body = WindowsHostInternalDispatchSchema.parse({ hostId, ownerUserId, request });
    const deadline = AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), 30_000) + 6_000);
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      throw new Error(`Rakazo internal Windows host dispatch failed (${response.status})`);
    }
    return WindowsHostCommandResultSchema.parse(await response.json());
  }
}
