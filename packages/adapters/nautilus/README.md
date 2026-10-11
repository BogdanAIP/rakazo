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
both hedge legs. This reserve is a risk calculation, not another wallet.

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
