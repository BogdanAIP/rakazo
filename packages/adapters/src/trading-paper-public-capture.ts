import type { PrismaClient } from "@rakazo/db";
import {
  recordIdempotentPublicAdapterPaperQuoteEvidence,
  recordPublicAdapterPaperQuoteEvidence,
} from "@rakazo/db";
import { fetchBingxPublicSpotSnapshot } from "./trading-bingx-public.js";
import { fetchOkxPublicCatalog, fetchOkxPublicSpotTickers } from "./trading-okx-public.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
export type PublicPaperSpotTarget = { venue: "okx" | "bingx"; symbol: string };

/** Explicit trusted-Rakazo-internal invocation ONLY; never an AI/RPC action or
 * recurring poller. Endpoints are hardcoded in existing keyless GET adapters;
 * there is deliberately NO caller-provided URL, fetch, clock, headers, price,
 * market metadata, API key or source label. It stores an observation, not a
 * signed exchange attestation, risk approval, fill or virtual money mutation. */
export async function capturePublicPaperSpotEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  target: PublicPaperSpotTarget,
  evidenceId?: string,
): Promise<{ id: string; source: "public_adapter_observation" }> {
  if (!/^[A-Z0-9]{2,40}-[A-Z0-9]{2,40}$/.test(target.symbol)) {
    throw new Error("Invalid public spot symbol");
  }
  const snapshot =
    target.venue === "bingx"
      ? await fetchBingxPublicSpotSnapshot()
      : await (async () => {
          const catalog = await fetchOkxPublicCatalog();
          const markets = catalog.markets.filter((market) => market.kind === "spot");
          return {
            markets,
            tickers: await fetchOkxPublicSpotTickers(markets),
          };
        })();
  const markets = snapshot.markets.filter(
    (market) => market.venue === target.venue && market.symbol === target.symbol,
  );
  const tickers = snapshot.tickers.filter(
    (ticker) =>
      ticker.venue === target.venue && ticker.kind === "spot" && ticker.symbol === target.symbol,
  );
  if (
    markets.length !== 1 ||
    tickers.length !== 1 ||
    markets[0]?.status !== "active" ||
    markets[0]?.kind !== "spot"
  ) {
    throw new Error("Active public spot market and ticker pair is unavailable");
  }
  // All owner, quote-currency, metadata, precision and freshness checks are
  // repeated by the DB service; no later stage may trust this return as allow.
  return evidenceId
    ? recordIdempotentPublicAdapterPaperQuoteEvidence(
        prisma,
        owner,
        ledgerId,
        evidenceId,
        markets[0],
        tickers[0],
      )
    : recordPublicAdapterPaperQuoteEvidence(prisma, owner, ledgerId, markets[0], tickers[0]);
}
