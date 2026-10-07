-- P11F-2 explicit worker automatic PAPER fill permission only.
-- This gate cannot fill a reservation, fetch market data, or place any exchange order.
CREATE TABLE "trading_paper_worker_fill_gates" (
    "ledgerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "strategyId" TEXT,
    "policyRevision" INTEGER NOT NULL,
    "gateRevision" INTEGER NOT NULL,
    "signalRevision" INTEGER NOT NULL,
    "fillRevision" INTEGER NOT NULL DEFAULT 0,
    "approvalEffectId" TEXT NOT NULL,
    "gateSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_worker_fill_gates_pkey" PRIMARY KEY ("ledgerId")
);
CREATE INDEX "trading_paper_worker_fill_gates_spaceId_userId_idx"
  ON "trading_paper_worker_fill_gates"("spaceId", "userId");
ALTER TABLE "trading_paper_worker_fill_gates"
  ADD CONSTRAINT "trading_paper_worker_fill_gates_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
