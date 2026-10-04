import {
  type TradingInstrument,
  type TradingPaperLedgerState,
  type TradingPaperPolicy,
  type TradingSignal,
  TradingSignalSchema,
  type TradingTicker,
} from "@rakazo/contracts";
import { deriveTradingPaperRiskState, type TradingPaperDerivedRiskState } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { verifyPublicPaperQuoteEvidenceInTransaction } from "./trading-paper-quote-evidence.js";
import { verifyTradingPaperRiskPolicyInTransaction } from "./trading-paper-risk-policy.js";
import { verifyTradingPaperStopGuardsInTransaction } from "./trading-paper-stop-guard.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";

type Owner = { spaceId: string; userId: string };
const SCALE = 100_000_000n;
const BPS_SCALE = 100_000_000n;

function units(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Unsupported exact paper quote decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function decimal(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function bpsScaled(value: number): bigint | null {
  const raw = String(value);
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}

export type TradingPaperReservationDenyReason =
  | "policy_disabled"
  | "kill_switch_active"
  | "quote_currency_mismatch"
  | "no_trade"
  | "invalid_signal"
  | "unsupported_instrument"
  | "existing_risk_unreconciled"
  | "trusted_market_snapshot_unavailable"
  | "market_snapshot_stale"
  | "market_snapshot_mismatch"
  | "market_spread_exceeded"
  | "market_trigger_deviation_exceeded"
  | "signal_expired"
  | "daily_loss_limit_exceeded"
  | "total_exposure_limit_exceeded"
  | "stop_risk_unavailable"
  | "open_stop_risk_limit_exceeded"
  | "position_limit_exceeded"
  | "risk_state_unavailable";

export type TradingPaperReservationDeny = {
  status: "deny";
  reason: TradingPaperReservationDenyReason;
  ledgerRevision: number;
  policyRevision: number;
};

export type TradingPaperReservationReady = {
  status: "ready";
  ledgerRevision: number;
  policyRevision: number;
  decisionNow: number;
  policy: TradingPaperPolicy;
  signal: Extract<TradingSignal, { kind: "proposal" }>;
  evidence: {
    id: string;
    source: "public_adapter_observation";
    market: TradingInstrument;
    ticker: TradingTicker;
  };
  state: TradingPaperLedgerState;
  risk: TradingPaperDerivedRiskState;
  openStopRiskQuote: string;
};

export async function evaluateTradingPaperReservationInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  proposedSignal: unknown,
  evidenceId: string | null,
): Promise<TradingPaperReservationDeny | TradingPaperReservationReady> {
  const { row, events, state } = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const verified = await verifyTradingPaperRiskPolicyInTransaction(tx, owner, ledgerId);
  const { policy } = verified;
  const deny = (reason: TradingPaperReservationDenyReason): TradingPaperReservationDeny => ({
    status: "deny",
    reason,
    ledgerRevision: row.version,
    policyRevision: verified.revision,
  });

  if (!policy.enabled) return deny("policy_disabled");
  if (policy.killSwitch) return deny("kill_switch_active");
  if (state.quoteCurrency !== policy.quoteCurrency) return deny("quote_currency_mismatch");

  const decisionNow = Date.now();
  const risk = deriveTradingPaperRiskState(
    {
      version: "paper_spot_full_fill_v1",
      ledgerId: row.id,
      openedAt: row.openedAt.toISOString(),
      quoteCurrency: row.quoteCurrency,
      initialBalanceQuote: row.initialBalanceQuote,
      events,
    },
    new Date(decisionNow),
  );
  if (units(risk.realizedLossTodayQuote) >= units(policy.maxDailyLossQuote)) {
    return deny("daily_loss_limit_exceeded");
  }
  if (units(risk.openExposureQuote) >= units(policy.maxTotalExposureQuote)) {
    return deny("total_exposure_limit_exceeded");
  }
  if (risk.openPositions >= policy.maxPositions) return deny("position_limit_exceeded");
  if (risk.openReservations > 0) return deny("existing_risk_unreconciled");

  const feeBps = bpsScaled(policy.assumedFeeBpsPerSide);
  const slippageBps = bpsScaled(policy.assumedSlippageBpsPerSide);
  if (feeBps === null || slippageBps === null) return deny("risk_state_unavailable");

  let openStopRisk = risk.openStopRiskQuote === null ? null : units(risk.openStopRiskQuote);
  if (!risk.stopRiskComplete || openStopRisk === null) {
    const guards = await verifyTradingPaperStopGuardsInTransaction(tx, ledgerId, events, state);
    if (!guards) return deny("stop_risk_unavailable");
    let total = 0n;
    const positions = new Map(state.positions.map((position) => [position.positionId, position]));
    for (const guard of guards) {
      const position = positions.get(guard.positionId);
      if (!position) return deny("stop_risk_unavailable");
      const quantity = units(position.quantityBase);
      const stop = units(guard.stopPriceQuote);
      const slippedStop = (stop * (BPS_SCALE - slippageBps)) / BPS_SCALE;
      const grossProceeds = (quantity * slippedStop) / SCALE;
      const sellFee = (grossProceeds * feeBps + BPS_SCALE - 1n) / BPS_SCALE;
      const netProceeds = grossProceeds > sellFee ? grossProceeds - sellFee : 0n;
      const cost = units(position.entryCostBasisQuote);
      if (cost > netProceeds) total += cost - netProceeds;
    }
    openStopRisk = total;
  }
  if (openStopRisk >= units(policy.maxOpenRiskQuote)) {
    return deny("open_stop_risk_limit_exceeded");
  }

  const parsed = TradingSignalSchema.safeParse(proposedSignal);
  if (!parsed.success) return deny("invalid_signal");
  const signal = parsed.data;
  if (signal.kind === "no_trade") return deny("no_trade");
  if (
    signal.executionStatus !== "research_only" ||
    signal.market.kind !== "spot" ||
    signal.action !== "spot_buy" ||
    signal.market.status !== "active" ||
    signal.market.quote !== state.quoteCurrency ||
    !policy.allowedVenues.includes(signal.market.venue)
  )
    return deny("unsupported_instrument");

  if (!evidenceId || evidenceId.length > 128) {
    return deny("trusted_market_snapshot_unavailable");
  }
  const evidence = await verifyPublicPaperQuoteEvidenceInTransaction(
    tx,
    owner,
    ledgerId,
    evidenceId,
  );
  if (!evidence) return deny("trusted_market_snapshot_unavailable");
  if (JSON.stringify(evidence.market) !== JSON.stringify(signal.market)) {
    return deny("market_snapshot_mismatch");
  }

  const observed = Date.parse(evidence.ticker.observedAt);
  const fetched = Date.parse(evidence.ticker.fetchedAt);
  if (
    observed > fetched + 2_000 ||
    fetched > decisionNow + 2_000 ||
    observed > decisionNow + 2_000 ||
    decisionNow - observed > policy.maxAgeMs ||
    decisionNow - fetched > policy.maxAgeMs
  )
    return deny("market_snapshot_stale");
  if (
    Date.parse(signal.expiresAt) <= decisionNow ||
    Date.parse(signal.createdAt) > decisionNow + 2_000
  )
    return deny("signal_expired");

  const bid = units(evidence.ticker.bid);
  const ask = units(evidence.ticker.ask);
  const trigger = units(signal.entryTrigger);
  const spreadCap = bpsScaled(policy.maxSpreadBps);
  const deviationCap = bpsScaled(policy.maxTriggerDeviationBps);
  if (spreadCap === null || deviationCap === null) return deny("risk_state_unavailable");
  if (2n * (ask - bid) * BPS_SCALE > spreadCap * (ask + bid)) {
    return deny("market_spread_exceeded");
  }
  const deviation = trigger >= ask ? trigger - ask : ask - trigger;
  if (deviation * BPS_SCALE > deviationCap * ask) {
    return deny("market_trigger_deviation_exceeded");
  }

  return {
    status: "ready",
    ledgerRevision: row.version,
    policyRevision: verified.revision,
    decisionNow,
    policy,
    signal,
    evidence,
    state,
    risk,
    openStopRiskQuote: decimal(openStopRisk),
  };
}
