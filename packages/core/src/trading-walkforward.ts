import {
  type TradingWalkforwardInput,
  type TradingWalkforwardOutput,
  TradingCandleSchema,
  TradingWalkforwardInputSchema,
  TradingWalkforwardOutputSchema,
} from "@rakazo/contracts";
import { researchClosedHourBreakout } from "./trading-research.js";
import { replayExplicitTradingFills } from "./trading-replay.js";

const HOUR = 3_600_000;

/**
 * Offline walk-forward spot-long research, one-bar holding period ONLY.
 * The signal receives exactly the previous 21 closed bars; only the next
 * bar's OPEN is used as an entry proxy, and its OHLC is used for the exit.
 * No RPC, account, exchange, clock dependence, live/Paper order capability.
 */
export function runSpotCandleWalkforward(raw: TradingWalkforwardInput): TradingWalkforwardOutput {
  const input = TradingWalkforwardInputSchema.parse(raw);
  const { market, candles } = input;
  if (market.venue !== "okx" || market.kind !== "spot" || market.status !== "active") {
    throw new Error("Walk-forward v1 requires an active OKX spot market");
  }
  if (market.expiryAt !== null || market.priceIncrement === null) {
    throw new Error("Unsupported walk-forward market precision/expiry");
  }
  if (Number(input.fixedNotionalQuote) > Number(input.initialBalanceQuote)) {
    throw new Error("Spot replay refuses initial borrowing or leverage");
  }
  for (let i = 0; i < candles.length; i++) {
    const bar = TradingCandleSchema.parse(candles[i]);
    if (
      bar.venue !== market.venue ||
      bar.kind !== market.kind ||
      bar.symbol !== market.symbol
    ) throw new Error("Mixed instrument or candle provenance");
    if (i && Date.parse(bar.openedAt) - Date.parse(candles[i - 1]!.openedAt) !== HOUR) {
      throw new Error("Walk-forward dataset contains a gap, duplicate or reordered candle");
    }
  }

  let signalCount = 0;
  let noTradeCount = 0;
  let skippedEntryCount = 0;
  const executions: TradingWalkforwardOutput["executions"] = [];
  const trades: Array<{
    tradeId: string;
    market: typeof market;
    side: "spot_long";
    decisionAt: string;
    enteredAt: string;
    exitedAt: string;
    entryReference: string;
    exitReference: string;
    notionalQuote: string;
    fundingCoverage: null;
  }> = [];

  for (let i = 20; i + 1 < candles.length; i++) {
    const last = candles[i]!;
    const next = candles[i + 1]!;
    const decisionMs = Date.parse(last.openedAt) + HOUR;
    // The research function never receives next or future bars.
    const result = researchClosedHourBreakout({
      market,
      candles: candles.slice(i - 20, i + 1),
      fetchedAt: new Date(decisionMs).toISOString(),
      now: new Date(decisionMs),
    });
    signalCount++;
    if (result.signal.kind === "no_trade") {
      noTradeCount++;
      continue;
    }
    const signal = result.signal;
    if (signal.action !== "spot_buy") throw new Error("Unexpected non-spot-buy walk-forward signal");
    const open = Number(next.open);
    const trigger = Number(signal.entryTrigger);
    const stop = Number(signal.stopLoss);
    const target = Number(signal.takeProfit[0]);
    if (
      ![open, trigger, stop, target].every((v) => Number.isFinite(v) && v > 0) ||
      !(stop < open && open < target) ||
      open < trigger ||
      ((open - trigger) / trigger) * 10_000 > input.maxEntryGapBps
    ) {
      skippedEntryCount++;
      continue;
    }
    const hitStop = Number(next.low) <= stop;
    const hitTarget = Number(next.high) >= target;
    // Conservative within-bar policy: if both levels are touched, stop wins.
    // A take-profit never receives positive opening-gap price improvement.
    const exitReference = hitStop ? stop : hitTarget ? target : Number(next.close);
    const exitReason = hitStop ? "stop" as const : hitTarget ? "target" as const : "next_bar_close" as const;
    const enteredAt = new Date(Date.parse(next.openedAt) + 1).toISOString();
    const exitedAt = new Date(Date.parse(next.openedAt) + HOUR).toISOString();
    const item = {
      signalId: signal.signalId,
      decisionAt: new Date(decisionMs).toISOString(),
      enteredAt,
      exitedAt,
      entryReason: "next_bar_open_proxy" as const,
      exitReason,
      entryReference: next.open,
      exitReference: String(exitReference),
    };
    executions.push(item);
    trades.push({
      tradeId: "walkforward-" + i,
      market,
      side: "spot_long",
      decisionAt: item.decisionAt,
      enteredAt,
      exitedAt,
      entryReference: item.entryReference,
      exitReference: item.exitReference,
      notionalQuote: input.fixedNotionalQuote,
      fundingCoverage: null,
    });
  }
  const replay = trades.length
    ? replayExplicitTradingFills({
        algorithm: "explicit_fill_replay_v1",
        datasetSha256: input.datasetSha256,
        strategyId: "breakout_20_1h_v1",
        strategyVersion: "1",
        initialBalanceQuote: input.initialBalanceQuote,
        feeBpsPerSide: input.feeBpsPerSide,
        adverseSlippageBpsPerSide: input.adverseSlippageBpsPerSide,
        trades,
      })
    : null;
  return TradingWalkforwardOutputSchema.parse({
    algorithm: "spot_breakout_next_bar_v1",
    datasetSha256: input.datasetSha256,
    signalCount,
    noTradeCount,
    skippedEntryCount,
    executions,
    replay,
  });
}
