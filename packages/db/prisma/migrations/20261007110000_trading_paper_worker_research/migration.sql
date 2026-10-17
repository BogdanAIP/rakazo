-- P11E-5 durable deterministic research output only.
-- No reservation, fill, broker order or model invocation is created here.
CREATE TABLE "trading_paper_worker_research" (
    "ledgerId" TEXT NOT NULL,
    "sourceScheduledFor" TIMESTAMP(3) NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "targetRevision" INTEGER NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quoteEvidenceId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "signalKind" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "outputSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_worker_research_pkey"
      PRIMARY KEY ("ledgerId", "sourceScheduledFor", "gateRevision", "targetRevision")
);
CREATE INDEX "trading_paper_worker_research_spaceId_userId_createdAt_idx"
  ON "trading_paper_worker_research"("spaceId", "userId", "createdAt");
CREATE INDEX "trading_paper_worker_research_ledgerId_signalId_idx"
  ON "trading_paper_worker_research"("ledgerId", "signalId");
ALTER TABLE "trading_paper_worker_research"
  ADD CONSTRAINT "trading_paper_worker_research_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
