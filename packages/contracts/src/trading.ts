import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Decimals remain strings: JS numbers are not suitable for order-size precision. */
export const TradingDecimalSchema = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)), "Finite decimal required");
export const TradingPositiveDecimalSchema = TradingDecimalSchema.refine(
  (value) => Number(value) > 0,
  "Positive decimal required",
);

export const TradingMarketKindSchema = z.enum(["spot", "perpetual", "dated_future", "dex_swap"]);
export type TradingMarketKind = z.infer<typeof TradingMarketKindSchema>;

export const TradingActionSchema = z.enum([
  "spot_buy",
  "spot_sell",
  "long",
  "short",
  "reduce",
  "close",
]);
export type TradingAction = z.infer<typeof TradingActionSchema>;

export const TradingInstrumentSchema = z
  .object({
    venue: z.string().trim().min(1).max(80),
    kind: TradingMarketKindSchema,
    symbol: z.string().trim().min(3).max(128),
    base: z.string().trim().min(1).max(40),
    quote: z.string().trim().min(1).max(40),
    status: z.enum(["active", "inactive"]),
    priceIncrement: TradingPositiveDecimalSchema.nullable(),
    quantityIncrement: TradingPositiveDecimalSchema.nullable(),
    minNotional: TradingPositiveDecimalSchema.nullable(),
    expiryAt: IsoDate.nullable(),
  })
  .superRefine((market, ctx) => {
    if ((market.kind === "dated_future") !== (market.expiryAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiryAt"],
        message: "Only dated futures require expiryAt",
      });
    }
  });
export type TradingInstrument = z.infer<typeof TradingInstrumentSchema>;

export const TradingTickerSchema = z.object({
  venue: z.string().trim().min(1).max(80),
  kind: TradingMarketKindSchema,
  symbol: z.string().trim().min(3).max(128),
  observedAt: IsoDate,
  fetchedAt: IsoDate,
  bid: TradingPositiveDecimalSchema,
  ask: TradingPositiveDecimalSchema,
  quoteVolume24h: TradingDecimalSchema,
});
export type TradingTicker = z.infer<typeof TradingTickerSchema>;

const SignalBase = z.object({
  signalId: Id,
  strategyId: Id,
  strategyVersion: z.string().trim().min(1).max(128),
  createdAt: IsoDate,
  expiresAt: IsoDate,
  evidenceIds: z.array(Id).min(1).max(100),
});

export const TradingSignalSchema = z
  .discriminatedUnion("kind", [
    SignalBase.extend({
      kind: z.literal("no_trade"),
      reason: z.string().trim().min(1).max(2_000),
    }),
    SignalBase.extend({
      kind: z.literal("proposal"),
      /** A proposal is not an order and grants no execution authority. */
      executionStatus: z.literal("research_only"),
      market: TradingInstrumentSchema,
      action: TradingActionSchema,
      entryTrigger: TradingPositiveDecimalSchema,
      stopLoss: TradingPositiveDecimalSchema,
      takeProfit: z.array(TradingPositiveDecimalSchema).min(1).max(8),
      invalidation: z.string().trim().min(1).max(2_000),
      rationale: z.string().trim().min(1).max(2_000),
      /** Null until explicitly provisioned from authorized account risk settings. */
      riskBudgetQuote: TradingPositiveDecimalSchema.nullable(),
      /** Null until order-book/depth and execution costs are independently checked. */
      maxSlippageBps: z.number().finite().min(0).max(10_000).nullable(),
    }),
  ])
  .superRefine((signal, ctx) => {
    if (Date.parse(signal.expiresAt) <= Date.parse(signal.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Signal must expire after creation",
      });
    }
    if (signal.kind === "proposal") {
      if (
        (signal.action === "spot_buy" || signal.action === "spot_sell") &&
        signal.market.kind !== "spot" &&
        signal.market.kind !== "dex_swap"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Spot action requires a spot instrument",
        });
      }
      if (
        (signal.action === "long" || signal.action === "short") &&
        signal.market.kind !== "perpetual" &&
        signal.market.kind !== "dated_future"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["action"],
          message: "Derivative action requires a future",
        });
      }
    }
  });
export type TradingSignal = z.infer<typeof TradingSignalSchema>;

/**
 * Provenance for one Resolver-selected read-only research implementation.
 *
 * This is deliberately data-only. A selected Market Resolver route or Skill
 * never carries PAPER or live execution authority into Trading Core.
 */
export const TradingResolvedResearchImplementationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["mcp", "api", "cli", "browser", "computer", "native", "skill"]),
  reference: z.string().trim().min(1).max(500),
  priority: z.number().int().min(1).max(10_000),
  readOnly: z.literal(true),
});

