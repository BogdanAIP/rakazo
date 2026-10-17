-- P11C-1 synthetic full-fill audit/idempotency only. No broker order capability.
CREATE TABLE "trading_paper_fill_decisions" (
    "ledgerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "decisionSha256" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "policyApprovalEffectId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "reserveEventSequence" INTEGER NOT NULL,
    "fillEventSequence" INTEGER NOT NULL,
    "fillEventId" TEXT NOT NULL,
    "quantityBase" TEXT NOT NULL,
    "executedPriceQuote" TEXT NOT NULL,
    "feeQuote" TEXT NOT NULL,
    "stopPriceQuote" TEXT NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_fill_decisions_pkey" PRIMARY KEY ("ledgerId", "reservationId")
);
CREATE UNIQUE INDEX "trading_paper_fill_decisions_ledgerId_fillEventId_key"
    ON "trading_paper_fill_decisions"("ledgerId", "fillEventId");
CREATE INDEX "trading_paper_fill_decisions_ledgerId_createdAt_idx"
    ON "trading_paper_fill_decisions"("ledgerId", "createdAt");
ALTER TABLE "trading_paper_fill_decisions"
    ADD CONSTRAINT "trading_paper_fill_decisions_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
