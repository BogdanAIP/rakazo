import type { TradingInstrument } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { assessTradingPaperWorkerMarketTargetPreflightInTransaction } from "./trading-paper-worker-market-target.js";
export async function verifyManagedTradingPaperMarketInTransaction(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  ledgerId: string,
  market: TradingInstrument,
  now: Date,
) {
  const managed = await tx.tradingPaperWorkspace.findUnique({
    where: { ledgerId },
    select: { ledgerId: true },
  });
  if (!managed) return true;
  const target = await assessTradingPaperWorkerMarketTargetPreflightInTransaction(
    tx,
    owner,
    ledgerId,
    now,
  );
  return (
    target.status === "ready" &&
    target.venue === market.venue &&
    target.symbol === market.symbol &&
    market.kind === "spot" &&
    market.quote === "USDT"
  );
}
