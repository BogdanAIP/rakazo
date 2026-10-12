import type { PaperPerpetualDecision, PaperPerpetualSnapshot } from "@rakazo/contracts";
import { PaperPerpetualDecisionSchema, PaperPerpetualSnapshotSchema } from "@rakazo/contracts";
import type { PerpetualPaperEvent, PerpetualPaperLedgerState } from "@rakazo/core";
import {
  paperPerpetualAmount as amount,
  evaluatePaperLeverage,
  formatPaperPerpetualAmount as format,
  getPaperExperimentPreset,
  paperPerpetualNotional as notional,
  previewPaperPerpetualProposal,
  previewPerpetualPaperOrderMatch,
  replayPerpetualPaperLedger,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  appendVerifiedPerpetualPaperEventInTransaction,
  recoverPerpetualPaperInTransaction,
} from "./trading-paper-perpetual-store.js";
import type { PerpetualOwner } from "./trading-paper-perpetual-workspace.js";
import {
  lockOwnedPerpetualWorkspace,
  perpetualDatabaseClock,
  perpetualPaperHash,
  savePerpetualControl,
  verifyPerpetualSource,
} from "./trading-paper-perpetual-workspace.js";
import { withTransactionRetry } from "./transaction-retry.js";

const SCALE = 100000000n;
const BPS = 10000n;
const fee = (qty: string, price: string) =>
  format((notional(amount(qty), amount(price)) * 10n + BPS - 1n) / BPS);
const signed = (s: string) => (s.startsWith("-") ? -amount(s.slice(1)) : amount(s));
function fundingPayment(qty: string, mark: string, rate: string, side: "long" | "short"): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(rate))
    throw new Error("Invalid public funding rate");
  const negative = rate.startsWith("-");
  const [whole, fractional = ""] = (negative ? rate.slice(1) : rate).split(".");
  const rateScale = 10n ** 24n;
  const value = BigInt(whole!) * rateScale + BigInt(fractional.padEnd(24, "0"));
  if (value > rateScale / 20n) throw new Error("Unsupported funding rate");
  const numerator = notional(amount(qty), amount(mark)) * value;
  // Costs round upward, credits downward. No artificial funding profit from rounding.
  const charge = (side === "long") !== negative;
  return format(charge ? -((numerator + rateScale - 1n) / rateScale) : numerator / rateScale);
}
function adverse(price: string, buy: boolean): string {
  return format(buy ? (amount(price) * 10010n + BPS - 1n) / BPS : (amount(price) * 9990n) / BPS);
}
type Key = {
  ledgerId: string;
  revision: number;
  scheduledFor: string;
  stage: "protection" | "research";
};

/** The authoritative money boundary. Owner membership, revision/expiry, Skill,
 * complete ledger integrity and independent risk are checked under one lock.
 * A captured research proposal cannot bypass this transaction.
 */
