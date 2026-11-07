# J7: offline 20× isolated-margin simulator, first report (2026-11-07)

**Synthetic paths only.** No exchange, network, keys, orders, PAPER or Trader; nothing here touches the bench panels, ledger or gates, and the trading ban in STATE is unchanged. All parameters are illustrative assumptions, not an exchange schedule. Author: Claude. Non-author review requested from GPT.

Code `scripts/trading/margin_sim_v40.py` (file SHA-256 `b39940342380d323c8bdab5b376e3caab88b43c5196d4b5482a7f05318ee43be`), tests `test_margin_sim_v40.py` (11, offline). It implements the design agreed on 11-03 (`LEVERAGE_20X_PRIMARY_MARGIN_CLAUDE_REPLY_20261103.md` §2–§4). Each variant runs on the same paths (common random numbers).

## What it models

Hourly bars for 12 assets, with a one-factor market and calm/stressed volatility regimes. Shocks are gaps at the bar open: common market jumps, momentum-crash dispersion jumps (recent winners down, losers up) and single-name squeezes of +10–40%. Funding is AR(1) and settles every 8 h. Maximum leverage varies by asset (50/25/20/10/5).

Each isolated leg works like this:
- **Entry.** Fills at the next open, with slippage and a taker fee on notional.
- **Liquidation.** Checked on the bar's adverse extreme. A liquidated leg loses its whole margin, and liquidation wins over a stop crossed in the same bar.
- **Stops.** A stop fills at the worse of the stop price and the open (gap-through).
- **Funding.** Debited from the isolated margin, which moves the liquidation price.

Entries are skipped, never topped up, in four cases:
- liquidation is closer than 1.5 × the stop;
- the asset cannot take the variant's leverage;
- the book margin cap (24% of equity) or the stress cap (15%) would bind;
- there is not enough cash.

The `x1_same_notional` and `x1_matched_risk` references are fully funded. A 1× book of that size would need more cash than the account holds, so they skip those checks.

**The signal has no edge by construction.** It is the long/short top-3 against bottom-3 by 7-day return on driftless paths. Results therefore measure what margin, leverage and costs do to a book, not a strategy.

Scenario: seed 1, 40 paths of 60 days, defaults in `Scenario`. SHA `9b5ce69eea458829d1ca26f160d1691667cc8bafc383dfcf86a83f8f967363a1`.

Params:
- fee 0.05% and slippage 0.05% per fill;
- maintenance margin 0.5%;
- margin cap 3% of current equity;
- risk budget 1% for the adaptive variants;
- stop = max(1%, trailing volatility over the hold).

Commands: `margin_sim_v40.py run --scenario S.json --out R.json` with `S.json` = `{"params": {"hold": 4}}` or `{"params": {"hold": 24}}`.

## Results: 60 days, no edge

**Hold 4 h** (a new book about every 5 h):

| Variant | Median return | P5 | P(lose ≥ 50%) | Median max DD | Entries | Liquidations | Batches with a liquidation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixed20 | −86.4% | −94.0% | 98% | 87% | 32,394 | 659 | 5.8% |
| adaptive20 | −75.1% | −83.8% | 92% | 76% | 32,558 | 661 | 5.9% |
| buffered20 | −91.1% | −97.4% | 100% | 91% | 40,654 | 1,060 | 9.2% |
| x1_same_margin | −14.8% | −19.0% | 0% | 15% | 60,978 | 0 | 0% |
| x1_same_notional | −96.4% | −98.8% | 100% | 97% | 60,978 | 0 | 0% |
| x1_matched_risk | −88.4% | −92.7% | 100% | 89% | 60,978 | 0 | 0% |

**Hold 24 h:**

| Variant | Median return | P5 | P(lose ≥ 50%) | Median max DD | Entries | Liquidations | Batches with a liquidation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixed20 / adaptive20 | 0 | 0 | 0% | 0% | **0** (every entry refused) | 0 | – |
| buffered20 | −23.5% | −48.5% | 2% | 34% | 8,862 | 69 | 2.9% |
| x1_same_margin | −3.3% | −7.1% | 0% | 5% | 12,000 | 0 | 0% |
| x1_same_notional | −57.4% | −80.4% | 65% | 65% | 12,000 | 0 | 0% |
| x1_matched_risk | −19.0% | −34.1% | 0% | 25% | 12,000 | 0 | 0% |

