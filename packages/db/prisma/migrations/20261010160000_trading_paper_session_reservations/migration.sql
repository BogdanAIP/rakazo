CREATE TABLE "trading_paper_session_reservations" (
 "ledgerId" TEXT NOT NULL, "reservationId" TEXT NOT NULL, "sessionRevision" INTEGER NOT NULL CHECK ("sessionRevision" > 0), "sessionStartedAt" TIMESTAMP(3) NOT NULL, "approvalEffectId" TEXT NOT NULL, "attributionSha256" TEXT NOT NULL,
 CONSTRAINT "tp_session_reservations_pkey" PRIMARY KEY ("ledgerId","reservationId"),
 CONSTRAINT "tp_session_reservations_decision_fkey" FOREIGN KEY ("ledgerId","reservationId") REFERENCES "trading_paper_reservation_decisions" ("ledgerId","reservationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tp_session_reservations_scope_idx" ON "trading_paper_session_reservations" ("ledgerId","sessionStartedAt");
