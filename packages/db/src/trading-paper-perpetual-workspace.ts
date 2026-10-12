import { createHash, randomUUID } from "node:crypto";
import type {
  MarketResolverPreparedResearch,
  PaperPerpetualCommand,
  PaperPerpetualDecision,
  PaperPerpetualSource,
  PaperPerpetualWorkspaceStatus,
  PaperVenueLeverageLimits,
  PerpetualControl,
} from "@rakazo/contracts";
import {
  PaperPerpetualCommandSchema,
  PaperPerpetualDecisionSchema,
  PaperPerpetualSourceSchema,
  PerpetualControlSchema,
} from "@rakazo/contracts";
import {
  evaluatePaperLeverage,
  formatPaperPerpetualAmount,
  getPaperExperimentPreset,
  PAPER_EXPERIMENT_STRATEGIES,
  paperPerpetualAmount,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { readOwnedMarketPreparedResearch } from "./market-research-read.js";
import {
  createDisabledPerpetualPaperAccount,
  PerpetualPaperIntegrityError,
  recoverPerpetualPaperInTransaction,
} from "./trading-paper-perpetual-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type PerpetualOwner = { spaceId: string; userId: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, canonical(row[key])]),
    );
  }
  return value;
}
export const perpetualPaperHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
export const perpetualPaperJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function perpetualTransactionDb(tx: Prisma.TransactionClient): PrismaClient {
  return {
    $transaction: async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient;
}
export function parsePerpetualControl(row: {
  control: unknown;
  controlSha256: string;
}): PerpetualControl {
  if (perpetualPaperHash(row.control) !== row.controlSha256)
    throw new PerpetualPaperIntegrityError("Futures control integrity failed");
  return PerpetualControlSchema.parse(row.control);
}
export async function perpetualDatabaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!row || !Number.isFinite(row.now.getTime()))
    throw new Error("Futures trusted clock unavailable");
  return row.now;
}
export async function lockOwnedPerpetualWorkspace(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  ledgerId: string,
) {
  const locked = await tx.$queryRaw<Array<{ ledgerId: string }>>(Prisma.sql`
    SELECT w."ledgerId" FROM "trading_paper_perpetual_workspaces" w
    JOIN "trading_paper_perpetual_ledgers" l ON l.id=w."ledgerId"
    WHERE w."ledgerId"=${ledgerId} AND l."spaceId"=${owner.spaceId} AND l."ownerUserId"=${owner.userId}
    FOR UPDATE OF w, l
  `);
  if (locked.length !== 1) throw new PerpetualPaperIntegrityError("Futures workspace unavailable");
  const row = await tx.tradingPaperPerpetualWorkspace.findUniqueOrThrow({ where: { ledgerId } });
  return { row, control: parsePerpetualControl(row) };
}
export function perpetualMarketSource(
  prepared: MarketResolverPreparedResearch,
): PaperPerpetualSource {
  const { selection, provenance, skillContent } = prepared;
  if (
    selection.status !== "ready" ||
    !selection.skill ||
    !provenance ||
    !skillContent?.trim() ||
    provenance.semanticKey !== "futures.data" ||
    !selection.implementation.readOnly
  ) {
    throw new Error("Read-only futures Market Skill unavailable");
  }
  if (!/okx/i.test(selection.implementation.reference))
    throw new Error("An OKX public Market route is required");
  return PaperPerpetualSourceSchema.parse({
    semanticKey: "futures.data",
    resolverKey: provenance.resolverKey,
    resolverDigest: provenance.resolverDigest,
    skillKey: selection.skill.key,
    skillDigest: selection.skill.digest,
    skillVariant: selection.skill.variant,
    contentSha256: createHash("sha256").update(skillContent, "utf8").digest("hex"),
    implementationReference: selection.implementation.reference,
  });
}
export async function verifyPerpetualSource(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  source: PaperPerpetualSource,
) {
  const prepared = await readOwnedMarketPreparedResearch(perpetualTransactionDb(tx), owner, {
    semanticKey: source.semanticKey,
    resolverKey: source.resolverKey,
    expectedDigest: source.resolverDigest,
    limit: 50,
  });
  if (perpetualPaperHash(perpetualMarketSource(prepared)) !== perpetualPaperHash(source)) {
    throw new Error("Futures Market Skill changed; review a new Start");
  }
  return prepared;
}
const initialControl = (): PerpetualControl => ({
  maxLeverage: null,
  sessionStatus: "idle",
  startedAt: null,
  expiresAt: null,
  protectionExpiresAt: null,
  instruments: [],
  source: null,
  orders: [],
  plans: [],
  closeAll: false,
  runtimeError: null,
  lastResearchAt: null,
  lastDecision: null,
});
/** Creates missing profiles only. It never tops up an existing account or starts jobs. */
export async function createOwnedPerpetualExperimentAccounts(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  strategies: readonly PaperPerpetualWorkspaceStatus["strategy"][] = PAPER_EXPERIMENT_STRATEGIES,
) {
  if (
    !strategies.length ||
    new Set(strategies).size !== strategies.length ||
    strategies.some((strategy) => !PAPER_EXPERIMENT_STRATEGIES.includes(strategy))
  )
    throw new Error("Invalid PAPER strategy selection");
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('perpetual-experiments'), hashtext(${JSON.stringify(owner)}))`;
        const existing = await tx.tradingPaperPerpetualLedger.findMany({
          where: { spaceId: owner.spaceId, ownerUserId: owner.userId, workspace: { isNot: null } },
          orderBy: { openedAt: "asc" },
          select: { id: true, strategy: true },
        });
        const accounts: Array<{
          ledgerId: string;
          strategy: "conservative" | "moderate" | "aggressive";
        }> = [];
        for (const strategy of strategies) {
          const found = existing.find((row) => row.strategy === strategy);
          if (found) {
            accounts.push({ ledgerId: found.id, strategy });
            continue;
          }
          const ledgerId = "paper-futures:" + randomUUID();
          const now = await perpetualDatabaseClock(tx);
          await createDisabledPerpetualPaperAccount(perpetualTransactionDb(tx), owner, {
            ledgerId,
            strategy,
            openedAt: now.toISOString(),
          });
          const bot = await tx.bot.create({
            data: {
              spaceId: owner.spaceId,
              userId: owner.userId,
              name: "PAPER futures controls",
              color: "",
              archivedAt: now,
            },
          });
          const thread = await tx.thread.create({
            data: { spaceId: owner.spaceId, userId: owner.userId, botId: bot.id },
          });
          const control = {
            ...initialControl(),
            maxLeverage: getPaperExperimentPreset(strategy).maxLeverage,
          };
          await tx.tradingPaperPerpetualWorkspace.create({
            data: {
              ledgerId,
              botId: bot.id,
              threadId: thread.id,
              control: perpetualPaperJson(control),
              controlSha256: perpetualPaperHash(control),
            },
          });
          accounts.push({ ledgerId, strategy });
        }
        return { mode: "paper_only" as const, accounts };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
export async function savePerpetualControl(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  revision: number,
  control: PerpetualControl,
  nextScheduledFor: Date | null,
) {
  const changed = await tx.tradingPaperPerpetualWorkspace.updateMany({
    where: { ledgerId, revision },
    data: {
      control: perpetualPaperJson(control),
      controlSha256: perpetualPaperHash(control),
      nextScheduledFor,
    },
  });
  if (changed.count !== 1) throw new Error("Futures control revision changed");
}
export async function commandOwnedPerpetualWorkspace(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  input: PaperPerpetualCommand,
  limits: readonly PaperVenueLeverageLimits[] = [],
) {
  input = PaperPerpetualCommandSchema.parse(input);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, control } = await lockOwnedPerpetualWorkspace(tx, owner, input.ledgerId);
        const { state } = await recoverPerpetualPaperInTransaction(tx, owner, input.ledgerId);
        const requestHash = perpetualPaperHash(input);
        const duplicate = await tx.tradingPaperPerpetualCommand.findUnique({
          where: { ledgerId_commandId: { ledgerId: input.ledgerId, commandId: input.commandId } },
        });
        if (duplicate) {
          if (
            duplicate.requestSha256 !== requestHash ||
            perpetualPaperHash(duplicate.request) !== requestHash
          )
            throw new Error("Conflicting futures command retry");
          return { revision: duplicate.revision };
        }
        if (row.revision !== input.expectedRevision)
          throw new Error("Futures session changed; refresh the account");
        const now = await perpetualDatabaseClock(tx);
        const clock = now.getTime();
        if (input.action === "set_leverage") {
          for (const instrument of input.instruments) {
            const evidence = limits.find((l) => l.instrument === instrument);
            const gross = state.openPositions
              .filter((p) => p.instrument === instrument)
              .reduce((sum, p) => sum + paperPerpetualAmount(p.quantityBase), 0n);
            const result = evaluatePaperLeverage({
              venue: input.venue,
              instrument,
              marginMode: "cross",
              requestedLeverage: input.maxLeverage,
              ownerMaxLeverage: input.maxLeverage,
              existingQuantityBase: formatPaperPerpetualAmount(gross),
              proposedQuantityBase: "0",
              limits: evidence ?? null,
              now: now.toISOString(),
            });
            if (result.status !== "allowed") throw new Error("Futures leverage setting refused");
          }
          control.maxLeverage = input.maxLeverage;
          control.orders = [];
          control.lastResearchAt = null;
        } else if (input.action === "start") {
          if (
            control.sessionStatus === "active" &&
            control.expiresAt &&
            Date.parse(control.expiresAt) > clock
          )
            throw new Error("Futures session already active");
          if (state.openPositions.length || control.orders.length || control.closeAll)
            throw new Error("Settle the previous futures positions before a new Start");
          await verifyPerpetualSource(tx, owner, input.source);
          control.sessionStatus = "active";
          control.startedAt ??= now.toISOString();
          control.expiresAt = new Date(clock + input.durationMinutes * 60000).toISOString();
          control.protectionExpiresAt = new Date(
            Date.parse(control.expiresAt) + input.protectionMinutes * 60000,
          ).toISOString();
          control.instruments = input.instruments;
          control.source = input.source;
          control.plans = [];
          control.lastResearchAt = null;
        } else if (input.action === "protect") {
          if (!state.openPositions.length) throw new Error("No futures positions need protection");
          control.protectionExpiresAt = new Date(
            Math.max(
              clock + input.durationMinutes * 60000,
              Date.parse(control.protectionExpiresAt ?? now.toISOString()),
            ),
          ).toISOString();
        } else {
          control.sessionStatus = input.action === "pause" ? "paused" : "ended";
          control.orders = [];
          if (input.action !== "close_all" && control.protectionExpiresAt) {
            control.protectionExpiresAt = new Date(
              Math.min(Date.parse(control.protectionExpiresAt), clock + 1440 * 60000),
            ).toISOString();
          }
          if (input.action === "close_all") {
            control.closeAll = true;
            control.protectionExpiresAt = new Date(clock + 15 * 60000).toISOString();
          }
        }
        control.runtimeError = null;
        const revision = row.revision + 1;
        const needsWake =
          control.sessionStatus === "active" ||
          (state.openPositions.length > 0 &&
            control.protectionExpiresAt &&
            Date.parse(control.protectionExpiresAt) > clock);
        const next = needsWake ? now : null;
        await tx.tradingPaperPerpetualWorkspace.update({
          where: { ledgerId: row.ledgerId },
          data: {
            revision,
            control: perpetualPaperJson(control),
            controlSha256: perpetualPaperHash(control),
            nextScheduledFor: next,
          },
        });
        await tx.tradingPaperPerpetualCommand.create({
          data: {
            ledgerId: input.ledgerId,
            commandId: input.commandId,
            request: perpetualPaperJson(input),
            requestSha256: requestHash,
            revision,
          },
        });
        return { revision };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
export async function readOwnedPerpetualWorkspace(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
): Promise<PaperPerpetualWorkspaceStatus | null> {
  return prisma.$transaction(
    async (tx) => {
      const ledger = await tx.tradingPaperPerpetualLedger.findFirst({
        where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
      });
      if (!ledger) return null;
      const base = {
        mode: "paper_only" as const,
        ledgerId,
        strategy: ledger.strategy as PaperPerpetualWorkspaceStatus["strategy"],
      };
      try {
        const recovered = await recoverPerpetualPaperInTransaction(tx, owner, ledgerId);
        const row = await tx.tradingPaperPerpetualWorkspace.findUnique({ where: { ledgerId } });
        const control = row ? parsePerpetualControl(row) : initialControl();
        const now = await perpetualDatabaseClock(tx);
        const active =
          control.sessionStatus === "active" &&
          control.expiresAt !== null &&
          Date.parse(control.expiresAt) > now.getTime();
        const protectedPositions =
          recovered.state.openPositions.length > 0 &&
          control.protectionExpiresAt !== null &&
          Date.parse(control.protectionExpiresAt) > now.getTime();
        return {
          ...base,
          status: "verified" as const,
          revision: row?.revision ?? 0,
          managed: !!row,
          startedAt: control.startedAt,
          sessionStatus:
            control.sessionStatus === "active" && !active ? "expired" : control.sessionStatus,
          phase:
            control.runtimeError ||
            (recovered.state.openPositions.length > 0 && !protectedPositions)
              ? "attention_required"
              : active
                ? "active"
                : protectedPositions
                  ? "protection_only"
                  : control.startedAt
                    ? "finished"
                    : "idle",
          expiresAt: control.expiresAt,
          protectionExpiresAt: control.protectionExpiresAt,
          runtimeError: control.runtimeError,
          instruments: control.instruments,
          lastDecision: control.lastDecision,
          openOrders: control.orders.map((o) => ({
            orderId: o.orderId,
            instrument: o.proposal.instrument,
            side: o.proposal.side,
            orderType: o.proposal.orderType,
            quantityBase: o.proposal.quantityBase,
            limitPriceQuote: o.proposal.limitPriceQuote,
            expiresAt: o.expiresAt,
          })),
          executionFees:
            recovered.engineConfig?.instruments.map(
              ({ instrument, makerFeeRate, takerFeeRate }) => ({
                instrument,
                makerFeeRate,
                takerFeeRate,
              }),
            ) ?? [],
          recoveryReservations: control.plans.map((p) => ({
            positionId: p.positionId,
            reservedNotionalQuote: p.recoveryReserveQuote,
            reservedStopRiskQuote: p.recoveryReservedRiskQuote,
            stages: p.recoverySteps.map((step) => ({
              stepId: step.stepId,
              triggerPriceQuote: step.triggerPriceQuote,
              maximumNotionalQuote: step.maximumNotionalQuote,
              remainingNotionalQuote: step.remainingNotionalQuote,
              activatedAt: step.activatedAt,
            })),
          })),
          pendingClose: control.closeAll,
          maxLeverage: control.maxLeverage ?? getPaperExperimentPreset(base.strategy).maxLeverage,
        };
      } catch {
        return {
          ...base,
          status: "integrity_blocked" as const,
          revision: 0,
          managed: false,
          startedAt: null,
          sessionStatus: "paused",
          phase: "attention_required",
          expiresAt: null,
          protectionExpiresAt: null,
          runtimeError: "integrity_blocked",
          instruments: [],
          lastDecision: null,
          openOrders: [],
          pendingClose: false,
          maxLeverage: getPaperExperimentPreset(base.strategy).maxLeverage,
        };
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
export async function readPerpetualWake(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
  revision: number,
  scheduledFor: string,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, control } = await lockOwnedPerpetualWorkspace(tx, owner, ledgerId);
        const { state, engineConfig } = await recoverPerpetualPaperInTransaction(
          tx,
          owner,
          ledgerId,
        );
        const now = await perpetualDatabaseClock(tx);
        if (
          row.revision !== revision ||
          row.nextScheduledFor?.toISOString() !== scheduledFor ||
          Date.parse(scheduledFor) > now.getTime()
        )
          return null;
        const entries =
          control.sessionStatus === "active" &&
          control.expiresAt !== null &&
          Date.parse(control.expiresAt) > now.getTime();
        const protects =
          state.openPositions.length > 0 &&
          control.protectionExpiresAt !== null &&
          Date.parse(control.protectionExpiresAt) > now.getTime();
        if (!entries && !protects) {
          await savePerpetualControl(tx, ledgerId, revision, { ...control, orders: [] }, null);
          return null;
        }
        return { row, control, state, engineConfig, entries, now };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
export async function failPerpetualWake(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
  revision: number,
  error: string,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const result = await lockOwnedPerpetualWorkspace(tx, owner, ledgerId);
        if (result.row.revision !== revision) return;
        const control = result.control;
        control.sessionStatus = "paused";
        control.orders = [];
        control.runtimeError = error;
        const now = await perpetualDatabaseClock(tx);
        const { state } = await recoverPerpetualPaperInTransaction(tx, owner, ledgerId);
        const next =
          state.openPositions.length &&
          control.protectionExpiresAt &&
          Date.parse(control.protectionExpiresAt) > now.getTime()
            ? new Date(now.getTime() + 60000)
            : null;
        await savePerpetualControl(tx, ledgerId, revision, control, next);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
export async function pausePerpetualAfterRestart(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, control } = await lockOwnedPerpetualWorkspace(tx, owner, ledgerId);
        if (control.sessionStatus !== "active") return;
        control.sessionStatus = "paused";
        control.orders = [];
        control.runtimeError = "restart_paused";
        const now = await perpetualDatabaseClock(tx);
        const { state } = await recoverPerpetualPaperInTransaction(tx, owner, ledgerId);
        const next =
          state.openPositions.length &&
          control.protectionExpiresAt &&
          Date.parse(control.protectionExpiresAt) > now.getTime()
            ? now
            : null;
        await tx.tradingPaperPerpetualWorkspace.update({
          where: { ledgerId },
          data: {
            revision: row.revision + 1,
            control: perpetualPaperJson(control),
            controlSha256: perpetualPaperHash(control),
            nextScheduledFor: next,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
export async function recordPerpetualResearchTick(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  key: {
    ledgerId: string;
    revision: number;
    scheduledFor: string;
    stage: "protection" | "research";
  },
  snapshot: unknown,
  decision: PaperPerpetualDecision,
  model?: { provider: string; modelId: string },
) {
  decision = PaperPerpetualDecisionSchema.parse(decision);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, control } = await lockOwnedPerpetualWorkspace(tx, owner, key.ledgerId);
        if (
          row.revision !== key.revision ||
          row.nextScheduledFor?.toISOString() !== key.scheduledFor
        )
          return null;
        const clock = await perpetualDatabaseClock(tx);
        if (Date.parse(key.scheduledFor) > clock.getTime()) return null;
        const existing = await tx.tradingPaperPerpetualTick.findUnique({
          where: {
            ledgerId_revision_scheduledFor_stage: {
              ledgerId: key.ledgerId,
              revision: key.revision,
              scheduledFor: new Date(key.scheduledFor),
              stage: key.stage,
            },
          },
        });
        if (existing) {
          if (
            existing.snapshotSha256 !== perpetualPaperHash(existing.snapshot) ||
            existing.decisionSha256 !== perpetualPaperHash(existing.decision)
          )
            throw new Error("Futures research integrity failed");
          return existing;
        }
        if (decision.kind !== "no_trade") {
          const now = await perpetualDatabaseClock(tx);
          if (
            control.sessionStatus !== "active" ||
            !control.expiresAt ||
            Date.parse(control.expiresAt) <= now.getTime() ||
            !control.source
          )
            return null;
          await verifyPerpetualSource(tx, owner, control.source);
        }
        return tx.tradingPaperPerpetualTick.create({
          data: {
            ledgerId: key.ledgerId,
            revision: key.revision,
            scheduledFor: new Date(key.scheduledFor),
            stage: key.stage,
            snapshot: perpetualPaperJson(snapshot),
            snapshotSha256: perpetualPaperHash(snapshot),
            decision: perpetualPaperJson(decision),
            decisionSha256: perpetualPaperHash(decision),
            modelProvider: model?.provider ?? null,
            modelId: model?.modelId ?? null,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
