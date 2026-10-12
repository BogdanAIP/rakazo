# Nautilus PAPER execution

The API and worker accept a provider-neutral simulator port. Trusted composition
selects the local NautilusTrader 1.231.0 process using absolute
PAPER_NAUTILUS_PYTHON and PAPER_NAUTILUS_SCRIPT paths. Install requirements.txt
in a separate Python 3.12+ virtual environment. Without a configured engine,
production cannot start new futures sessions. No exchange credentials or real
execution client are accepted; SIM is the only execution venue.

Each virtual account owns one native process and starts with 1000 USDT. Owner
controls, selected Market Skill, finite sessions and independent risk checks
remain in Rakazo. Preset leverage ceilings are 5/10/20; fresh public OKX cross
position tiers restrict the selected contract and gross hedge quantity. Owner
ceiling changes cancel pending entries and preserve open positions. Native
leverage changes require a flat account; while positions remain open, new
entries must use the existing native leverage. A later flat session can register
new selected contracts without resetting its wallet.

Native execution consumes the available public bid/ask and depth without an extra
fixed slippage charge. New accounts use the public OKX Lv1 PAPER preset: maker
0.02% and taker 0.05% per filled notional, verified on 2026-10-12 against
https://www.okx.com/en-eu/help/how-to-calculate-the-contract-transaction-fee.
This is a simulation preset, not a verified personal account tariff. Nautilus
selects the fee from actual native liquidity execution: a marketable limit can
be taker. Existing instruments retain their persisted rates during recovery.
The Start review shows registered rates and uses the preset for new contracts.
The risk preview budgets both sides at the highest registered fee rate and
reserves another 10 bps per side for slippage conservatively; this reserve is
not charged to the native wallet.
Observation and public-tier freshness tolerate at most 2 seconds of positive
host/exchange clock skew and still reject data older than 30 seconds.

Native fills, commissions, realized PnL, funding adjustments, positions, resting
orders and wallet balances are the accounting authority. Ordered inputs and
results commit in the same owner-scoped database transaction as the workspace
tick. Failed transactions discard their process; replay compares every committed
native result. The legacy ledger cannot append money events to a native account.

StandardMarginModel uses initial rate 1/leverage and the public maintenance
rate. LeveragedMarginModel instead divides both instrument rates by leverage,
which is unsuitable for directly supplied OKX maintenance rates. Native
account-wide hedge/net maintenance and liquidation are simulator semantics and
do not reproduce all OKX cross or isolated-margin rules. Rakazo independently
reserves gross initial margin and applies stop/daily-loss/exposure limits to
both hedge legs. New entries cannot exceed the registered first maintenance tier
in gross BASE quantity, including opposite legs; crossing a tier with a fixed
instrument maintenance rate would understate simulator requirements. This
reserve is a risk calculation, not another wallet.

A limit cancelled and replaced by risk revalidation can execute as taker if
its replacement crosses the fresh book; an earlier resting order does not make
that replacement a maker fill.

Every wake cancels resting entries before fresh executable data, settles native
marks/funding/protective exits, then validates any new entry against updated
equity and remaining public depth. Cancellation-only barriers contain zero
liquidity. Final public funding history must cover a previously recorded
settlement boundary before an account with held positions can advance past it.
Funding valuation uses the latest previously observed simulation mark, not a
claimed historical exchange settlement price.

Run python -m unittest discover -s packages/adapters/nautilus. Native PostgreSQL
journeys additionally require VERIFY_DATABASE, an isolated DATABASE_URL and
PAPER_NAUTILUS_PYTHON. CI installs the pinned simulator for native conformance,
worker recovery and the browser futures Start/pause/close journey. Offline model
and market fixtures are selected only by the test composition.
