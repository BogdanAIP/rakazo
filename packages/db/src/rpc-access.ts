import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RpcAccessGrantCreate } from "@rakazo/contracts";
import { PAPER_RPC_ACCESS_PROCEDURES, RpcAccessGrantCreateSchema, RpcAccessProceduresSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

type Owner = { userId: string; spaceId: string };
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const grantSelect = {
  id: true,
  label: true,
  spaceId: true,
  procedures: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
} satisfies Prisma.RpcAccessGrantSelect;
type Grant = Prisma.RpcAccessGrantGetPayload<{ select: typeof grantSelect }>;
function dto(row: Grant) {
  return {
    ...row,
    procedures: RpcAccessProceduresSchema.parse(row.procedures),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
async function clock(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row || !Number.isFinite(row.now.getTime())) throw new Error("RPC access clock unavailable");
  return row.now;
}
export async function createOwnedRpcAccessGrant(
  prisma: PrismaClient,
  owner: Owner,
  input: RpcAccessGrantCreate,
) {
  input = RpcAccessGrantCreateSchema.parse(input);
  const token = "rkg_" + randomBytes(32).toString("base64url");
  const result = await prisma.$transaction(async (tx) => {
    const now = await clock(tx);
    if (input.durationMinutes > 20160) {
      const sixMonths = new Date(now);
      sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6);
      const maxMinutes = Math.floor((sixMonths.getTime() - now.getTime()) / 60000);
      if (
        input.label !== "PAPER journal - owner renewed" ||
        input.procedures.length !== PAPER_RPC_ACCESS_PROCEDURES.length ||
        input.procedures.some((procedure) => !PAPER_RPC_ACCESS_PROCEDURES.includes(procedure)) ||
        input.durationMinutes > maxMinutes
      ) throw new Error("Long RPC grant requires the reviewed PAPER journal scope and at most six calendar months");
    }
    return tx.rpcAccessGrant.create({
      data: {
        id: "rpc-grant:" + randomUUID(),
        ownerUserId: owner.userId,
        spaceId: owner.spaceId,
        label: input.label,
        procedures: input.procedures,
        tokenSha256: hashToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + input.durationMinutes * 60000),
      },
      select: grantSelect,
    });
  });
  return { ...dto(result), token };
}
export async function listOwnedRpcAccessGrants(prisma: PrismaClient, owner: Owner) {
  return (
    await prisma.rpcAccessGrant.findMany({
      where: { spaceId: owner.spaceId, ownerUserId: owner.userId },
      orderBy: { createdAt: "desc" },
      select: grantSelect,
    })
  ).map(dto);
}
export async function revokeOwnedRpcAccessGrant(prisma: PrismaClient, owner: Owner, id: string) {
  const result = await prisma.$transaction(async (tx) => {
    const now = await clock(tx);
    return tx.rpcAccessGrant.updateMany({
      where: { id, spaceId: owner.spaceId, ownerUserId: owner.userId, revokedAt: null },
      data: { revokedAt: now },
    });
  });
  return { revoked: result.count === 1 };
}
/** An access grant is not a Better Auth session: it cannot sign in, manage
 * credentials, mint another grant, or select a different user/space. */
export async function resolveRpcAccessGrant(
  prisma: PrismaClient,
  token: string,
  procedure: string,
  requestedSpace?: string | null,
): Promise<Owner | null> {
  if (!/^rkg_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return prisma.$transaction(async (tx) => {
    const row = await tx.rpcAccessGrant.findUnique({ where: { tokenSha256: hashToken(token) } });
    const now = await clock(tx);
    if (
      !row ||
      row.revokedAt ||
      row.expiresAt.getTime() <= now.getTime() ||
      (requestedSpace && requestedSpace !== row.spaceId)
    )
      return null;
    const procedures = RpcAccessProceduresSchema.safeParse(row.procedures);
    if (!procedures.success || !procedures.data.some((allowed) => allowed === procedure))
      return null;
    return { userId: row.ownerUserId, spaceId: row.spaceId };
  });
}
