import { randomUUID } from "node:crypto";
import {
  WINDOWS_HOST_PROTOCOL_VERSION,
  WindowsHostAdvertisementSchema,
  WindowsHostHeartbeatSchema,
  type WindowsHostAdvertisement,
  type WindowsHostCapability,
} from "@rakazo/contracts";
import type { WindowsHostConfig } from "./config.js";
import { loadOrCreateWindowsHostIdentity } from "./identity.js";
import {
  HttpWindowsHostTransport,
  type WindowsHostTransport,
} from "./transport.js";

export const WINDOWS_HOST_RUNTIME_VERSION = "0.1.0";

const INITIAL_CAPABILITIES = ["identity"] as const satisfies readonly WindowsHostCapability[];

export async function buildAdvertisement(
  stateDir: string,
  startedAt = new Date().toISOString(),
): Promise<WindowsHostAdvertisement> {
  const identity = await loadOrCreateWindowsHostIdentity(stateDir);
  return WindowsHostAdvertisementSchema.parse({
    protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
    runtimeVersion: WINDOWS_HOST_RUNTIME_VERSION,
    identity,
    capabilities: [...INITIAL_CAPABILITIES],
    startedAt,
  });
}

export class WindowsHostRuntime {
  private readonly connectionId = randomUUID();
  private sequence = 0;

  constructor(
    private readonly config: WindowsHostConfig,
    private readonly transport: WindowsHostTransport | null = config.origin
      ? new HttpWindowsHostTransport(config.origin)
      : null,
  ) {}

  async probe() {
    return buildAdvertisement(this.config.stateDir);
  }

  async run(signal?: AbortSignal): Promise<never> {
    if (!this.transport || !this.config.origin) {
      throw new Error("RAKAZO_WINDOWS_HOST_ORIGIN is required");
    }

    const advertisement = await this.probe();
    let hostId = this.config.hostId;
    let credential = this.config.hostCredential;
    let heartbeatIntervalMs = 15_000;

    if ((!hostId || !credential) && this.config.pairingToken) {
      const paired = await this.transport.pair(
        advertisement,
        this.config.pairingToken,
        signal,
      );
      hostId = paired.hostId;
      credential = paired.hostCredential;
      heartbeatIntervalMs = paired.heartbeatIntervalMs;
    }

    if (!hostId || !credential) {
      throw new Error(
        "Provide a short-lived pairing token or an existing host id/credential",
      );
    }

    while (!signal?.aborted) {
      try {
        const heartbeat = WindowsHostHeartbeatSchema.parse({
          protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
          hostId,
          connectionId: this.connectionId,
          sequence: this.sequence++,
          sentAt: new Date().toISOString(),
          advertisement,
        });
        const result = await this.transport.heartbeat(heartbeat, credential, signal);
        if (result.revoked) {
          throw new Error("Windows host credential was revoked");
        }
        await sleep(heartbeatIntervalMs, signal);
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof Error && error.message.includes("revoked")) throw error;
        await sleep(Math.min(heartbeatIntervalMs, 30_000), signal);
      }
    }

    throw new Error("Windows host runtime stopped");
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done();

    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
