-- P11E-1 explicit PAPER market-observation target permission only.
-- No public request, scheduling, model invocation or ledger mutation occurs here.
CREATE TABLE "trading_paper_worker_market_targets" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "venue" TEXT,
    "symbol" TEXT,
    "gateRevision" INTEGER NOT NULL,
    "targetRevision" INTEGER NOT NULL DEFAULT 0,
    "approvalEffectId" TEXT NOT NULL,
    "targetSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_worker_market_targets_pkey" PRIMARY KEY ("ledgerId")
);
CREATE INDEX "trading_paper_worker_market_targets_spaceId_userId_idx"
    ON "trading_paper_worker_market_targets"("spaceId", "userId");
ALTER TABLE "trading_paper_worker_market_targets"
    ADD CONSTRAINT "trading_paper_worker_market_targets_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
