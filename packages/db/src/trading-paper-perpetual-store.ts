import { createHash } from "node:crypto";
import {
  replayPerpetualPaperLedger,
  type PerpetualPaperEvent,
  type PerpetualPaperLedgerInput,
  type PerpetualPaperLedgerState,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type Database = Pick<PrismaClient, "$transaction">;
const VERSION = "isolated_perpetual_paper_v1";
const MAX_EVENTS = 10_000;

export class PerpetualPaperIntegrityError extends Error {
  constructor(message = "Perpetual PAPER journal integrity or access denied") {
    super(message);
    this.name = "PerpetualPaperIntegrityError";
  }
}
export class PerpetualPaperConflictError extends Error {
  constructor(message = "Perpetual PAPER event version conflict") {
    super(message);
    this.name = "PerpetualPaperConflictError";
  }
}
const sha = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const asJson = (data: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}
const genesis = (input: PerpetualPaperLedgerInput, owner: Owner): string =>
  sha(JSON.stringify([VERSION, owner.spaceId, owner.userId, input.ledgerId, input.strategy, input.openedAt, input.initialBalanceQuote]));
const link = (previous: string, digest: string): string =>
  sha(JSON.stringify([previous, digest]));

function normalize(event: PerpetualPaperEvent): PerpetualPaperEvent {
  const base = {
    ledgerId: event.ledgerId,
    eventId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
  };
  switch (event.kind) {
    case "open":
      return {
        ...base,
        kind: "open",
        positionId: event.positionId,
        venue: event.venue,
        instrument: event.instrument,
        side: event.side,
        leverage: event.leverage,
        quantityBase: event.quantityBase,
        entryPriceQuote: event.entryPriceQuote,
        entryFeeQuote: event.entryFeeQuote,
        maintenanceMarginBps: event.maintenanceMarginBps,
      };
    case "mark":
      return { ...base, kind: "mark", positionId: event.positionId, markPriceQuote: event.markPriceQuote };
    case "funding":
      return {
        ...base,
        kind: "funding",
        positionId: event.positionId,
        paymentQuoteSigned: event.paymentQuoteSigned,
      };
    case "close":
    case "liquidate":
      return {
        ...base,
        kind: event.kind,
        positionId: event.positionId,
        exitPriceQuote: event.exitPriceQuote,
        exitFeeQuote: event.exitFeeQuote,
      };
    default:
      throw new PerpetualPaperIntegrityError("Unknown perpetual event kind");
  }
}
function serialized(event: PerpetualPaperEvent): string {
  return JSON.stringify(normalize(event));
}
async function member(tx: Prisma.TransactionClient, owner: Owner): Promise<void> {
  const row = await tx.spaceMember.findFirst({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    select: { id: true },
  });
  if (!row) throw new PerpetualPaperIntegrityError("Perpetual account membership denied");
}
const header = (row: {
  id: string;
  strategy: string;
  openedAt: Date;
  initialBalanceQuote: string;
}): PerpetualPaperLedgerInput => ({
  ledgerId: row.id,
  strategy: row.strategy as PerpetualPaperLedgerInput["strategy"],
  openedAt: row.openedAt.toISOString(),
  initialBalanceQuote: row.initialBalanceQuote as "1000",
  events: [],
});

async function recover(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
): Promise<{
  row: NonNullable<Awaited<ReturnType<typeof tx.tradingPaperPerpetualLedger.findFirst>>>;
  events: PerpetualPaperEvent[];
  state: PerpetualPaperLedgerState;
}> {
  await member(tx, owner);
  const row = await tx.tradingPaperPerpetualLedger.findFirst({
    where: { id: ledgerId, spaceId: owner.spaceId, ownerUserId: owner.userId },
  });
  if (!row) throw new PerpetualPaperIntegrityError("Owner-scoped perpetual ledger missing");
  if (row.quoteCurrency !== "USDT" || row.initialBalanceQuote !== "1000") {
    throw new PerpetualPaperIntegrityError("Perpetual journal currency or capital changed");
  }
  const rows = await tx.tradingPaperPerpetualEvent.findMany({
    where: { ledgerId: row.id },
    orderBy: { sequence: "asc" },
  });
  if (rows.length > MAX_EVENTS || rows.length !== row.version) {
    throw new PerpetualPaperIntegrityError("Perpetual event count differs from revision");
  }
  const base = header(row);
  let previous = genesis(base, owner);
  const events: PerpetualPaperEvent[] = [];
  for (const record of rows) {
    const event = normalize(record.payload as PerpetualPaperEvent);
    if (
      event.ledgerId !== row.id ||
      event.eventId !== record.eventId ||
      event.kind !== record.kind ||
      event.sequence !== events.length + 1 ||
      Date.parse(event.recordedAt) !== record.recordedAt.getTime()
    ) {
      throw new PerpetualPaperIntegrityError("Perpetual event metadata mismatch");
    }
    const digest = sha(serialized(event));
    const chain = link(previous, digest);
    if (
      record.payloadSha256 !== digest ||
      record.previousSha256 !== previous ||
      record.chainSha256 !== chain
    ) {
      throw new PerpetualPaperIntegrityError("Perpetual journal hash chain invalid");
    }
    events.push(event);
    previous = chain;
  }
  if (previous !== row.headSha256) {
    throw new PerpetualPaperIntegrityError("Perpetual journal head digest mismatch");
  }
  const state = replayPerpetualPaperLedger({ ...base, events });
  const projectionText = JSON.stringify(state);
  if (
    row.projectionSha256 !== sha(projectionText) ||
    JSON.stringify(canonical(row.projection)) !== JSON.stringify(canonical(state)) ||
    state.nextSequence !== row.version + 1
  ) {
    throw new PerpetualPaperIntegrityError("Perpetual projection diverged from replay");
  }
  return { row, events, state };
}

/** Internal only. Not callable by AI/Skill/RPC; no real-account side effects. */
export async function createDisabledPerpetualPaperAccount(
  prisma: Database,
  owner: Owner,
  raw: Omit<PerpetualPaperLedgerInput, "events" | "initialBalanceQuote">,
): Promise<PerpetualPaperLedgerState> {
  const base: PerpetualPaperLedgerInput = {
    ...raw,
    initialBalanceQuote: "1000",
    events: [],
  };
  const state = replayPerpetualPaperLedger(base);
  const head = genesis(base, owner);
  return prisma.$transaction(
    async (tx) => {
      await member(tx, owner);
      await tx.tradingPaperPerpetualLedger.create({
        data: {
          id: base.ledgerId,
          spaceId: owner.spaceId,
          ownerUserId: owner.userId,
          strategy: base.strategy,
          openedAt: new Date(base.openedAt),
          initialBalanceQuote: "1000",
          quoteCurrency: "USDT",
          projection: asJson(state),
          projectionSha256: sha(JSON.stringify(state)),
          headSha256: head,
        },
      });
      return state;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Always reconstruct and hash-check the complete owner-scoped event journal. */
export async function readVerifiedPerpetualPaperAccount(
  prisma: Database,
  owner: Owner,
  ledgerId: string,
): Promise<PerpetualPaperLedgerState> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => (await recover(tx, owner, ledgerId)).state,
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * Internal synthetic event writer, NOT an approval gate. Only invoke AFTER
 * independent owner/session, read-only market provenance, risk and policy checks.
 * No public endpoint, broker dispatcher or background schedule is added.
 */
export async function appendVerifiedPerpetualPaperEvent(
  prisma: Database,
  owner: Owner,
  raw: PerpetualPaperEvent,
): Promise<{ status: "appended" | "duplicate"; state: PerpetualPaperLedgerState }> {
  const event = normalize(raw);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { row, events, state } = await recover(tx, owner, event.ledgerId);
        const existing = events.find((item) => item.eventId === event.eventId);
        if (existing) {
          if (serialized(existing) !== serialized(event)) {
            throw new PerpetualPaperConflictError("Conflicting idempotent event ID");
          }
          return { status: "duplicate" as const, state };
        }
        if (event.sequence !== row.version + 1 || row.version >= MAX_EVENTS) {
          throw new PerpetualPaperConflictError("Perpetual event revision out of bounds");
        }
        const next = replayPerpetualPaperLedger({
          ...header(row),
          events: [...events, event],
        });
        const eventText = serialized(event);
        const digest = sha(eventText);
        const chain = link(row.headSha256, digest);
        const changed = await tx.tradingPaperPerpetualLedger.updateMany({
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
            projectionSha256: sha(JSON.stringify(next)),
            headSha256: chain,
          },
        });
        if (changed.count !== 1) {
          throw new PerpetualPaperConflictError("Perpetual ledger concurrently advanced");
        }
        await tx.tradingPaperPerpetualEvent.create({
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
        return { status: "appended" as const, state: next };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
