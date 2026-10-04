-- P11C-2 stop-triggered synthetic close audit/idempotency only. No broker I/O.
CREATE TABLE "trading_paper_close_decisions" (
    "ledgerId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "decisionSha256" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "policyApprovalEffectId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "buyFillEventSequence" INTEGER NOT NULL,
    "closeEventSequence" INTEGER NOT NULL,
    "closeEventId" TEXT NOT NULL,
    "quantityBase" TEXT NOT NULL,
    "executedPriceQuote" TEXT NOT NULL,
    "feeQuote" TEXT NOT NULL,
    "stopPriceQuote" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_close_decisions_pkey" PRIMARY KEY ("ledgerId", "positionId")
);
CREATE UNIQUE INDEX "trading_paper_close_decisions_ledgerId_closeEventId_key"
    ON "trading_paper_close_decisions"("ledgerId", "closeEventId");
CREATE INDEX "trading_paper_close_decisions_ledgerId_createdAt_idx"
    ON "trading_paper_close_decisions"("ledgerId", "createdAt");
ALTER TABLE "trading_paper_close_decisions"
    ADD CONSTRAINT "trading_paper_close_decisions_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
