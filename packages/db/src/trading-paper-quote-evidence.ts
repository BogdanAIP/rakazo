import { createHash, randomUUID } from "node:crypto";
import { type TradingTicker, TradingTickerSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const SOURCE = "offline_fixture" as const;
const MAX_AGE_MS = 300_000;
const SCALE = 100_000_000n;
function exact(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) {
    throw new PaperQuoteEvidenceError("Unsupported exact quote decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
const sha = (value: TradingTicker) =>
  createHash("sha256")
    .update(JSON.stringify([SOURCE, value]), "utf8")
    .digest("hex");

export class PaperQuoteEvidenceError extends Error {
  constructor(message = "Paper quote evidence is unavailable or invalid") {
    super(message);
    this.name = "PaperQuoteEvidenceError";
  }
}
async function requireOwner(tx: Prisma.TransactionClient, owner: Owner, ledgerId: string) {
  const [member, ledger] = await Promise.all([
    tx.spaceMember.findFirst({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      select: { id: true },
    }),
    tx.tradingPaperLedger.findFirst({
      where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
      select: { id: true },
    }),
  ]);
  if (!member || !ledger) throw new PaperQuoteEvidenceError("Quote owner/scope denied");
}

/** Internal-only fixture ingestion. NOT a trusted-exchange attestation, order
 * quote, live data connector, approval or background collector. Never export
 * this write method from the @rakazo/db package entrypoint or expose as RPC. */
export async function recordSyntheticPaperQuoteEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  rawTicker: unknown,
): Promise<{ id: string; source: typeof SOURCE }> {
  const ticker = TradingTickerSchema.parse(rawTicker);
  if (ticker.kind !== "spot" || !["okx", "bingx"].includes(ticker.venue)) {
    throw new PaperQuoteEvidenceError("Only offline spot fixtures are accepted");
  }
  const observed = Date.parse(ticker.observedAt);
  const fetched = Date.parse(ticker.fetchedAt);
  const now = Date.now();
  if (
    observed > fetched + 2_000 ||
    fetched > now + 2_000 ||
    observed > now + 2_000 ||
    now - observed > MAX_AGE_MS ||
    now - fetched > MAX_AGE_MS
  )
    throw new PaperQuoteEvidenceError("Offline quote is stale or future-dated");
  if (
    exact(ticker.bid) === 0n ||
    exact(ticker.ask) === 0n ||
    exact(ticker.bid) > exact(ticker.ask)
  ) {
    throw new PaperQuoteEvidenceError("Offline bid/ask is crossed or zero");
  }
  const id = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwner(tx, owner, ledgerId);
        await tx.tradingPaperQuoteEvidence.create({
          data: {
            id,
            ledgerId,
            source: SOURCE,
            payload: JSON.parse(JSON.stringify(ticker)) as Prisma.InputJsonValue,
            payloadSha256: sha(ticker),
            observedAt: new Date(observed),
            fetchedAt: new Date(fetched),
          },
        });
        return { id, source: SOURCE };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Integrity/scope verification, NOT current-price validation or trade approval.
 * Old snapshots remain readable for audit, but must never authorize operations. */
export async function readVerifiedPaperQuoteEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  id: string,
): Promise<{ id: string; source: typeof SOURCE; ticker: TradingTicker }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await requireOwner(tx, owner, ledgerId);
        const row = await tx.tradingPaperQuoteEvidence.findFirst({ where: { id, ledgerId } });
        if (!row || row.source !== SOURCE) throw new PaperQuoteEvidenceError();
        const parsed = TradingTickerSchema.safeParse(row.payload);
        if (!parsed.success) throw new PaperQuoteEvidenceError();
        const ticker = parsed.data;
        if (
          row.payloadSha256 !== sha(ticker) ||
          row.observedAt.getTime() !== Date.parse(ticker.observedAt) ||
          row.fetchedAt.getTime() !== Date.parse(ticker.fetchedAt)
        )
          throw new PaperQuoteEvidenceError("Quote evidence digest/timestamps mismatch");
        if (ticker.kind !== "spot" || !["okx", "bingx"].includes(ticker.venue)) {
          throw new PaperQuoteEvidenceError();
        }
        return { id, source: SOURCE, ticker };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
