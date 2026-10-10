-- H2b2: durable, owner- and lease-version-scoped plans for protection-only wakes.
-- No entry orders, credentials or worker-enable permissions in this table.
CREATE TABLE "trading_paper_protection_successor_intents" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leaseRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "sourceScheduledFor" TIMESTAMP(3) NOT NULL,
    "successorScheduledFor" TIMESTAMP(3) NOT NULL,
    "approvalEffectId" TEXT NOT NULL,
    "intentSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_protection_successor_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trading_paper_protection_successor_revisions_chk"
      CHECK ("leaseRevision" > 0 AND "gateRevision" >= 0),
    CONSTRAINT "trading_paper_protection_successor_forward_chk"
      CHECK ("successorScheduledFor" > "sourceScheduledFor")
);
CREATE UNIQUE INDEX "trading_paper_protection_successor_intents_ledgerId_leaseRevision_sourceScheduledFor_key"
    ON "trading_paper_protection_successor_intents" ("ledgerId","leaseRevision","sourceScheduledFor");
CREATE INDEX "trading_paper_protection_successor_intents_spaceId_userId_idx"
    ON "trading_paper_protection_successor_intents" ("spaceId","userId");
ALTER TABLE "trading_paper_protection_successor_intents"
    ADD CONSTRAINT "trading_paper_protection_successor_intents_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
