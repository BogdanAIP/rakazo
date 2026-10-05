-- P11C-11 short-lived explicit authority only. No synthetic close or broker I/O.
CREATE TABLE "trading_paper_protective_exit_authorities" (
    "effectId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "buyFillEventSequence" INTEGER NOT NULL,
    "stopPriceQuote" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authoritySha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_protective_exit_authorities_pkey" PRIMARY KEY ("effectId")
);
CREATE INDEX "trading_paper_protective_exit_authorities_ledgerId_positionId_expiresAt_idx"
    ON "trading_paper_protective_exit_authorities"("ledgerId", "positionId", "expiresAt");
ALTER TABLE "trading_paper_protective_exit_authorities"
    ADD CONSTRAINT "trading_paper_protective_exit_authorities_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
