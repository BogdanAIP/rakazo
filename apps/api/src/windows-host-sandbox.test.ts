import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { WindowsHostCommandHub } from "./windows-host-command-hub.js";
import { WindowsHostSandboxProvider } from "./windows-host-sandbox.js";

const context = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "owner-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

describe("WindowsHostSandboxProvider", () => {
  it("provisions the latest live paired host as a normal desktop computer", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "host-1" });
    const provider = new WindowsHostSandboxProvider(
      { windowsHost: { findFirst } } as unknown as PrismaClient,
      new WindowsHostCommandHub(),
    );

    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/home/rakazo" },
      context,
    );

    expect(computer).toMatchObject({
      botId: "bot-1",
      kind: "desktop",
      providerRef: "host-1",
      fresh: false,
    });
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("verifies the paired installation identity during prepare", async () => {
    const installationId = "4f8f9018-9022-40f4-a99d-18de278fa4de";
    const findFirst = vi.fn().mockResolvedValue({ installationId });
    const hub = new WindowsHostCommandHub();
    const provider = new WindowsHostSandboxProvider(
      { windowsHost: { findFirst } } as unknown as PrismaClient,
      hub,
    );
    const computer = {
      id: "desktop-bot-1",
      botId: "bot-1",
      kind: "desktop" as const,
      providerRef: "host-1",
      fresh: false,
    };

    const preparing = provider.prepare(computer, context);
    const command = await hub.poll("host-1", 1);
    expect(command?.request).toEqual({ kind: "identity.get" });
    hub.settle("host-1", {
      id: command!.id,
      ok: true,
      result: {
        kind: "identity",
        identity: {
          installationId,
          hostname: "target-host",
          platform: "win32",
          release: "10.0",
          arch: "x64",
        },
      },
    });

    await expect(preparing).resolves.toBeUndefined();
  });

  it("fails closed when no connected host belongs to the current owner", async () => {
    const provider = new WindowsHostSandboxProvider(
      {
        windowsHost: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient,
      new WindowsHostCommandHub(),
    );

    await expect(
      provider.provision({ botId: "bot-1", homePath: "/home/rakazo" }, context),
    ).rejects.toThrow("No connected Windows host");
  });
});
