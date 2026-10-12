import * as z from "zod";
import { IsoDate } from "./ids.js";
import { TradingCandleSchema, TradingInstrumentSchema } from "./trading.js";
import { PaperVenueLeverageLimitsSchema } from "./trading-paper-leverage.js";

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const Decimal = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/);
const Positive = Decimal.refine((value) => /[1-9]/.test(value));
export const PaperPerpetualStrategySchema = z.enum(["conservative", "moderate", "aggressive"]);
const Instrument = z.string().regex(/^[A-Z0-9]{1,20}-USDT-SWAP$/);
export const PaperPerpetualDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_trade"), reason: z.string().trim().min(1).max(2000) }).strict(),
  z
    .object({
      kind: z.literal("proposal"),
      instrument: Instrument,
      side: z.enum(["long", "short"]),
      leverage: z.number().int().positive().safe(),
      quantityBase: Positive,
      orderType: z.enum(["market", "limit"]),
      limitPriceQuote: Positive.nullable(),
      stopPriceQuote: Positive,
      takeProfitPriceQuote: Positive,
      /** Optional native-only scale-in: reuse the existing position and its exits. */
      addToPositionId: Id.optional(),
      /** Optional quote-sized FUTURE addition budget. Executor enforces a safety floor. */
      plannedRecoveryNotionalQuote: Decimal.optional(),
      /** Optional native-only rotation: close this old position before attempting entry. */
      replacePositionId: Id.optional(),
      rationale: z.string().trim().min(1).max(2000),
    })
    .strict()
    .refine((p) => !(p.addToPositionId && p.replacePositionId), {
      message: "Cannot scale in and rotate out in one proposal",
    }),
  z
    .object({
      kind: z.literal("close"),
      positionId: Id,
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reduce"),
      positionId: Id,
      quantityBase: Positive,
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tighten_stop"),
      positionId: Id,
      stopPriceQuote: Positive,
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export type PaperPerpetualDecision = z.infer<typeof PaperPerpetualDecisionSchema>;
export const PaperPerpetualSourceSchema = z
  .object({
    semanticKey: z.literal("futures.data"),
    resolverKey: z.string().min(1).max(512),
    resolverDigest: z.string().regex(/^[a-f0-9]{64}$/),
    skillKey: z.string().min(1).max(512),
    skillDigest: z.string().regex(/^[a-f0-9]{64}$/),
    skillVariant: z.enum(["original", "rccl", "wrapped", "hybrid"]),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    implementationReference: z.string().min(1).max(512),
  })
  .strict();
export type PaperPerpetualSource = z.infer<typeof PaperPerpetualSourceSchema>;
export const PaperPerpetualPreparationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), name: z.string(), scope: PaperPerpetualSourceSchema }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["market_not_ready", "model_not_configured", "engine_not_configured"]),
  }),
]);
export type PaperPerpetualPreparation = z.infer<typeof PaperPerpetualPreparationSchema>;
const Base = {
  ledgerId: Id,
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
};
export const PaperPerpetualCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...Base,
      action: z.literal("start"),
      venue: z.literal("okx"),
      instruments: z
        .array(Instrument)
        .min(1)
        .max(8)
        .refine((a) => new Set(a).size === a.length),
      durationMinutes: z.number().int().min(15).max(20160),
      protectionMinutes: z.number().int().min(15).max(1440),
      source: PaperPerpetualSourceSchema,
    })
    .strict(),
  z
    .object({
      ...Base,
      action: z.literal("set_leverage"),
      venue: z.literal("okx"),
      instruments: z
        .array(Instrument)
        .min(1)
        .max(8)
        .refine((a) => new Set(a).size === a.length),
      maxLeverage: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ ...Base, action: z.enum(["pause", "end", "close_all"]) }).strict(),
  z
    .object({
      ...Base,
      action: z.literal("protect"),
      durationMinutes: z.number().int().min(15).max(1440),
    })
    .strict(),
]);
export type PaperPerpetualCommand = z.infer<typeof PaperPerpetualCommandSchema>;
export const PaperPerpetualWorkspaceStatusSchema = z.object({
  mode: z.literal("paper_only"),
  status: z.enum(["verified", "integrity_blocked"]),
  ledgerId: Id,
  strategy: PaperPerpetualStrategySchema,
  revision: z.number().int().nonnegative(),
  managed: z.boolean(),
  startedAt: IsoDate.nullable(),
  sessionStatus: z.enum(["idle", "active", "paused", "ended", "expired"]),
  phase: z.enum(["idle", "active", "protection_only", "finished", "attention_required"]),
  expiresAt: IsoDate.nullable(),
  protectionExpiresAt: IsoDate.nullable(),
  runtimeError: z.string().nullable(),
  instruments: z.array(Instrument),
  lastDecision: z
    .object({
      at: IsoDate,
      outcome: z.string(),
      rationale: z.string(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
    })
    .nullable(),
  openOrders: z.array(
    z.object({
      orderId: Id,
      instrument: Instrument,
      side: z.enum(["long", "short"]),
      orderType: z.enum(["market", "limit"]),
      quantityBase: Decimal,
      limitPriceQuote: Decimal.nullable(),
      expiresAt: IsoDate,
    }),
  ),
  executionFees: z
    .array(
      z.object({
        instrument: Instrument,
        makerFeeRate: z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/),
        takerFeeRate: z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/),
      }),
    )
    .optional(),
  /** Capacity reserved inside the admission model, not wallet-locked cash. */
  recoveryReservations: z.array(z.object({
    positionId: Id,
    reservedNotionalQuote: Decimal,
    reservedStopRiskQuote: Decimal,
  }).strict()).max(4).optional(),
  pendingClose: z.boolean(),
  maxLeverage: z.number().int().positive().safe(),
});
export type PaperPerpetualWorkspaceStatus = z.infer<typeof PaperPerpetualWorkspaceStatusSchema>;

