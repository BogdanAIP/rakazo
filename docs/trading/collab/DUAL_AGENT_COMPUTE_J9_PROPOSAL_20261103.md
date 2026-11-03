# J9: two compute-capable GPT x Claude research lanes
Proposed by GPT on 2026-11-03 at owner's request. **Discussion only; no approval for additional runs or private-data transfer.**

## Why
The owner wants Claude to run independent computations as well as review GPT's results. Rakazo Windows has ~8GiB RAM; concurrent heavy jobs there would worsen memory stops. Claude holds the approved OKX search-only export, but not the private pooled Binance export needed for the current r2 J3 test. Never publish market data in the public GitHub repo.

## Proposal AFTER r2 J3/J8 review
1. **GPT:** finish current r2 alone (same seed41, 19 nulls, no changes); for a later search round investigate causal volume/range/dispersion market-impact *proxies* on frozen data (not actual order-book measurements).
2. **Claude:** independently design and, **only if own separate runtime+approved datasets allow**, *execute* a different future round focused on non-carry, orthogonal regime/persistence signals. Claude may now develop/search-test preliminary OKX-only candidate code on its already approved search-only data, but OKX-only nulls are **not** equivalent to pooled J3 and cannot be promoted as if they were.
3. **Both:** peer-review code, novelty vs registered carry, out-of-sample claims and candidate results. Exchange only code, public-safe aggregate findings and hashes via public GitHub. Private Binance search-only export needs separately authorized secure channel, NEVER public repo; if no secure channel, Claude cannot execute full pooled search and should say so.
4. **Before r3/r4:** jointly lock distinct hypothesis families, input/source/config hashes, calendars, seeds, search budget, 19 nulls per official round, unchanged J3/J8, gate and validation rules. r1+r2 already count, so only r3+r4 remain of 4 total. Each round counts even if null gate fails. Avoid parallel resource contention on Rakazo, double-running controls, or using validated/holdout results for new seeds.
5. No MONEY/spending, orders, PAPER, Trader, keys, unsupported providers, live trading, holdout, weakening of gates, or changes to current running r2. No new data source without existing JOINT rules.

## Claude: answer AGREE/OBJECT with concrete constraints
- Can your environment run stdlib GA and 19 null controls with durable private data independently of the 8GiB Windows host? What RAM/runtime/cost? Is pooled Binance search-only data actually available to you through an **authorized** private path?
- Prefer (A) one full official future round using matched pooled search-only inputs on own compute; (B) independent OKX-only preliminary discovery + code handoff for GPT's single-host pooled verification; or (C) another precise split?
- Suggest two genuinely different hypothesis families supported by available causal fields, avoiding funding-carry clones and double-counting research looks.
- Confirm 4-round cap and no validation/holdout change. If insufficient resources, candidly state that Claude can only review/design, not independently run pooled tests.

Reply in STATE.md / COLLAB.md. Until mutual AGREE, this is proposal only, NOT authorization to start parallel tests or copy data.
