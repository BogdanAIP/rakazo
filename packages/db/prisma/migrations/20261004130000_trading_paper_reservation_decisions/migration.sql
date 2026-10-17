-- B7 synthetic PAPER reservation idempotency/audit only.
-- No broker order queue, exchange account or live execution capability.
CREATE UNIQUE INDEX "trading_paper_policy_audits_ledgerId_toRevision_key"
    ON "trading_paper_policy_audits"("ledgerId", "toRevision");

CREATE TABLE "trading_paper_reservation_decisions" (
    "ledgerId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "decisionSha256" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "policyApprovalEffectId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "ledgerRevisionBefore" INTEGER NOT NULL,
    "eventSequence" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "quantityBase" TEXT NOT NULL,
    "heldQuote" TEXT NOT NULL,
    "worstCaseStopRiskQuote" TEXT NOT NULL,
    "stopPriceQuote" TEXT NOT NULL,
    "conservativeEntryQuote" TEXT NOT NULL,
    "conservativeStopQuote" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_reservation_decisions_pkey" PRIMARY KEY ("ledgerId", "signalId")
);
CREATE UNIQUE INDEX "trading_paper_reservation_decisions_ledgerId_eventId_key"
    ON "trading_paper_reservation_decisions"("ledgerId", "eventId");
CREATE UNIQUE INDEX "trading_paper_reservation_decisions_ledgerId_reservationId_key"
    ON "trading_paper_reservation_decisions"("ledgerId", "reservationId");
CREATE INDEX "trading_paper_reservation_decisions_ledgerId_createdAt_idx"
    ON "trading_paper_reservation_decisions"("ledgerId", "createdAt");
ALTER TABLE "trading_paper_reservation_decisions"
    ADD CONSTRAINT "trading_paper_reservation_decisions_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
