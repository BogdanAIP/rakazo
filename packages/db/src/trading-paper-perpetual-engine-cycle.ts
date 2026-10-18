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
  canConsumePaperRecoveryStep,
  consumePaperRecoveryStep,
  evaluatePaperLeverage,
  formatPaperPerpetualAmount as format,
  getPaperExperimentPreset,
  isFreshPaperObservation,
  paperPerpetualNotional as notional,
  observePaperRecoverySteps,
  PAPER_OKX_LV1_FEES,
  PAPER_PERPETUAL_RISK_POLICY_VERSION,
  paperPerpetualOrderExpiresAt,
  planPaperRecoverySteps,
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

import { withTransactionRetry } from "./transaction-retry.js";

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

/** Finish any cold native replay before requesting a new public market observation.
 * Quotes must be fetched after recovery to avoid expiring during long restarts.
 */
export async function preparePerpetualEngineBeforeMarketFetch(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
  engine: PaperPerpetualEngine,
): Promise<void> {
  if (!engine.requiresRecovery?.(ledgerId) || !engine.prepare) return;
  const history = await recoverPerpetualEngineInTransaction(prisma, owner, ledgerId);
  if (history) await engine.prepare(history.config, history.transitions);
}

/** Native simulator side effects remain disposable until the owner-scoped database
 * transaction commits. Never retry this transaction with an advanced process.
 * Queue retry recovers only committed batches and compares native output hashes.
 */
