# Virtual trading workspace

Open **Виртуальные счета · PAPER** from the Rakazo sidebar, or visit
`/app/paper-journal` in the authenticated web/Electron application.

1. Create an account with a virtual USDT balance and risk limits.
2. Choose a public quote source, a spot instrument and a session duration
   (15–240 minutes).
3. Choose research: an installed read-only Market Resolver Skill with the
   configured model, or the existing deterministic 20-candle breakout.
4. Review the source and limits, then confirm **Подтвердить запуск PAPER**. The first check
   is scheduled five minutes after confirmation; subsequent checks are five
   minutes apart. A check can produce NO_TRADE.
5. Follow verified balances, open positions, fees and ledger operations.
6. Pause or end entries when needed. Pending orders belonging to that session
   are released. Open positions remain visible and require a separate,
   time-limited protection lease after entries stop.

A process restart pauses entries. A research/provider failure pauses the
affected session. Restarting requires another explicit Start; an old request
cannot renew a session. Changing the selected Skill or variant also requires
a new reviewed Start.

Only virtual funds and public, keyless market observations are used. There is
no exchange-order dispatcher. Fill prices, fees and stop closes are synthetic;
the displayed balance uses accounting cost rather than live position
valuation. The current execution scope is spot-buy USDT on OKX or BingX.

Web and Electron share this workspace. The responsive authenticated web route
is available on mobile browsers; the native Expo application has no automatic
PAPER start control.

For a new installation, apply the repository's database migrations and run
the normal API/worker/web services. Worker reconciliation recovers only
explicitly authorized protective work and never restarts entry sessions.
