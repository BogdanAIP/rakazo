CREATE TABLE "trading_paper_resolved_research_reserve_uses" (
    "ledgerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "researchApprovalEffectId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "researchRevision" INTEGER NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "reserveEventSequence" INTEGER NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL,
    "useSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_paper_resolved_research_reserve_uses_pkey"
      PRIMARY KEY ("ledgerId", "reservationId")
);

CREATE UNIQUE INDEX "trading_paper_resolved_research_reserve_uses_ledgerId_signalId_key"
ON "trading_paper_resolved_research_reserve_uses"("ledgerId", "signalId");

CREATE INDEX "trading_paper_resolved_research_reserve_uses_researchApprovalEffectId_idx"
ON "trading_paper_resolved_research_reserve_uses"("researchApprovalEffectId");

CREATE INDEX "trading_paper_resolved_research_reserve_uses_ledgerId_reserveEventSequence_idx"
ON "trading_paper_resolved_research_reserve_uses"("ledgerId", "reserveEventSequence");

ALTER TABLE "trading_paper_resolved_research_reserve_uses"
ADD CONSTRAINT "trading_paper_resolved_research_reserve_uses_ledgerId_fkey"
FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
