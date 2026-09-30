import {
  type WindowsHostAdvertisement,
  type WindowsHostCommandEnvelope,
  WindowsHostCommandEnvelopeSchema,
  WindowsHostCommandReportSchema,
  type WindowsHostCommandResult,
  type WindowsHostHeartbeat,
  type WindowsHostHeartbeatResult,
  WindowsHostHeartbeatResultSchema,
  type WindowsHostPairingResult,
  WindowsHostPairingResultSchema,
} from "@rakazo/contracts";

export class WindowsHostAuthorizationError extends Error {
  constructor(readonly status: 401 | 403) {
    super("Windows host credential was rejected by Rakazo");
    this.name = "WindowsHostAuthorizationError";
  }
}

type FetchLike = typeof fetch;

export interface WindowsHostTransport {
  pair(
    advertisement: WindowsHostAdvertisement,
    pairingToken: string,
    signal?: AbortSignal,
  ): Promise<WindowsHostPairingResult>;
  heartbeat(
    heartbeat: WindowsHostHeartbeat,
    credential: string,
    signal?: AbortSignal,
  ): Promise<WindowsHostHeartbeatResult>;
  poll(
    hostId: string,
    credential: string,
    signal?: AbortSignal,
  ): Promise<WindowsHostCommandEnvelope | null>;
  report(
    hostId: string,
    result: WindowsHostCommandResult,
    credential: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class HttpWindowsHostTransport implements WindowsHostTransport {
  constructor(
    private readonly origin: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pair(advertisement: WindowsHostAdvertisement, pairingToken: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(this.url("/api/windows-host/pair"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ advertisement }),
      signal,
    });

    return WindowsHostPairingResultSchema.parse(await parseJsonResponse(response));
  }

  async heartbeat(heartbeat: WindowsHostHeartbeat, credential: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(this.url("/api/windows-host/heartbeat"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(heartbeat),
      signal,
    });

    return WindowsHostHeartbeatResultSchema.parse(await parseJsonResponse(response));
  }

  async poll(hostId: string, credential: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(this.url("/api/windows-host/commands/next"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hostId }),
      signal,
    });
    if (response.status === 204) return null;
    return WindowsHostCommandEnvelopeSchema.parse(await parseJsonResponse(response));
  }

  async report(
    hostId: string,
    result: WindowsHostCommandResult,
    credential: string,
    signal?: AbortSignal,
  ) {
    const body = WindowsHostCommandReportSchema.parse({ hostId, result });
    const response = await this.fetchImpl(this.url("/api/windows-host/commands/result"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    await parseJsonResponse(response);
  }

  private url(pathname: string) {
    return new URL(pathname, this.origin).toString();
  }
}

async function parseJsonResponse(response: Response) {
  if (response.status === 401 || response.status === 403) {
    throw new WindowsHostAuthorizationError(response.status);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Windows host request failed (${response.status})`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Windows host response was not valid JSON");
  }
}