Skips. At 4 h, about 20,600 entries were refused because the asset could not take 20× and about 9,250 because liquidation fell inside the buffer. At 24 h the same two reasons refused 4,087 and 8,393 entries. A round trip costs 2% of the posted margin at 20×. The median realised loss at a stop is 0.98–0.99 of the planned loss; gaps make the tail heavier.

## What this says (for the owner's 20× / 3% question)

1. **At 20× the horizon is forced intraday.** A 20× isolated leg is liquidated about 4.5% away. A daily stop on alts is ≥ 3%, and 1.5 × 3% is already beyond that. So every 20× daily entry is refused, as predicted in A4; only intraday holds are feasible.
2. **Without an edge, 20× turns cost into ruin.** The same trades at 1× with the same 3% margin lose 15% in 60 days; at 20× they lose 86%. Liquidations are a minor part of that (2% of entries). Most of the loss is the 0.2% round-trip cost paid on 20 times the notional, about every 5 hours. `x1_same_notional` loses as much with no liquidations at all.
3. **The edge needed is concrete.** Each 4-hour trade must earn more than about 0.2% of notional before leverage pays at all. No rule in this project has shown that: round 1's search rules failed validation, and the best registered rule (weekly funding carry) reached an annual net Sharpe of about 1.55 at 10 bp per side with weekly holds, which is nowhere near 0.2% every 4 hours.
4. **Adaptive sizing helps, but only against risk.** With a 1% stop-loss budget, adaptive20 loses less than fixed20 (−75% against −86%) because the stakes are smaller. It does not create return.
5. **Buffered 20× is the worst at 4 h.** It accepts more trades (lower effective leverage clears the buffer), so it pays more cost and suffers more liquidations.

Limitations: synthetic paths, a no-edge signal, an illustrative cost schedule, and no ADL, insurance fund, tiered maintenance or exchange-specific rules. The mark proxy is the bar extreme, which is conservative. These numbers are not a forecast for any real market. A next step, if both agents want one, is a predeclared planted-edge sweep: the per-trade edge at which each variant breaks even. That would also need a new scenario SHA, registered before running.

## Update after GPT's review (11-07)

GPT found two defects, both now fixed with regression tests (14 tests in total):

- **Exit-bar gap.** A scheduled exit whose open gapped past liquidation paid out below zero. It is now a liquidation, and every isolated payout is floored at zero.
- **Zero stake.** A zero stake raised a division error. It is now skipped as `zero_stake`.

Rerun with the same scenario SHA: liquidations rose by about 10 per variant, and medians moved by at most 0.2 points; the tables above stand.

## Leverage sweep for a 1,000 USDT account (owner's request, 11-07)

The owner asked which leverage to use with 1,000 USDT and what return to expect. Setup:
- **Book:** variant `levL` with margin 3% of equity per position (30 USDT at the start), 3 long and 3 short, held 24 h, then re-picked.
- **Exposure:** gross ≈ 0.18 × L of equity; 5× already puts about 90% of the deposit to work.
- **Period:** 180 days, 40 paths.
- **Planted edge:** the 3 strongest and 3 weakest coins by 7-day return drift up or down by d per day. d = 0 is no edge. The gross column shows the price move per closed trade that the book actually captured, before costs of about 0.2% per round trip.

Scenario SHAs: d = 0 `246b1277e023f57d815242b9b6f208b77171c6a66f5527cc288676057c6a6811`; d = 0.2% `970bf0123905ff60e349dda289cd92d98c41d884db72a84a97134a11c3727ad9`; d = 0.5% `ff6e769abd959899de4d4de47746d6c5f0086f37eae7de8ef4857b3a5fc7de57`; d = 1% `e2ace6fe72633dbe1ac08b0261bc99b4688cc662f67d7f66a04a4d8b48ab7cb0`.

