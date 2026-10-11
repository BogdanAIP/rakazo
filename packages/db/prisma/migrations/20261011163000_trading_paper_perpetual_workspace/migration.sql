CREATE TABLE "trading_paper_perpetual_workspaces" (
  "ledgerId" TEXT PRIMARY KEY REFERENCES "trading_paper_perpetual_ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "control" JSONB NOT NULL,
  "controlSha256" TEXT NOT NULL CHECK ("controlSha256" ~ '^[0-9a-f]{64}$'),
  "nextScheduledFor" TIMESTAMP(3),
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "trading_paper_perpetual_commands" (
  "ledgerId" TEXT NOT NULL REFERENCES "trading_paper_perpetual_workspaces"("ledgerId") ON DELETE CASCADE ON UPDATE CASCADE,
  "commandId" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "requestSha256" TEXT NOT NULL CHECK ("requestSha256" ~ '^[0-9a-f]{64}$'),
  "revision" INTEGER NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ledgerId", "commandId")
);
CREATE TABLE "trading_paper_perpetual_ticks" (
  "ledgerId" TEXT NOT NULL REFERENCES "trading_paper_perpetual_workspaces"("ledgerId") ON DELETE CASCADE ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "stage" TEXT NOT NULL CHECK ("stage" IN ('protection', 'research')),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot" JSONB NOT NULL,
  "snapshotSha256" TEXT NOT NULL CHECK ("snapshotSha256" ~ '^[0-9a-f]{64}$'),
  "decision" JSONB NOT NULL,
  "decisionSha256" TEXT NOT NULL CHECK ("decisionSha256" ~ '^[0-9a-f]{64}$'),
  "modelProvider" TEXT,
  "modelId" TEXT,
  "outcome" TEXT,
  "committedAt" TIMESTAMP(3),
  PRIMARY KEY ("ledgerId", "revision", "scheduledFor", "stage")
);
