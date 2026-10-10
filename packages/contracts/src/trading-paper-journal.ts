import * as z from "zod";
import { IsoDate } from "./ids.js";
import {
  TradingPaperLedgerEventSchema,
  TradingPaperLedgerStateSchema,
} from "./trading-paper-ledger.js";

const PaperLedgerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const TradingPaperJournalListOutputSchema = z.object({
  mode: z.literal("paper_only"),
  ledgers: z
    .array(
      z.object({
        ledgerId: PaperLedgerIdSchema,
        openedAt: IsoDate,
        updatedAt: IsoDate,
        quoteCurrency: z.string(),
        eventsCount: z.number().int().nonnegative(),
      }),
    )
    .max(50),
});

export const TradingPaperJournalReadInputSchema = z.object({
  ledgerId: PaperLedgerIdSchema,
  beforeSequence: z.number().int().positive().safe().optional(),
});

export const TradingPaperJournalReadOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    openedAt: IsoDate,
    updatedAt: IsoDate,
    state: TradingPaperLedgerStateSchema,
    events: z.array(TradingPaperLedgerEventSchema).max(100),
    nextBeforeSequence: z.number().int().positive().safe().nullable(),
  }),
  z.object({
    status: z.literal("integrity_blocked"),
    mode: z.literal("paper_only"),
    ledgerId: PaperLedgerIdSchema,
    // Financial details are deliberately omitted for an invalid journal.
    message: z.literal("Journal integrity verification failed"),
  }),
]);

export type TradingPaperJournalListOutput = z.infer<typeof TradingPaperJournalListOutputSchema>;
export type TradingPaperJournalReadOutput = z.infer<typeof TradingPaperJournalReadOutputSchema>;
