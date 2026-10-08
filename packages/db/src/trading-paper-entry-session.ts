import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { auditTradingPaperLifecycleInTransaction } from "./trading-paper-lifecycle-audit.js";
import { assessTradingPaperWorkerWakePreflightInTransaction } from "./trading-paper-worker-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Db = Pick<PrismaClient, "$transaction">;
type Action = "start" | "pause" | "end";
type Status = "active" | "paused" | "ended";
type Request = {
  action: Action;
  ledgerId: string;
  expectedRevision: number;
  durationMinutes: number | null;
};

type Persisted = {
  ledgerId: string;
  spaceId: string;
  userId: string;
  status: string;
  revision: number;
  workerGateRevision: number;
  startedAt: Date;
  expiresAt: Date;
  approvalEffectId: string;
  sessionSha256: string;
};

export class PaperEntrySessionIntegrityError extends Error {
  constructor(message = "PAPER entry session integrity mismatch") {
    super(message);
    this.name = "PaperEntrySessionIntegrityError";
  }
}

export type TradingPaperEntrySessionStatus =
  | { status: "absent"; mode: "paper_only"; ledgerId: string; revision: 0 }
  | {
      status: Status | "expired";
      mode: "paper_only";
      ledgerId: string;
      revision: number;
      workerGateRevision: number;
      startedAt: string;
      expiresAt: string;
      approvalEffectId: string;
    };

export type PaperEntrySessionControlResult =
  | {
      ok: true;
      mode: "paper_only";
      action: Action;
      ledgerId: string;
      revision: number;
      status: Status;
      expiresAt: string;
      workerGateRevision: number;
    }
  | {
      ok: false;
      mode: "paper_only";
      action: Action;
      ledgerId: string;
      reason:
        | "stale_revision"
        | "already_active"
        | "not_active"
        | "worker_denied"
        | "pending_reservations";
      currentRevision: number;
    };

export type PaperEntrySessionEntryPreflight =
  | {
      status: "ready";
      mode: "paper_only";
      ledgerId: string;
      sessionRevision: number;
      workerGateRevision: number;
      expiresAt: string;
      approvalEffectId: string;
    }
  | {
      status: "deny";
      mode: "paper_only";
      ledgerId: string;
      reason:
        | "session_absent"
        | "session_paused_or_ended"
        | "session_expired"
        | "worker_gate_changed"
        | "session_revision_missing";
    };

function parseRequest(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperEntrySessionIntegrityError("Invalid session effect request");
  }
  const row = value as Record<string, unknown>;
  const action = row.action;
  if (action !== "start" && action !== "pause" && action !== "end") {
    throw new PaperEntrySessionIntegrityError("Invalid session action");
  }
  const keys = Object.keys(row).sort();
  const expected =
    action === "start"
      ? ["action", "duration_minutes", "expected_revision", "ledger_id"]
      : ["action", "expected_revision", "ledger_id"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new PaperEntrySessionIntegrityError("Unexpected session approval fields");
  }
  if (
    typeof row.ledger_id !== "string" ||
    row.ledger_id.length < 1 ||
    row.ledger_id.length > 128 ||
    !Number.isSafeInteger(row.expected_revision) ||
    (row.expected_revision as number) < 0
  ) {
    throw new PaperEntrySessionIntegrityError("Invalid session identity or revision");
  }
  const minutes = row.duration_minutes;
  if (
    action === "start" &&
    (!Number.isSafeInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 240)
  ) {
    throw new PaperEntrySessionIntegrityError("Session duration must be 5-240 whole minutes");
  }
  return {
    action,
    ledgerId: row.ledger_id,
    expectedRevision: row.expected_revision as number,
    durationMinutes: action === "start" ? (minutes as number) : null,
  };
}

