import type { TradingPaperLedgerState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  assessTradingPaperSessionDrain,
  type PaperSessionDrainInput,
} from "./trading-paper-session-drain.js";

const flatLedger: TradingPaperLedgerState = {
  version: "paper_spot_full_fill_v1",
  ledgerId: "paper-synthetic-1",
  quoteCurrency: "USDT",
  nextSequence: 1,
  acceptedEvents: 0,
  retryEvents: 0,
  initialBalanceQuote: "500",
  availableQuote: "500",
  reservedQuote: "0",
  openCostBasisQuote: "0",
  realizedPnlQuote: "0",
  totalFeesQuote: "0",
  bookEquityQuote: "500",
  reservations: [],
  positions: [],
};

const base: PaperSessionDrainInput = {
  entryFenceCommitted: true,
  ledgerAuditVerified: true,
  ledger: flatLedger,
  inFlightEntryOperations: 0,
  unreconciledOutboxRecords: 0,
  unfencedQueuedEntryWakes: 0,
  unknownOrderStates: 0,
  verifiedProtectedPositionIds: [],
  protectionOnlyApproved: false,
};

const position = {
  positionId: "resv-one",
  signalId: "signal-one",
  symbol: "BTC-USDT",
  quantityBase: "0.1",
  entryCostBasisQuote: "100",
};

describe("H0 on-demand PAPER session drain — read-only and default deny", () => {
  it("finishes only a fenced, verified, flat and completely reconciled journal", () => {
    const result = assessTradingPaperSessionDrain(base);
    expect(result).toMatchObject({
      status: "finished",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: true,
      counts: { reservations: 0, openPositions: 0, protectedPositions: 0 },
      reasons: [],
    });
  });

  it.each([
    ["worker revocation uncommitted", { entryFenceCommitted: false }, "entry_fence_not_committed"],
    ["unverified lifecycle", { ledgerAuditVerified: false }, "ledger_or_lifecycle_unverified"],
    ["missing ledger", { ledger: null }, "ledger_or_lifecycle_unverified"],
    ["unknown future venue order", { unknownOrderStates: 1 }, "unknown_order_state"],
    ["unfenced queued wake", { unfencedQueuedEntryWakes: 1 }, "unfenced_queued_entry_wake"],
  ] as const)("never reports success for %s", (_label, change, reason) => {
    const status = assessTradingPaperSessionDrain({ ...base, ...change });
    expect(status).toMatchObject({
      status: "attention_required",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
    });
    expect(status.reasons).toContain(reason);
  });

  it("keeps an unfilled reserve in settling, never auto-releases it or calls it an order", () => {
    const ledger: TradingPaperLedgerState = {
      ...flatLedger,
      reservations: [
        {
          reservationId: "resv-one",
          signalId: "signal-one",
          symbol: "BTC-USDT",
          quantityBase: "0.1",
          heldQuote: "100",
          expiresAt: "2026-10-08T23:00:00.000Z",
        },
      ],
    };
    expect(assessTradingPaperSessionDrain({ ...base, ledger })).toMatchObject({
      status: "settling",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
      reasons: ["reservations_require_audited_release"],
      counts: { reservations: 1 },
    });
    expect(ledger.reservations).toHaveLength(1);
  });

  it("waits for known in-flight and unreconciled outbox work even when flat", () => {
    const result = assessTradingPaperSessionDrain({
      ...base,
      inFlightEntryOperations: 1,
      unreconciledOutboxRecords: 2,
    });
    expect(result).toMatchObject({
      status: "settling",
      allowNewEntries: false,
      counts: { inFlightEntryOperations: 1, unreconciledOutboxRecords: 2 },
      reasons: ["in_flight_entry", "unreconciled_outbox"],
    });
  });

  it("reports protection-only, not finished, for separately supervised open positions", () => {
    const ledger = { ...flatLedger, positions: [position] };
    const result = assessTradingPaperSessionDrain({
      ...base,
      ledger,
      verifiedProtectedPositionIds: ["resv-one"],
      protectionOnlyApproved: true,
    });
    expect(result).toMatchObject({
      status: "protection_only",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
      counts: { openPositions: 1, protectedPositions: 1 },
    });
  });

  it("fails closed when an open position loses verified stop monitoring", () => {
    const result = assessTradingPaperSessionDrain({
      ...base,
      ledger: { ...flatLedger, positions: [position] },
      verifiedProtectedPositionIds: ["resv-one"],
    });
    expect(result).toMatchObject({
      status: "attention_required",
      allowNewEntries: false,
      canDeclareFullyFlatAndStopped: false,
      reasons: ["open_position_without_verified_protection"],
    });
  });

  it("rejects stale, duplicated and out-of-scope protective candidate identities", () => {
    const ledger = { ...flatLedger, positions: [position] };
    for (const ids of [["resv-one", "resv-one"], ["not-a-position"]]) {
      const result = assessTradingPaperSessionDrain({
        ...base,
        ledger,
        verifiedProtectedPositionIds: ids,
        protectionOnlyApproved: true,
      });
      expect(result.status).toBe("attention_required");
    }
  });

  it("rejects negative, fractional and unsafe queue/in-flight counts", () => {
    for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        assessTradingPaperSessionDrain({ ...base, inFlightEntryOperations: n }),
      ).toThrow("Invalid PAPER session inFlightEntryOperations count");
    }
  });

  it("never declares fake success when a snapshot is malformed", () => {
    expect(() =>
      assessTradingPaperSessionDrain({
        ...base,
        ledger: { ...flatLedger, reservedQuote: "-100" },
      }),
    ).toThrow();
  });
});
