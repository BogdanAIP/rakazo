-- Explicit PAPER-only policy control audit. Repository artifact only.
CREATE TABLE "trading_paper_policy_audits" (
    "effectId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromRevision" INTEGER NOT NULL,
    "toRevision" INTEGER NOT NULL,
    "beforeSha256" TEXT NOT NULL,
    "afterSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_policy_audits_pkey" PRIMARY KEY ("effectId"),
    CONSTRAINT "trading_paper_policy_audits_action_check" CHECK ("action" IN ('enable', 'disable')),
    CONSTRAINT "trading_paper_policy_audits_revision_check" CHECK ("toRevision" = "fromRevision" + 1)
);
CREATE INDEX "trading_paper_policy_audits_ledgerId_createdAt_idx"
    ON "trading_paper_policy_audits"("ledgerId", "createdAt");
ALTER TABLE "trading_paper_policy_audits"
    ADD CONSTRAINT "trading_paper_policy_audits_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
