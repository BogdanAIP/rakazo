import type { JobPublisher } from "@rakazo/adapter-kit";
import { paperProtectionCheckJob } from "@rakazo/adapter-kit";
import type { TradingPaperWorkspaceCommand } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  commandOwnedTradingPaperWorkspace,
  pauseOwnedTradingPaperWorkspaceAfterRestart,
  prepareTradingPaperProtectionSuccessorIntent,
  readTradingPaperProtectionWakePreflight,
  readVerifiedTradingPaperEntrySession,
  readVerifiedTradingPaperProtectionLease,
  settleVerifiedTradingPaperSessionReservations,
} from "@rakazo/db";
import { enqueuePaperWorkerPreflightOnce } from "./paper-worker-scheduler.js";

type Owner = { spaceId: string; userId: string };
type Deps = { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> };

/** Human API calls are the only initial-entry publisher. Queue failure fences
 * the committed session before returning; retries cannot extend its deadline. */
export async function controlTradingPaperWorkspace(
  deps: Deps,
  owner: Owner,
  input: TradingPaperWorkspaceCommand,
): Promise<void> {
  const receipt = await commandOwnedTradingPaperWorkspace(deps.prisma, owner, input);
  try {
    if (input.action === "start") {
      const session = await readVerifiedTradingPaperEntrySession(
        deps.prisma,
        owner,
        input.ledgerId,
      );
      if (session.status !== "active" || session.revision !== receipt.revision) return;
      const result = await enqueuePaperWorkerPreflightOnce(deps, {
        ...owner,
        ledgerId: input.ledgerId,
        expectedGateRevision: session.workerGateRevision,
        expectedSessionRevision: session.revision,
        // Pin the first tick to the original Start; retries never postpone it.
        now: new Date(session.startedAt),
      });
      if (result.status !== "enqueued") throw new Error("PAPER first wake denied");
    } else if (input.action === "protect") {
      await recoverTradingPaperProtectionQueue(deps, owner, input.ledgerId);
    } else {
      await settleVerifiedTradingPaperSessionReservations(deps.prisma, owner, input.ledgerId);
    }
  } catch (error) {
    if (input.action === "start")
      await pauseOwnedTradingPaperWorkspaceAfterRestart(deps.prisma, owner, input.ledgerId);
    await deps.prisma.tradingPaperWorkspace.update({
      where: { ledgerId: input.ledgerId },
      data: { runtimeError: "queue_or_settlement_unavailable" },
    });
    throw error;
  }
}

/** Requeue the exact persisted protection tick only after fresh authority
 * verification. Completed ticks are skipped; immutable successor replay is
 * verified by the existing H2b planner. Never restarts entry work. */
export async function recoverTradingPaperProtectionQueue(
  deps: Deps,
  owner: Owner,
  ledgerId: string,
): Promise<void> {
  const lease = await readVerifiedTradingPaperProtectionLease(deps.prisma, owner, ledgerId);
  if (lease.status !== "active") return;
  const check = await readTradingPaperProtectionWakePreflight(
    deps.prisma,
    owner,
    ledgerId,
    lease.revision,
    lease.workerGateRevision,
  );
  if (check.status !== "ready") return;
  const workspace = await deps.prisma.tradingPaperWorkspace.findUniqueOrThrow({
    where: { ledgerId },
  });
  let scheduledFor = workspace.firstProtectionScheduledFor;
  const latest = await deps.prisma.tradingPaperProtectionSuccessorIntent.findFirst({
    where: { ledgerId, leaseRevision: lease.revision },
    orderBy: { successorScheduledFor: "desc" },
  });
  if (latest) {
    const verified = await prepareTradingPaperProtectionSuccessorIntent(deps.prisma, owner, {
      ledgerId,
      leaseRevision: lease.revision,
      gateRevision: lease.workerGateRevision,
      sourceScheduledFor: latest.sourceScheduledFor.toISOString(),
    });
    if (verified.status === "stop") return;
    scheduledFor = new Date(verified.successorScheduledFor);
  }
  if (
    !scheduledFor ||
    (workspace.lastProtectionHandledFor && scheduledFor <= workspace.lastProtectionHandledFor)
  )
    return;
  if (scheduledFor.getTime() >= Date.parse(lease.expiresAt)) return;
  await deps.jobs.enqueue(
    paperProtectionCheckJob({
      ...owner,
      ledgerId,
      gateRevision: lease.workerGateRevision,
      leaseRevision: lease.revision,
      scheduledFor,
    }),
  );
  await deps.prisma.tradingPaperWorkspace.update({
    where: { ledgerId },
    data: { runtimeError: null },
  });
}

/** Existing global reconciler calls this after process restart and every
 * reconciliation pass. Active entries are paused on restart; only separately
 * approved protective ticks may be recovered. Expiry never forces a sale. */
export async function reconcileTradingPaperWorkspaces(
  deps: Deps,
  restarting = false,
): Promise<void> {
  let afterLedger: string | undefined;
  for (;;) {
    const workspaces = await deps.prisma.tradingPaperWorkspace.findMany({
      take: 100,
      ...(afterLedger ? { where: { ledgerId: { gt: afterLedger } } } : {}),
      orderBy: { ledgerId: "asc" },
      include: { ledger: { select: { spaceId: true, ownerUserId: true } } },
    });
    for (const workspace of workspaces) {
      const owner = { spaceId: workspace.ledger.spaceId, userId: workspace.ledger.ownerUserId };
      try {
        if (restarting)
          await pauseOwnedTradingPaperWorkspaceAfterRestart(deps.prisma, owner, workspace.ledgerId);
        const session = await readVerifiedTradingPaperEntrySession(
          deps.prisma,
          owner,
          workspace.ledgerId,
        );
        if (
          session.status === "paused" ||
          session.status === "ended" ||
          session.status === "expired"
        ) {
          await settleVerifiedTradingPaperSessionReservations(
            deps.prisma,
            owner,
            workspace.ledgerId,
          );
          await recoverTradingPaperProtectionQueue(deps, owner, workspace.ledgerId);
        }
      } catch {
        await deps.prisma.tradingPaperWorkspace.update({
          where: { ledgerId: workspace.ledgerId },
          data: { runtimeError: "reconciliation_unavailable" },
        });
      }
    }
    if (workspaces.length < 100) break;
    afterLedger = workspaces.at(-1)!.ledgerId;
  }
}