function sha(row: Omit<Persisted, "sessionSha256">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.ledgerId,
        row.spaceId,
        row.userId,
        row.status,
        row.revision,
        row.workerGateRevision,
        row.startedAt.toISOString(),
        row.expiresAt.toISOString(),
        row.approvalEffectId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function checked(row: Persisted, owner: Owner, ledgerId: string): Persisted & { status: Status } {
  if (
    row.ledgerId !== ledgerId ||
    row.spaceId !== owner.spaceId ||
    row.userId !== owner.userId ||
    (row.status !== "active" && row.status !== "paused" && row.status !== "ended") ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.workerGateRevision) ||
    row.workerGateRevision < 0 ||
    !Number.isFinite(row.startedAt.getTime()) ||
    !Number.isFinite(row.expiresAt.getTime()) ||
    row.expiresAt <= row.startedAt ||
    row.expiresAt.getTime() - row.startedAt.getTime() > 240 * 60_000 ||
    row.sessionSha256 !== sha(row)
  ) {
    throw new PaperEntrySessionIntegrityError();
  }
  return row as Persisted & { status: Status };
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ db_now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS db_now`,
  );
  const now = rows[0]?.db_now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new PaperEntrySessionIntegrityError("Trusted database clock unavailable");
  }
  return now;
}

/** Readers never trust a user-supplied session status or an app-host clock. */
async function readInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  now: Date,
): Promise<TradingPaperEntrySessionStatus> {
  const ledger = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
    select: { id: true },
  });
  if (!ledger) throw new PaperEntrySessionIntegrityError("PAPER ledger unavailable for owner");
  const raw = await tx.tradingPaperEntrySession.findUnique({ where: { ledgerId } });
  if (!raw) return { status: "absent", mode: "paper_only", ledgerId, revision: 0 };
  const row = checked(raw, owner, ledgerId);
  const effect = await tx.externalEffect.findUnique({
    where: { id: row.approvalEffectId },
    include: { run: { select: { spaceId: true, userId: true } } },
  });
  if (
    effect?.status !== "completed" ||
    effect.kind !== "paper_session_control" ||
    effect.spaceId !== owner.spaceId ||
    effect.run.spaceId !== owner.spaceId ||
    effect.run.userId !== owner.userId
  ) {
    throw new PaperEntrySessionIntegrityError("Session missing owner-approved effect");
  }
  const request = parseRequest(effect.request);
  const result = effect.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PaperEntrySessionIntegrityError("Session approval result missing");
  }
  const approved = result as Record<string, unknown>;
  const expectedAction =
    row.status === "active" ? "start" : row.status === "paused" ? "pause" : "end";
  if (
    request.action !== expectedAction ||
    request.ledgerId !== ledgerId ||
    request.expectedRevision !== row.revision - 1 ||
    (row.status === "active" &&
      request.durationMinutes !== (row.expiresAt.getTime() - row.startedAt.getTime()) / 60_000) ||
    approved.ok !== true ||
    approved.action !== expectedAction ||
    approved.ledgerId !== ledgerId ||
    approved.mode !== "paper_only" ||
    approved.revision !== row.revision ||
    approved.status !== row.status ||
    approved.expiresAt !== row.expiresAt.toISOString() ||
    approved.workerGateRevision !== row.workerGateRevision
  ) {
    throw new PaperEntrySessionIntegrityError("Session effect and persisted state differ");
  }
  return {
    status: row.status === "active" && now >= row.expiresAt ? "expired" : row.status,
    mode: "paper_only",
    ledgerId,
    revision: row.revision,
    workerGateRevision: row.workerGateRevision,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    approvalEffectId: row.approvalEffectId,
  };
}

/** Read-only status; no start, recurrence or job scheduling. */
export async function readVerifiedTradingPaperEntrySession(
  prisma: Db,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperEntrySessionStatus> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => readInTransaction(tx, owner, ledgerId, await databaseNow(tx)),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Deny-by-default finite entry lease. Callable by future reserve/fill code
 * inside the SAME serializable transaction as its ledger write. This is not
 * currently wired to a trading writer; no Worker is activated by this function. */
export async function assessTradingPaperEntrySessionInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  expectedSessionRevision?: number,
): Promise<PaperEntrySessionEntryPreflight> {
  const status = await readInTransaction(tx, owner, ledgerId, await databaseNow(tx));
  const deny = (
    reason: Extract<PaperEntrySessionEntryPreflight, { status: "deny" }>["reason"],
  ) => ({ status: "deny" as const, mode: "paper_only" as const, ledgerId, reason });
  if (status.status === "absent") return deny("session_absent");
  if (status.status === "expired") return deny("session_expired");
  if (status.status !== "active") return deny("session_paused_or_ended");
  if (expectedSessionRevision !== undefined && status.revision !== expectedSessionRevision) {
    return deny("worker_gate_changed");
  }
  const worker = await assessTradingPaperWorkerWakePreflightInTransaction(
    tx,
    owner,
    ledgerId,
    await databaseNow(tx),
  );
  if (worker.status !== "ready" || worker.gateRevision !== status.workerGateRevision) {
    return deny("worker_gate_changed");
  }
  return {
    status: "ready",
    mode: "paper_only",
    ledgerId,
    sessionRevision: status.revision,
    workerGateRevision: status.workerGateRevision,
    expiresAt: status.expiresAt,
    approvalEffectId: status.approvalEffectId,
  };
}

/**
 * H1b — optional, explicit session fencing for the new session-aware worker.
 * Locks the SAME owner ledger row used by Start/Pause/End before the final
 * permission check. A transaction that reaches this barrier after Pause has
 * committed cannot create exposure with the previous session revision.
 *
 * No session revision means NO session authority. Legacy callers must be
 * migrated before this becomes the only production automated trading path.
 */
export async function lockAndVerifyTradingPaperEntrySessionInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  expectedSessionRevision?: number,
): Promise<
  PaperEntrySessionEntryPreflight | { status: "legacy_absent"; mode: "paper_only"; ledgerId: string }
> {
  if (
    expectedSessionRevision !== undefined &&
    (!Number.isSafeInteger(expectedSessionRevision) || expectedSessionRevision < 1)
  ) {
    throw new PaperEntrySessionIntegrityError("Invalid expected PAPER entry-session revision");
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "trading_paper_ledgers"
               WHERE "id" = ${ledgerId} AND "spaceId" = ${owner.spaceId}
                 AND "ownerUserId" = ${owner.userId} FOR UPDATE`,
  );
  if (locked.length !== 1 || locked[0]?.id !== ledgerId) {
    throw new PaperEntrySessionIntegrityError("PAPER entry session ledger lock unavailable");
  }
  if (expectedSessionRevision === undefined) {
    const existing = await tx.tradingPaperEntrySession.findUnique({
      where: { ledgerId },
      select: { ledgerId: true },
    });
    return existing
      ? {
          status: "deny" as const,
          mode: "paper_only" as const,
          ledgerId,
          reason: "session_revision_missing" as const,
        }
      : { status: "legacy_absent" as const, mode: "paper_only" as const, ledgerId };
  }
  return assessTradingPaperEntrySessionInTransaction(
    tx,
    owner,
    ledgerId,
    expectedSessionRevision,
  );
}

