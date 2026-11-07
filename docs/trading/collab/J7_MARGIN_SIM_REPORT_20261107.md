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
