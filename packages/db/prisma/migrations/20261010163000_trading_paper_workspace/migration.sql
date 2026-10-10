CREATE TABLE "trading_paper_workspaces" (
"ledgerId" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "botId" TEXT NOT NULL, "threadId" TEXT NOT NULL, "stopEffectId" TEXT, "sessionRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("sessionRevision" >= 0), "firstProtectionScheduledFor" TIMESTAMP(3), "lastProtectionHandledFor" TIMESTAMP(3), "runtimeError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "tp_workspace_ledger_fkey" FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_ledgers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
