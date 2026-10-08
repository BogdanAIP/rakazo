-- H1: owner-approved finite session permission only.
-- No background job, recurring task, order or trading enablement.
-- Absence of a row is always default-deny. Expiry evaluated using the DB clock.
CREATE TABLE "trading_paper_entry_sessions" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "workerGateRevision" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvalEffectId" TEXT NOT NULL,
    "sessionSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_entry_sessions_pkey" PRIMARY KEY ("ledgerId"),
    CONSTRAINT "trading_paper_entry_sessions_finite_chk" CHECK ("expiresAt" > "startedAt"),
    CONSTRAINT "trading_paper_entry_sessions_revision_chk" CHECK ("revision" > 0),
    CONSTRAINT "trading_paper_entry_sessions_worker_revision_chk" CHECK ("workerGateRevision" >= 0),
    CONSTRAINT "trading_paper_entry_sessions_status_chk" CHECK ("status" IN ('active', 'paused', 'ended'))
);
CREATE INDEX "trading_paper_entry_sessions_spaceId_userId_idx"
    ON "trading_paper_entry_sessions" ("spaceId", "userId");
ALTER TABLE "trading_paper_entry_sessions"
    ADD CONSTRAINT "trading_paper_entry_sessions_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
