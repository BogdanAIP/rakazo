import * as z from "zod";
import { IsoDate } from "./ids.js";

export const PAPER_RPC_ACCESS_PROCEDURES = [
  "trading/perpetualExperimentsCreate",
  "trading/perpetualMarketPrepare",
  "trading/perpetualLeverageRead",
  "trading/perpetualWorkspaceRead",
  "trading/perpetualWorkspaceCommand",
  "trading/perpetualJournalRead",
  "trading/perpetualJournalList",
  "trading/list",
  "trading/catalog",
  "trading/analyze",
  "trading/sweep",
  "trading/perpContext",
] as const;
export const RpcAccessProceduresSchema = z
  .array(z.enum(PAPER_RPC_ACCESS_PROCEDURES))
  .min(1)
  .max(PAPER_RPC_ACCESS_PROCEDURES.length)
  .refine((items) => new Set(items).size === items.length, "Duplicate RPC procedure");
export const RpcAccessGrantCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    durationMinutes: z.number().int().min(15).max(20160),
    procedures: RpcAccessProceduresSchema,
  })
  .strict();
export const RpcAccessGrantSchema = z.object({
  id: z.string(),
  label: z.string(),
  spaceId: z.string(),
  procedures: RpcAccessProceduresSchema,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  revokedAt: IsoDate.nullable(),
});
export const RpcAccessGrantCreatedSchema = RpcAccessGrantSchema.extend({
  token: z.string().regex(/^rkg_[A-Za-z0-9_-]{43}$/),
});
export type RpcAccessGrantCreate = z.infer<typeof RpcAccessGrantCreateSchema>;
