import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { WindowsHostCommandHub } from "./windows-host-command-hub.js";
import { mountWindowsHostRoutes } from "./windows-host.js";

const internalToken = "t".repeat(48);
const body = {
  hostId: "host-a",
  ownerUserId: "owner-a",
  request: { kind: "identity.get" },
};

function makeApp(host: { id: string } | null = { id: "host-a" }) {
  const app = new Hono();
  const hub = new WindowsHostCommandHub();
  const findFirst = vi.fn().mockResolvedValue(host);
  mountWindowsHostRoutes(app, {
    prisma: { windowsHost: { findFirst } } as unknown as PrismaClient,
    commandHub: hub,
    internalToken,
    resolveOwner: async () => null,
  });
  return { app, hub, findFirst };
}

function dispatch(app: Hono, token = internalToken) {
  return app.request("/api/windows-host/internal/dispatch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("internal Windows host command dispatch", () => {
  it("refuses missing or incorrect worker credentials before querying hosts", async () => {
    const { app, hub, findFirst } = makeApp();
    const noAuth = await app.request("/api/windows-host/internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(noAuth.status).toBe(401);
    expect((await dispatch(app, "x".repeat(48))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
    hub.close();
  });

  it("does not dispatch a host owned by another account or a disconnected host", async () => {
    const { app, hub, findFirst } = makeApp(null);
    const response = await dispatch(app);
    expect(response.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "host-a",
        ownerUserId: "owner-a",
        revokedAt: null,
        lastSeenAt: { gte: expect.any(Date) },
      },
      select: { id: true },
    });
    hub.close();
  });

  it("correlates the host result to an authorized worker dispatch", async () => {
    const { app, hub } = makeApp();
    const pending = dispatch(app);
    const command = await hub.poll("host-a", 100);
    expect(command?.request).toEqual({ kind: "identity.get" });
    expect(
      hub.settle("host-a", {
        id: command!.id,
        ok: true,
        result: {
          kind: "identity",
          identity: {
            installationId: "4f8f9018-9022-40f4-a99d-18de278fa4de",
            hostname: "windows-laptop",
            platform: "win32",
            release: "10.0",
            arch: "x64",
          },
        },
      }),
    ).toBe(true);
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json()).result.kind).toBe("identity");
    hub.close();
  });
});
