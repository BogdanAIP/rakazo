import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_HOST_PROTOCOL_VERSION,
  type WindowsHostAdvertisement,
  type WindowsHostHeartbeat,
} from "@rakazo/contracts";
import { HttpWindowsHostTransport } from "./transport.js";

const advertisement: WindowsHostAdvertisement = {
  protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
  runtimeVersion: "0.1.0",
  identity: {
    installationId: "4f8f9018-9022-40f4-a99d-18de278fa4de",
    hostname: "test-host",
    platform: "win32",
    release: "10.0",
    arch: "x64",
  },
  capabilities: ["identity"],
  startedAt: "2026-09-30T00:00:00.000Z",
};

describe("HttpWindowsHostTransport", () => {
  it("keeps the pairing credential out of the JSON body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer pairing-secret" });
      expect(String(init?.body)).not.toContain("pairing-secret");
      return new Response(
        JSON.stringify({
          hostId: "host-1",
          hostCredential: "x".repeat(32),
          heartbeatIntervalMs: 15_000,
          pairedAt: "2026-09-30T00:00:01.000Z",
        }),
        { status: 200 },
      );
    });

    const transport = new HttpWindowsHostTransport(
      "http://127.0.0.1:3100",
      fetchImpl as typeof fetch,
    );
    await transport.pair(advertisement, "pairing-secret");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the host credential out of the heartbeat body", async () => {
    const heartbeat: WindowsHostHeartbeat = {
      protocolVersion: WINDOWS_HOST_PROTOCOL_VERSION,
      hostId: "host-1",
      connectionId: "35633dcb-8c94-4f55-9517-8b76f28676df",
      sequence: 0,
      sentAt: "2026-09-30T00:00:02.000Z",
      advertisement,
    };
    const credential = "c".repeat(32);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${credential}` });
      expect(String(init?.body)).not.toContain(credential);
      return new Response(
        JSON.stringify({
          ok: true,
          serverTime: "2026-09-30T00:00:03.000Z",
          revoked: false,
        }),
        { status: 200 },
      );
    });

    const transport = new HttpWindowsHostTransport(
      "http://127.0.0.1:3100",
      fetchImpl as typeof fetch,
    );
    await transport.heartbeat(heartbeat, credential);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
