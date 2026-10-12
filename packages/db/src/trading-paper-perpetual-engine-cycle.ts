import type { PaperPerpetualEngine } from "@rakazo/adapter-kit";
import type {
  PaperPerpetualEngineBatch,
  PaperPerpetualEngineConfig,
  PaperPerpetualEngineSnapshot,
  PaperPerpetualSnapshot,
} from "@rakazo/contracts";
import { PaperPerpetualDecisionSchema, PaperPerpetualSnapshotSchema } from "@rakazo/contracts";
import {
  paperPerpetualAmount as amount,
  assessPaperRecoveryStructure,
  evaluatePaperLeverage,
  formatPaperPerpetualAmount as format,
  getPaperExperimentPreset,
  isFreshPaperObservation,
  paperPerpetualNotional as notional,
  PAPER_OKX_LV1_FEES,
  previewPaperPerpetualProposal,
  projectPerpetualEngineSnapshot,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  appendPerpetualEngineBatchInTransaction,
  recoverPerpetualEngineInTransaction,
} from "./trading-paper-perpetual-engine.js";
import { recoverPerpetualPaperInTransaction } from "./trading-paper-perpetual-store.js";
import type { PerpetualOwner } from "./trading-paper-perpetual-workspace.js";
import {
  perpetualPaperHash as hash,
  lockOwnedPerpetualWorkspace,
  perpetualDatabaseClock,
  savePerpetualControl,
  verifyPerpetualSource,
} from "./trading-paper-perpetual-workspace.js";

const signed = (s: string) => (s.startsWith("-") ? -amount(s.slice(1)) : amount(s));
const ns = (date: string | Date) =>
  String(BigInt(date instanceof Date ? date.getTime() : Date.parse(date)) * 1000000n);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
type Key = {
  ledgerId: string;
  revision: number;
  scheduledFor: string;
  stage: "protection" | "research";
};

/** Native simulator side effects remain disposable until the owner-scoped database
 * transaction commits. Never retry this transaction with an advanced process.
 * Queue retry recovers only committed batches and compares native output hashes.
 */
