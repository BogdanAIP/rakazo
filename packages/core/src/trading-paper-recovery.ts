import type { PaperPerpetualEngineBatch, PaperPerpetualEngineSnapshot } from "@rakazo/contracts";

const SCALE = 100_000_000n;
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;
function fixed(raw: string): bigint {
  const text = raw.trim().replace(/ USDT$/, "");
  if (!decimal.test(text)) throw new Error("Invalid native PAPER settlement");
  const negative = text.startsWith("-");
  const [whole, part = ""] = (negative ? text.slice(1) : text).split(".");
  const n = BigInt(whole!) * SCALE + BigInt(part.padEnd(8, "0"));
  return negative ? -n : n;
}
function format(n: bigint): string {
  const abs = n < 0n ? -n : n;
  return (
    (n < 0n ? "-" : "") + (abs / SCALE).toString() + "." + (abs % SCALE).toString().padStart(8, "0")
  );
}
type Transition = Readonly<{
  input: PaperPerpetualEngineBatch;
  output: PaperPerpetualEngineSnapshot;
}>;
type PositionEpisode = {
  positionId: string;
  side: "long" | "short";
  netFlows: bigint;
  fees: bigint;
  funding: bigint;
  grossEntered: bigint;
  worstNet: bigint;
  underwater: boolean;
  liquidated: boolean;
  completed: boolean;
};
/**
 * Native journal-based recovery of a POSITION EPISODE (one positionId).
 * Scale-in and partial closes on that position are captured. Hedges and
 * rotations with DIFFERENT IDs are NOT counted as a single economic idea:
 * that requires a persistent, explicitly authorized idea lineage.
 *
 * An episode was genuinely underwater when net marked PnL fell more than
 * max(0.5% of cumulative entered notional, 0.05 USDT). Initial fees alone
 * should not count every new position as a "recovery".
 * A recovery requires that episode to be FULLY CLOSED at positive net PnL
 * after all directly attributable commissions and funding.
 *
 * All transitions MUST be obtained from a verified full hash-chain replay,
 * never one page of the UI journal. Missing fills refuse a verified score.
 */
export function summarizePaperPositionRecovery(transitions: readonly Transition[]):
  | {
      status: "verified";
      scope: "position_only";
      completedUnderwater: number;
      recovered: number;
      recoveryRatePercent: string | null;
      completedLosses: number;
      openUnderwater: number;
      liquidated: number;
    }
  | { status: "incomplete"; scope: "position_only"; reason: string } {
  const episodes = new Map<string, PositionEpisode>();
  try {
    for (const { input, output } of transitions) {
      const orders = new Map(
        input.commands.filter((x) => x.kind === "order").map((x) => [x.orderId, x]),
      );
      for (const event of output.events) {
        if (event.kind === "fill") {
          const id = event.positionId;
          const orderId = event.orderId;
          if (!id || !orderId || !event.quantityBase || !event.priceQuote || !event.commission)
            throw new Error("missing_native_fill_detail");
          const order = orders.get(orderId);
          const isLiquidation = orderId.startsWith("LIQUIDATION");
          const prior = episodes.get(id);
          if (!order && (!isLiquidation || !prior)) throw new Error("unattributed_native_fill");
          const action = order?.action ?? (prior!.side === "long" ? "sell" : "buy");
          const qty = fixed(event.quantityBase);
          const price = fixed(event.priceQuote);
          const fee = fixed(event.commission);
          if (qty <= 0n || price <= 0n || fee < 0n) throw new Error("invalid_native_fill");
          const side = order?.reduceOnly ? prior?.side : action === "buy" ? "long" : "short";
          if (!side || (prior && prior.side !== side)) throw new Error("invalid_position_lineage");
          const ep: PositionEpisode = prior ?? {
            positionId: id,
            side,
            netFlows: 0n,
            fees: 0n,
            funding: 0n,
            grossEntered: 0n,
            worstNet: 0n,
            underwater: false,
            liquidated: false,
            completed: false,
          };
          if (ep.completed) throw new Error("reopened_completed_position");
          const notional = (qty * price) / SCALE;
          ep.netFlows += action === "sell" ? notional : -notional;
          ep.fees += fee;
          if (order && !order.reduceOnly) ep.grossEntered += notional;
          if (isLiquidation) ep.liquidated = true;
          episodes.set(id, ep);
        } else if (event.kind === "funding") {
          if (!event.positionId || !event.paymentQuoteSigned)
            throw new Error("unattributed_funding");
          const ep = episodes.get(event.positionId);
          if (!ep || ep.completed) throw new Error("unknown_position_funding");
          ep.funding += fixed(event.paymentQuoteSigned);
        }
      }
      const current = new Map(output.positions.map((x) => [x.positionId, x]));
      for (const ep of episodes.values()) {
        if (ep.completed) continue;
        const position = current.get(ep.positionId);
        const markValue = position
          ? (fixed(position.quantityBase) * fixed(position.markPriceQuote)) / SCALE
          : 0n;
        const balance =
          ep.netFlows + (ep.side === "long" ? markValue : -markValue) - ep.fees + ep.funding;
        if (balance < ep.worstNet) ep.worstNet = balance;
        const threshold =
          ep.grossEntered / 200n > SCALE / 20n ? ep.grossEntered / 200n : SCALE / 20n;
        if (balance < -threshold) ep.underwater = true;
        if (!position) {
          // Only native fill-driven episodes exist; a closed episode is final.
          ep.completed = true;
        }
      }
    }
    const all = [...episodes.values()];
    const completedUnderwater = all.filter((x) => x.completed && x.underwater);
    const recovered = completedUnderwater.filter(
      (x) => !x.liquidated && x.netFlows - x.fees + x.funding > 0n,
    ).length;
    return {
      status: "verified",
      scope: "position_only",
      completedUnderwater: completedUnderwater.length,
      recovered,
      recoveryRatePercent:
        completedUnderwater.length === 0
          ? null
          : ((10000 * recovered) / completedUnderwater.length / 100).toFixed(2),
      completedLosses: all.filter((x) => x.completed && x.netFlows - x.fees + x.funding <= 0n)
        .length,
      openUnderwater: all.filter((x) => !x.completed && x.underwater).length,
      liquidated: all.filter((x) => x.liquidated).length,
    };
  } catch (error) {
    return {
      status: "incomplete",
      scope: "position_only",
      reason: error instanceof Error ? error.message : "unreadable_native_event",
    };
  }
}
