# Virtual trading workspace

Open **Виртуальные счета · PAPER** from the Rakazo sidebar, or visit
`/app/paper-journal` in the authenticated web/Electron application.

Use **Модели** in the journal to open the shared connection settings, including
before completing general onboarding. A connected Codex subscription shows the
models available to that account from its live catalog. Choose a model and apply
it with **Use this model** (the label follows the interface language). Each scheduled
Market research check uses the current default model, including during an active
session. The deterministic breakout does not use a model.

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
valuation. The spot execution scope is spot-buy USDT on OKX or BingX.

Web and Electron share this workspace. The responsive authenticated web route
is available on mobile browsers; the native Expo application has no automatic
PAPER start control.

For a new installation, apply the repository's database migrations and run
the normal API/worker/web services. Worker reconciliation recovers only
explicitly authorized protective work and never restarts entry sessions.

## Perpetual PAPER policy: paper-risk-v3

The futures tab uses a separate append-only native simulator journal, three
independent virtual accounts and finite entry/protection authority. It never
dispatches real exchange orders. Existing positions retain their booked stops,
targets and recovery reserves across a policy upgrade.

| Profile | Per idea | All open ideas | Daily realized loss |
| --- | --- | --- | --- |
| Conservative | 0.5% | 1% | 1.5% |
| Moderate | 1% | 2% | 3% |
| Aggressive | 2% | 4% | 5% |

Budgets use verified current marked equity, with exact fixed-point rounding
down. High-watermark drawdowns of 2.5% / 5% / 8% halve new idea and open-risk
budgets; 5% / 10% / 15% block new exposure respectively. Protective exits remain
available within their explicit authority.

Size follows the structural stop, entry/exit fees and adverse slippage.
A mandatory 50% adverse move against every gross leg, including unspent add
reserves, must leave more than maintenance plus 25% of equity. Held markets use
their own verified maintenance rates with a 2% stress floor. Opposite hedge
legs never net away. A 100% adverse gross move and a long collapse / 200% short
rally remain diagnostics and may exhaust equity; they do not reject admission.
These simplified PAPER scenarios do not reproduce venue liquidation guarantees.

A single-entry idea can reserve zero future adds. A positive add reserve needs
two preplanned stages totaling 100%; it consumes gross, margin and whole-idea
stop-risk capacity before the first fill. A triggered stage still requires a
new decision and fresh structure/risk checks. No automatic averaging or widening
an existing stop is permitted.

A compared limit lasts until its signal validity, at most 30 minutes after
submission, bounded by the session deadline. Market and legacy proposals retain
a five-minute bound. Every wake cancels native resting entries before the next
quote and rechecks admission. A mark reaching the stop or target invalidates an
unfilled idea. Later fill/expiry outcomes update the same decision's result
while preserving its original time and provenance.

Discovery uses official underlying categories where available, excludes
non-crypto/unknown categories, and retains a curated fallback for legacy
providers that omit categorization. All eligible liquid crypto symbols remain
in the scanner and the model research input as ranked bulk quote/range data.
Detailed execution snapshots and executable proposals stay within the owner-approved
eight-instrument session; outside-session candidates require another reviewed choice.
Aggressive suggestions rank rolling relative 24-hour range before liquidity,
after spread/turnover filters. This is a candidate prefilter, not a signal.

Evaluate policy versions on the same captured inputs before comparing forward
results. Record the version, candidate coverage, rejection reasons, net fills,
fees, funding, drawdown and completed trades. Keep old records intact. There is
no validated profit expectation, universal reward/risk threshold, daily return
quota or automatic strategy scheduling in external ChatGPT mode.
