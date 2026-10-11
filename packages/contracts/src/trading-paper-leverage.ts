import * as z from "zod";
import { IsoDate } from "./ids.js";

const Quantity = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/);
const Instrument = z.string().regex(/^[A-Z0-9]{1,20}-USDT-SWAP$/);
export const PaperVenueLeverageLimitsSchema = z.object({
  venue: z.enum(["okx", "bingx"]),
  instrument: Instrument,
  marginMode: z.enum(["cross", "isolated"]),
  sourceId: z.string().trim().min(1).max(256),
  observedAt: IsoDate,
  tiers: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(128),
        minQuantityBase: Quantity,
        maxQuantityBase: Quantity,
        maxLeverage: z.number().min(1).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(1000),
});
export type PaperVenueLeverageLimits = z.infer<typeof PaperVenueLeverageLimitsSchema>;
export type PaperLeverageTier = PaperVenueLeverageLimits["tiers"][number];
export const PaperLeverageReadInputSchema = z.object({
  ledgerId: z.string().min(1).max(128),
  instruments: z
    .array(Instrument)
    .min(1)
    .max(8)
    .refine((rows) => new Set(rows).size === rows.length),
});