export const PaperPerpetualSnapshotSchema = z.object({
  market: TradingInstrumentSchema,
  fetchedAt: IsoDate,
  leverageLimits: PaperVenueLeverageLimitsSchema.optional(),
  book: z.object({
    venue: z.literal("okx"),
    instrument: Instrument,
    sourceId: Id,
    observedAt: IsoDate,
    bidQuote: Positive,
    askQuote: Positive,
    bidAvailableBase: Decimal,
    askAvailableBase: Decimal,
  }),
  rules: z.object({
    basePerContract: Positive,
    lotIncrementBase: Positive,
    minimumBase: Positive,
    maxTierBase: Positive,
    maintenanceMarginBps: z.number().int().min(1).max(1000),
    maxLeverage: z.number().int().positive(),
  }),
  markPriceQuote: Positive,
  markObservedAt: IsoDate,
  fundingNextAt: IsoDate.nullable().optional(),
  funding: z
    .array(
      z.object({
        settledAt: IsoDate,
        rateSigned: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,24})?$/),
        // Latest observed mark is an explicit PAPER valuation assumption.
        priceBasis: z.literal("latest_observed_mark_simulation"),
      }),
    )
    .max(400),
  history: z.array(TradingCandleSchema).max(100),
});
export type PaperPerpetualSnapshot = z.infer<typeof PaperPerpetualSnapshotSchema>;

const Proposal = PaperPerpetualDecisionSchema.options[1];
const Order = z.object({
  orderId: z.string(),
  proposal: Proposal,
  submittedAt: IsoDate,
  expiresAt: IsoDate,
  ideaRiskSpentQuote: Decimal.default("0"),
});
const Plan = z.object({
  positionId: z.string(),
  stopPriceQuote: z.string(),
  takeProfitPriceQuote: z.string(),
  stopRiskQuote: z.string(),
  /** Unspent, committed future add capacity (not an executable limit order). */
  recoveryReserveQuote: Decimal.default("0"),
  /** Pending stop-risk capacity attributable to the reserved adds. */
  recoveryReservedRiskQuote: Decimal.default("0"),
  fundingThrough: IsoDate,
});
export const PerpetualControlSchema = z
  .object({
    maxLeverage: z.number().int().positive().safe().nullable().default(null),
    sessionStatus: z.enum(["idle", "active", "paused", "ended"]),
    startedAt: IsoDate.nullable(),
    expiresAt: IsoDate.nullable(),
    protectionExpiresAt: IsoDate.nullable(),
    instruments: z.array(z.string()),
    source: PaperPerpetualSourceSchema.nullable(),
    orders: z.array(Order).max(1),
    plans: z.array(Plan).max(4),
    closeAll: z.boolean(),
    runtimeError: z.string().nullable(),
    lastResearchAt: IsoDate.nullable(),
    lastDecision: z
      .object({
        at: IsoDate,
        outcome: z.string(),
        rationale: z.string(),
        provider: z.string().nullable(),
        model: z.string().nullable(),
      })
      .nullable(),
  })
  .strict();
export type PerpetualControl = z.infer<typeof PerpetualControlSchema>;
