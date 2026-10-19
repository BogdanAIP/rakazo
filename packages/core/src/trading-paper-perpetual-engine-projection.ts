import type { PaperPerpetualEngineConfig, PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import type { PaperExperimentStrategy } from "./trading-paper-experiments.js";
import { estimatePaperLiquidationPrices } from "./trading-paper-liquidation-estimate.js";
import type { PerpetualPaperLedgerState } from "./trading-paper-perpetual-ledger.js";
import {
  paperPerpetualAmount as amount,
  formatPaperPerpetualAmount as format,
  paperPerpetualNotional as notional,
} from "./trading-paper-perpetual-ledger.js";

const signed = (value: string) => (value.startsWith("-") ? -amount(value.slice(1)) : amount(value));
/** Display/risk projection from the executor's authoritative Money values.
 * It does not replay fills, charge fees/funding, or create a second wallet.
 */
export function projectPerpetualEngineSnapshot(
  config: PaperPerpetualEngineConfig,
  snapshot: PaperPerpetualEngineSnapshot,
  strategy: PaperExperimentStrategy,
): PerpetualPaperLedgerState {
  const liquidationPrices = estimatePaperLiquidationPrices(config, snapshot);
  const unrealized = snapshot.positions.reduce((sum, p) => sum + signed(p.unrealizedPnlQuote), 0n);
  const equity = signed(snapshot.balanceQuote) + unrealized;
  return {
    ledgerId: config.accountId,
    strategy,
    initialBalanceQuote: "1000",
    marginMode: "account_wide",
    engine: { id: snapshot.engineId, version: snapshot.engineVersion },
    availableQuote: snapshot.availableQuote,
    lockedMarginQuote: snapshot.lockedQuote,
    bookBalanceQuote: snapshot.balanceQuote,
    realizedPnlQuote: snapshot.realizedPnlQuote,
    unrealizedPnlQuote: format(unrealized),
    markedEquityQuote: format(equity),
    fundingNetQuote: snapshot.fundingNetQuote,
    totalFeesQuote: snapshot.totalFeesQuote,
    bankruptcyShortfallQuote: format(equity < 0n ? -equity : 0n),
    openPositions: snapshot.positions.map((p) => {
      const side = p.side === "LONG" ? ("long" as const) : ("short" as const);
      const terms = config.instruments.find((i) => i.instrument === p.instrument);
      if (!terms) throw new Error("Executor position market unavailable");
      const value = notional(amount(p.quantityBase), amount(p.markPriceQuote));
      return {
        positionId: p.positionId,
        hedgeBucket: [config.accountId, strategy, "okx", p.instrument, side].join(":"),
        venue: "okx" as const,
        instrument: p.instrument,
        side,
        leverage: snapshot.leverage,
        quantityBase: p.quantityBase,
        entryPriceQuote: p.entryPriceQuote,
        markPriceQuote: p.markPriceQuote,
        isolatedMarginQuote: "0",
        initialMarginQuote: format(
          (value + BigInt(snapshot.leverage) - 1n) / BigInt(snapshot.leverage),
        ),
        unrealizedPnlQuote: p.unrealizedPnlQuote,
        maintenanceMarginQuote: format(
          (value * amount(terms.maintenanceRate) + 99999999n) / 100000000n,
        ),
        liquidationRequired: equity <= signed(snapshot.lockedQuote),
        estimatedLiquidationPriceQuote: liquidationPrices.get(p.instrument) ?? null,
      };
    }),
    closedPositions: snapshot.closedPositions,
    liquidations: snapshot.liquidations,
    acceptedEvents: snapshot.eventCount,
    retryEvents: 0,
    nextSequence: snapshot.sequence + 1,
  };
}