/** H1 permission writer: ALL calls require a claimed, owner-approved effect.
 * Start issues a finite lease but NEVER schedules or submits a PAPER order.
 * Pause/End fence the entry lease by incrementing the revision; existing
 * positions remain in the ledger for separate protection-only supervision. */
export async function applyApprovedTradingPaperEntrySessionControl(
  prisma: Db,
  owner: Owner,
  effectId: string,
): Promise<PaperEntrySessionControlResult> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx): Promise<PaperEntrySessionControlResult> => {
        const effect = await tx.externalEffect.findUnique({
          where: { id: effectId },
          include: { run: { select: { spaceId: true, userId: true } } },
        });
        if (
          effect?.status !== "executing" ||
          effect.kind !== "paper_session_control" ||
          effect.spaceId !== owner.spaceId ||
          effect.run.spaceId !== owner.spaceId ||
          effect.run.userId !== owner.userId
        ) {
          throw new PaperEntrySessionIntegrityError("Explicit owner session approval required");
        }
        const request = parseRequest(effect.request);
        const owned = await tx.tradingPaperLedger.findFirst({
          where: { id: request.ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
          select: { id: true },
        });
        if (!owned) throw new PaperEntrySessionIntegrityError("PAPER ledger owner mismatch");
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "trading_paper_ledgers"
                     WHERE "id" = ${request.ledgerId} AND "spaceId" = ${owner.spaceId}
                       AND "ownerUserId" = ${owner.userId} FOR UPDATE`,
        );
        if (locked.length !== 1)
          throw new PaperEntrySessionIntegrityError("Ledger lock unavailable");
        const now = await databaseNow(tx);
        const previous = await readInTransaction(tx, owner, request.ledgerId, now);
        const complete = async (result: PaperEntrySessionControlResult) => {
          const updated = await tx.externalEffect.updateMany({
            where: { id: effectId, status: "executing" },
            data: {
              status: "completed",
              result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            },
          });
          if (updated.count !== 1)
            throw new PaperEntrySessionIntegrityError("Approval effect CAS failed");
          return result;
        };
        if (previous.revision !== request.expectedRevision) {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            reason: "stale_revision",
            currentRevision: previous.revision,
          });
        }
        if (request.action === "start" && previous.status === "active") {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            reason: "already_active",
            currentRevision: previous.revision,
          });
        }
        if (
          request.action !== "start" &&
          (previous.status === "absent" || previous.status === "ended")
        ) {
          return complete({
            ok: false,
            mode: "paper_only",
            action: request.action,
            ledgerId: request.ledgerId,
            reason: "not_active",
            currentRevision: previous.revision,
          });
        }
        let workerGateRevision = previous.status === "absent" ? 0 : previous.workerGateRevision;
        let startTime = previous.status === "absent" ? now : new Date(previous.startedAt);
        let expiry = previous.status === "absent" ? now : new Date(previous.expiresAt);
        if (request.action === "start") {
          const wake = await assessTradingPaperWorkerWakePreflightInTransaction(
            tx,
            owner,
            request.ledgerId,
            now,
          );
          if (wake.status !== "ready") {
            return complete({
              ok: false,
              mode: "paper_only",
              action: request.action,
              ledgerId: request.ledgerId,
              reason: "worker_denied",
              currentRevision: previous.revision,
            });
          }
          const lifecycle = await auditTradingPaperLifecycleInTransaction(
            tx,
            owner,
            request.ledgerId,
            now,
          );
          if (lifecycle.openReservations > 0) {
            return complete({
              ok: false,
              mode: "paper_only",
              action: request.action,
              ledgerId: request.ledgerId,
              reason: "pending_reservations",
              currentRevision: previous.revision,
            });
          }
          workerGateRevision = wake.gateRevision;
          startTime = now;
          expiry = new Date(now.getTime() + request.durationMinutes! * 60_000);
        }
        const next = {
          ledgerId: request.ledgerId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          status: (request.action === "start"
            ? "active"
            : request.action === "pause"
              ? "paused"
              : "ended") as Status,
          revision: previous.revision + 1,
          workerGateRevision,
          startedAt: startTime,
          expiresAt: expiry,
          approvalEffectId: effectId,
        };
        const hash = sha(next);
        await tx.tradingPaperEntrySession.upsert({
          where: { ledgerId: request.ledgerId },
          create: { ...next, sessionSha256: hash },
          update: { ...next, sessionSha256: hash },
        });
        return complete({
          ok: true,
          mode: "paper_only",
          action: request.action,
          ledgerId: request.ledgerId,
          revision: next.revision,
          status: next.status,
          expiresAt: expiry.toISOString(),
          workerGateRevision,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
