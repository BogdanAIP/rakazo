/**
 * Inert defaults for the three independent Rakazo PAPER experiments.
 *
 * These are NOT execution approvals, exchange permissions, margin calculations,
 * liquidation estimates, or substitutes for the persisted risk/approval gates.
 * Keep this module free of I/O and model calls.
 */
export type PaperExperimentStrategy = "conservative" | "moderate" | "aggressive";
export type PaperHedgeSide = "long" | "short";
export type PaperExperimentVenue = "okx" | "bingx";

export type PaperExperimentPreset = Readonly<{
  id: PaperExperimentStrategy;
  accountName: string;
  initialBalanceQuote: "1000";
  maxPerIdeaRiskQuote: string;
  maxDailyLossQuote: string;
  maxOpenRiskQuote: string;
  maxTotalExposureQuote: string;
  maxLeverage: 5 | 10 | 20;
  maxConcurrentPositions: 2 | 3 | 4;
  /** Proposed future derivatives bookkeeping, not an exchange setting. */
  positionMode: "hedge";
  /** Independent experimental strategy selection, not a strategy signal. */
  researchMode: "model_proposes";
}>;

const presets: Readonly<Record<PaperExperimentStrategy, PaperExperimentPreset>> = Object.freeze({
  conservative: Object.freeze({
    id: "conservative",
    accountName: "PAPER · Консервативная",
    initialBalanceQuote: "1000",
    maxPerIdeaRiskQuote: "5",
    maxDailyLossQuote: "15",
    maxOpenRiskQuote: "10",
    maxTotalExposureQuote: "500",
    maxLeverage: 5,
    maxConcurrentPositions: 2,
    positionMode: "hedge",
    researchMode: "model_proposes",
  }),
  moderate: Object.freeze({
    id: "moderate",
    accountName: "PAPER · Умеренная",
    initialBalanceQuote: "1000",
    maxPerIdeaRiskQuote: "10",
    maxDailyLossQuote: "30",
    maxOpenRiskQuote: "20",
    maxTotalExposureQuote: "1000",
    maxLeverage: 10,
    maxConcurrentPositions: 3,
    positionMode: "hedge",
    researchMode: "model_proposes",
  }),
  aggressive: Object.freeze({
    id: "aggressive",
    accountName: "PAPER · Агрессивная",
    initialBalanceQuote: "1000",
    maxPerIdeaRiskQuote: "20",
    maxDailyLossQuote: "50",
    maxOpenRiskQuote: "40",
    maxTotalExposureQuote: "1500",
    maxLeverage: 20,
    maxConcurrentPositions: 4,
    positionMode: "hedge",
    researchMode: "model_proposes",
  }),
});

export const PAPER_EXPERIMENT_STRATEGIES: readonly PaperExperimentStrategy[] = Object.freeze([
  "conservative",
  "moderate",
  "aggressive",
]);

export function getPaperExperimentPreset(id: PaperExperimentStrategy): PaperExperimentPreset {
  return presets[id];
}

/**
 * Serializes a future hedged derivative POSITION bucket (not an order).
 * Opposite sides, accounts/strategies, venues and markets must remain distinct.
 * Must never be used as a database primary key without owner/ledger scope.
 */
export function paperExperimentHedgeBucket(
  input: Readonly<{
    strategy: PaperExperimentStrategy;
    ledgerId: string;
    venue: PaperExperimentVenue;
    instrument: string;
    side: PaperHedgeSide;
  }>,
): string | null {
  if (!presets[input.strategy]) return null;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.ledgerId)) return null;
  if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(input.instrument)) return null;
  if (input.venue !== "okx" && input.venue !== "bingx") return null;
  if (input.side !== "long" && input.side !== "short") return null;
  return [
    "paper-hedge-v1",
    input.strategy,
    input.ledgerId,
    input.venue,
    input.instrument,
    input.side,
  ].join(":");
}