export const TradingResolvedResearchSkillProvenanceSchema = z.object({
  marketEntryId: Id,
  marketKey: z.string().trim().min(1).max(200),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  variant: z.enum(["original", "rccl", "wrapped", "hybrid"]),
  /** SHA-256 of the exact selected instruction TEXT, not of the Market source revision.
   * Optional only for archived pre-G9 research envelopes. The G7 Market bridge
   * always adds it. Adapted variants cannot receive v1 PAPER approvals. */
  contentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const TradingResolvedResearchProvenanceSchema = z.object({
  semanticKey: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z][a-z0-9._-]*$/),
  resolverKey: z.string().trim().min(1).max(200),
  resolverDigest: z.string().regex(/^[a-f0-9]{64}$/),
  implementation: TradingResolvedResearchImplementationSchema,
  skill: TradingResolvedResearchSkillProvenanceSchema.nullable(),
  resolvedAt: IsoDate,
});
export type TradingResolvedResearchProvenance = z.infer<
  typeof TradingResolvedResearchProvenanceSchema
>;

/**
 * Normalized boundary between Market Resolver/Skills and Trading Core.
 *
 * The envelope can carry a proposal or explicit NO_TRADE, but it is always
 * research-only and grants no reserve/fill/close authority. A later explicit
 * strategy/risk gate must independently approve any PAPER state transition.
 */
export const TradingResolvedResearchEnvelopeSchema = z.object({
  schemaVersion: z.literal("trading-resolved-research-v1"),
  mode: z.literal("research_only"),
  executionAuthority: z.literal("none"),
  provenance: TradingResolvedResearchProvenanceSchema,
  signal: TradingSignalSchema,
});
export type TradingResolvedResearchEnvelope = z.infer<typeof TradingResolvedResearchEnvelopeSchema>;

/**
 * Immutable research-source identity that a later explicit PAPER strategy gate
 * may approve. It intentionally omits a signal's price levels and evidence so
 * approval cannot be confused with an order or one specific fill.
 */
const TradingResolvedResearchApprovalScopeV1Schema = z.object({
  schemaVersion: z.literal("trading-resolved-research-scope-v1"),
  semanticKey: TradingResolvedResearchProvenanceSchema.shape.semanticKey,
  resolverKey: TradingResolvedResearchProvenanceSchema.shape.resolverKey,
  resolverDigest: TradingResolvedResearchProvenanceSchema.shape.resolverDigest,
  implementationReference: TradingResolvedResearchImplementationSchema.shape.reference,
  skillSourceDigest: TradingResolvedResearchSkillProvenanceSchema.shape.sourceDigest.nullable(),
  strategyId: Id,
  strategyVersion: z.string().trim().min(1).max(128),
  venue: z.string().trim().min(1).max(80).nullable(),
  marketKind: TradingMarketKindSchema.nullable(),
  action: TradingActionSchema.nullable(),
});

/**
 * G9: an explicit owner approval for a Market Skill MUST bind the chosen
 * original/RCCL/wrapped/hybrid version AND SHA-256 of the actual instructions.
 *
 * V1 is retained strictly for replay/verification of existing historic grants.
 * Parsing and hashing stored v1 JSON must remain stable. G7 research with
 * pinned selected Skill content derives v2, never upgrades a v1 grant.
 */
const TradingResolvedResearchApprovalScopeV2Schema =
  TradingResolvedResearchApprovalScopeV1Schema.omit({ schemaVersion: true }).extend({
    schemaVersion: z.literal("trading-resolved-research-scope-v2"),
    skillVariant: TradingResolvedResearchSkillProvenanceSchema.shape.variant,
    skillContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  });

export const TradingResolvedResearchApprovalScopeSchema = z.discriminatedUnion("schemaVersion", [
  TradingResolvedResearchApprovalScopeV1Schema,
  TradingResolvedResearchApprovalScopeV2Schema,
]);
export type TradingResolvedResearchApprovalScope = z.infer<
  typeof TradingResolvedResearchApprovalScopeSchema
>;

/** Read-only, user-invoked market prefilter. It creates no orders or buy/sell signals. */
export const TradingScanRequestSchema = z.object({
  venue: z.enum(["bingx", "okx"]).default("bingx"),
  allowedQuotes: z
    .array(z.string().regex(/^[A-Z0-9]{2,20}$/))
    .min(1)
    .max(20)
    .default(["USDT"]),
  minQuoteVolume24h: z.number().finite().min(0).max(1e15).default(100_000),
  maxSpreadBps: z.number().finite().min(0).max(10_000).default(40),
  maxDataAgeMs: z.number().int().min(1_000).max(300_000).default(60_000),
});
export type TradingScanRequest = z.infer<typeof TradingScanRequestSchema>;

export const TradingExclusionReasonSchema = z.enum([
  "inactive",
  "quote_not_allowed",
  "missing_ticker",
  "stale_or_future_data",
  "invalid_book",
  "insufficient_volume",
  "excessive_spread",
]);

export const TradingScanOutputSchema = z.object({
  fetchedAt: IsoDate,
  candidates: z.array(
    z.object({
      market: TradingInstrumentSchema,
      ticker: TradingTickerSchema,
      spreadBps: z.number().finite().nonnegative(),
    }),
  ),
  excluded: z.array(
    z.object({
      market: TradingInstrumentSchema,
      reason: TradingExclusionReasonSchema,
    }),
  ),
});
export type TradingScanOutput = z.infer<typeof TradingScanOutputSchema>;

