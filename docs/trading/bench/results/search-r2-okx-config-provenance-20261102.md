# Round 2 — OKX search-export configuration provenance

**Recorded 2026-11-02 during the existing r2 search; not a change to its inputs, score, validation, or trial ledger.** Response to Claude's 16:20 Moscow independent review question. Values read directly from the private OKX export config bytes on authorized Rakazo.

## Identity and original immutable source

- OKX search-export CSV SHA-256: `c16cc3c3e5fc069a526f7f826b6055bfc871285f6a30f623a075b49bf0d99836` (unchanged from r1 and locked before r2).
- OKX search-export config SHA-256: `db1a93bf0c34de80dc1b2b92494586f188b0df0eb36391266e3f243be5fb6594` (the exact r2 pre-fitness lock).
- `parent_config_sha256`: **`de588938f5006ce426d5b927a6fec1189d854c410ca757ba242146b677e59e9e`** — correct original frozen daily OKX config.
- `parent_panel_sha256`: **`7aef07bd222a429d7b39d56cd0273ed0a9c34001c4cc6e1bd5b62e1874df0cce`** — original frozen daily OKX panel.
- `exported_at_utc`: **`2026-11-01T17:55:03Z`**.
- `search_end_utc`: **`2025-03-01T00:00:00Z`**; `holdout_start_utc`: **`2026-02-01T00:00:00Z`**. r2 fitness receives only the search-truncated exported CSV; validation and holdout not read.

## Exact decision-related `gate` members from that config

| Setting | Recorded value |
|---|---|
| `costs_bp_per_side` | `[0,5,10,15]` |
| `gate_cost_bp_per_side` | `10` |
| `missing_exit_penalty_bp` | `300` |
| `prior_trials` | `200` |
| `dsr_min` | `0.95` |
| `folds` | `4` |
| `folds_positive_min` | `3` |
| `min_effective_periods` | `20` |
| `min_periods` | `30` |
| `max_funding_unknown_share` | `0.05` |
| `target_sharpe_annual` | `2.0` |
| `holdout_alpha` | `0.05` |
| `holdout_budget` | `3` |

The `gate` also embeds the original registered-hypothesis SHA list. `prior_trials` is in the nested `gate` object, **not a top-level config key**. None of these values were changed during this review or in the active run.

The earlier r1 export config SHA `1674e683…` is different, but the search CSV bytes are identical, and the r2 config points to the correct original immutable parent SHA. The export includes a variable `exported_at_utc` field; a different export timestamp is a plausible cause of different config SHA. This report does **not** claim byte-for-byte equivalence to the older r1 config, whose bytes were not compared here.

**Research status:** r2 real seed 41, population 80×30 running in the private supervisor. No current in-sample fitness has been admitted to OKX validation, no holdout opened, no trading or financial spending.
