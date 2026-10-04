-- P12-1A: native Rakazo Bot identity for NEW synthetic paper ledgers only.
-- Existing P10/P11 journals remain unbound (NULL): never infer historical ownership.
-- No runtime scheduling, exchange orders, accounts or live capability.
ALTER TABLE "trading_paper_ledgers" ADD COLUMN "botId" TEXT;

CREATE UNIQUE INDEX "trading_paper_ledgers_botId_key"
  ON "trading_paper_ledgers"("botId");

ALTER TABLE "trading_paper_ledgers"
  ADD CONSTRAINT "trading_paper_ledgers_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A ledger's Bot binding is creation-time immutable, including legacy NULL.
-- Archiving a Bot is allowed; deletion of a bound Bot is denied by FK.
CREATE FUNCTION trading_paper_reject_bot_rebinding()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."botId" IS DISTINCT FROM OLD."botId" THEN
    RAISE EXCEPTION 'Trading paper Bot binding is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'trading_paper_bot_binding_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trading_paper_bot_binding_immutable
  BEFORE UPDATE OF "botId" ON "trading_paper_ledgers"
  FOR EACH ROW EXECUTE FUNCTION trading_paper_reject_bot_rebinding();
