import { randomUUID } from "node:crypto";
import type {
  TradingPaperAccountCreateInput,
  TradingPaperWorkspaceCommand,
} from "@rakazo/contracts";
import { TradingPaperWorkspaceCommandSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { readOwnedMarketPreparedResearch } from "./market-research-read.js";
import {
  applyApprovedTradingPaperEntrySessionControl,
  readVerifiedTradingPaperEntrySession,
} from "./trading-paper-entry-session.js";
import { auditTradingPaperLifecycle } from "./trading-paper-lifecycle-audit.js";
import { tradingPaperMarketScope } from "./trading-paper-market-choice.js";
import {
  applyApprovedTradingPaperProtectionControl,
  readVerifiedTradingPaperProtectionLease,
} from "./trading-paper-protection-lease.js";
import { applyApprovedTradingPaperResolvedResearchFillControl } from "./trading-paper-resolved-research-fill-gate.js";
import { applyApprovedTradingPaperResolvedResearchControl } from "./trading-paper-resolved-research-gate.js";
import {
  applyApprovedTradingPaperControl,
  createDisabledTradingPaperRiskPolicy,
  lockTradingPaperRiskPolicyInTransaction,
  readVerifiedTradingPaperRiskPolicy,
} from "./trading-paper-risk-policy.js";
import { createTradingPaperLedger, readVerifiedTradingPaperLedger } from "./trading-paper-store.js";
import { applyApprovedTradingPaperWorkerFillControl } from "./trading-paper-worker-fill-gate.js";
import { applyApprovedTradingPaperWorkerControl } from "./trading-paper-worker-gate.js";
import { applyApprovedTradingPaperWorkerMarketTargetControl } from "./trading-paper-worker-market-target.js";
import { applyApprovedTradingPaperWorkerRecurrenceControl } from "./trading-paper-worker-recurrence-gate.js";
import { applyApprovedTradingPaperWorkerSignalControl } from "./trading-paper-worker-signal-gate.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
/** Existing DB approval writers join this outer serializable transaction. No
 * model, private exchange connection or second ledger is involved. */
function transactionDb(tx: Prisma.TransactionClient): PrismaClient {
  return {
    $transaction: async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient;
}
function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error("PAPER control rejected; refresh the account");
  return result as T & { ok: true };
}

export async function createOwnedTradingPaperAccount(
  prisma: PrismaClient,
  owner: Owner,
  input: TradingPaperAccountCreateInput,
): Promise<{ ledgerId: string }> {
  const ledgerId = `paper-account:${randomUUID()}`;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const db = transactionDb(tx);
        const count = await tx.tradingPaperLedger.count({
          where: { spaceId: owner.spaceId, ownerUserId: owner.userId },
        });
        if (count >= 50) throw new Error("PAPER account limit reached");
        await createTradingPaperLedger(db, owner, {
          ledgerId,
          openedAt: new Date().toISOString(),
          quoteCurrency: "USDT",
          initialBalanceQuote: input.initialBalanceQuote,
        });
        await createDisabledTradingPaperRiskPolicy(db, owner, ledgerId, {
          allowedVenues: ["okx", "bingx"],
          quoteCurrency: "USDT",
          maxAgeMs: 60000,
          maxSpreadBps: 40,
          maxTriggerDeviationBps: 50,
          maxPositions: 2,
          maxPerIdeaRiskQuote: input.maxPerIdeaRiskQuote,
          maxDailyLossQuote: input.maxDailyLossQuote,
          maxOpenRiskQuote: input.maxOpenRiskQuote,
          maxTotalExposureQuote: input.maxTotalExposureQuote,
          assumedFeeBpsPerSide: 10,
          assumedSlippageBpsPerSide: 10,
        });
        const bot = await tx.bot.create({
          data: {
            spaceId: owner.spaceId,
            userId: owner.userId,
            name: "PAPER controls",
            color: "",
            archivedAt: new Date(),
          },
        });
        const thread = await tx.thread.create({
          data: { spaceId: owner.spaceId, userId: owner.userId, botId: bot.id },
        });
        await tx.tradingPaperWorkspace.create({
          data: { ledgerId, name: input.name, botId: bot.id, threadId: thread.id },
        });
        return { ledgerId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function commandOwnedTradingPaperWorkspace(
  prisma: PrismaClient,
  owner: Owner,
  input: TradingPaperWorkspaceCommand,
): Promise<{ ledgerId: string; action: TradingPaperWorkspaceCommand["action"]; revision: number }> {
  input = TradingPaperWorkspaceCommandSchema.parse(input);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockTradingPaperRiskPolicyInTransaction(tx, owner, input.ledgerId);
        const lock = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "trading_paper_ledgers" WHERE "id"=${input.ledgerId} AND "spaceId"=${owner.spaceId} AND "ownerUserId"=${owner.userId} FOR UPDATE`,
        );
        if (lock.length !== 1) throw new Error("PAPER account unavailable");
        const workspace = await tx.tradingPaperWorkspace.findUnique({
          where: { ledgerId: input.ledgerId },
        });
        if (!workspace) throw new Error("This ledger is not a managed PAPER account");
        const db = transactionDb(tx);
        const session = await readVerifiedTradingPaperEntrySession(db, owner, input.ledgerId);
        const runId = `paper-ui:${owner.userId}:${input.commandId}`;
        const duplicate = await tx.run.findUnique({
          where: { id: runId },
          include: { effects: true },
        });
        if (duplicate) {
          const effect = duplicate.effects.find((e) => e.kind === "paper_ui_command");
          if (
            !effect ||
            JSON.stringify(TradingPaperWorkspaceCommandSchema.parse(effect.request)) !==
              JSON.stringify(input)
          )
            throw new Error("PAPER command identity conflict");
          const receipt = effect.result as {
            ledgerId: string;
            action: TradingPaperWorkspaceCommand["action"];
            revision: number;
          } | null;
          if (
            effect.status !== "completed" ||
            !receipt ||
            receipt.ledgerId !== input.ledgerId ||
            receipt.action !== input.action ||
            !Number.isSafeInteger(receipt.revision)
          )
            throw new Error("PAPER command receipt invalid");
          return receipt;
        }
        if (session.revision !== input.expectedRevision)
          throw new Error("PAPER session changed; refresh the account");
        const task = await tx.task.create({
          data: {
            spaceId: owner.spaceId,
            userId: owner.userId,
            botId: workspace.botId,
            threadId: workspace.threadId,
            prompt: "PAPER account control",
            status: "completed",
          },
        });
        await tx.run.create({
          data: {
            id: runId,
            spaceId: owner.spaceId,
            userId: owner.userId,
            botId: workspace.botId,
            threadId: workspace.threadId,
            taskId: task.id,
            status: "completed",
            trigger: "user",
          },
        });
        const approve = async (kind: string, request: Prisma.InputJsonValue) => {
          const effect = await tx.externalEffect.create({
            data: {
              spaceId: owner.spaceId,
              runId,
              kind,
              status: "executing",
              idempotencyKey: `${runId}:${kind}`,
              request,
            },
          });
          return effect.id;
        };
        const ledgerId = input.ledgerId;
        let result: { revision: number } | undefined;
        if (input.action === "start") {
          if (session.status === "active") throw new Error("PAPER session already active");
          const report = await auditTradingPaperLifecycle(db, owner, ledgerId);
          if (report.openPositions || report.openReservations)
            throw new Error("Settle the previous PAPER session before starting");
          const protection = await readVerifiedTradingPaperProtectionLease(db, owner, ledgerId);
          if (protection.status === "active" || protection.status === "expired") {
            requireOk(
              await applyApprovedTradingPaperProtectionControl(
                db,
                owner,
                await approve("paper_protection_control", {
                  action: "end",
                  ledger_id: ledgerId,
                  expected_revision: protection.revision,
                }),
              ),
            );
          }
          let policy = await readVerifiedTradingPaperRiskPolicy(db, owner, ledgerId);
          if (!policy.policy.enabled) {
            requireOk(
              await applyApprovedTradingPaperControl(
                db,
                owner,
                await approve("paper_trading_control", {
                  action: "enable",
                  ledger_id: ledgerId,
                  expected_policy_revision: policy.revision,
                }),
              ),
            );
            policy = await readVerifiedTradingPaperRiskPolicy(db, owner, ledgerId);
          }
          const worker = requireOk(
            await applyApprovedTradingPaperWorkerControl(
              db,
              owner,
              await approve("paper_worker_control", {
                action: "enable",
                ledger_id: ledgerId,
                expected_policy_revision: policy.revision,
                cadence_minutes: 5,
              }),
            ),
          );
          requireOk(
            await applyApprovedTradingPaperWorkerMarketTargetControl(
              db,
              owner,
              await approve("paper_worker_market_target_control", {
                action: "enable",
                ledger_id: ledgerId,
                expected_gate_revision: worker.gateRevision,
                venue: input.venue,
                symbol: input.symbol,
              }),
            ),
          );
          const researchSource = input.researchSource ?? { kind: "baseline" as const };
          if (researchSource.kind === "market") {
            const prepared = await readOwnedMarketPreparedResearch(db, owner, {
              semanticKey: researchSource.scope.semanticKey,
              resolverKey: researchSource.scope.resolverKey,
              expectedDigest: researchSource.scope.resolverDigest,
              limit: 50,
            });
            const scope = tradingPaperMarketScope(prepared, input.venue);
            if (JSON.stringify(scope) !== JSON.stringify(researchSource.scope))
              throw new Error("PAPER Market selection changed; review the current Skill");
            const gate = requireOk(
              await applyApprovedTradingPaperResolvedResearchControl(
                db,
                owner,
                await approve("paper_resolved_research_control", {
                  action: "enable",
                  ledger_id: ledgerId,
                  expected_gate_revision: worker.gateRevision,
                  scope,
                }),
              ),
            );
            requireOk(
              await applyApprovedTradingPaperResolvedResearchFillControl(
                db,
                owner,
                await approve("paper_resolved_research_fill_control", {
                  action: "enable",
                  ledger_id: ledgerId,
                  expected_gate_revision: worker.gateRevision,
                  expected_research_revision: gate.researchRevision,
                  scope,
                }),
              ),
            );
          } else {
            const signal = requireOk(
              await applyApprovedTradingPaperWorkerSignalControl(
                db,
                owner,
                await approve("paper_worker_signal_control", {
                  action: "enable",
                  ledger_id: ledgerId,
                  expected_gate_revision: worker.gateRevision,
                  strategy_id: "breakout_20_1h_v1",
                }),
              ),
            );
            requireOk(
              await applyApprovedTradingPaperWorkerFillControl(
                db,
                owner,
                await approve("paper_worker_fill_control", {
                  action: "enable",
                  ledger_id: ledgerId,
                  expected_gate_revision: worker.gateRevision,
                  expected_signal_revision: signal.signalRevision,
                  strategy_id: "breakout_20_1h_v1",
                }),
              ),
            );
          }
          requireOk(
            await applyApprovedTradingPaperWorkerRecurrenceControl(
              db,
              owner,
              await approve("paper_worker_recurrence_control", {
                action: "enable",
                ledger_id: ledgerId,
                expected_gate_revision: worker.gateRevision,
              }),
            ),
          );
          const started = requireOk(
            await applyApprovedTradingPaperEntrySessionControl(
              db,
              owner,
              await approve("paper_session_control", {
                action: "start",
                ledger_id: ledgerId,
                expected_revision: session.revision,
                duration_minutes: input.durationMinutes,
              }),
            ),
          );
          // Start explicitly includes automatic fencing after worker restart.
          const stopEffectId = await tx.externalEffect.create({
            data: {
              spaceId: owner.spaceId,
              runId,
              kind: "paper_session_control",
              status: "executing",
              idempotencyKey: `${runId}:restart-pause`,
              request: {
                action: "pause",
                ledger_id: ledgerId,
                expected_revision: started.revision,
              },
            },
          });
          await tx.tradingPaperWorkspace.update({
            where: { ledgerId },
            data: {
              stopEffectId: stopEffectId.id,
              sessionRevision: started.revision,
              researchSource: JSON.parse(JSON.stringify(researchSource)) as Prisma.InputJsonValue,
              runtimeError: null,
            },
          });
          result = started;
        } else if (input.action === "pause" || input.action === "end") {
          result = requireOk(
            await applyApprovedTradingPaperEntrySessionControl(
              db,
              owner,
              await approve("paper_session_control", {
                action: input.action,
                ledger_id: ledgerId,
                expected_revision: session.revision,
              }),
            ),
          );
          await tx.tradingPaperWorkspace.update({
            where: { ledgerId },
            data: { runtimeError: null },
          });
        } else if (input.action === "protect") {
          const protection = await readVerifiedTradingPaperProtectionLease(db, owner, ledgerId);
          if (input.expectedProtectionRevision !== protection.revision)
            throw new Error("PAPER protection changed; refresh the account");
          result = requireOk(
            await applyApprovedTradingPaperProtectionControl(
              db,
              owner,
              await approve("paper_protection_control", {
                action: "start",
                ledger_id: ledgerId,
                expected_revision: protection.revision,
                duration_minutes: input.durationMinutes,
                cadence_minutes: 5,
              }),
            ),
          );
          await tx.tradingPaperWorkspace.update({
            where: { ledgerId },
            data: {
              firstProtectionScheduledFor: new Date(),
              lastProtectionHandledFor: null,
              runtimeError: null,
            },
          });
        }
        if (!result) throw new Error("PAPER command unavailable");
        const receipt = { ledgerId, action: input.action, revision: result.revision };
        await tx.externalEffect.create({
          data: {
            spaceId: owner.spaceId,
            runId,
            kind: "paper_ui_command",
            status: "completed",
            idempotencyKey: `${runId}:command`,
            request: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue,
            result: receipt,
          },
        });
        return receipt;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
    ),
  );
}

export async function pauseOwnedTradingPaperWorkspaceAfterRestart(
  prisma: PrismaClient,
  owner: Owner,
  ledgerId: string,
  expectedRevision?: number,
): Promise<void> {
  const workspace = await prisma.tradingPaperWorkspace.findUnique({ where: { ledgerId } });
  if (
    !workspace?.stopEffectId ||
    (expectedRevision !== undefined && workspace.sessionRevision !== expectedRevision)
  )
    return;
  const session = await readVerifiedTradingPaperEntrySession(prisma, owner, ledgerId);
  if (session.status !== "active" || session.revision !== workspace.sessionRevision) return;
  await applyApprovedTradingPaperEntrySessionControl(prisma, owner, workspace.stopEffectId);
}

export async function readOwnedTradingPaperWorkspace(
  prisma: PrismaClient,
  owner: Owner,
  ledgerId: string,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const owned = await tx.tradingPaperLedger.findFirst({
          where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
          select: { id: true },
        });
        if (!owned) return null;
        const workspace = await tx.tradingPaperWorkspace.findUnique({ where: { ledgerId } });
        if (!workspace) return null;
        const db = transactionDb(tx);
        try {
          const session = await readVerifiedTradingPaperEntrySession(db, owner, ledgerId);
          const protection = await readVerifiedTradingPaperProtectionLease(db, owner, ledgerId);
          const policy = await readVerifiedTradingPaperRiskPolicy(db, owner, ledgerId);
          await auditTradingPaperLifecycle(db, owner, ledgerId);
          const state = await readVerifiedTradingPaperLedger(db, owner, ledgerId);
          const phase = workspace.runtimeError
            ? "attention_required"
            : session.status === "active"
              ? "active"
              : state.reservations.length
                ? "settling"
                : state.positions.length
                  ? protection.status === "active" && !workspace.runtimeError
                    ? "protection_only"
                    : "attention_required"
                  : session.status === "absent"
                    ? "idle"
                    : "finished";
          return {
            status: "verified" as const,
            mode: "paper_only" as const,
            ledgerId,
            name: workspace.name,
            sessionStatus: session.status,
            sessionRevision: session.revision,
            expiresAt: session.status === "absent" ? null : session.expiresAt,
            protectionStatus: protection.status,
            protectionRevision: protection.revision,
            protectionExpiresAt: protection.status === "absent" ? null : protection.expiresAt,
            phase,
            policy: policy.policy,
            openPositions: state.positions.length,
            openReservations: state.reservations.length,
            runtimeError: workspace.runtimeError,
          };
        } catch (error) {
          if (error instanceof Error && /Integrity|Audit/.test(error.name))
            return { status: "integrity_blocked" as const, mode: "paper_only" as const, ledgerId };
          throw error;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
