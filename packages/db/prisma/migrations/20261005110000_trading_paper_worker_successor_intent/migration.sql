-- P11D-11 durable successor intent only. No queue or execution side effect.
CREATE TABLE "trading_paper_worker_successor_intents" (
    "ledgerId" TEXT NOT NULL,
    "sourceScheduledFor" TIMESTAMP(3) NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "recurrenceRevision" INTEGER NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recurrenceApprovalEffectId" TEXT NOT NULL,
    "workerApprovalEffectId" TEXT NOT NULL,
    "paperApprovalEffectId" TEXT NOT NULL,
    "successorScheduledFor" TIMESTAMP(3) NOT NULL,
    "intentSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_worker_successor_intents_pkey"
      PRIMARY KEY ("ledgerId", "sourceScheduledFor", "gateRevision", "recurrenceRevision")
);
CREATE INDEX "trading_paper_worker_successor_intents_spaceId_userId_createdAt_idx"
  ON "trading_paper_worker_successor_intents"("spaceId", "userId", "createdAt");
ALTER TABLE "trading_paper_worker_successor_intents"
  ADD CONSTRAINT "trading_paper_worker_successor_intents_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
