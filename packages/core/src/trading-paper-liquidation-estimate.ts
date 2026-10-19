import type { PaperPerpetualEngineConfig, PaperPerpetualEngineSnapshot } from "@rakazo/contracts";
import {
  paperPerpetualAmount as amount,
  formatPaperPerpetualAmount as format,
} from "./trading-paper-perpetual-ledger.js";

const SCALE = 100_000_000n;
const signed = (value: string) => (value.startsWith("-") ? -amount(value.slice(1)) : amount(value));
/** Indicative maintenance boundary for one instrument moving, with every other
 * mark, quantity, wallet balance and maintenance rate held fixed. Not an order
 * or an OKX liquidation quote; future fees, funding and adds change the result.
 */
export function estimatePaperLiquidationPrices(
  config: PaperPerpetualEngineConfig,
  snapshot: PaperPerpetualEngineSnapshot,
): Map<string, string | null> {
  const equity =
    signed(snapshot.balanceQuote) +
    snapshot.positions.reduce((n, p) => n + signed(p.unrealizedPnlQuote), 0n);
  const groups = new Map<string, { mark: bigint; net: bigint; gross: bigint; rate: bigint }>();
  let maintenance = 0n;
  for (const position of snapshot.positions) {
    const terms = config.instruments.find((i) => i.instrument === position.instrument);
    if (!terms) throw Error("Executor position market unavailable");
    const quantity = amount(position.quantityBase),
      mark = amount(position.markPriceQuote),
      rate = amount(terms.maintenanceRate);
    const group = groups.get(position.instrument) ?? { mark, net: 0n, gross: 0n, rate };
    if (group.mark !== mark) throw Error("Conflicting instrument marks");
    group.net += position.side === "LONG" ? quantity : -quantity;
    group.gross += quantity;
    groups.set(position.instrument, group);
    maintenance += (quantity * mark * rate + SCALE * SCALE - 1n) / (SCALE * SCALE);
  }
  return new Map(
    [...groups].map(([instrument, p]) => {
      const slope = p.net * SCALE - p.gross * p.rate;
      if (slope === 0n) return [instrument, null];
      const price = p.mark + ((maintenance - equity) * SCALE * SCALE) / slope;
      return [instrument, price > 0n ? format(price) : null];
    }),
  );
}
