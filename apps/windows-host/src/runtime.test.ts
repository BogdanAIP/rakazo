import {
  WINDOWS_HOST_PROTOCOL_VERSION,
  type WindowsHostAdvertisement,
  type WindowsHostPairingResult,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WindowsHostConfig } from "./config.js";
import type {
  StoredWindowsHostCredential,
  WindowsHostCredentialStore,
} from "./credential-store.js";
import { executeWindowsHostCommand, resolveWindowsHostCredential } from "./runtime.js";
import type { WindowsHostTransport } from "./transport.js";

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

class MemoryCredentialStore implements WindowsHostCredentialStore {
  value: StoredWindowsHostCredential | null;

  constructor(value: StoredWindowsHostCredential | null = null) {
    this.value = value;
  }

  async load() {
    return this.value;
  }

  async save(value: StoredWindowsHostCredential) {
    this.value = value;
  }

  async clear() {
    this.value = null;
  }
}

function baseConfig(overrides: Partial<WindowsHostConfig> = {}): WindowsHostConfig {
  return {
    origin: "http://127.0.0.1:3100",
    stateDir: "unused",
    pairingToken: null,
    hostId: null,
    hostCredential: null,
    ...overrides,
  };
}

function transport(pairing?: WindowsHostPairingResult): WindowsHostTransport {
  return {
    pair: vi.fn(async () => {
      if (!pairing) throw new Error("pair should not be called");
      return pairing;
    }),
    heartbeat: vi.fn(async () => ({
      ok: true as const,
      serverTime: "2026-09-30T00:00:01.000Z",
      revoked: false,
    })),
    poll: vi.fn(async () => null),
    report: vi.fn(async () => undefined),
  };
}

describe("resolveWindowsHostCredential", () => {
  it("uses an explicit id and credential without touching the persisted store", async () => {
    const store = new MemoryCredentialStore({
      hostId: "stored-host",
      hostCredential: "s".repeat(48),
    });
    const load = vi.spyOn(store, "load");

    const resolved = await resolveWindowsHostCredential(
      baseConfig({ hostId: "env-host", hostCredential: "e".repeat(48) }),
      advertisement,
      transport(),
      store,
    );

    expect(resolved).toMatchObject({ hostId: "env-host", source: "env" });
    expect(load).not.toHaveBeenCalled();
  });

  it("pairs once and persists the returned scoped host credential", async () => {
    const store = new MemoryCredentialStore();
    const paired: WindowsHostPairingResult = {
      hostId: "paired-host",
      hostCredential: "p".repeat(48),
      heartbeatIntervalMs: 12_000,
      pairedAt: "2026-09-30T00:00:01.000Z",
    };

    const resolved = await resolveWindowsHostCredential(
      baseConfig({ pairingToken: "pair-me" }),
      advertisement,
      transport(paired),
      store,
    );

    expect(resolved).toEqual({
      hostId: "paired-host",
      credential: "p".repeat(48),
      heartbeatIntervalMs: 12_000,
      source: "pairing",
    });
    expect(store.value).toEqual({
      hostId: "paired-host",
      hostCredential: "p".repeat(48),
    });
  });

  it("restores a persisted host credential after restart", async () => {
    const store = new MemoryCredentialStore({
      hostId: "stored-host",
      hostCredential: "s".repeat(48),
    });

    const resolved = await resolveWindowsHostCredential(
      baseConfig(),
      advertisement,
      transport(),
      store,
    );

    expect(resolved).toMatchObject({
      hostId: "stored-host",
      credential: "s".repeat(48),
      source: "store",
    });
  });

  it("restarts with a saved credential even if the one-use pairing token remains configured", async () => {
    const store = new MemoryCredentialStore({
      hostId: "stored-host",
      hostCredential: "s".repeat(48),
    });
    const client = transport();
    const resolved = await resolveWindowsHostCredential(
      baseConfig({ pairingToken: "already-consumed" }),
      advertisement,
      client,
      store,
    );

    expect(resolved).toMatchObject({
      hostId: "stored-host",
      credential: "s".repeat(48),
      source: "store",
    });
    expect(client.pair).not.toHaveBeenCalled();
  });

  it("rejects a partial environment override instead of mixing credential sources", async () => {
    await expect(
      resolveWindowsHostCredential(
        baseConfig({ hostId: "env-host" }),
        advertisement,
        transport(),
        new MemoryCredentialStore(),
      ),
    ).rejects.toThrow("must be provided together");
  });
});

describe("executeWindowsHostCommand", () => {
  it("returns the physical host identity without invoking another agent runtime", async () => {
    const result = await executeWindowsHostCommand(
      {
        id: "35633dcb-8c94-4f55-9517-8b76f28676df",
        request: { kind: "identity.get" },
      },
      advertisement,
    );

    expect(result).toEqual({
      id: "35633dcb-8c94-4f55-9517-8b76f28676df",
      ok: true,
      result: { kind: "identity", identity: advertisement.identity },
    });
  });
});
