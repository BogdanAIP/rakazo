import {
  type TradingReplayInput,
  TradingReplayInputSchema,
  type TradingReplayOutput,
  TradingReplayOutputSchema,
} from "@rakazo/contracts";

/**
 * Deterministic, OFFLINE accounting for supplied historical fill scenarios.
 * This is not a strategy backtester or a simulator of intrabar fills,
 * liquidations or market impact. No network, exchange or paper order handles.
 */
export function replayExplicitTradingFills(input: TradingReplayInput): TradingReplayOutput {
  const data = TradingReplayInputSchema.parse(input);
  const balanceStart = Number(data.initialBalanceQuote);
  let equity = balanceStart;
  let peak = balanceStart;
  let maxRealizedDrawdownPct = 0;
  let totalFeesQuote = 0;
  let totalFundingQuote = 0;
  let priorExit = Number.NEGATIVE_INFINITY;
  let quote: string | null = null;
  const ids = new Set<string>();

  const rows: TradingReplayOutput["trades"] = [];
  const within = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e14) {
      throw new Error("Backtest input or derived amount exceeds bounded arithmetic");
    }
    return value;
  };

  for (const trade of data.trades) {
    const decision = Date.parse(trade.decisionAt);
    const entered = Date.parse(trade.enteredAt);
    const exited = Date.parse(trade.exitedAt);
    if (!(decision < entered && entered < exited) || decision < priorExit) {
      throw new Error("Replay requires chronological non-overlapping fills after signal decisions");
    }
    priorExit = exited;
    if (ids.has(trade.tradeId)) throw new Error("Duplicate backtest trade ID");
    ids.add(trade.tradeId);
    if (trade.market.status !== "active") throw new Error("Inactive backtest market");
    if (quote !== null && quote !== trade.market.quote) {
      throw new Error("Mixed quote currencies require a separately verified FX ledger");
    }
    quote = trade.market.quote;

    const spot = trade.side === "spot_long";
    if (spot !== (trade.market.kind === "spot")) {
      throw new Error("Spot/futures position type mismatch");
    }
    if (!spot && trade.market.kind !== "perpetual") {
      throw new Error("Only spot long and linear perpetual experiments are modeled");
    }
    const coverage = trade.fundingCoverage;
    if (spot && coverage !== null) throw new Error("Spot must not contain funding events");
    if (!spot && coverage === null) {
      throw new Error("Futures funding history coverage is mandatory; never default it to zero");
    }
    const direction = trade.side === "perpetual_short" ? -1 : 1;
    const entryRef = within(Number(trade.entryReference));
    const exitRef = within(Number(trade.exitReference));
    const notional = within(Number(trade.notionalQuote));
    if (notional > equity) {
      throw new Error("Replay v1 forbids leverage, borrowing and over-budget exposure");
    }

    const adverse = data.adverseSlippageBpsPerSide / 10_000;
    const entryFill = within(entryRef * (1 + direction * adverse));
    const exitFill = within(exitRef * (1 - direction * adverse));
    if (entryFill <= 0 || exitFill <= 0) throw new Error("Invalid adverse-slip fill price");
    const quantityBase = within(notional / entryFill);
    const referenceGross = within(direction * quantityBase * (exitRef - entryRef));
    const grossPnlQuote = within(direction * quantityBase * (exitFill - entryFill));
    const slippageImpactQuote = within(referenceGross - grossPnlQuote);
    const feeQuote = within((notional + quantityBase * exitFill) * (data.feeBpsPerSide / 10_000));

    let fundingQuote = 0;
    if (coverage !== null) {
      const expected = coverage.expectedSettlementTimes.map((value) => Date.parse(value));
      if (Date.parse(coverage.from) > entered || Date.parse(coverage.through) < exited) {
        throw new Error("Funding coverage must span the whole holding period");
      }
      if (expected.length !== coverage.events.length) {
        throw new Error("Missing historical funding rate for an expected settlement");
      }
      let prev = entered;
      for (let i = 0; i < expected.length; i++) {
        const time = expected[i]!;
        const event = coverage.events[i]!;
        if (time <= prev || time > exited || Date.parse(event.settledAt) !== time) {
          throw new Error(
            "Funding schedule must be complete, unique, ordered and held-period-only",
          );
        }
        const rate = within(Number(event.ratePerSettlement));
        if (Math.abs(rate) > 1) throw new Error("Implausible historical settlement funding rate");
        const mark = within(Number(event.markPrice));
        fundingQuote = within(fundingQuote - direction * quantityBase * mark * rate);
        prev = time;
      }
      // Coverage is an external provenance assertion. A verified exchange
      // funding calendar must establish expectedSettlementTimes before replay.
    }
    const netPnlQuote = within(grossPnlQuote - feeQuote + fundingQuote);
    equity = within(equity + netPnlQuote);
    if (equity <= 0)
      throw new Error("Virtual balance exhausted; experiment needs a liquidation model");
    peak = Math.max(peak, equity);
    maxRealizedDrawdownPct = Math.max(maxRealizedDrawdownPct, ((peak - equity) / peak) * 100);
    totalFeesQuote = within(totalFeesQuote + feeQuote);
    totalFundingQuote = within(totalFundingQuote + fundingQuote);
    rows.push({
      tradeId: trade.tradeId,
      entryFill,
      exitFill,
      grossPnlQuote,
      slippageImpactQuote,
      feeQuote,
      fundingQuote,
      netPnlQuote,
      equityAfterQuote: equity,
    });
  }
  return TradingReplayOutputSchema.parse({
    algorithm: "explicit_fill_replay_v1",
    datasetSha256: data.datasetSha256,
    realizedOnly: true,
    initialBalanceQuote: balanceStart,
    finalBalanceQuote: equity,
    netPnlQuote: equity - balanceStart,
    totalFeesQuote,
    totalFundingQuote,
    maxRealizedDrawdownPct,
    trades: rows,
  });
}
