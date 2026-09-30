import type { Hono } from "hono";
import {
  WindowsHostHeartbeatSchema,
  WindowsHostPairingClaimSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  claimWindowsHostPairing,
  createWindowsHostPairing,
  listWindowsHosts,
  recordWindowsHostHeartbeat,
  revokeWindowsHost,
  WindowsHostAuthenticationError,
  WindowsHostPairingError,
  WindowsHostReplayError,
} from "@rakazo/db";

const HEARTBEAT_INTERVAL_MS = 15_000;

interface OwnerIdentity {
  userId: string;
  isDeploymentOwner: boolean;
}

export function mountWindowsHostRoutes(
  app: Hono,
  deps: {
    prisma: PrismaClient;
    resolveOwner: (request: Request) => Promise<OwnerIdentity | null>;
  },
) {
  app.post("/api/windows-host/pairings", async (c) => {
    const owner = await deps.resolveOwner(c.req.raw);
    if (!owner) return c.json({ error: "Unauthorized" }, 401);
    if (!owner.isDeploymentOwner) return c.json({ error: "Forbidden" }, 403);

    const body = await optionalJson(c.req.raw);
    const ttlMs = readOptionalPositiveInteger(body, "ttlMs");
    if (ttlMs === null) return c.json({ error: "Invalid ttlMs" }, 400);

    try {
      const pairing = await createWindowsHostPairing(deps.prisma, {
        ownerUserId: owner.userId,
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
      return c.json({
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        expiresAt: pairing.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof WindowsHostPairingError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.get("/api/windows-hosts", async (c) => {
    const owner = await deps.resolveOwner(c.req.raw);
    if (!owner) return c.json({ error: "Unauthorized" }, 401);
    if (!owner.isDeploymentOwner) return c.json({ error: "Forbidden" }, 403);

    const hosts = await listWindowsHosts(deps.prisma, owner.userId);
    return c.json(
      hosts.map((host) => ({
        ...host,
        revokedAt: host.revokedAt?.toISOString() ?? null,
        lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
        createdAt: host.createdAt.toISOString(),
        updatedAt: host.updatedAt.toISOString(),
      })),
    );
  });

  app.post("/api/windows-hosts/:hostId/revoke", async (c) => {
    const owner = await deps.resolveOwner(c.req.raw);
    if (!owner) return c.json({ error: "Unauthorized" }, 401);
    if (!owner.isDeploymentOwner) return c.json({ error: "Forbidden" }, 403);

    const revoked = await revokeWindowsHost(deps.prisma, {
      ownerUserId: owner.userId,
      hostId: c.req.param("hostId"),
    });
    if (!revoked) return c.json({ error: "Host not found or already revoked" }, 404);
    return c.json({ ok: true as const });
  });

  app.post("/api/windows-host/pair", async (c) => {
    const pairingToken = bearerToken(c.req.header("authorization"));
    if (!pairingToken) return c.json({ error: "Unauthorized" }, 401);

    const parsed = WindowsHostPairingClaimSchema.safeParse(await requiredJson(c.req.raw));
    if (!parsed.success) return c.json({ error: "Invalid pairing claim" }, 400);

    try {
      const paired = await claimWindowsHostPairing(deps.prisma, {
        pairingToken,
        advertisement: parsed.data.advertisement,
      });
      return c.json({
        hostId: paired.host.id,
        hostCredential: paired.hostCredential,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        pairedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof WindowsHostPairingError) {
        return c.json({ error: "Invalid or expired pairing capability" }, 401);
      }
      throw error;
    }
  });

  app.post("/api/windows-host/heartbeat", async (c) => {
    const credential = bearerToken(c.req.header("authorization"));
    if (!credential) return c.json({ error: "Unauthorized" }, 401);

    const parsed = WindowsHostHeartbeatSchema.safeParse(await requiredJson(c.req.raw));
    if (!parsed.success) return c.json({ error: "Invalid heartbeat" }, 400);

    try {
      const state = await recordWindowsHostHeartbeat(deps.prisma, {
        credential,
        heartbeat: parsed.data,
      });
      return c.json({
        ok: true as const,
        serverTime: new Date().toISOString(),
        revoked: state.revoked,
      });
    } catch (error) {
      if (error instanceof WindowsHostAuthenticationError) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (error instanceof WindowsHostReplayError) {
        return c.json({ error: "Stale heartbeat" }, 409);
      }
      throw error;
    }
  });
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function requiredJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function optionalJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-length")) return {};
  return requiredJson(request);
}

function readOptionalPositiveInteger(
  value: unknown,
  key: string,
): number | undefined | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) return null;
  return candidate as number;
}