/** Public metadata only; this response has no order or signing capability. */
export const TradingCatalogOutputSchema = z.object({
  fetchedAt: IsoDate,
  markets: z.array(TradingInstrumentSchema),
  excluded: z.array(
    z.object({
      kind: z.enum(["spot", "perpetual", "dated_future"]),
      symbol: z.string().min(1).max(128),
      reason: z.enum(["incomplete_metadata", "pre_market_or_special_contract", "expired_contract"]),
    }),
  ),
});

/** Exactly one closed 1H source bar; quote volume is normalized by OKX volCcyQuote. */
export const TradingCandleSchema = z
  .object({
    venue: z.enum(["okx", "bingx"]),
    kind: z.enum(["spot", "perpetual", "dated_future"]),
    symbol: z.string().trim().min(3).max(128),
    openedAt: IsoDate,
    durationMs: z.literal(3_600_000),
    open: TradingPositiveDecimalSchema,
    high: TradingPositiveDecimalSchema,
    low: TradingPositiveDecimalSchema,
    close: TradingPositiveDecimalSchema,
    quoteVolume: TradingDecimalSchema,
    confirmed: z.literal(true),
  })
  .superRefine((candle, ctx) => {
    const o = Number(candle.open);
    const h = Number(candle.high);
    const l = Number(candle.low);
    const c = Number(candle.close);
    if (l > Math.min(o, c) || h < Math.max(o, c) || l > h) {
      ctx.addIssue({ code: "custom", path: ["high"], message: "Invalid candle OHLC bounds" });
    }
    if (Date.parse(candle.openedAt) % candle.durationMs !== 0) {
      ctx.addIssue({ code: "custom", path: ["openedAt"], message: "Unaligned 1H candle" });
    }
  });
export type TradingCandle = z.infer<typeof TradingCandleSchema>;

export const TradingCandleResearchInputSchema = z.object({
  symbol: z
    .string()
    .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/)
    .max(128),
  kind: z.enum(["spot", "perpetual", "dated_future"]),
});
export type TradingCandleResearchInput = z.infer<typeof TradingCandleResearchInputSchema>;

export const TradingResearchOutputSchema = z.object({
  algorithm: z.literal("breakout_20_1h_v1"),
  venue: z.enum(["okx", "bingx"]),
  market: TradingInstrumentSchema,
  fetchedAt: IsoDate,
  candleCount: z.number().int().nonnegative().max(100),
  latestClosedAt: IsoDate.nullable(),
  /** No live trade authority, with evidence and explicit abstention. */
  signal: TradingSignalSchema,
});
export type TradingResearchOutput = z.infer<typeof TradingResearchOutputSchema>;

/**
 * User-invoked, bounded cross-altcoin research. Candidate selection is by
 * quote turnover / data quality ONLY, not predicted profitability.
 */
export const TradingSweepRequestSchema = TradingScanRequestSchema.pick({
  allowedQuotes: true,
  minQuoteVolume24h: true,
  maxSpreadBps: true,
  maxDataAgeMs: true,
}).extend({
  maxInstruments: z.number().int().min(1).max(5).default(3),
});
export type TradingSweepRequest = z.infer<typeof TradingSweepRequestSchema>;

export const TradingSweepOutputSchema = z.object({
  venue: z.literal("okx"),
  fetchedAt: IsoDate,
  universeCount: z.number().int().nonnegative(),
  shortlistCount: z.number().int().nonnegative(),
  filteredOutCount: z.number().int().nonnegative(),
  /** Research outputs include proposals AND NO_TRADE, never executable orders. */
  analyzed: z.array(TradingResearchOutputSchema).max(5),
  unavailable: z
    .array(
      z.object({
        symbol: z.string().min(3).max(128),
        reason: z.literal("history_unavailable_or_invalid"),
      }),
    )
    .max(5),
});
export type TradingSweepOutput = z.infer<typeof TradingSweepOutputSchema>;

/** Signed, finite funding rate only; NOT an order-price or quantity schema. */
export const TradingSignedRateSchema = z
  .string()
  .max(64)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)), "Finite funding rate required");

export const TradingPerpContextInputSchema = z.object({
  symbol: z
    .string()
    .regex(/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/)
    .max(128),
});
export type TradingPerpContextInput = z.infer<typeof TradingPerpContextInputSchema>;

/** Read-only derivative telemetry; NOT liquidation price or position sizing. */
export const TradingPerpContextSchema = z.object({
  venue: z.literal("okx"),
  market: TradingInstrumentSchema,
  fetchedAt: IsoDate,
  funding: z.object({
    ratePerSettlement: TradingSignedRateSchema,
    settlementAt: IsoDate,
    nextIndicativeRate: TradingSignedRateSchema.nullable(),
    nextSettlementAt: IsoDate.nullable(),
  }),
  openInterest: z.object({
    contracts: TradingDecimalSchema,
    baseUnits: TradingDecimalSchema,
    usdNotional: TradingDecimalSchema,
    observedAt: IsoDate,
  }),
  mark: z.object({
    price: TradingPositiveDecimalSchema,
    observedAt: IsoDate,
  }),
});
export type TradingPerpContext = z.infer<typeof TradingPerpContextSchema>;
