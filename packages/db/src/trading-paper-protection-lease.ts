import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { verifyTradingPaperSessionSettlingAuthorityInTransaction } from "./trading-paper-entry-session.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { readTradingPaperResolvedResearchFillUseInTransaction } from "./trading-paper-resolved-research-fill-gate.js";
import { verifyTradingPaperStopGuardsInTransaction } from "./trading-paper-stop-guard.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { readTradingPaperWorkerFillUseInTransaction } from "./trading-paper-worker-fill-gate.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
type Action = "start" | "end";
type Request = {
  action: Action;
  ledgerId: string;
  expectedRevision: number;
  durationMinutes?: number;
  cadenceMinutes?: number;
};
type Row = {
  ledgerId: string;
  spaceId: string;
  userId: string;
  enabled: boolean;
  revision: number;
  workerGateRevision: number;
  entryRevision: number;
  cadenceMinutes: number;
  startedAt: Date;
  expiresAt: Date;
  approvalEffectId: string;
  leaseSha256: string;
};

export class PaperProtectionLeaseIntegrityError extends Error {
  constructor(message = "PAPER protection-only approval unavailable or invalid") {
    super(message);
    this.name = "PaperProtectionLeaseIntegrityError";
  }
}

export type TradingPaperProtectionLeaseStatus =
  | { status: "absent"; mode: "paper_only"; ledgerId: string; revision: 0 }
  | {
      status: "active" | "ended" | "expired";
      mode: "paper_only";
      ledgerId: string;
      revision: number;
      workerGateRevision: number;
      entryRevision: number;
      cadenceMinutes: number;
      expiresAt: string;
    };

export type PaperProtectionControlResult =
  | {
      ok: true;
      mode: "paper_only";
      ledgerId: string;
      action: Action;
      revision: number;
      status: "active" | "ended";
      workerGateRevision: number;
      entryRevision: number;
      cadenceMinutes: number;
      expiresAt: string;
    }
  | {
      ok: false;
      mode: "paper_only";
      ledgerId: string;
      action: Action;
      currentRevision: number;
      reason:
        | "stale_revision"
        | "already_active"
        | "not_active"
        | "worker_denied"
        | "entry_not_stopped"
        | "no_protectable_positions"
        | "positions_still_open";
    };

function parseRequest(input: unknown): Request {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PaperProtectionLeaseIntegrityError("Invalid protection approval request");
  }
  const v = input as Record<string, unknown>;
  if (v.action !== "start" && v.action !== "end") {
    throw new PaperProtectionLeaseIntegrityError("Invalid protection control action");
  }
  const keys = Object.keys(v).sort();
  const expected =
    v.action === "start"
      ? ["action", "cadence_minutes", "duration_minutes", "expected_revision", "ledger_id"]
      : ["action", "expected_revision", "ledger_id"];
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) ||
    typeof v.ledger_id !== "string" ||
    v.ledger_id.length < 1 ||
    v.ledger_id.length > 128 ||
    !Number.isSafeInteger(v.expected_revision) ||
    (v.expected_revision as number) < 0 ||
    (v.action === "start" &&
      (!Number.isSafeInteger(v.cadence_minutes) ||
        (v.cadence_minutes as number) < 5 ||
        (v.cadence_minutes as number) > 60 ||
        !Number.isSafeInteger(v.duration_minutes) ||
        (v.duration_minutes as number) < 5 ||
        (v.duration_minutes as number) > 1440))
  ) {
    throw new PaperProtectionLeaseIntegrityError("Invalid scoped protection approval payload");
  }
  return {
    action: v.action as Action,
    ledgerId: v.ledger_id as string,
    expectedRevision: v.expected_revision as number,
    ...(v.action === "start"
      ? {
          cadenceMinutes: v.cadence_minutes as number,
          durationMinutes: v.duration_minutes as number,
        }
      : {}),
  };
}