| Planted edge | Leverage | Gross exposure | Median 180 d | P5 | P(lose ≥ 50%) | Median max DD | Entries | Liquidations | Gross move per trade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 1× | 18% | -9.9% | -18.3% | 0% | 12% | 39,840 | 0 | -0.15% |
| none | 2× | 36% | -14.9% | -27.9% | 0% | 19% | 33,200 | 0 | -0.11% |
| none | 3× | 54% | -22.2% | -39.0% | 0% | 27% | 33,200 | 12 | -0.10% |
| none | 5× | 90% | -34.8% | -56.3% | 18% | 42% | 33,194 | 35 | -0.09% |
| none | 10× | 180% | -43.2% | -64.5% | 38% | 50% | 20,561 | 79 | -0.08% |
| none | 20× | 360% | +0.0% | +0.0% | 0% | 0% | 1 | 0 | – |
| 0.2%/day | 1× | 18% | -5.7% | -14.5% | 0% | 8% | 39,840 | 0 | -0.00% |
| 0.2%/day | 2× | 36% | -9.0% | -22.0% | 0% | 14% | 33,200 | 0 | +0.03% |
| 0.2%/day | 3× | 54% | -13.5% | -31.4% | 0% | 21% | 33,200 | 12 | +0.05% |
| 0.2%/day | 5× | 90% | -22.1% | -47.0% | 2% | 32% | 33,194 | 35 | +0.05% |
| 0.2%/day | 10× | 180% | -29.2% | -56.3% | 8% | 42% | 20,613 | 73 | +0.06% |
| 0.2%/day | 20× | 360% | +0.0% | +0.0% | 0% | 0% | 1 | 0 | – |
| 0.5%/day | 1× | 18% | +0.1% | -9.1% | 0% | 5% | 39,840 | 0 | +0.20% |
| 0.5%/day | 2× | 36% | +1.8% | -13.5% | 0% | 9% | 33,200 | 0 | +0.28% |
| 0.5%/day | 3× | 54% | +2.4% | -19.8% | 0% | 13% | 33,200 | 11 | +0.29% |
| 0.5%/day | 5× | 90% | +3.7% | -31.4% | 0% | 22% | 33,194 | 29 | +0.29% |
| 0.5%/day | 10× | 180% | -0.2% | -34.1% | 0% | 29% | 20,662 | 77 | +0.30% |
| 0.5%/day | 20× | 360% | +0.0% | +0.0% | 0% | 0% | 1 | 0 | – |
| 1%/day | 1× | 18% | +13.2% | +3.9% | 0% | 3% | 39,840 | 0 | +0.62% |
| 1%/day | 2× | 36% | +26.2% | +7.6% | 0% | 6% | 33,200 | 0 | +0.70% |
| 1%/day | 3× | 54% | +41.3% | +11.1% | 0% | 9% | 33,200 | 9 | +0.71% |
| 1%/day | 5× | 90% | +74.8% | +11.3% | 0% | 13% | 33,194 | 28 | +0.70% |
| 1%/day | 10× | 180% | +75.3% | -7.4% | 0% | 22% | 20,636 | 82 | +0.68% |
| 1%/day | 20× | 360% | +0.0% | +0.0% | 0% | 0% | 1 | 0 | – |

Reading:
1. **Without an edge, every leverage loses, and more leverage loses more:** −10% at 1×, −22% at 3×, −35% at 5×, −43% at 10× (a 38% chance of losing half). The no-edge momentum book also eats the planted momentum crashes.
2. **20× does not trade at a daily hold.** Liquidation sits inside 1.5 × the stop, so entries are refused (one entry in 180 days).
3. **Leverage only pays once the gross edge clearly exceeds cost.** At about 0.3% captured per trade (d = 0.5%) the result is roughly break-even at any leverage, with a wide P5. At about 0.7% per trade (d = 1%), 3–5× is best (+41% / +75% median) and 10× adds risk without adding return.
4. **That edge is far above anything this project has measured.** About 0.7% per trade per day is several hundred percent a year. The best registered rule (weekly carry, annual net Sharpe ≈ 1.55, REJECT) is nowhere near it.
5. **So for a real account the answer today is leverage 0.** Once a rule passes validation and holdout, size it from its measured edge and volatility, probably 3–5× on 3% stakes, never 20×.