export async function commitPerpetualEngineWake(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  key: Key,
  raw: readonly PaperPerpetualSnapshot[],
  engine: PaperPerpetualEngine,
) {
  const execution = raw.map((s) => PaperPerpetualSnapshotSchema.parse(s));
  if (new Set(execution.map((s) => s.market.symbol)).size !== execution.length)
    throw new Error("Duplicate futures observations");
  try {
    return await prisma.$transaction(
      async (tx) => {
        const { row, control } = await lockOwnedPerpetualWorkspace(tx, owner, key.ledgerId);
        if (
          row.revision !== key.revision ||
          row.nextScheduledFor?.toISOString() !== key.scheduledFor
        )
          return { status: "fenced" as const };
        const tickKey = {
          ledgerId: key.ledgerId,
          revision: key.revision,
          scheduledFor: new Date(key.scheduledFor),
          stage: key.stage,
        };
        const tick = await tx.tradingPaperPerpetualTick.findUniqueOrThrow({
          where: { ledgerId_revision_scheduledFor_stage: tickKey },
        });
        if (
          tick.snapshotSha256 !== hash(tick.snapshot) ||
          tick.decisionSha256 !== hash(tick.decision)
        )
          throw new Error("Futures research integrity failed");
        if (tick.committedAt) return { status: "duplicate" as const };
        const decision = PaperPerpetualDecisionSchema.parse(tick.decision);
        let now = await perpetualDatabaseClock(tx),
          clock = now.getTime();
        if (Date.parse(key.scheduledFor) > clock) return { status: "fenced" as const };
        let active =
          control.sessionStatus === "active" &&
          control.expiresAt !== null &&
          Date.parse(control.expiresAt) > clock;
        const protects =
          control.protectionExpiresAt !== null && Date.parse(control.protectionExpiresAt) > clock;
        let prior = await recoverPerpetualEngineInTransaction(tx, owner, key.ledgerId);
        const old = await recoverPerpetualPaperInTransaction(tx, owner, key.ledgerId);
        if (!prior && old.row.version !== 0)
          throw new Error("Existing custom wallet cannot change executor");
        const snapshots = new Map(execution.map((s) => [s.market.symbol, s]));
        for (const s of execution) {
          if (
            s.market.venue !== "okx" ||
            s.market.kind !== "perpetual" ||
            s.market.quote !== "USDT" ||
            s.market.status !== "active" ||
            s.book.instrument !== s.market.symbol ||
            s.book.venue !== "okx"
          )
            throw new Error("Unverified derivative market identity");
          for (const at of [s.book.observedAt, s.markObservedAt, s.fetchedAt])
            if (!isFreshPaperObservation(at, now.toISOString()))
              throw new Error("Stale futures execution observation");
        }
        let outcome = key.stage === "protection" ? "protection_checked" : "no_trade";
        // First protection with no positions need not create a wallet before research.
        if (!prior && !execution.length) {
          await tx.tradingPaperPerpetualTick.update({
            where: { ledgerId_revision_scheduledFor_stage: tickKey },
            data: { outcome, committedAt: now },
          });
          return { status: "committed" as const, outcome, state: old.state };
        }
        const preset = getPaperExperimentPreset(old.state.strategy);
        const ceiling = control.maxLeverage ?? preset.maxLeverage;
        const termsFor = (symbol: string) => {
          const s = snapshots.get(symbol);
          if (!s || !s.market.priceIncrement) throw new Error("Native contract terms unavailable");
          return {
            instrument: symbol,
            priceIncrement: s.market.priceIncrement,
            quantityIncrement: s.rules.lotIncrementBase,
            minimumBase: s.rules.minimumBase,
            maximumBase: s.rules.maxTierBase,
            maintenanceRate: format(BigInt(s.rules.maintenanceMarginBps) * 10000n),
            ...PAPER_OKX_LV1_FEES,
          };
        };
        const config: PaperPerpetualEngineConfig = prior?.config ?? {
          version: "paper_engine_config_v1",
          engineId: engine.id,
          engineVersion: engine.version,
          accountId: key.ledgerId,
          initialBalanceQuote: "1000",
          leverage: ceiling,
          instruments: control.instruments.map(termsFor),
        };
        let state = old.state;
        const batch: PaperPerpetualEngineBatch = {
          sequence: (prior?.snapshot?.sequence ?? 0) + 1,
          quotes: [],
          commands: [],
          funding: [],
        };
        const priorSnapshot = prior?.snapshot;
        let effectiveConfig = prior?.effectiveConfig ?? config;
        const known = new Set(effectiveConfig.instruments.map((i) => i.instrument));
        const additions = control.instruments.filter((symbol) => !known.has(symbol)).map(termsFor);
        if (additions.length) {
          if (state.openPositions.length || priorSnapshot?.openOrders.length)
            throw new Error("Settle account before registering new markets");
          batch.registerInstruments = additions;
          effectiveConfig = {
            ...effectiveConfig,
            instruments: [...effectiveConfig.instruments, ...additions],
          };
          for (const t of additions) known.add(t.instrument);
        }
        // Cancel resting entries before feeding any new executable quote. Every
        // remaining intent must pass independent risk again on this wake.
        for (const o of priorSnapshot?.openOrders ?? [])
          batch.commands.push({ kind: "cancel", instrument: o.instrument, orderId: o.orderId });
        const nativeClock = BigInt(priorSnapshot?.clockNs ?? "0");
        for (const p of state.openPositions)
          if (!snapshots.has(p.instrument))
            throw new Error("Protective public observation missing");
        for (const s of execution) {
          if (!known.has(s.market.symbol)) throw new Error("Native market not registered");
          const previous = prior?.transitions
            .flatMap((t) => t.input.quotes)
            .filter((q) => q.instrument === s.market.symbol)
            .at(-1);
          const boundary = previous?.fundingNextAtNs;
          const settled = s.funding.filter(
            (f) => BigInt(ns(f.settledAt)) > nativeClock && Date.parse(f.settledAt) <= clock,
          );
          const held = state.openPositions.some((p) => p.instrument === s.market.symbol);
          if (
            held &&
            boundary &&
            BigInt(boundary) <= BigInt(ns(now)) &&
            !settled.some((f) => ns(f.settledAt) === boundary)
          )
            throw new Error("Final funding settlement unavailable");
          if (held && !boundary) throw new Error("Funding boundary unavailable");
          if (priorSnapshot)
            for (const f of settled)
              batch.funding.push({
                instrument: s.market.symbol,
                atNs: ns(f.settledAt),
                rateSigned: f.rateSigned,
              });
          batch.quotes.push({
            instrument: s.market.symbol,
            atNs: ns(now),
            bidQuote: s.book.bidQuote,
            askQuote: s.book.askQuote,
            markPriceQuote: s.markPriceQuote,
            bidAvailableBase: s.book.bidAvailableBase,
            askAvailableBase: s.book.askAvailableBase,
            sourceId: s.book.sourceId,
            bookObservedAtNs: ns(s.book.observedAt),
            markObservedAtNs: ns(s.markObservedAt),
            ...(s.fundingNextAt && Date.parse(s.fundingNextAt) > clock
              ? { fundingNextAtNs: ns(s.fundingNextAt) }
              : {}),
          });
        }
        const prefix = "native:" + hash([key.ledgerId, key.revision, key.scheduledFor, key.stage]);
        if (protects)
          for (const p of state.openPositions) {
            const plan = control.plans.find((x) => x.positionId === p.positionId),
              s = snapshots.get(p.instrument);
            if (!plan || !s) throw new Error("Native protective plan missing");
            const stop =
              p.side === "long"
                ? amount(s.markPriceQuote) <= amount(plan.stopPriceQuote)
                : amount(s.markPriceQuote) >= amount(plan.stopPriceQuote);
            const target =
              p.side === "long"
                ? amount(s.markPriceQuote) >= amount(plan.takeProfitPriceQuote)
                : amount(s.markPriceQuote) <= amount(plan.takeProfitPriceQuote);
            const fullExit =
              stop ||
              target ||
              control.closeAll ||
              (active &&
                key.stage === "research" &&
                ((decision.kind === "close" && decision.positionId === p.positionId) ||
                  (decision.kind === "proposal" && decision.replacePositionId === p.positionId)));
            const partialExit =
              active &&
              key.stage === "research" &&
              decision.kind === "reduce" &&
              decision.positionId === p.positionId;
            let exitQuantity: string | null = fullExit ? p.quantityBase : null;
            if (!fullExit && partialExit && decision.kind === "reduce") {
              const requested = amount(decision.quantityBase);
              const held = amount(p.quantityBase);
              const lot = amount(s.rules.lotIncrementBase);
              const remainder = held - requested;
              // No reverse trade, extra exposure or stranded sub-minimum dust.
              if (
                requested === 0n ||
                requested > held ||
                lot === 0n ||
                requested % lot !== 0n ||
                (remainder > 0n && remainder < amount(s.rules.minimumBase))
              ) {
                outcome = "denied_reduce";
              } else {
                exitQuantity = decision.quantityBase;
                outcome = "reduce_submitted";
              }
            }
            if (exitQuantity)
              batch.commands.push({
                kind: "order",
                orderId: prefix + ":exit:" + batch.commands.length,
                positionId: p.positionId,
                instrument: p.instrument,
                action: p.side === "long" ? "sell" : "buy",
                quantityBase: exitQuantity,
                reduceOnly: true,
                orderType: "market",
                limitPriceQuote: null,
              });
          }
        let output: PaperPerpetualEngineSnapshot | null = null;
        // Native marks, funding and exits settle before checking risk for a new entry.
        if (batch.quotes.length || batch.commands.length) {
          output = await engine.apply(config, prior?.transitions ?? [], batch);
          await appendPerpetualEngineBatchInTransaction(tx, owner, {
            config,
            batchId: prefix + ":observe",
            input: batch,
            output,
            expectedHead: prior?.headSha256 ?? null,
          });
          state = projectPerpetualEngineSnapshot(effectiveConfig, output, old.state.strategy);
          prior = await recoverPerpetualEngineInTransaction(tx, owner, key.ledgerId);
          for (const plan of control.plans) {
            const before = old.state.openPositions.find((x) => x.positionId === plan.positionId),
              after = state.openPositions.find((x) => x.positionId === plan.positionId);
            if (before && after && amount(after.quantityBase) < amount(before.quantityBase))
              plan.stopRiskQuote = format(
                ceil(
                  amount(plan.stopRiskQuote) * amount(after.quantityBase),
                  amount(before.quantityBase),
                ),
              );
          }
          control.plans = control.plans.filter((plan) =>
            state.openPositions.some((p) => p.positionId === plan.positionId),
          );
          const submitted = new Map(
            batch.commands.filter((c) => c.kind === "order").map((c) => [c.orderId, c]),
          );
          batch.quotes = batch.quotes.map((q) => {
            let bid = amount(q.bidAvailableBase),
              ask = amount(q.askAvailableBase);
            for (const e of output!.events) {
              const c = e.kind === "fill" ? submitted.get(e.orderId!) : undefined;
              if (c && c.instrument === q.instrument) {
                if (c.action === "buy") ask -= amount(e.quantityBase!);
                else bid -= amount(e.quantityBase!);
              }
            }
            return {
              ...q,
              atNs: String(BigInt(output!.clockNs) + 1n),
              bidAvailableBase: format(bid > 0n ? bid : 0n),
              askAvailableBase: format(ask > 0n ? ask : 0n),
            };
          });
          batch.sequence = output.sequence + 1;
          batch.commands = [];
          batch.funding = [];
          delete batch.registerInstruments;
        }
        now = await perpetualDatabaseClock(tx);
        clock = now.getTime();
        active =
          control.sessionStatus === "active" &&
          control.expiresAt !== null &&
          Date.parse(control.expiresAt) > clock;
        for (const snapshot of execution)
          if (
            !isFreshPaperObservation(snapshot.book.observedAt, now.toISOString()) ||
            !isFreshPaperObservation(snapshot.markObservedAt, now.toISOString()) ||
            !isFreshPaperObservation(snapshot.fetchedAt, now.toISOString())
          )
            throw new Error("Execution observation expired during native preparation");
        const beforeEntry = state;
        let accepted: ReturnType<typeof previewPaperPerpetualProposal> | null = null;
        let enteringPosition: string | null = null;
        if (key.stage === "research") {
          if (active && control.source) await verifyPerpetualSource(tx, owner, control.source);
          if (!active) control.orders = [];
          if (active && decision.kind === "proposal" && !control.orders.length) {
            if (!control.instruments.includes(decision.instrument)) outcome = "denied_market";
            else if (
              decision.replacePositionId &&
              !old.state.openPositions.some((x) => x.positionId === decision.replacePositionId)
            )
              outcome = "denied_replace_unknown";
            else if (clock - tick.recordedAt.getTime() > 120000) outcome = "expired_research";
            else
              control.orders = [
                {
                  orderId:
                    "paper-order:" +
                    hash([key.ledgerId, key.revision, key.scheduledFor, key.stage, decision]),
                  proposal: decision,
                  ideaRiskSpentQuote: "0",
                  submittedAt: tick.recordedAt.toISOString(),
                  expiresAt: new Date(
                    Math.min(tick.recordedAt.getTime() + 300000, Date.parse(control.expiresAt!)),
                  ).toISOString(),
                },
              ];
          }
          if (active && control.orders.length) {
            const order = control.orders[0]!,
              p = order.proposal,
              s = snapshots.get(p.instrument);
            if (!s) throw new Error("Futures execution market missing");
            enteringPosition = p.addToPositionId ?? "paper-position:" + hash(order.orderId);
            const existingAddition = p.addToPositionId
              ? state.openPositions.find((x) => x.positionId === p.addToPositionId)
              : undefined;
            const additionPlan = existingAddition
              ? control.plans.find((x) => x.positionId === existingAddition.positionId)
              : undefined;
            const stillOpenReplacement = p.replacePositionId
              ? state.openPositions.some((x) => x.positionId === p.replacePositionId)
              : false;
            const entry =
              p.orderType === "limit"
                ? p.limitPriceQuote
                : p.side === "long"
                  ? s.book.askQuote
                  : s.book.bidQuote;
            const gross = state.openPositions.reduce(
              (sum, x) =>
                sum +
                notional(
                  amount(x.quantityBase),
                  amount(x.markPriceQuote) > amount(x.entryPriceQuote)
                    ? amount(x.markPriceQuote)
                    : amount(x.entryPriceQuote),
                ),
              0n,
            );
            const grossBySide = (side: "long" | "short") =>
              state.openPositions
                .filter((held) => held.side === side)
                .reduce(
                  (sum, held) =>
                    sum +
                    notional(
                      amount(held.quantityBase),
                      amount(held.markPriceQuote) > amount(held.entryPriceQuote)
                        ? amount(held.markPriceQuote)
                        : amount(held.entryPriceQuote),
                    ),
                  0n,
                );
            const reserve = state.openPositions.reduce(
              (sum, x) =>
                sum +
                ceil(
                  notional(
                    amount(x.quantityBase),
                    amount(x.markPriceQuote) > amount(x.entryPriceQuote)
                      ? amount(x.markPriceQuote)
                      : amount(x.entryPriceQuote),
                  ),
                  BigInt(x.leverage),
                ),
              0n,
            );
            const available = signed(state.markedEquityQuote) - reserve;
            const day = now.toISOString().slice(0, 10);
            const beginning =
              prior?.transitions.filter((t) => t.recordedAt.toISOString().slice(0, 10) < day).at(-1)
                ?.output.realizedPnlQuote ?? "0";
            const lost =
              signed(beginning) -
              signed(state.realizedPnlQuote) -
              (signed(state.unrealizedPnlQuote) < 0n ? signed(state.unrealizedPnlQuote) : 0n);
            const instrumentQuantity = state.openPositions
              .filter((x) => x.instrument === p.instrument)
              .reduce((sum, x) => sum + amount(x.quantityBase), 0n);
            const registeredTerms = effectiveConfig.instruments.find(
              (i) => i.instrument === p.instrument,
            )!;
            const registeredMaximum = amount(registeredTerms.maximumBase);
            const highestFeeRate = [
              signed(registeredTerms.makerFeeRate),
              signed(registeredTerms.takerFeeRate),
              0n,
            ].reduce((max, value) => (value > max ? value : max));
            const lever = evaluatePaperLeverage({
              venue: "okx",
              instrument: p.instrument,
              marginMode: "cross",
              requestedLeverage: p.leverage,
              ownerMaxLeverage: ceiling,
              existingQuantityBase: format(instrumentQuantity),
              proposedQuantityBase: p.quantityBase,
              limits: s.leverageLimits ?? null,
              now: now.toISOString(),
            });
            const intendedNotional = entry
              ? notional(amount(p.quantityBase), amount(entry))
              : 0n;
            // Every fresh idea receives at least 50% of its initial notional
            // in separately budgeted future scale-in capacity. No staged order
            // is submitted automatically; a later AI decision and fresh risk
            // gate are still mandatory.
            const automaticRecovery = p.addToPositionId ? 0n : ceil(intendedNotional, 2n);
            const suggestedRecovery =
              !p.addToPositionId && p.plannedRecoveryNotionalQuote
                ? amount(p.plannedRecoveryNotionalQuote)
                : 0n;
            const newRecovery =
              suggestedRecovery > automaticRecovery ? suggestedRecovery : automaticRecovery;
            const consumedRecovery = p.addToPositionId ? intendedNotional : 0n;
            const remainingReserve = (plan: (typeof control.plans)[number]) => {
              const reserved = amount(plan.recoveryReserveQuote);
              if (plan.positionId !== p.addToPositionId) return reserved;
              return consumedRecovery >= reserved ? 0n : reserved - consumedRecovery;
            };
            const remainingRiskReserve = (plan: (typeof control.plans)[number]) => {
              const booked = amount(plan.recoveryReservedRiskQuote);
              const initial = amount(plan.recoveryReserveQuote);
              if (plan.positionId !== p.addToPositionId || initial === 0n) return booked;
              const consumed = consumedRecovery < initial ? consumedRecovery : initial;
              const used = ceil(booked * consumed, initial);
              return booked > used ? booked - used : 0n;
            };
            const recoveryBuckets = (side: "long" | "short") =>
              control.plans.reduce((sum, plan) => {
                const held = state.openPositions.find((x) => x.positionId === plan.positionId);
                return held?.side === side ? sum + remainingReserve(plan) : sum;
              }, 0n);
            const recoveryRisk = control.plans.reduce(
              (sum, plan) => sum + remainingRiskReserve(plan), 0n,
            );
            const sameIdeaRecoveryRisk = control.plans.reduce((sum, plan) => {
              const held = state.openPositions.find((x) => x.positionId === plan.positionId);
              return held?.instrument === p.instrument && held.side === p.side
                ? sum + remainingRiskReserve(plan)
                : sum;
            }, 0n);
            const risk = previewPaperPerpetualProposal({
              strategy: state.strategy,
              ledgerId: key.ledgerId,
              venue: "okx",
              instrument: p.instrument,
              side: p.side,
              leverage: p.leverage,
              ownerMaxLeverage: ceiling,
              quantityBase: p.quantityBase,
              entryPriceQuote: entry ?? "0",
              stopPriceQuote: p.stopPriceQuote,
              takeProfitPriceQuote: p.takeProfitPriceQuote,
              availableQuote: format(available > 0n ? available : 0n),
              additionalRecoveryNotionalQuote: format(newRecovery),
              portfolio: {
                openPositions: state.openPositions.filter((x) => x.positionId !== enteringPosition)
                  .length,
                openNotionalQuote: format(gross),
                openLongNotionalQuote: format(grossBySide("long")),
                openShortNotionalQuote: format(grossBySide("short")),
                recoveryLongNotionalQuote: format(recoveryBuckets("long")),
                recoveryShortNotionalQuote: format(recoveryBuckets("short")),
                recoveryReservedRiskQuote: format(recoveryRisk),
                sameIdeaReservedRiskQuote: format(sameIdeaRecoveryRisk),
                markedEquityQuote: format(
                  signed(state.markedEquityQuote) > 0n ? signed(state.markedEquityQuote) : 0n,
                ),
                peakEquityQuote: format(
                  (prior?.transitions ?? []).reduce(
                    (peak, historical) => {
                      const equity =
                        signed(historical.output.balanceQuote) +
                        historical.output.positions.reduce(
                          (sum, held) => sum + signed(held.unrealizedPnlQuote),
                          0n,
                        );
                      return equity > peak ? equity : peak;
                    },
                    signed(state.markedEquityQuote) > amount(preset.initialBalanceQuote)
                      ? signed(state.markedEquityQuote)
                      : amount(preset.initialBalanceQuote),
                  ),
                ),
                openStopRiskQuote: format(
                  control.plans.reduce((sum, x) => sum + amount(x.stopRiskQuote), 0n),
                ),
                sameIdeaStopRiskQuote: format(
                  control.plans.reduce((sum, plan) => {
                    const held = state.openPositions.find((x) => x.positionId === plan.positionId);
                    return held?.instrument === p.instrument && held.side === p.side
                      ? sum + amount(plan.stopRiskQuote)
                      : sum;
                  }, 0n),
                ),
                realizedLossTodayQuote: format(lost > 0n ? lost : 0n),
              },
              // Budget both sides at the highest persisted native fee rate.
              assumedFeeBpsPerSide: Number(ceil(highestFeeRate, 10000n)),
              assumedSlippageBpsPerSide: 10,
              maintenanceMarginBps: s.rules.maintenanceMarginBps,
            });
            let denied: string | null = null;
            if (p.addToPositionId && !existingAddition) denied = "denied_add_unknown";
            else if (
              p.addToPositionId &&
              (!additionPlan || consumedRecovery > amount(additionPlan.recoveryReserveQuote))
            ) denied = "denied_add_unreserved";
            else if (
              p.addToPositionId &&
              (!additionPlan ||
                existingAddition?.instrument !== p.instrument ||
                existingAddition?.side !== p.side ||
                existingAddition?.leverage !== p.leverage ||
                additionPlan.stopPriceQuote !== p.stopPriceQuote ||
                additionPlan.takeProfitPriceQuote !== p.takeProfitPriceQuote)
            )
              denied = "denied_add_plan_mismatch";
            else if (
              existingAddition &&
              (p.side === "long"
                ? amount(s.markPriceQuote) < amount(existingAddition.entryPriceQuote)
                : amount(s.markPriceQuote) > amount(existingAddition.entryPriceQuote)) &&
              assessPaperRecoveryStructure(s.history, p.side).status !== "confirmed_structure"
            ) denied = "denied_add_falling_knife";
            else if (p.replacePositionId && stillOpenReplacement)
              denied = "denied_replace_not_closed";
            else if (Date.parse(order.expiresAt) <= clock) denied = "order_expired";
            else if (Date.parse(s.book.observedAt) < Date.parse(order.submittedAt))
              denied = "quote_before_submission";
            else if (!s.fundingNextAt || Date.parse(s.fundingNextAt) <= clock)
              denied = "funding_boundary_unavailable";
            else if (lever.status !== "allowed") denied = "denied_" + lever.reason;
            else if (state.openPositions.length && p.leverage !== prior?.snapshot?.leverage)
              denied = "denied_account_leverage";
            else if (risk.status !== "inert_preview") denied = "denied_" + risk.reason;
            else if (
              amount(order.ideaRiskSpentQuote) + amount(risk.worstCaseStopLossQuote) >
              amount(preset.maxPerIdeaRiskQuote)
            )
              denied = "denied_risk_budget_exceeded";
            else if (
              amount(p.quantityBase) < amount(s.rules.minimumBase) ||
              amount(p.quantityBase) % amount(s.rules.lotIncrementBase) !== 0n ||
              instrumentQuantity + amount(p.quantityBase) > amount(s.rules.maxTierBase) ||
              instrumentQuantity + amount(p.quantityBase) > registeredMaximum ||
              (p.orderType === "limit" &&
                (!entry || amount(entry) % amount(s.market.priceIncrement!) !== 0n))
            )
              denied = "denied_contract";
            // Changing native leverage requires an empty account and no resting native
            // orders; cancellation is committed in a separate wake before this case.
            else if (
              !state.openPositions.length &&
              prior?.snapshot?.openOrders.length &&
              p.leverage !== prior.snapshot.leverage
            )
              denied = "denied_cancel_before_leverage";
            if (denied) {
              outcome = denied;
              control.orders = [];
            } else {
              accepted = risk;
              if (!state.openPositions.length) batch.leverage = p.leverage;
              batch.quotes = batch.quotes.map((q) => ({
                ...q,
                atNs: String(BigInt(ns(now)) > BigInt(q.atNs) ? BigInt(ns(now)) : BigInt(q.atNs)),
              }));
              batch.commands.push({
                kind: "order",
                orderId: prefix + ":entry",
                positionId: enteringPosition,
                instrument: p.instrument,
                action: p.side === "long" ? "buy" : "sell",
                quantityBase: p.quantityBase,
                reduceOnly: false,
                orderType: p.orderType,
                limitPriceQuote: p.limitPriceQuote,
              });
            }
          }
        }
        if (batch.commands.some((c) => c.kind === "order" && !c.reduceOnly)) {
          output = await engine.apply(config, prior?.transitions ?? [], batch);
          await appendPerpetualEngineBatchInTransaction(tx, owner, {
            config,
            batchId: prefix + ":entry",
            input: batch,
            output,
            expectedHead: prior?.headSha256 ?? null,
          });
          state = projectPerpetualEngineSnapshot(effectiveConfig, output, old.state.strategy);
        }
        if (
          accepted?.status === "inert_preview" &&
          enteringPosition &&
          output &&
          control.orders.length
        ) {
          const order = control.orders[0]!,
            before = beforeEntry.openPositions.find((p) => p.positionId === enteringPosition),
            after = state.openPositions.find((p) => p.positionId === enteringPosition);
          const filled =
            (after ? amount(after.quantityBase) : 0n) - (before ? amount(before.quantityBase) : 0n);
          if (filled > 0n) {
            const risk = ceil(
              amount(accepted.worstCaseStopLossQuote) * filled,
              amount(order.proposal.quantityBase),
            );
            const plan = control.plans.find((p) => p.positionId === enteringPosition);
            if (plan) {
              plan.stopRiskQuote = format(amount(plan.stopRiskQuote) + risk);
              // A filled addition CONSUMES previously guaranteed capacity.
              if (order.proposal.addToPositionId) {
                const consumed = notional(
                  filled,
                  amount(
                    order.proposal.orderType === "limit"
                      ? order.proposal.limitPriceQuote!
                      : order.proposal.side === "long"
                        ? snapshots.get(order.proposal.instrument)!.book.askQuote
                        : snapshots.get(order.proposal.instrument)!.book.bidQuote,
                  ),
                );
                const initial = amount(plan.recoveryReserveQuote);
                const actuallyConsumed = consumed < initial ? consumed : initial;
                const heldRisk = amount(plan.recoveryReservedRiskQuote);
                const usedRisk = initial > 0n
                  ? ceil(heldRisk * actuallyConsumed, initial)
                  : 0n;
                plan.recoveryReserveQuote = format(initial - actuallyConsumed);
                plan.recoveryReservedRiskQuote = format(
                  heldRisk > usedRisk ? heldRisk - usedRisk : 0n,
                );
              } else {
                // Another partial fill of the INITIAL order adds its pro-rata
                // reserve rather than spending capacity on itself.
                plan.recoveryReserveQuote = format(
                  amount(plan.recoveryReserveQuote) +
                    ceil(
                      amount(accepted.plannedRecoveryNotionalQuote) * filled,
                      amount(order.proposal.quantityBase),
                    ),
                );
                plan.recoveryReservedRiskQuote = format(
                  amount(plan.recoveryReservedRiskQuote) +
                    ceil(
                      amount(accepted.plannedRecoveryRiskQuote) * filled,
                      amount(order.proposal.quantityBase),
                    ),
                );
              }
            } else {
              control.plans.push({
                positionId: enteringPosition,
                stopPriceQuote: order.proposal.stopPriceQuote,
                takeProfitPriceQuote: order.proposal.takeProfitPriceQuote,
                stopRiskQuote: format(risk),
                recoveryReserveQuote: format(
                  ceil(amount(accepted.plannedRecoveryNotionalQuote) * filled,
                    amount(order.proposal.quantityBase)),
                ),
                recoveryReservedRiskQuote: format(
                  ceil(amount(accepted.plannedRecoveryRiskQuote) * filled,
                    amount(order.proposal.quantityBase)),
                ),
                fundingThrough: now.toISOString(),
              });
            }
            order.ideaRiskSpentQuote = format(amount(order.ideaRiskSpentQuote) + risk);
          }
          const pending = output.openOrders.find((o) => o.orderId === prefix + ":entry");
          if (pending) {
            order.proposal.quantityBase = pending.quantityBase;
            outcome = filled > 0n ? "partially_filled" : "order_pending";
          } else {
            outcome = filled > 0n ? "filled" : "order_cancelled_or_denied";
            control.orders = [];
          }
        }
        if (key.stage === "research" && active && decision.kind === "tighten_stop") {
          const held = state.openPositions.find((p) => p.positionId === decision.positionId);
          const plan = control.plans.find((p) => p.positionId === decision.positionId);
          const market = held ? snapshots.get(held.instrument) : undefined;
          if (!held || !plan || !market) {
            outcome = "denied_stop_unknown";
          } else {
            const requested = amount(decision.stopPriceQuote);
            const previous = amount(plan.stopPriceQuote);
            const current = amount(market.markPriceQuote);
            const increment = market.market.priceIncrement
              ? amount(market.market.priceIncrement)
              : 0n;
            // Permitted stop adjustment ALWAYS moves toward current market:
            // long goes up / short goes down. A stop at or beyond the mark
            // is unsafe; the normal protection cycle, not AI prose, exits.
            const improves = held.side === "long" ? requested > previous : requested < previous;
            const behindMarket = held.side === "long" ? requested < current : requested > current;
            if (!improves || !behindMarket || increment === 0n || requested % increment !== 0n) {
              outcome = "denied_stop_not_tighter";
            } else {
              plan.stopPriceQuote = decision.stopPriceQuote;
              // Do NOT lower the persisted stop-risk budget on speculative gains.
              // This conservatively preserves the original whole-idea risk until
              // actual native execution changes the lot and its recorded fills.
              outcome = "protective_stop_tightened";
            }
          }
        }
        if (!state.openPositions.length) control.closeAll = false;
        if (!active) control.orders = [];
        if (key.stage === "research" && tick.modelId) {
          control.lastResearchAt = now.toISOString();
          control.lastDecision = {
            at: now.toISOString(),
            outcome,
            rationale: decision.kind === "proposal" ? decision.rationale : decision.reason,
            provider: tick.modelProvider,
            model: tick.modelId,
          };
        }
        control.runtimeError = null;
        const needsNext = active || (state.openPositions.length > 0 && protects);
        const next =
          key.stage === "protection"
            ? row.nextScheduledFor
            : needsNext
              ? new Date(Math.max(Date.parse(key.scheduledFor) + 60000, clock + 1000))
              : null;
        await savePerpetualControl(tx, key.ledgerId, key.revision, control, next);
        await tx.tradingPaperPerpetualTick.update({
          where: { ledgerId_revision_scheduledFor_stage: tickKey },
          data: { outcome, committedAt: now },
        });
        return { status: "committed" as const, outcome, state };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
    );
  } catch (error) {
    engine.invalidate(key.ledgerId);
    throw error;
  }
}

/** Owner pause/end/restart must drain native pending orders even without data.
 * Cancellation barriers have zero liquidity and cannot grant entry authority.
 */
export async function cancelPerpetualEngineOrders(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
  engine: PaperPerpetualEngine,
) {
  try {
    await prisma.$transaction(
      async (tx) => {
        const { row } = await lockOwnedPerpetualWorkspace(tx, owner, ledgerId);
        const recovered = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId);
        if (!recovered?.snapshot?.openOrders.length) return;
        const batch: PaperPerpetualEngineBatch = {
          sequence: recovered.snapshot.sequence + 1,
          quotes: [],
          funding: [],
          commands: recovered.snapshot.openOrders.map((o) => ({
            kind: "cancel",
            instrument: o.instrument,
            orderId: o.orderId,
          })),
        };
        const output = await engine.apply(recovered.config, recovered.transitions, batch);
        if (output.openOrders.length) throw new Error("Native pending cancellation incomplete");
        await appendPerpetualEngineBatchInTransaction(tx, owner, {
          config: recovered.config,
          batchId: "native-cancel:" + hash([ledgerId, row.revision, batch.sequence]),
          input: batch,
          output,
          expectedHead: recovered.headSha256,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
    );
  } catch (error) {
    engine.invalidate(ledgerId);
    throw error;
  }
}
