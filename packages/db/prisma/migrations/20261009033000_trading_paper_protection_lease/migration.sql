-- H2b: independent finite owner-approved PAPER protective-only lease.
-- This table grants zero entry/buy/reserve/real order authority.
CREATE TABLE "trading_paper_protection_leases" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL,
    "workerGateRevision" INTEGER NOT NULL,
    "entryRevision" INTEGER NOT NULL,
    "cadenceMinutes" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvalEffectId" TEXT NOT NULL,
    "leaseSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_protection_leases_pkey" PRIMARY KEY ("ledgerId"),
    CONSTRAINT "trading_paper_protection_leases_rev_chk" CHECK ("revision" > 0),
    CONSTRAINT "trading_paper_protection_leases_scope_chk" CHECK ("workerGateRevision" >= 0 AND "entryRevision" > 0),
    CONSTRAINT "trading_paper_protection_leases_cadence_chk" CHECK ("cadenceMinutes" >= 5 AND "cadenceMinutes" <= 60),
    CONSTRAINT "trading_paper_protection_leases_duration_chk" CHECK ("expiresAt" > "startedAt" AND "expiresAt" <= "startedAt" + INTERVAL '24 hours')
);
CREATE INDEX "trading_paper_protection_leases_spaceId_userId_idx"
    ON "trading_paper_protection_leases" ("spaceId", "userId");
ALTER TABLE "trading_paper_protection_leases"
    ADD CONSTRAINT "trading_paper_protection_leases_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
