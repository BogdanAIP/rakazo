CREATE TABLE "trading_paper_resolved_research_fill_uses" (
    "ledgerId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "fillApprovalEffectId" TEXT NOT NULL,
    "researchApprovalEffectId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "researchRevision" INTEGER NOT NULL,
    "fillRevision" INTEGER NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "reserveEventSequence" INTEGER NOT NULL,
    "fillEventSequence" INTEGER NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL,
    "useSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_paper_resolved_research_fill_uses_pkey"
      PRIMARY KEY ("ledgerId", "reservationId")
);

CREATE UNIQUE INDEX "trading_paper_resolved_research_fill_uses_ledgerId_fillEventSequence_key"
ON "trading_paper_resolved_research_fill_uses"("ledgerId", "fillEventSequence");

CREATE INDEX "trading_paper_resolved_research_fill_uses_fillApprovalEffectId_idx"
ON "trading_paper_resolved_research_fill_uses"("fillApprovalEffectId");

CREATE INDEX "trading_paper_resolved_research_fill_uses_researchApprovalEffectId_idx"
ON "trading_paper_resolved_research_fill_uses"("researchApprovalEffectId");

CREATE INDEX "trading_paper_resolved_research_fill_uses_evidenceId_idx"
ON "trading_paper_resolved_research_fill_uses"("evidenceId");

ALTER TABLE "trading_paper_resolved_research_fill_uses"
ADD CONSTRAINT "trading_paper_resolved_research_fill_uses_ledgerId_fkey"
FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
