-- P11D-0 default-deny worker permission/config only. No Graphile job is created here.
CREATE TABLE "trading_paper_worker_gates" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cadenceMinutes" INTEGER,
    "policyRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL DEFAULT 0,
    "approvalEffectId" TEXT NOT NULL,
    "gateSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_worker_gates_pkey" PRIMARY KEY ("ledgerId")
);
CREATE INDEX "trading_paper_worker_gates_spaceId_userId_idx"
    ON "trading_paper_worker_gates"("spaceId", "userId");
ALTER TABLE "trading_paper_worker_gates"
    ADD CONSTRAINT "trading_paper_worker_gates_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
