-- Paper-only policy storage; default-denied by service. No active worker or orders.
-- Apply only in an isolated CI DB or after explicit reviewed local migration.
CREATE TABLE "trading_paper_risk_policies" (
    "ledgerId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "policy" JSONB NOT NULL,
    "policySha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_risk_policies_pkey" PRIMARY KEY ("ledgerId"),
    CONSTRAINT "trading_paper_risk_policies_revision_nonnegative" CHECK ("revision" >= 0)
);
ALTER TABLE "trading_paper_risk_policies"
    ADD CONSTRAINT "trading_paper_risk_policies_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