function digest(v: Omit<Row, "leaseSha256">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        v.ledgerId,
        v.spaceId,
        v.userId,
        v.enabled,
        v.revision,
        v.workerGateRevision,
        v.entryRevision,
        v.cadenceMinutes,
        v.startedAt.toISOString(),
        v.expiresAt.toISOString(),
        v.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ db_now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS db_now`,
  );
  const now = rows[0]?.db_now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PaperProtectionLeaseIntegrityError("Trusted database clock unavailable");
  }
  return now;
}

async function readInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  now: Date,
): Promise<TradingPaperProtectionLeaseStatus> {
  const owned = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!owned)
    throw new PaperProtectionLeaseIntegrityError("PAPER protection ledger owner mismatch");
  const raw = await tx.tradingPaperProtectionLease.findUnique({ where: { ledgerId } });
  if (!raw) return { status: "absent", mode: "paper_only", ledgerId, revision: 0 };
  const row = raw as Row;
  if (
    row.ledgerId !== ledgerId ||
    row.spaceId !== owner.spaceId ||
    row.userId !== owner.userId ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.entryRevision) ||
    row.entryRevision < 1 ||
    !Number.isSafeInteger(row.workerGateRevision) ||
    row.workerGateRevision < 0 ||
    !Number.isSafeInteger(row.cadenceMinutes) ||
    row.cadenceMinutes < 5 ||
    row.cadenceMinutes > 60 ||
    row.expiresAt <= row.startedAt ||
    row.expiresAt.getTime() - row.startedAt.getTime() > 86400_000 ||
    row.leaseSha256 !== digest(row)
  ) {
    throw new PaperProtectionLeaseIntegrityError("Protection lease integrity mismatch");
  }
  const effect = await tx.externalEffect.findUnique({
    where: { id: row.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_protection_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperProtectionLeaseIntegrityError("Protection effect scope mismatch");
  }
  const request = parseRequest(effect.request);
  const result = effect.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PaperProtectionLeaseIntegrityError("Protection effect result missing");
  }
  const approved = result as Record<string, unknown>;
  const action = row.enabled ? "start" : "end";
  if (
    request.action !== action ||
    request.ledgerId !== ledgerId ||
    request.expectedRevision !== row.revision - 1 ||
    (row.enabled &&
      (request.durationMinutes !== (row.expiresAt.getTime() - row.startedAt.getTime()) / 60_000 ||
        request.cadenceMinutes !== row.cadenceMinutes)) ||
    approved.revision !== row.revision ||
    approved.status !== (row.enabled ? "active" : "ended") ||
    approved.workerGateRevision !== row.workerGateRevision ||
    approved.entryRevision !== row.entryRevision ||
    approved.cadenceMinutes !== row.cadenceMinutes ||
    approved.expiresAt !== row.expiresAt.toISOString()
  ) {
    throw new PaperProtectionLeaseIntegrityError("Protection approval disagrees with ledger lease");
  }
  return {
    status: !row.enabled ? "ended" : now >= row.expiresAt ? "expired" : "active",
    mode: "paper_only",
    ledgerId,
    revision: row.revision,
    workerGateRevision: row.workerGateRevision,
    entryRevision: row.entryRevision,
    cadenceMinutes: row.cadenceMinutes,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Read-only, owner-scoped lease status; never schedules a job. */
export async function readVerifiedTradingPaperProtectionLease(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperProtectionLeaseStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async tx => readInTransaction(tx, owner, ledgerId, await dbNow(tx)),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export type PaperProtectionWakePreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      revision: number;
      gateRevision: number;
      cadenceMinutes: number;
      expiresAt: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason: "protection_not_active" | "protection_scope_changed" | "entry_not_stopped"
        | "worker_gate_denied";
    };

/** Independent authority, NOT an entry lease, rechecked every protection wake. */
export async function readTradingPaperProtectionWakePreflight(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
  expectedRevision: number,
  expectedGateRevision: number,
): Promise<PaperProtectionWakePreflight> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      !Number.isSafeInteger(expectedGateRevision) || expectedGateRevision < 0) {
    throw new PaperProtectionLeaseIntegrityError("Malformed protection wake revision");
  }
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperProtectionWakePreflight> => {
        const now = await dbNow(tx);
        const current = await readInTransaction(tx, owner, ledgerId, now);
        const deny = (reason: Extract<PaperProtectionWakePreflight, { status: "deny" }>["reason"]) =>
          ({ status: "deny" as const, mode: "paper_only" as const, ledgerId, reason });
        if (current.status !== "active") return deny("protection_not_active");
        if (current.revision !== expectedRevision ||
            current.workerGateRevision !== expectedGateRevision) {
          return deny("protection_scope_changed");
        }
        const entry = await verifyTradingPaperSessionSettlingAuthorityInTransaction(
          tx, owner, ledgerId,
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("active or absent entry session")) {
            return null;
          }
          throw error;
        });
        if (!entry || entry.sessionRevision < current.entryRevision) {
          return deny("entry_not_stopped");
        }
        const gate = await assessTradingPaperWorkerWakePreflightInTransaction(
          tx, owner, ledgerId, now,
        );
        if (gate.status !== "ready" || gate.gateRevision !== current.workerGateRevision) {
          return deny("worker_gate_denied");
        }
        return {
          status: "ready", mode: "paper_only", ledgerId,
          revision: current.revision,
          gateRevision: current.workerGateRevision,
          cadenceMinutes: current.cadenceMinutes,
          expiresAt: current.expiresAt,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * H2b permission writer. Explicit owner-approved finite protection lease,
 * with no automatic scheduling or trading authorization. An approved Stop
 * is accepted only when no position remains open; cannot silently abandon
 * synthetic stop oversight on an open PAPER position.
 */
export async function applyApprovedTradingPaperProtectionControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperProtectionControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperProtectionControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_protection_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId || effect.run.userId !== owner.userId
        ) {
          throw new PaperProtectionLeaseIntegrityError("Explicit protection owner approval required");
        }
        const request = parseRequest(effect.request);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "trading_paper_ledgers"
                     WHERE "id" = ${request.ledgerId}
                       AND "spaceId" = ${owner.spaceId}
                       AND "ownerUserId" = ${owner.userId} FOR UPDATE`,
        );
        if (locked.length !== 1) {
          throw new PaperProtectionLeaseIntegrityError("Protection ledger lock unavailable");
        }
        const now = await dbNow(tx);
        const previous = await readInTransaction(tx, owner, request.ledgerId, now);
        const complete = async (value: PaperProtectionControlResult) => {
          const cas = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: {
              status: "completed",
              result: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
            },
          });
          if (cas.count !== 1) throw new PaperProtectionLeaseIntegrityError("Effect CAS failed");
          return value;
        };
        const deny = async (
          reason: Extract<PaperProtectionControlResult, { ok: false }>["reason"],
        ) => complete({
          ok: false, mode: "paper_only", ledgerId: request.ledgerId,
          action: request.action, reason, currentRevision: previous.revision,
        });
        if (request.expectedRevision !== previous.revision) return deny("stale_revision");
        if (request.action === "start" && previous.status === "active") return deny("already_active");
        if (request.action === "end" && previous.status !== "active") return deny("not_active");

        const report = await auditTradingPaperLifecycleInTransaction(
          tx, owner, request.ledgerId, now,
        );
        const recovered = await recoverTradingPaperLedgerInTransaction(tx, owner, request.ledgerId);
        if (request.action === "end" && report.openPositions !== 0) {
          return deny("positions_still_open");
        }

        let entryRevision = previous.status === "absent" ? 0 : previous.entryRevision;
        let gateRevision = previous.status === "absent" ? 0 : previous.workerGateRevision;
        let cadence = previous.status === "absent" ? 5 : previous.cadenceMinutes;
        let startedAt = previous.status === "absent" ? now : (await tx.tradingPaperProtectionLease.findUniqueOrThrow({
          where: { ledgerId: request.ledgerId },
          select: { startedAt: true },
        })).startedAt;
        let expiresAt = previous.status === "absent" ? now : new Date(previous.expiresAt);
        if (request.action === "start") {
          const settled = await verifyTradingPaperSessionSettlingAuthorityInTransaction(
            tx, owner, request.ledgerId,
          ).catch((err: unknown) => {
            if (err instanceof Error && err.message.includes("active or absent entry session")) return null;
            throw err;
          });
          if (!settled) return deny("entry_not_stopped");
          const worker = await assessTradingPaperWorkerWakePreflightInTransaction(
            tx, owner, request.ledgerId, now,
          );
          if (worker.status !== "ready") return deny("worker_denied");
          const guards = await verifyTradingPaperStopGuardsInTransaction(
            tx, request.ledgerId, recovered.events, recovered.state,
          );
          if (report.openPositions === 0 || guards?.length !== report.openPositions) {
            return deny("no_protectable_positions");
          }
          for (const position of recovered.state.positions) {
            const [workerFill, resolvedFill] = await Promise.all([
              readTradingPaperWorkerFillUseInTransaction(
                tx, owner, request.ledgerId, position.positionId,
              ),
              readTradingPaperResolvedResearchFillUseInTransaction(
                tx, owner, request.ledgerId, position.positionId,
              ),
            ]);
            if (Boolean(workerFill) === Boolean(resolvedFill)) {
              return deny("no_protectable_positions");
            }
          }
          entryRevision = settled.sessionRevision;
          gateRevision = worker.gateRevision;
          cadence = request.cadenceMinutes!;
          startedAt = now;
          expiresAt = new Date(now.getTime() + request.durationMinutes! * 60_000);
        }
        const next = {
          ledgerId: request.ledgerId, spaceId: owner.spaceId, userId: owner.userId,
          enabled: request.action === "start",
          revision: previous.revision + 1,
          workerGateRevision: gateRevision, entryRevision,
          cadenceMinutes: cadence, startedAt, expiresAt, approvalEffectId: effectId,
        };
        await tx.tradingPaperProtectionLease.upsert({
          where: { ledgerId: request.ledgerId },
          create: { ...next, leaseSha256: digest(next) },
          update: { ...next, leaseSha256: digest(next) },
        });
        return complete({
          ok: true, mode: "paper_only",
          ledgerId: request.ledgerId, action: request.action,
          revision: next.revision,
          status: next.enabled ? "active" : "ended",
          workerGateRevision: gateRevision,
          entryRevision, cadenceMinutes: cadence, expiresAt: expiresAt.toISOString(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