// Retry the whole operation: its failure handler invalidates the native process
// before another attempt reconstructs only the committed journal.
export function commitPerpetualEngineWake(
  ...args: Parameters<typeof commitPerpetualEngineWakeOnce>
) {
  return withTransactionRetry(() => commitPerpetualEngineWakeOnce(...args));
}
async function commitPerpetualEngineWakeOnce(
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
    // Reconstruct committed native state before acquiring PostgreSQL row locks.
    // A fresh owner-scoped history and locked journal head must match exactly.
    let preparedHead: string | null = null;
    if (engine.requiresRecovery?.(key.ledgerId) && engine.prepare) {
      const history = await recoverPerpetualEngineInTransaction(prisma, owner, key.ledgerId);
      if (history) {
        await engine.prepare(history.config, history.transitions);
        preparedHead = history.headSha256;
      }
    }
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
        let prior = await recoverPerpetualEngineInTransaction(tx, owner, key.ledgerId, {
          transactionScopedReuse: true,
        });
        if (preparedHead !== null && prior?.headSha256 !== preparedHead)
          throw new Error("PAPER journal advanced during native recovery; retry wake");
        if (prior?.snapshot?.openOrders.length) {
          // Drain cancellation with zero liquidity in its own native batch.
          // Queuing a cancel alongside a crossing quote can match the GTC first.
          prior = await cancelNativeEntriesInTransaction(
            tx,
            owner,
            prior,
            engine,
            "native-revalidate:" + hash([key.ledgerId, key.revision, key.scheduledFor, key.stage]),
          );
        }
        const old = await recoverPerpetualPaperInTransaction(tx, owner, key.ledgerId, {
          transactionScopedNativeReuse: true,
        });
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
          if (key.stage === "research") {
            if (tick.modelId) {
              control.lastResearchAt = now.toISOString();
              control.lastDecision = {
                at: now.toISOString(),
                outcome,
                riskPolicyVersion: PAPER_PERPETUAL_RISK_POLICY_VERSION,
                rationale: decision.kind === "proposal" ? decision.rationale : decision.reason,
                provider: tick.modelProvider,
                model: tick.modelId,
                comparison: decision.comparison,
              };
            }
            control.runtimeError = null;
            await savePerpetualControl(
              tx,
              key.ledgerId,
              key.revision,
              control,
              active
                ? new Date(Math.max(Date.parse(key.scheduledFor) + 60000, clock + 1000))
                : null,
            );
          }
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
        const existing = new Map(
          effectiveConfig.instruments.map((term) => [term.instrument, term]),
        );
        const refreshes = execution
          .filter((snapshot) => known.has(snapshot.market.symbol))
          .map((snapshot) => termsFor(snapshot.market.symbol))
          .filter((term) => hash(existing.get(term.instrument)) !== hash(term));
        const contractUpdatePending = additions.length > 0 || refreshes.length > 0;
        const canUpdateContracts = !state.openPositions.length && !priorSnapshot?.openOrders.length;
        if (contractUpdatePending && canUpdateContracts) {
          batch.registerInstruments = [...additions, ...refreshes];
          const next = new Map(effectiveConfig.instruments.map((term) => [term.instrument, term]));
          for (const term of batch.registerInstruments) {
            next.set(term.instrument, term);
            known.add(term.instrument);
          }
          effectiveConfig = { ...effectiveConfig, instruments: [...next.values()] };
        }
        const contractUpdateDeferred = contractUpdatePending && !canUpdateContracts;
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
                decision.kind === "close" &&
                decision.positionId === p.positionId);
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
        const applySettlement = async (suffix: string) => {
          if (batch.quotes.length || batch.commands.length) {
            const previousState = state;
            output = await engine.apply(config, prior?.transitions ?? [], batch);
            await appendPerpetualEngineBatchInTransaction(tx, owner, {
              config,
              batchId: prefix + suffix,
              input: batch,
              output,
              expectedHead: prior?.headSha256 ?? null,
            });
            state = projectPerpetualEngineSnapshot(effectiveConfig, output, old.state.strategy);
            prior = await recoverPerpetualEngineInTransaction(tx, owner, key.ledgerId, {
              transactionScopedReuse: true,
            });
            for (const plan of control.plans) {
              const before = previousState.openPositions.find(
                  (x) => x.positionId === plan.positionId,
                ),
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
        };
        await applySettlement(":observe");
        if (active && key.stage === "research" && decision.kind === "close") {
          const held = old.state.openPositions.some((p) => p.positionId === decision.positionId);
          outcome = !held
            ? "denied_close_unknown"
            : state.openPositions.some((p) => p.positionId === decision.positionId)
              ? "close_partial_or_not_ready"
              : "closed";
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
        // Pre-booked triggers are observed against authenticated public marks.
        // They are NOT executable orders. A later independent decision is mandatory.
        for (const plan of control.plans) {
          const position = state.openPositions.find((x) => x.positionId === plan.positionId);
          const mark = position ? snapshots.get(position.instrument) : null;
          if (position && mark && plan.recoverySteps.length) {
            plan.recoverySteps = observePaperRecoverySteps(
              position.side,
              mark.markPriceQuote,
              now.toISOString(),
              plan.recoverySteps,
            );
          }
        }
        let beforeEntry = state;
        let accepted: ReturnType<typeof previewPaperPerpetualProposal> | null = null;
        let enteringPosition: string | null = null;
        let processedOrderId: string | null = null;
        if (key.stage === "research") {
          if (active && control.source) await verifyPerpetualSource(tx, owner, control.source);
          if ((!active || contractUpdateDeferred) && control.orders.length) {
            processedOrderId = control.orders[0]!.orderId;
            outcome = !active ? "order_expired" : "denied_contract_terms_pending";
            control.orders = [];
          }
          if (active && decision.kind === "proposal" && !control.orders.length) {
            if (contractUpdateDeferred) outcome = "denied_contract_terms_pending";
            else if (!control.instruments.includes(decision.instrument)) outcome = "denied_market";
            else if (
              decision.replacePositionId &&
              !old.state.openPositions.some((x) => x.positionId === decision.replacePositionId)
            )
              outcome = "denied_replace_unknown";
            else if (
              clock - tick.recordedAt.getTime() > 120000 ||
              (decision.comparison && Date.parse(decision.comparison.validUntil) <= clock)
            )
              outcome = "expired_research";
            else
              control.orders = [
                {
                  orderId:
                    "paper-order:" +
                    hash([key.ledgerId, key.revision, key.scheduledFor, key.stage, decision]),
                  proposal: decision,
                  ideaRiskSpentQuote: "0",
                  submittedAt: tick.recordedAt.toISOString(),
                  expiresAt: paperPerpetualOrderExpiresAt({
                    orderType: decision.orderType,
                    submittedAt: tick.recordedAt.toISOString(),
                    sessionExpiresAt: control.expiresAt!,
                    comparisonValidUntil: decision.comparison?.validUntil,
                  }),
                },
              ];
          }
          for (let admissionPass = 0; admissionPass < 2; admissionPass++) {
            if (active && control.orders.length) {
              const order = control.orders[0]!,
                p = order.proposal,
                s = snapshots.get(p.instrument);
              processedOrderId = order.orderId;
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
              const replacement = p.replacePositionId
                ? state.openPositions.find((x) => x.positionId === p.replacePositionId)
                : undefined;
              let riskState = state;
              const riskPlans = control.plans.filter(
                (plan) => plan.positionId !== replacement?.positionId,
              );
              if (replacement) {
                const quote = snapshots.get(replacement.instrument);
                const terms = effectiveConfig.instruments.find(
                  (i) => i.instrument === replacement.instrument,
                );
                if (!quote || !terms) throw new Error("Replacement exit evidence unavailable");
                const exitPrice =
                  replacement.side === "long" ? quote.book.bidQuote : quote.book.askQuote;
                const exitNotional = notional(amount(replacement.quantityBase), amount(exitPrice));
                const entryNotional = notional(
                  amount(replacement.quantityBase),
                  amount(replacement.entryPriceQuote),
                );
                const realized =
                  replacement.side === "long"
                    ? exitNotional - entryNotional
                    : entryNotional - exitNotional;
                const fee = ceil(
                  exitNotional *
                    (signed(terms.takerFeeRate) > 0n ? signed(terms.takerFeeRate) : 0n),
                  100000000n,
                );
                riskState = {
                  ...state,
                  openPositions: state.openPositions.filter(
                    (x) => x.positionId !== replacement.positionId,
                  ),
                  markedEquityQuote: format(
                    signed(state.markedEquityQuote) +
                      realized -
                      signed(replacement.unrealizedPnlQuote) -
                      fee,
                  ),
                  realizedPnlQuote: format(signed(state.realizedPnlQuote) + realized - fee),
                  unrealizedPnlQuote: format(
                    signed(state.unrealizedPnlQuote) - signed(replacement.unrealizedPnlQuote),
                  ),
                };
              }
              // A marketable limit can execute at a better public bid/ask
              // than its limit: risk and reserved notional use that executable quote.
              const executableQuote = p.side === "long" ? s.book.askQuote : s.book.bidQuote;
              const entry =
                p.orderType !== "limit"
                  ? executableQuote
                  : p.side === "long"
                    ? amount(executableQuote) <= amount(p.limitPriceQuote!)
                      ? executableQuote
                      : p.limitPriceQuote
                    : amount(executableQuote) >= amount(p.limitPriceQuote!)
                      ? executableQuote
                      : p.limitPriceQuote;
              const gross = riskState.openPositions.reduce(
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
                riskState.openPositions
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
              const reserve = riskState.openPositions.reduce(
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
              const available = signed(riskState.markedEquityQuote) - reserve;
              const day = now.toISOString().slice(0, 10);
              const beginning =
                prior?.transitions
                  .filter((t) => t.recordedAt.toISOString().slice(0, 10) < day)
                  .at(-1)?.output.realizedPnlQuote ?? "0";
              const lost =
                signed(beginning) -
                signed(riskState.realizedPnlQuote) -
                (signed(riskState.unrealizedPnlQuote) < 0n
                  ? signed(riskState.unrealizedPnlQuote)
                  : 0n);
              const instrumentQuantity = riskState.openPositions
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
              const intendedNotional = entry ? notional(amount(p.quantityBase), amount(entry)) : 0n;
              // Reserve only explicitly planned adds. Zero is a complete single-entry idea.
              // Positive reserves still require fixed stages and a fresh later decision.
              const newRecovery = p.addToPositionId
                ? 0n
                : amount(p.plannedRecoveryNotionalQuote ?? "0");
              const consumedRecovery = p.addToPositionId ? intendedNotional : 0n;
              const remainingReserve = (plan: (typeof riskPlans)[number]) => {
                const reserved = amount(plan.recoveryReserveQuote);
                if (plan.positionId !== p.addToPositionId) return reserved;
                return consumedRecovery >= reserved ? 0n : reserved - consumedRecovery;
              };
              const remainingRiskReserve = (plan: (typeof riskPlans)[number]) => {
                const booked = amount(plan.recoveryReservedRiskQuote);
                const initial = amount(plan.recoveryReserveQuote);
                if (plan.positionId !== p.addToPositionId || initial === 0n) return booked;
                const consumed = consumedRecovery < initial ? consumedRecovery : initial;
                const used = ceil(booked * consumed, initial);
                return booked > used ? booked - used : 0n;
              };
              const recoveryBuckets = (side: "long" | "short") =>
                riskPlans.reduce((sum, plan) => {
                  const held = riskState.openPositions.find(
                    (x) => x.positionId === plan.positionId,
                  );
                  return held?.side === side ? sum + remainingReserve(plan) : sum;
                }, 0n);
              const maintenanceLegs = riskState.openPositions.map((held) => {
                const verified = snapshots.get(held.instrument);
                if (!verified) throw new Error("Missing verified held-market maintenance terms");
                const heldGross = notional(
                  amount(held.quantityBase),
                  amount(held.markPriceQuote) > amount(held.entryPriceQuote)
                    ? amount(held.markPriceQuote)
                    : amount(held.entryPriceQuote),
                );
                const unspent = riskPlans.reduce(
                  (sum, plan) =>
                    plan.positionId === held.positionId ? sum + remainingReserve(plan) : sum,
                  0n,
                );
                return {
                  grossNotionalQuote: format(heldGross + unspent),
                  maintenanceMarginBps: verified.rules.maintenanceMarginBps,
                };
              });
              const recoveryRisk = riskPlans.reduce(
                (sum, plan) => sum + remainingRiskReserve(plan),
                0n,
              );
              const sameIdeaRecoveryRisk = riskPlans.reduce((sum, plan) => {
                const held = riskState.openPositions.find((x) => x.positionId === plan.positionId);
                return held?.instrument === p.instrument && held.side === p.side
                  ? sum + remainingRiskReserve(plan)
                  : sum;
              }, 0n);
              const proposedRecoverySteps = p.recoverySteps
                ? planPaperRecoverySteps(
                    p.side,
                    entry ?? "0",
                    p.stopPriceQuote,
                    format(newRecovery),
                    p.recoverySteps,
                  )
                : null;
              const recoveryStage = additionPlan?.recoverySteps.find(
                (step) => step.stepId === p.recoveryStepId,
              );
              const stepConfirmation =
                existingAddition && recoveryStage?.activatedAt
                  ? assessPaperRecoveryStructure(
                      s.history.filter(
                        (candle) =>
                          Date.parse(candle.openedAt) >= Date.parse(recoveryStage.activatedAt!) &&
                          Date.parse(candle.openedAt) + candle.durationMs <= clock,
                      ),
                      p.side,
                    ).status === "confirmed_structure"
                  : false;
              const stageApproval =
                existingAddition && additionPlan
                  ? canConsumePaperRecoveryStep(
                      additionPlan.recoverySteps,
                      p.recoveryStepId,
                      format(consumedRecovery),
                      stepConfirmation,
                    )
                  : "missing";
              const risk = previewPaperPerpetualProposal({
                strategy: riskState.strategy,
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
                  openPositions: riskState.openPositions.filter(
                    (x) => x.positionId !== enteringPosition,
                  ).length,
                  openNotionalQuote: format(gross),
                  openLongNotionalQuote: format(grossBySide("long")),
                  openShortNotionalQuote: format(grossBySide("short")),
                  recoveryLongNotionalQuote: format(recoveryBuckets("long")),
                  recoveryShortNotionalQuote: format(recoveryBuckets("short")),
                  recoveryReservedRiskQuote: format(recoveryRisk),
                  maintenanceLegs,
                  sameIdeaReservedRiskQuote: format(sameIdeaRecoveryRisk),
                  markedEquityQuote: format(
                    signed(riskState.markedEquityQuote) > 0n
                      ? signed(riskState.markedEquityQuote)
                      : 0n,
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
                      signed(riskState.markedEquityQuote) > amount(preset.initialBalanceQuote)
                        ? signed(riskState.markedEquityQuote)
                        : amount(preset.initialBalanceQuote),
                    ),
                  ),
                  openStopRiskQuote: format(
                    riskPlans.reduce((sum, x) => sum + amount(x.stopRiskQuote), 0n),
                  ),
                  sameIdeaStopRiskQuote: format(
                    riskPlans.reduce((sum, plan) => {
                      const held = riskState.openPositions.find(
                        (x) => x.positionId === plan.positionId,
                      );
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
              if (
                !p.addToPositionId &&
                ((newRecovery > 0n && proposedRecoverySteps === null) ||
                  (newRecovery === 0n && p.recoverySteps !== undefined))
              )
                denied = "denied_recovery_plan_invalid";
              else if (p.addToPositionId && !existingAddition) denied = "denied_add_unknown";
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
                p.addToPositionId &&
                additionPlan!.recoverySteps.length &&
                stageApproval !== "ready"
              )
                denied = "denied_recovery_step_" + stageApproval;
              else if (
                p.addToPositionId &&
                consumedRecovery > amount(additionPlan!.recoveryReserveQuote)
              )
                denied = "denied_add_unreserved";
              else if (
                existingAddition &&
                (p.side === "long"
                  ? amount(s.markPriceQuote) < amount(existingAddition.entryPriceQuote)
                  : amount(s.markPriceQuote) > amount(existingAddition.entryPriceQuote)) &&
                assessPaperRecoveryStructure(s.history, p.side).status !== "confirmed_structure"
              )
                denied = "denied_add_falling_knife";
              else if (Date.parse(order.expiresAt) <= clock) denied = "order_expired";
              else if (
                p.side === "long"
                  ? amount(s.markPriceQuote) <= amount(p.stopPriceQuote) ||
                    amount(s.markPriceQuote) >= amount(p.takeProfitPriceQuote)
                  : amount(s.markPriceQuote) >= amount(p.stopPriceQuote) ||
                    amount(s.markPriceQuote) <= amount(p.takeProfitPriceQuote)
              )
                denied = "entry_invalidated";
              else if (Date.parse(s.book.observedAt) < Date.parse(order.submittedAt))
                denied = "quote_before_submission";
              else if (!s.fundingNextAt || Date.parse(s.fundingNextAt) <= clock)
                denied = "funding_boundary_unavailable";
              else if (lever.status !== "allowed") denied = "denied_" + lever.reason;
              else if (riskState.openPositions.length && p.leverage !== prior?.snapshot?.leverage)
                denied = "denied_account_leverage";
              else if (risk.status !== "inert_preview") denied = "denied_" + risk.reason;
              else if (
                amount(order.ideaRiskSpentQuote) + amount(risk.worstCaseStopLossQuote) >
                amount(risk.maxPerIdeaRiskQuote)
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
                !riskState.openPositions.length &&
                prior?.snapshot?.openOrders.length &&
                p.leverage !== prior.snapshot.leverage
              )
                denied = "denied_cancel_before_leverage";
              if (denied) {
                outcome = denied;
                control.orders = [];
              } else if (stillOpenReplacement && replacement) {
                // Admission checks the post-exit book before authorizing this close.
                // Recheck the actual settlement before any new entry; a partial
                // reduction never grants replacement entry authority.
                batch.commands.push({
                  kind: "order",
                  orderId: prefix + ":replacement",
                  positionId: replacement.positionId,
                  instrument: replacement.instrument,
                  action: replacement.side === "long" ? "sell" : "buy",
                  quantityBase: replacement.quantityBase,
                  reduceOnly: true,
                  orderType: "market",
                  limitPriceQuote: null,
                });
                await applySettlement(":replace");
                beforeEntry = state;
                if (
                  state.openPositions.some(
                    (position) => position.positionId === replacement.positionId,
                  )
                ) {
                  outcome = "denied_replace_not_closed";
                  control.orders = [];
                  break;
                }
                now = await perpetualDatabaseClock(tx);
                clock = now.getTime();
                active =
                  control.sessionStatus === "active" &&
                  control.expiresAt !== null &&
                  Date.parse(control.expiresAt) > clock;
                if (!active) {
                  outcome = "expired_research";
                  control.orders = [];
                  break;
                }
                if (
                  execution.some(
                    (snapshot) =>
                      !isFreshPaperObservation(snapshot.book.observedAt, now.toISOString()),
                  )
                )
                  throw new Error("Replacement execution observation expired");
                continue;
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
            break;
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
                // Consume the guaranteed recovery budget at the ACTUAL
                // native fill prices, not the submitted limit or public quote.
                const entryFills = output.events.filter(
                  (event) => event.kind === "fill" && event.orderId === prefix + ":entry",
                );
                if (
                  entryFills.some((event) => !event.quantityBase || !event.priceQuote) ||
                  entryFills.reduce((sum, event) => sum + amount(event.quantityBase!), 0n) !==
                    filled
                )
                  throw new Error("Native recovery fill evidence disagrees with position delta");
                const consumed = entryFills.reduce(
                  (sum, event) =>
                    sum + notional(amount(event.quantityBase!), amount(event.priceQuote!)),
                  0n,
                );
                const initial = amount(plan.recoveryReserveQuote);
                const actuallyConsumed = consumed < initial ? consumed : initial;
                if (plan.recoverySteps.length && order.proposal.recoveryStepId) {
                  plan.recoverySteps = consumePaperRecoveryStep(
                    plan.recoverySteps,
                    order.proposal.recoveryStepId,
                    format(actuallyConsumed),
                  );
                }
                const heldRisk = amount(plan.recoveryReservedRiskQuote);
                const usedRisk = initial > 0n ? ceil(heldRisk * actuallyConsumed, initial) : 0n;
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
                if (order.proposal.recoverySteps) {
                  const part = planPaperRecoverySteps(
                    order.proposal.side,
                    accepted.effectiveEntryQuote,
                    order.proposal.stopPriceQuote,
                    format(
                      ceil(
                        amount(accepted.plannedRecoveryNotionalQuote) * filled,
                        amount(order.proposal.quantityBase),
                      ),
                    ),
                    order.proposal.recoverySteps,
                  );
                  if (!part) throw new Error("Committed PAPER recovery plan became invalid");
                  for (const step of part) {
                    const held = plan.recoverySteps.find((x) => x.stepId === step.stepId);
                    if (!held || held.triggerPriceQuote !== step.triggerPriceQuote)
                      throw new Error("Changed recovery step during partial initial fill");
                    held.maximumNotionalQuote = format(
                      amount(held.maximumNotionalQuote) + amount(step.maximumNotionalQuote),
                    );
                    held.remainingNotionalQuote = format(
                      amount(held.remainingNotionalQuote) + amount(step.remainingNotionalQuote),
                    );
                  }
                }
              }
            } else {
              control.plans.push({
                positionId: enteringPosition,
                stopPriceQuote: order.proposal.stopPriceQuote,
                takeProfitPriceQuote: order.proposal.takeProfitPriceQuote,
                stopRiskQuote: format(risk),
                recoveryReserveQuote: format(
                  ceil(
                    amount(accepted.plannedRecoveryNotionalQuote) * filled,
                    amount(order.proposal.quantityBase),
                  ),
                ),
                recoveryReservedRiskQuote: format(
                  ceil(
                    amount(accepted.plannedRecoveryRiskQuote) * filled,
                    amount(order.proposal.quantityBase),
                  ),
                ),
                recoverySteps: order.proposal.recoverySteps
                  ? (planPaperRecoverySteps(
                      order.proposal.side,
                      accepted.effectiveEntryQuote,
                      order.proposal.stopPriceQuote,
                      format(
                        ceil(
                          amount(accepted.plannedRecoveryNotionalQuote) * filled,
                          amount(order.proposal.quantityBase),
                        ),
                      ),
                      order.proposal.recoverySteps,
                    ) ?? [])
                  : [],
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
            riskPolicyVersion: PAPER_PERPETUAL_RISK_POLICY_VERSION,
            rationale: decision.kind === "proposal" ? decision.rationale : decision.reason,
            provider: tick.modelProvider,
            model: tick.modelId,
            comparison: decision.comparison,
            ...(decision.kind === "proposal" && processedOrderId
              ? { orderId: processedOrderId }
              : {}),
          };
        } else if (processedOrderId && control.lastDecision?.orderId === processedOrderId) {
          // Settlement updates this order's result without inventing a new AI decision
          // or overwriting its original research time, rationale and provenance.
          control.lastDecision.outcome = outcome;
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
// Retry the whole operation: its failure handler invalidates the native process
// before another attempt reconstructs only the committed journal.
export function cancelPerpetualEngineOrders(
  ...args: Parameters<typeof cancelPerpetualEngineOrdersOnce>
) {
  return withTransactionRetry(() => cancelPerpetualEngineOrdersOnce(...args));
}
async function cancelPerpetualEngineOrdersOnce(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  ledgerId: string,
  engine: PaperPerpetualEngine,
  expectedRevision?: number,
) {
  try {
    let preparedHead: string | null = null;
    if (engine.requiresRecovery?.(ledgerId) && engine.prepare) {
      const history = await recoverPerpetualEngineInTransaction(prisma, owner, ledgerId);
      if (history) {
        await engine.prepare(history.config, history.transitions);
        preparedHead = history.headSha256;
      }
    }
    await prisma.$transaction(
      async (tx) => {
        const { row } = await lockOwnedPerpetualWorkspace(tx, owner, ledgerId);
        // A delayed retry of a previously accepted owner command must never
        // cancel native orders that belong to a later workspace revision.
        if (expectedRevision !== undefined && row.revision !== expectedRevision) return;
        const recovered = await recoverPerpetualEngineInTransaction(tx, owner, ledgerId, {
          transactionScopedReuse: true,
        });
        if (preparedHead !== null && recovered?.headSha256 !== preparedHead)
          throw new Error("PAPER journal advanced during native cancellation recovery");
        if (!recovered?.snapshot?.openOrders.length) return;
        await cancelNativeEntriesInTransaction(
          tx,
          owner,
          recovered,
          engine,
          "native-cancel:" + hash([ledgerId, row.revision, recovered.snapshot.sequence + 1]),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
    );
  } catch (error) {
    engine.invalidate(ledgerId);
    throw error;
  }
}

/** Shared by wake revalidation and owner pause/restart; never carries executable liquidity. */
async function cancelNativeEntriesInTransaction(
  tx: Prisma.TransactionClient,
  owner: PerpetualOwner,
  recovered: NonNullable<Awaited<ReturnType<typeof recoverPerpetualEngineInTransaction>>>,
  engine: PaperPerpetualEngine,
  batchId: string,
) {
  const snapshot = recovered.snapshot!;
  const batch: PaperPerpetualEngineBatch = {
    sequence: snapshot.sequence + 1,
    quotes: [],
    funding: [],
    commands: snapshot.openOrders.map((o) => ({
      kind: "cancel",
      instrument: o.instrument,
      orderId: o.orderId,
    })),
  };
  const output = await engine.apply(recovered.config, recovered.transitions, batch);
  if (
    output.openOrders.length ||
    output.events.some((event) => event.kind === "fill") ||
    output.balanceQuote !== snapshot.balanceQuote ||
    output.totalFeesQuote !== snapshot.totalFeesQuote
  )
    throw new Error("Native cancellation changed exposure or money");
  await appendPerpetualEngineBatchInTransaction(tx, owner, {
    config: recovered.config,
    batchId,
    input: batch,
    output,
    expectedHead: recovered.headSha256,
  });
  const next = await recoverPerpetualEngineInTransaction(tx, owner, recovered.config.accountId, {
    transactionScopedReuse: true,
  });
  if (!next) throw new Error("Native cancellation journal missing");
  return next;
}
