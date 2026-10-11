import * as z from "zod";

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const Amount = z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/);
const Positive = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/)
  .refine((v) => /[1-9]/.test(v));
const Instrument = z.string().regex(/^[A-Z0-9]{1,20}-USDT-SWAP$/);
const Clock = z.string().regex(/^[1-9]\d{0,19}$/);
export const PaperPerpetualEngineInstrumentSchema = z
  .object({
    instrument: Instrument,
    priceIncrement: Positive,
    quantityIncrement: Positive,
    minimumBase: Positive,
    maximumBase: Positive,
    maintenanceRate: Positive,
    makerFeeRate: Amount,
    takerFeeRate: Amount,
  })
  .strict();
export const PaperPerpetualEngineConfigSchema = z
  .object({
    version: z.literal("paper_engine_config_v1"),
    engineId: Id,
    engineVersion: z.string().min(1).max(64),
    accountId: Id,
    initialBalanceQuote: z.literal("1000"),
    leverage: z.number().int().positive().safe(),
    instruments: z.array(PaperPerpetualEngineInstrumentSchema).min(1).max(8),
  })
  .strict();
export const PaperPerpetualEngineBatchSchema = z
  .object({
    registerInstruments: z.array(PaperPerpetualEngineInstrumentSchema).max(8).optional(),
    leverage: z.number().int().positive().safe().optional(),
    sequence: z.number().int().positive().safe(),
    quotes: z
      .array(
        z
          .object({
            instrument: Instrument,
            atNs: Clock,
            bidQuote: Positive,
            askQuote: Positive,
            fundingNextAtNs: Clock.optional(),
            sourceId: Id.optional(),
            bookObservedAtNs: Clock.optional(),
            markObservedAtNs: Clock.optional(),
            markPriceQuote: Positive.optional(),
            bidAvailableBase: Amount,
            askAvailableBase: Amount,
          })
          .strict(),
      )
      .max(100),
    commands: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("cancel"), instrument: Instrument, orderId: Id }).strict(),
          z
            .object({
              kind: z.literal("order"),
              orderId: Id,
              positionId: Id,
              instrument: Instrument,
              action: z.enum(["buy", "sell"]),
              quantityBase: Positive,
              reduceOnly: z.boolean(),
              orderType: z.enum(["market", "limit"]),
              limitPriceQuote: Positive.nullable(),
            })
            .strict(),
        ]),
      )
      .max(8),
    funding: z
      .array(
        z
          .object({
            instrument: Instrument,
            atNs: Clock,
            rateSigned: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,24})?$/),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const PaperPerpetualEngineSnapshotSchema = z
  .object({
    version: z.literal("paper_engine_snapshot_v1"),
    engineId: Id,
    engineVersion: z.string().min(1).max(64),
    accountId: Id,
    sequence: z.number().int().positive().safe(),
    marginMode: z.literal("account_wide"),
    leverage: z.number().int().positive().safe(),
    clockNs: Clock,
    balanceQuote: Amount,
    availableQuote: Amount,
    lockedQuote: Amount,
    positions: z
      .array(
        z
          .object({
            positionId: Id,
            instrument: Instrument,
            side: z.enum(["LONG", "SHORT"]),
            quantityBase: Positive,
            realizedPnl: Amount,
            entryPriceQuote: Positive,
            markPriceQuote: Positive,
            unrealizedPnlQuote: Amount,
          })
          .strict(),
      )
      .max(100),
    closedPositions: z.number().int().nonnegative().safe(),
    openOrders: z
      .array(z.object({ orderId: Id, instrument: Instrument, quantityBase: Positive }).strict())
      .max(100),
    realizedPnlQuote: Amount,
    totalFeesQuote: Amount,
    fundingNetQuote: Amount,
    liquidations: z.number().int().nonnegative().safe(),
    eventCount: z.number().int().nonnegative().safe(),
    events: z.array(z.record(z.string(), z.string().max(2000))).max(1000),
  })
  .strict();
export type PaperPerpetualEngineConfig = z.infer<typeof PaperPerpetualEngineConfigSchema>;
export type PaperPerpetualEngineBatch = z.infer<typeof PaperPerpetualEngineBatchSchema>;
export type PaperPerpetualEngineSnapshot = z.infer<typeof PaperPerpetualEngineSnapshotSchema>;
