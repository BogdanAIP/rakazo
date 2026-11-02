# Algorithm Discovery r2: immutable input and search contract

**PRE-RUN source lock — 2026-11-02, BEFORE any r2 strategy fitness evaluation.** All hashes below were **independently recomputed directly from the private bytes on authorized Windows Rakazo** and matched its completed INPUTS_READY_AWAITING_PUBLIC_LOCK_NO_FITNESS_RUN checkpoint. No raw market data in this public report.

## Source provenance and daily aggregation
- Binance hourly J6 audited CSV SHA-256: `eefdcfaa9f1f7849a9dc1869e7310dd3beb9c9807d3c27dd7732c2d7b988c170`, 4,357,999 hourly rows; source-only 2020-01-01→2023-12-31, already passed J5 and bench audit; independently reviewed by Claude.
- Full Binance daily aggregate SHA-256: `c686e1bf9f5a8a25039fce1e88bbcbb2dd923a4e6682a2bb754f1dece610d306`, 181,682 rows, 265 contracts; independently audited for correct 1-day intervals, zero eligibility mismatches, no empty global days.
- Binance daily **search-only freeze config** SHA-256: `baf999cd23670e8dadfdb66e8f1fa3a6948a49edfbcd4971d51b857786988b7a`. This is a *search split/config source*, **not** independent Binance validation; 2020 is warm-up, effective Binance search folds 2021-01-01→2023-09-30; `search_end=2023-10-01`.
- Binance search-only CSV export SHA-256: `1cea411ee2c3b9deafbc46cc2761071093c4edd17f5559dbb3d9793e4cdec104`, 160,046 rows, last open date 2023-09-30.
- Binance search export config SHA-256: `18d3a5ccb4cd7f949a14afca295f4e3ee2379aeaf1eb0433c096d1a888548c6f`.
- Frozen OKX daily **search-only** export CSV SHA-256: `c16cc3c3e5fc069a526f7f826b6055bfc871285f6a30f623a075b49bf0d99836`, its exported config SHA-256: `db1a93bf0c34de80dc1b2b92494586f188b0df0eb36391266e3f243be5fb6594`, search period 2023-10-01→2025-02-28.
- Frozen OKX daily validation remains 2025-03-01→2026-01-31; **holdout** starts 2026-02-01. Neither may be read by r2 search.

## Pinned executable contract, budget, rejection logic
- `algorithm_search_v40.py` SHA-256 from private execution snapshot: `30e3e2a027a4dc50469f8b6e1c257e6a72fea4e416552751b100164ed93240fa`.
- Supporting source from the same preflight: `aggregate_panel_daily_v40.py` SHA-256 `196ec5ea3ef23b5ef10edbc11d0a6c6a1b2540e7e60ad252e72766e2b1f252c1`; `algorithm_bench_v40.py` SHA-256 `80fe24eacc8c2972e6e0cc870c9c3ef92566f51da90c96d87c7151c3a23d1e6e`.
- One **real r2 population search**, seed **41**, population **80**, generations **30**, cross-exchange pooled fitness across **2 OKX + 3 Binance** search folds, `extra_start=2021-01-01`, `extra_folds=3`, round ID **r2**, promotion cap **5**.
- Exactly **19 matched-budget shuffled-score null searches**, null indices **0–18** with identical settings and search inputs (J3); predefine all seeds and null indices before computation. A round counts against the 4-round search budget even when it has no discovery.
- **J3 gate:** only if the real best in-sample fitness is strictly above **every** one of the 19 null maxima may up to 5 *pre-registered* candidates go to the already frozen OKX validation. Otherwise log `r2: no discovery`, **zero validation trials**.
- No search-derived candidates seeded from already-inspected validation, no post-hoc parameter changes, no modified trial ledger, no additional candidate beyond max 5, no look at holdout, no claim that 19 nulls establish global 5% familywise error across rounds.
- Preflight artifacts privately held under `runs/r2-input-prep-20261102/`; exact r2 output must use new exclusive path(s). Publish just report/candidate hashes, null maxima, and trial entries to public branch; raw/export market data remain private.

**STATUS AT PUBLICATION:** Only input preparation completed (all four PASS), **no r2 fitness evaluation started**. This file must precede the first fitness evaluation commit/execution. No PAPER/Trader, orders, Docker, account/key handling, or paid services.
