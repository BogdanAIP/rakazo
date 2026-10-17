import { createHash } from "node:crypto";
import type { TradingPaperLedgerEvent, TradingPaperLedgerState } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { recoverTradingPaperLedgerInTransaction } from "./trading-paper-store.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Owner = { spaceId: string; userId: string };
type PaperDb = Pick<PrismaClient, "$transaction">;
const decimal = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
const SCALE = 100_000_000n;
function units(value: string): bigint {
  if (!decimal.test(value)) throw new PaperStopGuardIntegrityError("Invalid exact stop decimal");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
const digest = (value: {
  ledgerId: string;
  positionId: string;
  signalId: string;
  symbol: string;
  quantityBase: string;
  stopPriceQuote: string;
  openedSequence: number;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        value.ledgerId,
        value.positionId,
        value.signalId,
        value.symbol,
        value.quantityBase,
        value.stopPriceQuote,
        value.openedSequence,
      ]),
      "utf8",
    )
    .digest("hex");

export class PaperStopGuardIntegrityError extends Error {
  constructor(message = "Paper stop guard unavailable or invalid") {
    super(message);
    this.name = "PaperStopGuardIntegrityError";
  }
}

/** Internal-only bridge for current synthetic tests/future trusted Worker.
 * It can only attach a stop to an ALREADY verified open P9 position and its
 * exact fill_buy sequence. It is intentionally NOT exported by @rakazo/db root,
 * not an RPC/MCP tool and does not create/reserve/fill any virtual order. */
export async function recordTradingPaperStopGuardForOpenPositionInTransaction(
  tx: Prisma.TransactionClient,
  owner: Owner,
  ledgerId: string,
  positionId: string,
  stopPriceQuote: string,
): Promise<void> {
  if (!decimal.test(stopPriceQuote) || !/[1-9]/.test(stopPriceQuote)) {
    throw new PaperStopGuardIntegrityError("Invalid exact stop price");
  }
  const { events, state } = await recoverTradingPaperLedgerInTransaction(tx, owner, ledgerId);
  const position = state.positions.find((entry) => entry.positionId === positionId);
  const fill = events.find(
    (entry): entry is Extract<TradingPaperLedgerEvent, { kind: "fill_buy" }> =>
      entry.kind === "fill_buy" && entry.reservationId === positionId,
  );
  if (!position || !fill) throw new PaperStopGuardIntegrityError();
  if (units(stopPriceQuote) >= units(fill.executedPriceQuote)) {
    throw new PaperStopGuardIntegrityError("Long paper stop must be below entry fill");
  }
  const row = {
    ledgerId,
    positionId,
    signalId: position.signalId,
    symbol: position.symbol,
    quantityBase: position.quantityBase,
    stopPriceQuote,
    openedSequence: fill.sequence,
  };
  await tx.tradingPaperStopGuard.create({
    data: { ...row, guardSha256: digest(row) },
  });
}

export async function recordTradingPaperStopGuardForOpenPosition(
  prisma: PaperDb,
  owner: Owner,
  ledgerId: string,
  positionId: string,
  stopPriceQuote: string,
): Promise<void> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      (tx) =>
        recordTradingPaperStopGuardForOpenPositionInTransaction(
          tx,
          owner,
          ledgerId,
          positionId,
          stopPriceQuote,
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export type VerifiedPaperStopGuard = {
  positionId: string;
  signalId: string;
  symbol: string;
  quantityBase: string;
  stopPriceQuote: string;
  openedSequence: number;
};

/** Same-transaction verifier. Missing guard => null (fail closed); a present
 * but corrupted/mismatched guard throws. Historical guards for already closed
 * positions are ignored because only CURRENT verified positions authorize risk math. */
export async function verifyTradingPaperStopGuardsInTransaction(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  events: readonly TradingPaperLedgerEvent[],
  state: TradingPaperLedgerState,
): Promise<VerifiedPaperStopGuard[] | null> {
  if (state.positions.length === 0) return [];
  const ids = state.positions.map((position) => position.positionId);
  const rows = await tx.tradingPaperStopGuard.findMany({
    where: { ledgerId, positionId: { in: ids } },
  });
  if (rows.length !== state.positions.length) return null;
  const byId = new Map(rows.map((row) => [row.positionId, row] as const));
  const result: VerifiedPaperStopGuard[] = [];
  for (const position of state.positions) {
    const row = byId.get(position.positionId);
    const fill = events.find(
      (entry): entry is Extract<TradingPaperLedgerEvent, { kind: "fill_buy" }> =>
        entry.kind === "fill_buy" && entry.reservationId === position.positionId,
    );
    if (!row || !fill) throw new PaperStopGuardIntegrityError();
    const normalized = {
      ledgerId,
      positionId: position.positionId,
      signalId: position.signalId,
      symbol: position.symbol,
      quantityBase: position.quantityBase,
      stopPriceQuote: row.stopPriceQuote,
      openedSequence: fill.sequence,
    };
    if (
      row.signalId !== normalized.signalId ||
      row.symbol !== normalized.symbol ||
      row.quantityBase !== normalized.quantityBase ||
      row.openedSequence !== normalized.openedSequence ||
      !decimal.test(row.stopPriceQuote) ||
      !/[1-9]/.test(row.stopPriceQuote) ||
      row.guardSha256 !== digest(normalized) ||
      units(row.stopPriceQuote) >= units(fill.executedPriceQuote)
    ) {
      throw new PaperStopGuardIntegrityError();
    }
    result.push({
      positionId: normalized.positionId,
      signalId: normalized.signalId,
      symbol: normalized.symbol,
      quantityBase: normalized.quantityBase,
      stopPriceQuote: normalized.stopPriceQuote,
      openedSequence: normalized.openedSequence,
    });
  }
  return result;
}
