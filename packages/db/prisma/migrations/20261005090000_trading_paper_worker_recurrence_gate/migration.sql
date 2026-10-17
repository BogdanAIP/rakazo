-- P11D-6 explicit recurrence permission only. No job is scheduled here.
CREATE TABLE "trading_paper_worker_recurrences" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "gateRevision" INTEGER NOT NULL,
    "recurrenceRevision" INTEGER NOT NULL DEFAULT 0,
    "approvalEffectId" TEXT NOT NULL,
    "recurrenceSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_worker_recurrences_pkey" PRIMARY KEY ("ledgerId")
);
CREATE INDEX "trading_paper_worker_recurrences_spaceId_userId_idx"
    ON "trading_paper_worker_recurrences"("spaceId", "userId");
ALTER TABLE "trading_paper_worker_recurrences"
    ADD CONSTRAINT "trading_paper_worker_recurrences_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
