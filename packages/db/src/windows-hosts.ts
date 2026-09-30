import { createHash, randomBytes } from "node:crypto";
import type {
  WindowsHostAdvertisement,
  WindowsHostHeartbeat,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;

type WindowsHostDb = Pick<
  PrismaClient,
  "windowsHost" | "windowsHostPairing" | "$transaction"
>;

export class WindowsHostPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsHostPairingError";
  }
}

export class WindowsHostAuthenticationError extends Error {
  constructor(message = "Invalid Windows host credential") {
    super(message);
    this.name = "WindowsHostAuthenticationError";
  }
}

export class WindowsHostReplayError extends Error {
  constructor(message = "Stale Windows host heartbeat") {
    super(message);
    this.name = "WindowsHostReplayError";
  }
}

export function hashWindowsHostSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export async function createWindowsHostPairing(
  prisma: WindowsHostDb,
  input: {
    ownerUserId: string;
    ttlMs?: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) {
    throw new WindowsHostPairingError("Invalid Windows host pairing lifetime");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs);
  const pairing = await prisma.windowsHostPairing.create({
    data: {
      ownerUserId: input.ownerUserId,
      tokenHash: hashWindowsHostSecret(token),
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });

  return {
    pairingId: pairing.id,
    pairingToken: token,
    expiresAt: pairing.expiresAt,
  };
}

export async function claimWindowsHostPairing(
  prisma: WindowsHostDb,
  input: {
    pairingToken: string;
    advertisement: WindowsHostAdvertisement;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const tokenHash = hashWindowsHostSecret(input.pairingToken);

  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const pairing = await tx.windowsHostPairing.findUnique({
          where: { tokenHash },
        });
        if (!pairing || pairing.usedAt || pairing.expiresAt <= now) {
          throw new WindowsHostPairingError("Pairing token is invalid, expired, or already used");
        }

        const consumed = await tx.windowsHostPairing.updateMany({
          where: {
            id: pairing.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          throw new WindowsHostPairingError("Pairing token was already consumed");
        }

        const hostCredential = randomBytes(48).toString("base64url");
        const credentialHash = hashWindowsHostSecret(hostCredential);
        const { identity } = input.advertisement;

        const host = await tx.windowsHost.upsert({
          where: { installationId: identity.installationId },
          create: {
            installationId: identity.installationId,
            ownerUserId: pairing.ownerUserId,
            hostname: identity.hostname,
            platform: identity.platform,
            release: identity.release,
            arch: identity.arch,
            protocolVersion: input.advertisement.protocolVersion,
            runtimeVersion: input.advertisement.runtimeVersion,
            capabilities: input.advertisement.capabilities,
            credentialHash,
            lastSeenAt: now,
          },
          update: {
            ownerUserId: pairing.ownerUserId,
            hostname: identity.hostname,
            platform: identity.platform,
            release: identity.release,
            arch: identity.arch,
            protocolVersion: input.advertisement.protocolVersion,
            runtimeVersion: input.advertisement.runtimeVersion,
            capabilities: input.advertisement.capabilities,
            credentialHash,
            revokedAt: null,
            lastSeenAt: now,
            lastConnectionId: null,
            lastSequence: -1,
          },
          select: {
            id: true,
            ownerUserId: true,
            installationId: true,
            createdAt: true,
          },
        });

        return { host, hostCredential };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function recordWindowsHostHeartbeat(
  prisma: WindowsHostDb,
  input: {
    credential: string;
    heartbeat: WindowsHostHeartbeat;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const credentialHash = hashWindowsHostSecret(input.credential);

  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const host = await tx.windowsHost.findFirst({
          where: {
            id: input.heartbeat.hostId,
            credentialHash,
          },
        });
        if (!host) throw new WindowsHostAuthenticationError();

        if (host.revokedAt) {
          return {
            hostId: host.id,
            revoked: true as const,
            lastSeenAt: host.lastSeenAt,
          };
        }

        if (
          host.lastConnectionId === input.heartbeat.connectionId &&
          input.heartbeat.sequence <= host.lastSequence
        ) {
          throw new WindowsHostReplayError();
        }

        const { identity } = input.heartbeat.advertisement;
        const updated = await tx.windowsHost.update({
          where: { id: host.id },
          data: {
            hostname: identity.hostname,
            platform: identity.platform,
            release: identity.release,
            arch: identity.arch,
            protocolVersion: input.heartbeat.advertisement.protocolVersion,
            runtimeVersion: input.heartbeat.advertisement.runtimeVersion,
            capabilities: input.heartbeat.advertisement.capabilities,
            lastSeenAt: now,
            lastConnectionId: input.heartbeat.connectionId,
            lastSequence: input.heartbeat.sequence,
          },
          select: { id: true, lastSeenAt: true },
        });

        return {
          hostId: updated.id,
          revoked: false as const,
          lastSeenAt: updated.lastSeenAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function authenticateWindowsHost(
  prisma: Pick<PrismaClient, "windowsHost">,
  input: { hostId: string; credential: string },
) {
  const credentialHash = hashWindowsHostSecret(input.credential);
  const host = await prisma.windowsHost.findFirst({
    where: {
      id: input.hostId,
      credentialHash,
    },
    select: {
      id: true,
      ownerUserId: true,
      installationId: true,
      revokedAt: true,
      lastSeenAt: true,
    },
  });
  if (!host) throw new WindowsHostAuthenticationError();
  return {
    ...host,
    revoked: host.revokedAt !== null,
  };
}

export async function revokeWindowsHost(
  prisma: Pick<PrismaClient, "windowsHost">,
  input: { ownerUserId: string; hostId: string; now?: Date },
): Promise<boolean> {
  const result = await prisma.windowsHost.updateMany({
    where: {
      id: input.hostId,
      ownerUserId: input.ownerUserId,
      revokedAt: null,
    },
    data: { revokedAt: input.now ?? new Date() },
  });
  return result.count === 1;
}

export async function listWindowsHosts(
  prisma: Pick<PrismaClient, "windowsHost">,
  ownerUserId: string,
) {
  return prisma.windowsHost.findMany({
    where: { ownerUserId },
    orderBy: [{ revokedAt: "asc" }, { lastSeenAt: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      installationId: true,
      hostname: true,
      platform: true,
      release: true,
      arch: true,
      protocolVersion: true,
      runtimeVersion: true,
      capabilities: true,
      revokedAt: true,
      lastSeenAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
