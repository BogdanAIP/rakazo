import { createHash, randomUUID } from "node:crypto";
import {
  type TradingInstrument,
  TradingInstrumentSchema,
  type TradingTicker,
  TradingTickerSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const SOURCE = "offline_fixture" as const;
const PUBLIC_SOURCE = "public_adapter_observation" as const;
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

const publicSha = (market: TradingInstrument, ticker: TradingTicker) =>
  createHash("sha256")
    .update(JSON.stringify([PUBLIC_SOURCE, market, ticker]), "utf8")
    .digest("hex");

function validateTicker(ticker: TradingTicker, now: number): void {
  const observed = Date.parse(ticker.observedAt);
  const fetched = Date.parse(ticker.fetchedAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(fetched) ||
    observed > fetched + 2_000 ||
    fetched > now + 2_000 ||
    observed > now + 2_000 ||
    now - observed > MAX_AGE_MS ||
    now - fetched > MAX_AGE_MS
  )
    throw new PaperQuoteEvidenceError("Quote is stale or future-dated");
  const bid = exact(ticker.bid);
  const ask = exact(ticker.ask);
  if (bid === 0n || ask === 0n || bid > ask) {
    throw new PaperQuoteEvidenceError("Bid/ask is crossed or zero");
  }
}
function validatePair(market: TradingInstrument, ticker: TradingTicker): void {
  if (
    market.kind !== "spot" ||
    market.status !== "active" ||
    market.expiryAt !== null ||
    market.priceIncrement === null ||
    market.quantityIncrement === null ||
    !["okx", "bingx"].includes(market.venue) ||
    ticker.kind !== "spot" ||
    ticker.venue !== market.venue ||
    ticker.symbol !== market.symbol ||
    exact(market.priceIncrement) === 0n ||
    exact(market.quantityIncrement) === 0n ||
    (market.minNotional !== null && exact(market.minNotional) === 0n)
  )
    throw new PaperQuoteEvidenceError("Public spot market/ticker mismatch or incomplete precision");
}

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

/** Persist source-labeled public adapter observation in the EXISTING scoped DB.
 * This function is DB-only; its inputs must originate from the fixed-endpoint
 * adapter function, never a model, RPC route or caller-reported source label.
 * Hash is an integrity checksum, NOT an exchange signature or risk approval. */
async function recordPublicAdapterPaperQuoteEvidenceWithId(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  id: string,
  rawMarket: unknown,
  rawTicker: unknown,
): Promise<{ id: string; source: typeof PUBLIC_SOURCE }> {
  const market = TradingInstrumentSchema.parse(rawMarket);
  const ticker = TradingTickerSchema.parse(rawTicker);
  validatePair(market, ticker);
  validateTicker(ticker, Date.now());
  try {
    return await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await requireOwner(tx, owner, ledgerId);
          const existing = await tx.tradingPaperQuoteEvidence.findFirst({
            where: { id, ledgerId },
            select: { id: true },
          });
          if (existing) {
            const checked = await verifyPublicPaperQuoteEvidenceInTransaction(
              tx,
              owner,
              ledgerId,
              id,
            );
            if (!checked) throw new PaperQuoteEvidenceError();
            return { id, source: PUBLIC_SOURCE };
          }
          const ledger = await tx.tradingPaperLedger.findUniqueOrThrow({
            where: { id: ledgerId },
            select: { quoteCurrency: true },
          });
          if (market.quote !== ledger.quoteCurrency) {
            throw new PaperQuoteEvidenceError("Observed quote currency differs from ledger");
          }
          await tx.tradingPaperQuoteEvidence.create({
            data: {
              id,
              ledgerId,
              source: PUBLIC_SOURCE,
              market: JSON.parse(JSON.stringify(market)) as Prisma.InputJsonValue,
              payload: JSON.parse(JSON.stringify(ticker)) as Prisma.InputJsonValue,
              payloadSha256: publicSha(market, ticker),
              observedAt: new Date(ticker.observedAt),
              fetchedAt: new Date(ticker.fetchedAt),
            },
          });
          return { id, source: PUBLIC_SOURCE };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      await readVerifiedPublicPaperQuoteEvidence(prisma, owner, ledgerId, id);
      return { id, source: PUBLIC_SOURCE };
    }
    throw error;
  }
}

export async function recordPublicAdapterPaperQuoteEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  rawMarket: unknown,
  rawTicker: unknown,
): Promise<{ id: string; source: typeof PUBLIC_SOURCE }> {
  return recordPublicAdapterPaperQuoteEvidenceWithId(
    prisma,
    owner,
    ledgerId,
    randomUUID(),
    rawMarket,
    rawTicker,
  );
}

/** Worker-only durable idempotency key. Reusing the same scheduled-wake ID
 * returns the already verified observation instead of inserting another row. */
export async function recordIdempotentPublicAdapterPaperQuoteEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  id: string,
  rawMarket: unknown,
  rawTicker: unknown,
): Promise<{ id: string; source: typeof PUBLIC_SOURCE }> {
  if (!/^paper-(?:worker|resolver|market):[a-f0-9]{64}$/u.test(id)) {
    throw new PaperQuoteEvidenceError("Invalid paper worker evidence id");
  }
  return recordPublicAdapterPaperQuoteEvidenceWithId(
    prisma,
    owner,
    ledgerId,
    id,
    rawMarket,
    rawTicker,
  );
}

/** For evidence/audit UI only. Does not grant the quote freshness at decision
 * time, signal approval, capacity to reserve, or authenticated venue signing. */
export async function readVerifiedPublicPaperQuoteEvidence(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  id: string,
): Promise<{
  id: string;
  source: typeof PUBLIC_SOURCE;
  market: TradingInstrument;
  ticker: TradingTicker;
}> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const checked = await verifyPublicPaperQuoteEvidenceInTransaction(tx, owner, ledgerId, id);
        if (!checked) throw new PaperQuoteEvidenceError();
        return checked;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Internal reader for the SAME serializable transaction as policy + P10 replay.
 * Returns null for absent/offline evidence, throws for corrupt public evidence.
 * Reading a valid row does NOT grant an approval or an allow token. */
export async function verifyPublicPaperQuoteEvidenceInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  id: string,
): Promise<{
  id: string;
  source: typeof PUBLIC_SOURCE;
  market: TradingInstrument;
  ticker: TradingTicker;
} | null> {
  await requireOwner(tx, owner, ledgerId);
  const row = await tx.tradingPaperQuoteEvidence.findFirst({ where: { id, ledgerId } });
  if (!row || row.source !== PUBLIC_SOURCE) return null;
  const parsedMarket = TradingInstrumentSchema.safeParse(row.market);
  const parsedTicker = TradingTickerSchema.safeParse(row.payload);
  if (!parsedMarket.success || !parsedTicker.success) throw new PaperQuoteEvidenceError();
  const market = parsedMarket.data;
  const ticker = parsedTicker.data;
  validatePair(market, ticker);
  if (
    row.payloadSha256 !== publicSha(market, ticker) ||
    row.observedAt.getTime() !== Date.parse(ticker.observedAt) ||
    row.fetchedAt.getTime() !== Date.parse(ticker.fetchedAt)
  )
    throw new PaperQuoteEvidenceError("Public quote digest/timestamps mismatch");
  return { id, source: PUBLIC_SOURCE, market, ticker };
}
