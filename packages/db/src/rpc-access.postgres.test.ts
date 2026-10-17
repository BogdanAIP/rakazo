import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import {
  createOwnedRpcAccessGrant,
  listOwnedRpcAccessGrants,
  resolveRpcAccessGrant,
  revokeOwnedRpcAccessGrant,
} from "./rpc-access.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("finite owner-scoped RPC access against PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let owner: { userId: string; spaceId: string };
  let orgId: string;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 4 });
  });
  beforeEach(async () => {
    const suffix = randomUUID();
    owner = { userId: "rpc-user-" + suffix, spaceId: "rpc-space-" + suffix };
    orgId = "rpc-org-" + suffix;
    await db.prisma.user.create({
      data: {
        id: owner.userId,
        email: owner.userId + "@rakazo.test",
        name: "RPC fixture",
        emailVerified: true,
      },
    });
    await db.prisma.organization.create({
      data: { id: orgId, name: "RPC fixture", slug: orgId, createdAt: new Date() },
    });
    await db.prisma.space.create({
      data: {
        id: owner.spaceId,
        organizationId: orgId,
        name: "RPC fixture",
        createdByUserId: owner.userId,
      },
    });
  });
  afterEach(async () => {
    await db.prisma.organization.deleteMany({ where: { id: orgId } });
    await db.prisma.user.deleteMany({ where: { id: owner.userId } });
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const input = () => ({
    label: "PAPER read fixture",
    durationMinutes: 15,
    procedures: ["trading/perpetualWorkspaceRead" as const],
  });
  it("stores only a hash and binds a token to exact procedures and one owner space", async () => {
    const grant = await createOwnedRpcAccessGrant(db.prisma, owner, input());
    expect(grant.token).toMatch(/^rkg_[A-Za-z0-9_-]{43}$/);
    const stored = await db.prisma.rpcAccessGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(stored.tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(grant.token);
    const listed = await listOwnedRpcAccessGrants(db.prisma, owner);
    expect(JSON.stringify(listed)).not.toContain(grant.token);
    expect(JSON.stringify(listed)).not.toContain("tokenSha256");
    expect(await resolveRpcAccessGrant(db.prisma, grant.token, input().procedures[0]!)).toEqual(
      owner,
    );
    for (const procedure of [
      "computer/exec",
      "rpcAccess/grantCreate",
      "me",
      "trading/perpetualWorkspaceCommand",
    ]) {
      expect(await resolveRpcAccessGrant(db.prisma, grant.token, procedure)).toBeNull();
    }
    expect(
      await resolveRpcAccessGrant(db.prisma, grant.token, input().procedures[0]!, "another-space"),
    ).toBeNull();
    expect(
      await resolveRpcAccessGrant(db.prisma, grant.token + "x", input().procedures[0]!),
    ).toBeNull();
  });
  it("rejects expiry and owner-only revocation immediately without minting a browser session", async () => {
    const grant = await createOwnedRpcAccessGrant(db.prisma, owner, input());
    expect(
      await revokeOwnedRpcAccessGrant(db.prisma, { ...owner, userId: "not-owner" }, grant.id),
    ).toEqual({ revoked: false });
    expect(await resolveRpcAccessGrant(db.prisma, grant.token, input().procedures[0]!)).toEqual(
      owner,
    );
    expect(await revokeOwnedRpcAccessGrant(db.prisma, owner, grant.id)).toEqual({ revoked: true });
    expect(await resolveRpcAccessGrant(db.prisma, grant.token, input().procedures[0]!)).toBeNull();
    const expired = await createOwnedRpcAccessGrant(db.prisma, owner, input());
    await db.prisma.rpcAccessGrant.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    expect(
      await resolveRpcAccessGrant(db.prisma, expired.token, input().procedures[0]!),
    ).toBeNull();
    expect(await db.prisma.session.findFirst({ where: { token: grant.token } })).toBeNull();
  });
  it("refuses unlimited, duplicate or non-PAPER authority", async () => {
    for (const extra of [
      { durationMinutes: 0 },
      { durationMinutes: 20161 },
      { procedures: ["computer/exec"] },
      { procedures: ["rpcAccess/grantCreate"] },
      { procedures: ["trading/list", "trading/list"] },
    ]) {
      await expect(
        createOwnedRpcAccessGrant(db.prisma, owner, { ...input(), ...extra } as Parameters<
          typeof createOwnedRpcAccessGrant
        >[2]),
      ).rejects.toThrow();
    }
    expect(await db.prisma.rpcAccessGrant.count({ where: { ownerUserId: owner.userId } })).toBe(0);
  });
});
