import { createHash } from "node:crypto";
import {
  type TradingPaperLedgerEvent,
  TradingPaperLedgerEventSchema,
  type TradingPaperLedgerInput,
  TradingPaperLedgerInputSchema,
  type TradingPaperLedgerState,
  TradingPaperLedgerStateSchema,
} from "@rakazo/contracts";
import { replayTradingPaperLedger } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type PaperStoreDb = Pick<PrismaClient, "$transaction">;
type Owner = { spaceId: string; userId: string };
type PaperEvent = TradingPaperLedgerEvent;
const VERSION = "paper_spot_full_fill_v1" as const;
const MAX_REPLAY_EVENTS = 10_000;

export class PaperLedgerIntegrityError extends Error {
  constructor(message = "Paper ledger integrity mismatch; paper writes halted") {
    super(message);
    this.name = "PaperLedgerIntegrityError";
  }
}
export class PaperLedgerConflictError extends Error {
  constructor(message = "Paper ledger version or event conflict") {
    super(message);
    this.name = "PaperLedgerConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function normalizedEvent(value: unknown): PaperEvent {
  return TradingPaperLedgerEventSchema.parse(value);
}
function payload(value: PaperEvent): string {
  return JSON.stringify(normalizedEvent(value));
}
function stateJson(value: TradingPaperLedgerState): string {
  return JSON.stringify(TradingPaperLedgerStateSchema.parse(value));
}
function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function genesis(input: {
  ledgerId: string;
  spaceId: string;
  userId: string;
  openedAt: string;
  quoteCurrency: string;
  initialBalanceQuote: string;
}): string {
  return sha256(
    JSON.stringify([
      VERSION,
      input.ledgerId,
      input.spaceId,
      input.userId,
      input.openedAt,
      input.quoteCurrency,
      input.initialBalanceQuote,
    ]),
  );
}
function chained(previous: string, eventSha256: string): string {
  return sha256(JSON.stringify([previous, eventSha256]));
}
function header(row: {
  id: string;
  spaceId: string;
  ownerUserId: string;
  openedAt: Date;
  quoteCurrency: string;
  initialBalanceQuote: string;
}): TradingPaperLedgerInput {
  return TradingPaperLedgerInputSchema.parse({
    version: VERSION,
    ledgerId: row.id,
    openedAt: row.openedAt.toISOString(),
    quoteCurrency: row.quoteCurrency,
    initialBalanceQuote: row.initialBalanceQuote,
    events: [],
  });
}

/** No authorization here is derived from AI prose; this is a db-only helper.
 * The caller MUST be an authenticated Rakazo service. Never expose as MCP/RPC. */
async function assertMember(tx: Prisma.TransactionClient, owner: Owner): Promise<void> {
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!member) throw new PaperLedgerIntegrityError("Paper ledger scope is not accessible");
}

/**
 * Rebuilds EVERY stored event, verifies its canonical digest and hash chain,
 * then compares the reconstruction with the stored projection. Any mismatch
 * blocks future writes rather than silently accepting cached virtual money.
 * Hashes detect accidental DB edits, NOT an adversary with DB write privilege.
 */
async function recover(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<{
  row: Awaited<ReturnType<typeof tx.tradingPaperLedger.findFirst>> & {};
  events: PaperEvent[];
  state: TradingPaperLedgerState;
}> {
  await assertMember(tx, owner);
  const row = await tx.tradingPaperLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
  });
  if (!row) throw new PaperLedgerIntegrityError("Paper ledger unavailable for scoped owner");
  const rows = await tx.tradingPaperLedgerEvent.findMany({
    where: { ledgerId: row.id },
    orderBy: { sequence: "asc" },
  });
  if (rows.length > MAX_REPLAY_EVENTS || rows.length !== row.version) {
    throw new PaperLedgerIntegrityError("Paper event count differs from ledger revision");
  }
  const base = header(row);
  const openedAt = base.openedAt;
  let previous = genesis({
    ledgerId: row.id,
    spaceId: row.spaceId,
    userId: row.ownerUserId,
    openedAt,
    quoteCurrency: row.quoteCurrency,
    initialBalanceQuote: row.initialBalanceQuote,
  });
  const events: PaperEvent[] = [];
  for (const entry of rows) {
    const event = normalizedEvent(entry.payload);
    if (
      event.ledgerId !== ledgerId ||
      event.sequence !== events.length + 1 ||
      event.eventId !== entry.eventId ||
      event.kind !== entry.kind ||
      Date.parse(event.recordedAt) !== entry.recordedAt.getTime()
    )
      throw new PaperLedgerIntegrityError("Paper event metadata mismatch");
    const digest = sha256(payload(event));
    const chain = chained(previous, digest);
    if (
      digest !== entry.payloadSha256 ||
      previous !== entry.previousSha256 ||
      chain !== entry.chainSha256
    )
      throw new PaperLedgerIntegrityError("Paper event chain verification failed");
    events.push(event);
    previous = chain;
  }
  if (previous !== row.headSha256) {
    throw new PaperLedgerIntegrityError("Paper journal head digest mismatch");
  }
  const reconstructed = replayTradingPaperLedger({ ...base, events });
  const normalizedProjection = TradingPaperLedgerStateSchema.parse(row.projection);
  const digest = sha256(stateJson(reconstructed));
  if (
    row.projectionSha256 !== digest ||
    stateJson(normalizedProjection) !== stateJson(reconstructed) ||
    reconstructed.nextSequence !== row.version + 1
  )
    throw new PaperLedgerIntegrityError("Paper stored balance/projection differs from replay");
  return { row, events, state: reconstructed };
}

