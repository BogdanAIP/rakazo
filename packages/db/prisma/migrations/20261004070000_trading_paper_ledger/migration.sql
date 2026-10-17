-- Inert paper-only persistence. This migration must NOT be applied to an
-- existing local database without backup, review and explicit authorization.
CREATE TABLE "trading_paper_ledgers" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "initialBalanceQuote" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "projection" JSONB NOT NULL,
    "projectionSha256" TEXT NOT NULL,
    "headSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trading_paper_ledgers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trading_paper_ledgers_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "trading_paper_ledger_events" (
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
    CONSTRAINT "trading_paper_ledger_events_pkey" PRIMARY KEY ("ledgerId","sequence"),
    CONSTRAINT "trading_paper_ledger_events_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "trading_paper_ledger_events_kind" CHECK ("kind" IN ('reserve','release','fill_buy','fill_sell'))
);

CREATE TABLE "trading_paper_ledger_outbox" (
    "ledgerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trading_paper_ledger_outbox_pkey" PRIMARY KEY ("ledgerId","sequence"),
    CONSTRAINT "trading_paper_ledger_outbox_status" CHECK ("status" IN ('pending','delivered'))
);

CREATE INDEX "trading_paper_ledgers_spaceId_ownerUserId_idx"
    ON "trading_paper_ledgers"("spaceId","ownerUserId");
CREATE UNIQUE INDEX "trading_paper_ledger_events_ledgerId_eventId_key"
    ON "trading_paper_ledger_events"("ledgerId","eventId");

ALTER TABLE "trading_paper_ledgers"
    ADD CONSTRAINT "trading_paper_ledgers_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trading_paper_ledgers"
    ADD CONSTRAINT "trading_paper_ledgers_ownerUserId_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trading_paper_ledger_events"
    ADD CONSTRAINT "trading_paper_ledger_events_ledgerId_fkey" FOREIGN KEY ("ledgerId")
    REFERENCES "trading_paper_ledgers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trading_paper_ledger_outbox"
    ADD CONSTRAINT "trading_paper_ledger_outbox_ledgerId_sequence_fkey"
    FOREIGN KEY ("ledgerId","sequence")
    REFERENCES "trading_paper_ledger_events"("ledgerId","sequence")
    ON DELETE CASCADE ON UPDATE CASCADE;
