-- Separate virtual futures journal. No runtime activation, exchange access or owner session.
-- Apply only through isolated CI / reviewed migration, never in a running user DB implicitly.
CREATE TABLE "trading_paper_perpetual_ledgers" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "strategy" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL DEFAULT 'USDT',
  "openedAt" TIMESTAMP(3) NOT NULL,
  "initialBalanceQuote" TEXT NOT NULL DEFAULT '1000',
  "version" INTEGER NOT NULL DEFAULT 0,
  "projection" JSONB NOT NULL,
  "projectionSha256" TEXT NOT NULL,
  "headSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "trading_paper_perpetual_ledgers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "paper_perp_version_nonnegative" CHECK ("version" >= 0),
  CONSTRAINT "paper_perp_strategy" CHECK ("strategy" IN ('conservative', 'moderate', 'aggressive')),
  CONSTRAINT "paper_perp_initial_balance" CHECK ("quoteCurrency" = 'USDT' AND "initialBalanceQuote" = '1000'),
  CONSTRAINT "paper_perp_hashes" CHECK (
    "projectionSha256" ~ '^[0-9a-f]{64}$' AND "headSha256" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "trading_paper_perpetual_events" (
  "ledgerId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "previousSha256" TEXT NOT NULL,
  "chainSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trading_paper_perpetual_events_pkey" PRIMARY KEY ("ledgerId", "sequence"),
  CONSTRAINT "paper_perp_event_sequence" CHECK ("sequence" > 0),
  CONSTRAINT "paper_perp_event_kind" CHECK ("kind" IN ('open', 'mark', 'funding', 'close', 'liquidate')),
  CONSTRAINT "paper_perp_event_hashes" CHECK (
    "payloadSha256" ~ '^[0-9a-f]{64}$' AND
    "previousSha256" ~ '^[0-9a-f]{64}$' AND
    "chainSha256" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "trading_paper_perpetual_ledgers_owner_strategy_idx"
  ON "trading_paper_perpetual_ledgers"("spaceId", "ownerUserId", "strategy");
CREATE UNIQUE INDEX "trading_paper_perpetual_events_idempotency_key"
  ON "trading_paper_perpetual_events"("ledgerId", "eventId");

ALTER TABLE "trading_paper_perpetual_ledgers"
  ADD CONSTRAINT "trading_paper_perpetual_ledgers_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trading_paper_perpetual_ledgers"
  ADD CONSTRAINT "trading_paper_perpetual_ledgers_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trading_paper_perpetual_events"
  ADD CONSTRAINT "trading_paper_perpetual_events_ledgerId_fkey"
  FOREIGN KEY ("ledgerId") REFERENCES "trading_paper_perpetual_ledgers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
