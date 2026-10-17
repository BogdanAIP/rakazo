import * as z from "zod";
import { IsoDate } from "./ids.js";

/** Research supplied by the proposer; execution still captures fresh trusted
 * market data and applies the independent PAPER risk gates. */
export const PaperResearchComparisonSchema = z
  .object({
    asOf: IsoDate,
    validUntil: IsoDate,
    method: z.string().trim().min(1).max(300),
    profileRationale: z.string().trim().min(1).max(500),
    candidates: z
      .array(
        z
          .object({
            instrument: z.string().regex(/^[A-Z0-9]{1,20}-USDT-SWAP$/),
            verdict: z.enum(["selected", "rejected", "watch"]),
            reason: z.string().trim().min(1).max(500),
            facts: z
              .array(
                z
                  .object({
                    name: z.string().trim().min(1).max(64),
                    value: z.string().trim().min(1).max(120),
                  })
                  .strict(),
              )
              .max(6)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine(
        (rows) => new Set(rows.map((row) => row.instrument)).size === rows.length,
        "Duplicate comparison instrument",
      ),
  })
  .strict()
  .refine((value) => {
    const duration = Date.parse(value.validUntil) - Date.parse(value.asOf);
    return duration > 0 && duration <= 1800000;
  }, "Comparison validity must be positive and at most thirty minutes");
export type PaperResearchComparison = z.infer<typeof PaperResearchComparisonSchema>;
