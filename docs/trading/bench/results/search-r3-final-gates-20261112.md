# Search round r3: completed controls and candidate originality (12 November 2026)

**Frozen original search:** 582 genomes evaluated, 4 candidate rules, pooled OKX+Binance, library r3-f1, seed 43, population 80, generations 30. Search source SHA-256 0c940e227a94ac78b49d67c5de1014cf02b79e1850d9dc6b33a8eddfdc052aee; original real report SHA 5847a9e919ce83446d2d14babab4c593850f11a1358adf49ee79a889aa30cda9.

## J3 matched-null screen

- Real unfiltered best fitness **0.9852835467660632** strictly greater than all 19 nulls (maximum **0.14261588080986065**, seed14): numerical J3 PASS. Real generation-0 receipt GEN0_OK.
- All 19 original/replayed null controls checked and accepted with pinned full-ledger RECEIPT_OK and GEN0_OK, every seed exactly once, search config and both search-panel pins unchanged.
- Earlier interrupted seed6 prefix 152 rows PREFIX_MATCH, original null18 prefix 1325 complete rows vs 1556 replayed PREFIX_MATCH. Original SHA null18 ad000c5f4b5643987b40870ddf88246e6c80a22270c4d41e1dd6efdfee6cacc1 unchanged.
- Final seed18 fitness -0.5243606669557059; report SHA fdc2c25ef8778443d81e4626a3d89df9378a7125ea3a576b74113d33fbb68792 and full ledger SHA cbaa4f419970f5c8a1ea406f2aa1cb13f10f8adf85a81641167cd871626bf269. Non-author Claude review pending.

## J8: novelty against frozen carry reference

Each candidate passed the pinned J8 report+ledger receipt check with no errors. Reference = -fund3, 7d hold, inverse-vol, library r2; candidate library r3-f1. All candidate pooled fitness values strictly exceed the best null.

| Candidate | Pooled fitness | OKX correlation | Binance correlation | Pooled correlation | J8 |
|---|---:|---:|---:|---:|---|
| r3-1 | 0.985284 | 0.1676 | -0.0620 | -0.0210 | NEW |
| r3-2 | 0.651432 | 0.1768 | 0.1001 | 0.1132 | NEW |
| r3-3 | 0.194192 | 0.2828 | -0.0805 | -0.0219 | NEW |
| r3-4 | 0.150172 | -0.0471 | -0.1251 | -0.1107 | NEW |

The weakest candidate-specific margin is r3-4: +0.0075563826 above the null maximum (not evidence of trading profitability).

## J14: pairwise retained-candidate novelty

Original frozen order 1,2,3,4; each candidate compared only with those retained before it. Every one of six J8 pair receipts checked as eligible, with no problems; all pairs NEW.

| Pair | OKX correlation | Binance correlation | Pooled correlation | J14 verdict |
|---|---:|---:|---:|---|
| r3-1 vs r3-2 | 0.2493 | 0.4447 | 0.4070 | NEW |
| r3-1 vs r3-3 | 0.5123 | 0.5232 | 0.5202 | NEW |
| r3-1 vs r3-4 | 0.3798 | 0.4117 | 0.4052 | NEW |
| r3-2 vs r3-3 | 0.6449 | 0.5625 | 0.5768 | NEW |
| r3-2 vs r3-4 | -0.2217 | -0.0281 | -0.0662 | NEW |
| r3-3 vs r3-4 | -0.0126 | 0.0214 | 0.0149 | NEW |

All four were admitted to ONE independent frozen OKX validation without retuning. Full non-holdout validation results in promote-r3.md. Neither the numeric search gate nor originality screens prove future profitability. Protected holdout not opened.