export async function commitPerpetualPaperWake(
  prisma: PrismaClient,
  owner: PerpetualOwner,
  key: Key,
  rawExecution: readonly PaperPerpetualSnapshot[],
) {
  const execution = rawExecution.map((row) => PaperPerpetualSnapshotSchema.parse(row));
  if (new Set(execution.map((row) => row.market.symbol)).size !== execution.length)
    throw new Error("Duplicate futures observations");
  return withTransactionRetry(() =>
    prisma.$transaction(
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
          tick.snapshotSha256 !== perpetualPaperHash(tick.snapshot) ||
          tick.decisionSha256 !== perpetualPaperHash(tick.decision)
        )
          throw new Error("Futures research integrity failed");
        if (tick.committedAt) return { status: "duplicate" as const };
        const decision: PaperPerpetualDecision = PaperPerpetualDecisionSchema.parse(tick.decision);
        const now = await perpetualDatabaseClock(tx);
        const clock = now.getTime();
        if (Date.parse(key.scheduledFor) > clock) return { status: "fenced" as const };
        const active =
          control.sessionStatus === "active" &&
          control.expiresAt !== null &&
          Date.parse(control.expiresAt) > clock;
        const protects =
          control.protectionExpiresAt !== null && Date.parse(control.protectionExpiresAt) > clock;
        let recovered = await recoverPerpetualPaperInTransaction(tx, owner, key.ledgerId);
        let state: PerpetualPaperLedgerState = recovered.state;
        const prefix =
          "perp-tick:" +
          perpetualPaperHash([key.ledgerId, key.revision, key.scheduledFor, key.stage]);
        const snapshots = new Map(execution.map((snapshot) => [snapshot.market.symbol, snapshot]));
        for (const snapshot of snapshots.values()) {
          if (
            snapshot.market.venue !== "okx" ||
            snapshot.market.kind !== "perpetual" ||
            snapshot.market.quote !== "USDT" ||
            snapshot.market.status !== "active"
          )
            throw new Error("Unverified derivative market identity");
          for (const sampled of [
            snapshot.book.observedAt,
            snapshot.markObservedAt,
            snapshot.fetchedAt,
          ]) {
            if (Date.parse(sampled) > clock || clock - Date.parse(sampled) > 30000)
              throw new Error("Stale futures execution observation");
          }
        }
        let eventNumber = 0;
        const append = async (
          payload:
            | Omit<
                Extract<PerpetualPaperEvent, { kind: "mark" }>,
                "ledgerId" | "sequence" | "recordedAt" | "eventId"
              >
            | Omit<PerpetualPaperEvent, "ledgerId" | "sequence" | "recordedAt" | "eventId">,
        ) => {
          const event = {
            ...payload,
            ledgerId: key.ledgerId,
            sequence: state.nextSequence,
            eventId: prefix + ":" + ++eventNumber,
            recordedAt: now.toISOString(),
          } as PerpetualPaperEvent;
          state = (await appendVerifiedPerpetualPaperEventInTransaction(tx, owner, event)).state;
        };
        const depths = new Map(
          execution.map((s) => [
            s.market.symbol,
            { bid: amount(s.book.bidAvailableBase), ask: amount(s.book.askAvailableBase) },
          ]),
        );
        const publicBook = (snapshot: PaperPerpetualSnapshot) => ({
          ...snapshot.book,
          bidAvailableBase: format(depths.get(snapshot.market.symbol)!.bid),
          askAvailableBase: format(depths.get(snapshot.market.symbol)!.ask),
        });
        const consume = (symbol: string, buy: boolean, qty: string) => {
          const depth = depths.get(symbol)!;
          if (buy) depth.ask -= amount(qty);
          else depth.bid -= amount(qty);
        };
        // Protective accounting never depends on the model being available.
        if (protects && (key.stage === "protection" || active))
          for (const initial of [...state.openPositions]) {
            const plan = control.plans.find((p) => p.positionId === initial.positionId);
            const snapshot = snapshots.get(initial.instrument);
            if (!plan || !snapshot)
              throw new Error("Futures protective plan or public observation missing");
            if (
              snapshot.funding.length === 400 &&
              Date.parse(snapshot.funding[0]!.settledAt) > Date.parse(plan.fundingThrough)
            )
              throw new Error("Funding history gap");
            for (const settlement of snapshot.funding) {
              if (Date.parse(settlement.settledAt) <= Date.parse(plan.fundingThrough)) continue;
              await append({
                kind: "funding",
                positionId: initial.positionId,
                paymentQuoteSigned: fundingPayment(
                  initial.quantityBase,
                  snapshot.markPriceQuote,
                  settlement.rateSigned,
                  initial.side,
                ),
              } as PerpetualPaperEvent);
              plan.fundingThrough = settlement.settledAt;
            }
            if (initial.markPriceQuote !== snapshot.markPriceQuote)
              await append({
                kind: "mark",
                positionId: initial.positionId,
                markPriceQuote: snapshot.markPriceQuote,
              });
            const p = state.openPositions.find(
              (position) => position.positionId === initial.positionId,
            )!;
            const stop =
              p.side === "long"
                ? amount(snapshot.markPriceQuote) <= amount(plan.stopPriceQuote)
                : amount(snapshot.markPriceQuote) >= amount(plan.stopPriceQuote);
            const target =
              p.side === "long"
                ? amount(snapshot.markPriceQuote) >= amount(plan.takeProfitPriceQuote)
                : amount(snapshot.markPriceQuote) <= amount(plan.takeProfitPriceQuote);
            const requested =
              key.stage === "research" &&
              active &&
              decision.kind === "close" &&
              decision.positionId === p.positionId;
            if (!p.liquidationRequired && !stop && !target && !control.closeAll && !requested)
              continue;
            const buy = p.side === "short";
            if (p.liquidationRequired) {
              const reference =
                p.side === "long"
                  ? format(
                      amount(snapshot.book.bidQuote) < amount(snapshot.markPriceQuote)
                        ? amount(snapshot.book.bidQuote)
                        : amount(snapshot.markPriceQuote),
                    )
                  : format(
                      amount(snapshot.book.askQuote) > amount(snapshot.markPriceQuote)
                        ? amount(snapshot.book.askQuote)
                        : amount(snapshot.markPriceQuote),
                    );
              const price = adverse(reference, buy);
              await append({
                kind: "liquidate",
                positionId: p.positionId,
                exitPriceQuote: price,
                exitFeeQuote: fee(p.quantityBase, price),
              } as PerpetualPaperEvent);
            } else {
              const matched = previewPerpetualPaperOrderMatch(
                {
                  accountId: key.ledgerId,
                  strategy: state.strategy,
                  venue: "okx",
                  instrument: p.instrument,
                  positionSide: p.side,
                  intent: "reduce_only",
                  action: buy ? "buy" : "sell",
                  orderType: "market",
                  timeInForce: "ioc",
                  quantityBase: p.quantityBase,
                  alreadyFilledBase: "0",
                  lotIncrement: snapshot.rules.lotIncrementBase,
                  limitPriceQuote: null,
                  triggerPriceQuote: null,
                  positionAvailableBase: p.quantityBase,
                  submittedAt: snapshot.book.observedAt,
                  expiresAt: new Date(clock + 60000).toISOString(),
                },
                publicBook(snapshot),
                now.toISOString(),
              );
              if (matched.status !== "inert_fill_preview")
                throw new Error("Protective exit has no executable public depth");
              const price = adverse(matched.executionPriceQuote, buy);
              const pnl =
                ((p.side === "long"
                  ? amount(price) - amount(p.entryPriceQuote)
                  : amount(p.entryPriceQuote) - amount(price)) *
                  amount(matched.filledBase)) /
                SCALE;
              const margin =
                (amount(p.isolatedMarginQuote) * amount(matched.filledBase)) /
                amount(p.quantityBase);
              if (margin + pnl - amount(fee(matched.filledBase, price)) < 0n) {
                await append({ kind: "mark", positionId: p.positionId, markPriceQuote: price });
                await append({
                  kind: "liquidate",
                  positionId: p.positionId,
                  exitPriceQuote: price,
                  exitFeeQuote: fee(p.quantityBase, price),
                } as PerpetualPaperEvent);
              } else {
                await append({
                  kind: "close",
                  positionId: p.positionId,
                  quantityBase: matched.filledBase,
                  exitPriceQuote: price,
                  exitFeeQuote: fee(matched.filledBase, price),
                } as PerpetualPaperEvent);
                consume(p.instrument, buy, matched.filledBase);
                const remaining = state.openPositions.find(
                  (position) => position.positionId === p.positionId,
                );
                if (remaining)
                  plan.stopRiskQuote = format(
                    (amount(plan.stopRiskQuote) * amount(remaining.quantityBase)) /
                      amount(p.quantityBase),
                  );
              }
            }
          }
        control.plans = control.plans.filter((p) =>
          state.openPositions.some((position) => position.positionId === p.positionId),
        );
        if (!state.openPositions.length) control.closeAll = false;
        let outcome = key.stage === "protection" ? "protection_checked" : "no_trade";
        if (key.stage === "research") {
          if (active && control.source) await verifyPerpetualSource(tx, owner, control.source);
          if (!active) control.orders = [];
          if (active && decision.kind === "proposal" && !control.orders.length) {
            if (!control.instruments.includes(decision.instrument)) outcome = "denied_market";
            else if (clock - tick.recordedAt.getTime() > 120000) outcome = "expired_research";
            else {
              control.orders = [
                {
                  orderId:
                    "paper-order:" +
                    perpetualPaperHash([
                      key.ledgerId,
                      key.revision,
                      key.scheduledFor,
                      key.stage,
                      decision,
                    ]),
                  proposal: decision,
                  ideaRiskSpentQuote: "0",
                  submittedAt: tick.recordedAt.toISOString(),
                  expiresAt: new Date(
                    Math.min(tick.recordedAt.getTime() + 5 * 60000, Date.parse(control.expiresAt!)),
                  ).toISOString(),
                },
              ];
            }
          }
          if (active && control.orders.length) {
            const order = control.orders[0]!;
            const proposal = order.proposal;
            const snapshot = snapshots.get(proposal.instrument);
            if (!snapshot) throw new Error("Futures execution market missing");
            const matched = previewPerpetualPaperOrderMatch(
              {
                accountId: key.ledgerId,
                strategy: state.strategy,
                venue: "okx",
                instrument: proposal.instrument,
                positionSide: proposal.side,
                intent: "open",
                action: proposal.side === "long" ? "buy" : "sell",
                orderType: proposal.orderType,
                timeInForce: proposal.orderType === "market" ? "ioc" : "gtc",
                quantityBase: proposal.quantityBase,
                alreadyFilledBase: "0",
                lotIncrement: snapshot.rules.lotIncrementBase,
                limitPriceQuote: proposal.limitPriceQuote,
                triggerPriceQuote: null,
                positionAvailableBase: null,
                submittedAt: order.submittedAt,
                expiresAt: order.expiresAt,
              },
              publicBook(snapshot),
              now.toISOString(),
            );
            if (
              matched.status === "deny" ||
              (matched.status === "not_filled" &&
                ["expired", "empty_book"].includes(matched.reason) &&
                proposal.orderType === "market")
            ) {
              outcome =
                matched.status === "deny"
                  ? "denied_" + matched.reason
                  : "cancelled_" + matched.reason;
              control.orders = [];
            } else if (matched.status === "not_filled") {
              outcome = matched.reason === "expired" ? "order_expired" : "order_pending";
              if (matched.reason === "expired") control.orders = [];
            } else {
              const utcDay = now.toISOString().slice(0, 10);
              recovered = await recoverPerpetualPaperInTransaction(tx, owner, key.ledgerId);
              const beginning = replayPerpetualPaperLedger({
                ledgerId: key.ledgerId,
                strategy: state.strategy,
                openedAt: recovered.row.openedAt.toISOString(),
                initialBalanceQuote: "1000",
                events: recovered.events.filter((event) => event.recordedAt.slice(0, 10) < utcDay),
              });
              const lost =
                signed(beginning.realizedPnlQuote) -
                signed(state.realizedPnlQuote) -
                (signed(state.unrealizedPnlQuote) < 0n ? signed(state.unrealizedPnlQuote) : 0n);
              const leverageCheck = evaluatePaperLeverage({
                venue: "okx",
                instrument: proposal.instrument,
                marginMode: "cross",
                requestedLeverage: proposal.leverage,
                ownerMaxLeverage:
                  control.maxLeverage ?? getPaperExperimentPreset(state.strategy).maxLeverage,
                existingQuantityBase: format(
                  state.openPositions
                    .filter((p) => p.instrument === proposal.instrument)
                    .reduce((sum, p) => sum + amount(p.quantityBase), 0n),
                ),
                proposedQuantityBase: proposal.quantityBase,
                limits: snapshot.leverageLimits ?? null,
                now: now.toISOString(),
              });
              const riskInput = {
                strategy: state.strategy,
                ledgerId: key.ledgerId,
                venue: "okx",
                instrument: proposal.instrument,
                side: proposal.side,
                leverage: proposal.leverage,
                ownerMaxLeverage:
                  control.maxLeverage ?? getPaperExperimentPreset(state.strategy).maxLeverage,
                quantityBase: proposal.quantityBase,
                entryPriceQuote: matched.executionPriceQuote,
                stopPriceQuote: proposal.stopPriceQuote,
                takeProfitPriceQuote: proposal.takeProfitPriceQuote,
                availableQuote: state.availableQuote,
                portfolio: {
                  openPositions: state.openPositions.length,
                  openNotionalQuote: format(
                    state.openPositions.reduce(
                      (sum, p) =>
                        sum +
                        notional(
                          amount(p.quantityBase),
                          amount(p.markPriceQuote) > amount(p.entryPriceQuote)
                            ? amount(p.markPriceQuote)
                            : amount(p.entryPriceQuote),
                        ),
                      0n,
                    ),
                  ),
                  markedEquityQuote: state.markedEquityQuote,
                  // Legacy fallback has no persisted native high-watermark replay.
                  // Keep initial equity as its conservative minimum peak estimate.
                  peakEquityQuote: format(
                    signed(state.markedEquityQuote) > 1000n * SCALE
                      ? signed(state.markedEquityQuote)
                      : 1000n * SCALE,
                  ),
                  openStopRiskQuote: format(
                    control.plans.reduce((sum, p) => sum + amount(p.stopRiskQuote), 0n),
                  ),
                  sameIdeaStopRiskQuote: format(
                    control.plans.reduce((sum, plan) => {
                      const held = state.openPositions.find(
                        (pos) => pos.positionId === plan.positionId,
                      );
                      return held?.instrument === proposal.instrument && held.side === proposal.side
                        ? sum + amount(plan.stopRiskQuote)
                        : sum;
                    }, 0n),
                  ),
                  realizedLossTodayQuote: format(lost > 0n ? lost : 0n),
                },
                assumedFeeBpsPerSide: 10,
                assumedSlippageBpsPerSide: 10,
                maintenanceMarginBps: snapshot.rules.maintenanceMarginBps,
              } as const;
              const fullRisk = previewPaperPerpetualProposal(riskInput);
              const risk = previewPaperPerpetualProposal({
                ...riskInput,
                quantityBase: matched.filledBase,
              });
              if (leverageCheck.status !== "allowed") {
                outcome = "denied_" + leverageCheck.reason;
                control.orders = [];
              } else if (fullRisk.status !== "inert_preview" || risk.status !== "inert_preview") {
                outcome =
                  "denied_" +
                  (fullRisk.status === "deny"
                    ? fullRisk.reason
                    : risk.status === "deny"
                      ? risk.reason
                      : "invalid_input");
                control.orders = [];
              } else if (
                amount(order.ideaRiskSpentQuote) + amount(risk.worstCaseStopLossQuote) >
                amount(getPaperExperimentPreset(state.strategy).maxPerIdeaRiskQuote)
              ) {
                outcome = "denied_risk_budget_exceeded";
                control.orders = [];
              } else if (
                proposal.leverage > snapshot.rules.maxLeverage ||
                amount(matched.filledBase) < amount(snapshot.rules.minimumBase) ||
                state.openPositions
                  .filter((p) => p.instrument === proposal.instrument)
                  .reduce((sum, p) => sum + amount(p.quantityBase), amount(matched.filledBase)) >
                  amount(snapshot.rules.maxTierBase) ||
                (proposal.orderType === "limit" &&
                  proposal.limitPriceQuote !== null &&
                  (proposal.side === "long"
                    ? amount(risk.effectiveEntryQuote) > amount(proposal.limitPriceQuote)
                    : amount(risk.effectiveEntryQuote) < amount(proposal.limitPriceQuote)))
              ) {
                outcome = "denied_contract_or_limit";
                control.orders = [];
              } else {
                const positionId = "paper-position:" + perpetualPaperHash([prefix, order.orderId]);
                await append({
                  kind: "open",
                  positionId,
                  venue: "okx",
                  instrument: proposal.instrument,
                  side: proposal.side,
                  leverage: proposal.leverage,
                  quantityBase: matched.filledBase,
                  entryPriceQuote: risk.effectiveEntryQuote,
                  entryFeeQuote: risk.entryFeeQuote,
                  maintenanceMarginBps: snapshot.rules.maintenanceMarginBps,
                } as PerpetualPaperEvent);
                control.plans.push({
                  positionId,
                  stopPriceQuote: proposal.stopPriceQuote,
                  takeProfitPriceQuote: proposal.takeProfitPriceQuote,
                  stopRiskQuote: risk.worstCaseStopLossQuote,
                  fundingThrough: now.toISOString(),
                });
                consume(proposal.instrument, proposal.side === "long", matched.filledBase);
                outcome = matched.partial ? "partially_filled" : "filled";
                control.orders =
                  matched.partial && proposal.orderType === "limit" && !matched.cancelRemaining
                    ? [
                        {
                          ...order,
                          ideaRiskSpentQuote: format(
                            amount(order.ideaRiskSpentQuote) + amount(risk.worstCaseStopLossQuote),
                          ),
                          proposal: { ...proposal, quantityBase: matched.remainingBase },
                        },
                      ]
                    : [];
              }
            }
          }
          if (active && decision.kind === "close")
            outcome = state.openPositions.some((p) => p.positionId === decision.positionId)
              ? "close_partial_or_not_ready"
              : "closed";
          if (tick.modelId) {
            control.lastResearchAt = now.toISOString();
            control.lastDecision = {
              at: now.toISOString(),
              outcome,
              rationale: decision.kind === "proposal" ? decision.rationale : decision.reason,
              provider: tick.modelProvider,
              model: tick.modelId,
            };
          }
        }
        if (!active && control.sessionStatus === "active") control.orders = [];
        if (
          active ||
          ["market_data_unavailable", "protection_unavailable", "execution_unavailable"].includes(
            control.runtimeError ?? "",
          )
        )
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
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 },
    ),
  );
}