/**
 * Creates a disabled/inert synthetic ledger, not a deposit or an executable
 * paper account. Membership is checked within the same transaction.
 */
export async function createTradingPaperLedger(
  prisma: PaperStoreDb,
  owner: Owner,
  raw: Omit<TradingPaperLedgerInput, "events" | "version">,
): Promise<TradingPaperLedgerState> {
  const input = TradingPaperLedgerInputSchema.parse({
    ...raw,
    version: VERSION,
    events: [],
  });
  const openedAt = new Date(input.openedAt).toISOString();
  const base = { ...input, openedAt };
  const state = replayTradingPaperLedger(base);
  const head = genesis({
    ledgerId: input.ledgerId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    openedAt,
    quoteCurrency: input.quoteCurrency,
    initialBalanceQuote: input.initialBalanceQuote,
  });
  return prisma.$transaction(
    async (tx) => {
      await assertMember(tx, owner);
      await tx.tradingPaperLedger.create({
        data: {
          id: input.ledgerId,
          spaceId: owner.spaceId,
          ownerUserId: owner.userId,
          openedAt: new Date(openedAt),
          quoteCurrency: input.quoteCurrency,
          initialBalanceQuote: input.initialBalanceQuote,
          version: 0,
          projection: asJson(state),
          projectionSha256: sha256(stateJson(state)),
          headSha256: head,
        },
      });
      return state;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Read-only independently verified projection; no action permissions exposed. */
export async function readVerifiedTradingPaperLedger(
  prisma: PaperStoreDb,
  owner: Owner,
  ledgerId: string,
): Promise<TradingPaperLedgerState> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const verified = await recover(tx, owner, ledgerId);
        return verified.state;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * Trusted-service-only storage primitive. Accepts synthetic paper events, NOT
 * LLM instructions or an order request. Checks full replay BEFORE CAS, then
 * atomically updates projection + event + inert outbox row. A concurrent
 * conflicting revision either loses CAS or aborts the serializable transaction.
 */
export async function appendTradingPaperLedgerEvent(
  prisma: PaperStoreDb,
  owner: Owner,
  raw: PaperEvent,
): Promise<{ status: "appended" | "duplicate"; state: TradingPaperLedgerState }> {
  const event = normalizedEvent(raw);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, events, state } = await recover(tx, owner, event.ledgerId);
        const existing = events.find((entry) => entry.eventId === event.eventId);
        if (existing) {
          if (payload(existing) !== payload(event)) {
            throw new PaperLedgerConflictError("Duplicate paper ID has a conflicting payload");
          }
          return { status: "duplicate" as const, state };
        }
        if (event.sequence !== row.version + 1) {
          throw new PaperLedgerConflictError("Paper event sequence gap or concurrent stale writer");
        }
        if (events.length >= MAX_REPLAY_EVENTS) {
          throw new PaperLedgerConflictError("Paper journal exceeds bounded full replay");
        }
        const next = replayTradingPaperLedger({ ...header(row), events: [...events, event] });
        const digest = sha256(payload(event));
        const chain = chained(row.headSha256, digest);
        const changed = await tx.tradingPaperLedger.updateMany({
          where: {
            id: row.id,
            spaceId: owner.spaceId,
            ownerUserId: owner.userId,
            version: row.version,
            headSha256: row.headSha256,
          },
          data: {
            version: { increment: 1 },
            projection: asJson(next),
            projectionSha256: sha256(stateJson(next)),
            headSha256: chain,
          },
        });
        if (changed.count !== 1) throw new PaperLedgerConflictError("Paper version CAS failed");
        await tx.tradingPaperLedgerEvent.create({
          data: {
            ledgerId: row.id,
            sequence: event.sequence,
            eventId: event.eventId,
            kind: event.kind,
            recordedAt: new Date(event.recordedAt),
            payload: asJson(event),
            payloadSha256: digest,
            previousSha256: row.headSha256,
            chainSha256: chain,
          },
        });
        await tx.tradingPaperLedgerOutbox.create({
          data: { ledgerId: row.id, sequence: event.sequence, status: "pending" },
        });
        return { status: "appended" as const, state: next };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
