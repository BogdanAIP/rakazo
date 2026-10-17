CREATE TABLE "trading_paper_resolved_research_fill_gates" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" JSONB,
    "policyRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "researchRevision" INTEGER NOT NULL,
    "fillRevision" INTEGER NOT NULL DEFAULT 0,
    "approvalEffectId" TEXT NOT NULL,
    "gateSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_paper_resolved_research_fill_gates_pkey"
      PRIMARY KEY ("ledgerId")
);

CREATE INDEX "trading_paper_resolved_research_fill_gates_spaceId_userId_idx"
ON "trading_paper_resolved_research_fill_gates"("spaceId", "userId");

CREATE INDEX "trading_paper_resolved_research_fill_gates_approvalEffectId_idx"
ON "trading_paper_resolved_research_fill_gates"("approvalEffectId");

ALTER TABLE "trading_paper_resolved_research_fill_gates"
ADD CONSTRAINT "trading_paper_resolved_research_fill_gates_ledgerId_fkey"
FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
