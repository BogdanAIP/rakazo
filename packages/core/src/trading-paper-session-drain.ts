import { type TradingPaperLedgerState, TradingPaperLedgerStateSchema } from "@rakazo/contracts";

/**
 * H0: a fail-closed, READ-ONLY assessment for ending a manually started
 * synthetic PAPER trading session. Does NOT stop the worker, change session
 * permissions, cancel reservations or create/release/close ledger events.
 *
 * A caller must first durably revoke the new-entry session lease (transactional
 * fencing), then supply a strictly verified existing PAPER ledger + lifecycle
 * and independently verified protective monitoring / queue status.
 */
export type PaperSessionDrainInput = {
  /** Must represent an acknowledged durable entry-session revocation. */
  entryFenceCommitted: boolean;
  /** Verification of the existing hash-chain and full PAPER lifecycle audit. */
  ledgerAuditVerified: boolean;
  ledger: TradingPaperLedgerState | null;
  /** All four counts come from trusted server-side transaction/queue records. */
  inFlightEntryOperations: number;
  unreconciledOutboxRecords: number;
  unfencedQueuedEntryWakes: number;
  unknownOrderStates: number;
  /** IDs from separately VERIFIED protective-stop candidates, not user claims. */
  verifiedProtectedPositionIds: readonly string[];
  /** Explicit separately authorized and current protection-only supervision. */
  protectionOnlyApproved: boolean;
};

export type PaperSessionDrainAssessment = {
  status: "settling" | "protection_only" | "finished" | "attention_required";
  /** An assessment never grants any exposure-increasing authority. */
  allowNewEntries: false;
  canDeclareFullyFlatAndStopped: boolean;
  counts: {
    reservations: number | null;
    openPositions: number | null;
    protectedPositions: number | null;
    inFlightEntryOperations: number;
    unreconciledOutboxRecords: number;
    unfencedQueuedEntryWakes: number;
    unknownOrderStates: number;
  };
  reasons: string[];
};

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid PAPER session ${label} count`);
  }
}

/**
 * Session deadline fences NEW entries, not an already committed synthetic
 * fill. A drained entry session with protected open positions must remain
 * visible as protection_only, NEVER as globally stopped/flat.
 *
 * Outbox *delivery* is not a prerequisite: today's PAPER outbox is inert.
 * Only independently identified UNRECONCILED outbox records block drain.
 */
export function assessTradingPaperSessionDrain(
  input: PaperSessionDrainInput,
): PaperSessionDrainAssessment {
  for (const [label, value] of [
    ["inFlightEntryOperations", input.inFlightEntryOperations],
    ["unreconciledOutboxRecords", input.unreconciledOutboxRecords],
    ["unfencedQueuedEntryWakes", input.unfencedQueuedEntryWakes],
    ["unknownOrderStates", input.unknownOrderStates],
  ] as const) {
    requireCount(value, label);
  }

  const ledger =
    input.ledgerAuditVerified && input.ledger !== null
      ? TradingPaperLedgerStateSchema.parse(input.ledger)
      : null;
  const counts: PaperSessionDrainAssessment["counts"] = {
    reservations: ledger?.reservations.length ?? null,
    openPositions: ledger?.positions.length ?? null,
    protectedPositions: ledger ? 0 : null,
    inFlightEntryOperations: input.inFlightEntryOperations,
    unreconciledOutboxRecords: input.unreconciledOutboxRecords,
    unfencedQueuedEntryWakes: input.unfencedQueuedEntryWakes,
    unknownOrderStates: input.unknownOrderStates,
  };

  const blocked = (reasons: string[]): PaperSessionDrainAssessment => ({
    status: "attention_required",
    allowNewEntries: false,
    canDeclareFullyFlatAndStopped: false,
    counts,
    reasons,
  });
  if (!input.entryFenceCommitted) return blocked(["entry_fence_not_committed"]);
  if (!ledger) return blocked(["ledger_or_lifecycle_unverified"]);
  if (input.unknownOrderStates > 0) return blocked(["unknown_order_state"]);
  if (input.unfencedQueuedEntryWakes > 0) return blocked(["unfenced_queued_entry_wake"]);

  const openIds = new Set(ledger.positions.map((position) => position.positionId));
  const verifiedIds = new Set(input.verifiedProtectedPositionIds);
  if (verifiedIds.size !== input.verifiedProtectedPositionIds.length) {
    return blocked(["duplicate_protective_candidate"]);
  }
  if ([...verifiedIds].some((id) => !openIds.has(id))) {
    return blocked(["protective_candidate_not_open"]);
  }
  counts.protectedPositions = verifiedIds.size;

  // Risk oversight for verified open positions must be kept separately from
  // the entry worker. Never claim the session has safely drained otherwise.
  if (openIds.size > 0 && (!input.protectionOnlyApproved || verifiedIds.size !== openIds.size)) {
    return blocked(["open_position_without_verified_protection"]);
  }

  const pending: string[] = [];
  if (input.inFlightEntryOperations > 0) pending.push("in_flight_entry");
  if (input.unreconciledOutboxRecords > 0) pending.push("unreconciled_outbox");
  if (ledger.reservations.length > 0) pending.push("reservations_require_audited_release");
  if (pending.length) {
    return {
      status: "settling",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
      counts,
      reasons: pending,
    };
  }

  if (openIds.size > 0) {
    return {
      status: "protection_only",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
      counts,
      reasons: ["open_positions_under_separate_protection"],
    };
  }

  return {
    status: "finished",
    allowNewEntries: false,
    canDeclareFullyFlatAndStopped: true,
    counts,
    reasons: [],
  };
}
