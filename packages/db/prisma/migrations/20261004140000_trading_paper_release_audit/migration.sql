-- B8 synthetic reservation release audit/reconciliation only.
CREATE TABLE "trading_paper_release_audits" (
    "ledgerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "eventSequence" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "releasedQuote" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3) NOT NULL,
    "releaseSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_release_audits_pkey" PRIMARY KEY ("ledgerId", "reservationId"),
    CONSTRAINT "trading_paper_release_audits_reason_check" CHECK ("reason" IN ('expired', 'kill_switch'))
);
CREATE UNIQUE INDEX "trading_paper_release_audits_ledgerId_eventId_key"
    ON "trading_paper_release_audits"("ledgerId", "eventId");
CREATE INDEX "trading_paper_release_audits_ledgerId_createdAt_idx"
    ON "trading_paper_release_audits"("ledgerId", "createdAt");
ALTER TABLE "trading_paper_release_audits"
    ADD CONSTRAINT "trading_paper_release_audits_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
