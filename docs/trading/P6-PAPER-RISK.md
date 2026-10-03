# P6 — Paper-only risk preview (no order execution)

Status: stacked draft after P5; all actions here are **pure, offline calculations**. No API / RPC route, trading connection, exchange or wallet keys, user account read, background schedule, broker authorization, database mutation, or actual paper order is added.

## Independent user-supplied risk envelope

`evaluateTradingPaperRisk()` accepts a typed research-only signal, an explicit `paper_only` policy, a synthetic/user-supplied virtual portfolio snapshot, and a timestamped public bid/ask observation.

- Requires **enabled=true and killSwitch=false**. Never turns either flag on automatically.
- Rejects NO_TRADE, expired/future-dated signals, stale quote or portfolio snapshot, inactive or unallowlisted venue, quote-currency mismatch, bad spread and runaway price deviation from entry trigger.
- Supports **SPOT BUY previews only** in this first slice. Futures, shorts and DEX are denied until instrument face-value, margin, liquidation, settlement and on-chain-specific risk are separately modeled.
- Calculates conservative (but illustrative) worst-case risk: assumed entry with adverse buy slippage, assumed stop exit with adverse sell slippage, **both** taker fees, an independent max per-idea risk, a daily-loss budget reduced by losses and outstanding stop risk, max aggregate open stop risk, position count, available cash and total quote exposure. Quantizes paper size downward to the market's published quantity increment, checks min notional.
- Signal's untrusted `riskBudgetQuote` can only **lower** the independent policy risk cap; a requested `maxSlippageBps` lower than the policy's conservative slippage assumption denies the preview rather than silently relaxing execution cost.
- Returns `status=deny` with a reason or `status=paper_preview, mode=paper_only`: an inert **preview**, not a broker order or authorization. No direct execution token/order ID or account identity is in the output. No position gets opened; this function does not mutate balances or reserve funds.

## What is not implemented

- No durable order/reservation/idempotency, fill journal, fees reconciliation, price streaming, stop order placement, restart recovery, live broker/sandbox simulation or partial fills. A later *supervised* Rakazo paper Worker must own these under an independent capability, with persisted state, deterministic order IDs, reservation and strict audit/reconciliation.
- Policy/portfolio values here are supplied by a caller and can be forged if the future system does not read them from a user-authorized trusted state store. The current result **cannot** be reused as a live-risk approval.
- Numbers in the preview use bounded JS numeric research arithmetic, not an exchange-compliant fixed-decimal order sizing library. Maximum eight quantity decimal places are supported; other instrument precisions fail closed rather than rounding up.
- An indicative stop is **not** a guaranteed exit fill. Real gap/liquidity/slippage can exceed this assumed loss, and paper results are not a profit forecast.
- Daily loss is realized-to-date plus already-reserved stop risk. Gains do not increase the daily-loss allowance in this policy.

## Acceptance

Offline tests cover inert preview, kill switch, NO_TRADE, stale signal/market/portfolio, spread/trigger drift, venue/currency mismatch, unsupported futures, cash and aggregate caps, max positions, min lot size, and inability of an AI proposal to increase an independent risk limit. Exact-head CI must pass the new package checks and tests; do not promote to a running paper service without a separate audit. Previous staged PRs #3–#6 are prerequisites, not automatically merged/deployed.
