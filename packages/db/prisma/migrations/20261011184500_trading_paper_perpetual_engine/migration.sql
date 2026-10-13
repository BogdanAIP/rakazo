CREATE TABLE "trading_paper_perpetual_engines" (
 "ledgerId" TEXT NOT NULL PRIMARY KEY, "config" JSONB NOT NULL, "configSha256" TEXT NOT NULL,
 "sequence" INTEGER NOT NULL DEFAULT 0, "headSha256" TEXT NOT NULL,
 "projection" JSONB, "projectionSha256" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "trading_paper_perpetual_engines_ledgerId_fkey" FOREIGN KEY ("ledgerId")
 REFERENCES "trading_paper_perpetual_ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "trading_paper_perpetual_engine_batches" (
 "ledgerId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "batchId" TEXT NOT NULL,
 "input" JSONB NOT NULL, "output" JSONB NOT NULL, "inputSha256" TEXT NOT NULL,
 "outputSha256" TEXT NOT NULL, "previousSha256" TEXT NOT NULL, "chainSha256" TEXT NOT NULL,
 "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("ledgerId","sequence"),
 CONSTRAINT "trading_paper_perpetual_engine_batches_ledgerId_fkey" FOREIGN KEY ("ledgerId")
 REFERENCES "trading_paper_perpetual_engines"("ledgerId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "trading_paper_perpetual_engine_batches_ledgerId_batchId_key"
 ON "trading_paper_perpetual_engine_batches"("ledgerId","batchId");
