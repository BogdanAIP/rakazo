import * as z from "zod";
import { TradingPaperPolicySchema } from "./trading-paper.js";

const Ledger = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const Amount = z.string().regex(/^(?:[1-9]\d{0,8})(?:\.\d{1,8})?$/);
export const TradingPaperAccountCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    initialBalanceQuote: Amount,
    maxPerIdeaRiskQuote: Amount,
    maxDailyLossQuote: Amount,
    maxOpenRiskQuote: Amount,
    maxTotalExposureQuote: Amount,
  })
  .strict();
const Base = {
  ledgerId: Ledger,
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
};
export const TradingPaperWorkspaceCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...Base,
      action: z.literal("start"),
      venue: z.enum(["okx", "bingx"]),
      symbol: z.string().regex(/^[A-Z0-9]{2,20}-USDT$/),
      durationMinutes: z.number().int().min(15).max(240),
    })
    .strict(),
  z.object({ ...Base, action: z.enum(["pause", "end"]) }).strict(),
  z
    .object({
      ...Base,
      action: z.literal("protect"),
      expectedProtectionRevision: z.number().int().nonnegative().safe(),
      durationMinutes: z.number().int().min(15).max(1440),
    })
    .strict(),
]);
export const TradingPaperWorkspaceStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    mode: z.literal("paper_only"),
    ledgerId: Ledger,
    name: z.string(),
    sessionStatus: z.enum(["absent", "active", "paused", "ended", "expired"]),
    sessionRevision: z.number().int().nonnegative(),
    expiresAt: z.string().nullable(),
    protectionStatus: z.enum(["absent", "active", "ended", "expired"]),
    protectionRevision: z.number().int().nonnegative(),
    protectionExpiresAt: z.string().nullable(),
    phase: z.enum([
      "idle",
      "active",
      "settling",
      "protection_only",
      "finished",
      "attention_required",
    ]),
    policy: TradingPaperPolicySchema,
    openPositions: z.number().int().nonnegative(),
    openReservations: z.number().int().nonnegative(),
    runtimeError: z.string().nullable(),
  }),
  z.object({
    status: z.literal("integrity_blocked"),
    mode: z.literal("paper_only"),
    ledgerId: Ledger,
  }),
]);
export type TradingPaperAccountCreateInput = z.infer<typeof TradingPaperAccountCreateInputSchema>;
export type TradingPaperWorkspaceCommand = z.infer<typeof TradingPaperWorkspaceCommandSchema>;
export type TradingPaperWorkspaceStatus = z.infer<typeof TradingPaperWorkspaceStatusSchema>;
