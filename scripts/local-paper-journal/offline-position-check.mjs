import { fetchOkxClosedOneHourHistory, reviewPaperOfflineH1 } from "./offline-gap-runtime.mjs";

/** A bounded, owner-authenticated, read-only evidence check. Never changes PAPER. */
export async function inspectOfflinePositions({ rows, readRpc, fetchImpl, now, start, resumed }) {
  const guarded = rows.filter((row) => Array.isArray(row.rawPlans) && row.rawPlans.length);
  if (guarded.length > 3 || guarded.some((row) => row.rawPlans.length > 4))
    throw new Error("Offline audit scope exceeds limit");
  const catalog = guarded.length ? await readRpc("trading/catalog", {}, 1024 * 1024) : { markets: [] };
  if (!Array.isArray(catalog?.markets)) throw new Error("PAPER catalog unavailable");
  const results = [];
  for (const row of guarded) {
    const journal = await readRpc("trading/perpetualJournalRead",
      { ledgerId: row.ledgerId, limit: 1 }, 1024 * 1024);
    if (journal?.status !== "verified" || !Array.isArray(journal.state?.openPositions))
      throw new Error("Unverified PAPER ledger");
    if (journal.state.openPositions.length > 4) throw new Error("Too many offline positions");
    for (const position of journal.state.openPositions) {
      const item = {
        strategy: row.summary.strategy,
        instrument: position.instrument,
        executionVerified: false,
        fundingReviewRequired: true,
        newEntriesAuthorized: false,
      };
      const plan = row.rawPlans.find((p) => p.positionId === position.positionId);
      const instrument = catalog.markets.find((m) =>
        m.venue === "okx" && m.kind === "perpetual" && m.status === "active" &&
        m.symbol === position.instrument);
      if (!plan || !instrument || position.venue !== "okx" ||
          !["long", "short"].includes(position.side)) {
        results.push({ ...item, status: "history_incomplete", barsReviewed: 0 });
        continue;
      }
      try {
        const history = await fetchOkxClosedOneHourHistory(instrument,
          { fetchImpl, now: new Date(now()) });
        const review = reviewPaperOfflineH1({
          offlineAt: new Date(start).toISOString(),
          onlineAt: new Date(resumed).toISOString(),
          instrument: position.instrument,
          side: position.side,
          stopPriceQuote: plan.stopPriceQuote,
          takeProfitPriceQuote: plan.takeProfitPriceQuote,
          candles: history.candles,
        });
        results.push({ ...item, status: review.status, barsReviewed: review.barsReviewed });
      } catch {
        results.push({ ...item, status: "history_incomplete", barsReviewed: 0 });
      }
    }
  }
  return results;
}
