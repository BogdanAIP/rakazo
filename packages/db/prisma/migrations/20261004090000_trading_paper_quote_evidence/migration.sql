-- Inert PAPER quote evidence: offline fixtures or labeled public adapter observations only.
-- This migration is a repository artifact; do not apply to the user's running database.
CREATE TABLE "trading_paper_quote_evidence" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "market" JSONB,
    "payloadSha256" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_quote_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trading_paper_quote_evidence_source_check" CHECK (("source" = 'offline_fixture' AND "market" IS NULL)
        OR ("source" = 'public_adapter_observation' AND "market" IS NOT NULL))
);
CREATE INDEX "trading_paper_quote_evidence_ledgerId_receivedAt_idx"
    ON "trading_paper_quote_evidence"("ledgerId", "receivedAt");
ALTER TABLE "trading_paper_quote_evidence"
    ADD CONSTRAINT "trading_paper_quote_evidence_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
