-- P11B-5: persisted synthetic stop guards. Repository artifact only; do not apply to live DB here.
CREATE TABLE "trading_paper_stop_guards" (
    "ledgerId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantityBase" TEXT NOT NULL,
    "stopPriceQuote" TEXT NOT NULL,
    "openedSequence" INTEGER NOT NULL,
    "guardSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_stop_guards_pkey" PRIMARY KEY ("ledgerId", "positionId"),
    CONSTRAINT "trading_paper_stop_guards_openedSequence_check" CHECK ("openedSequence" > 0)
);
ALTER TABLE "trading_paper_stop_guards"
    ADD CONSTRAINT "trading_paper_stop_guards_ledgerId_fkey"
    FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
