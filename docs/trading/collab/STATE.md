# Algorithm Discovery: STATE

The only control file for autonomous GPT × Claude work. **Rewrite it, do not append.** Keep it to about one page. Detailed history stays in `docs/trading/COLLAB.md` (Log, newest first). Research only: no orders, PAPER, Trader, accounts, keys or providers, ever.

Last updated: 2026-11-01 22:55 Moscow, by Claude.

## Protocol

1. Each agent works **its own lane** below, top item first, and changes only its own lane, except to add a handoff item to the other lane.
2. An item marked **[OWNER]** blocks only that item. Add it to *Blocked on owner* and continue with anything else. The owner is notified only when that list is not empty, plus one short daily digest from Claude.
3. Finish every turn by updating this file (status, next item, any handoff), pushing, and, if something is non-trivial, writing one Log entry in `COLLAB.md`.
4. Pull before acting, rebase before pushing, never force-push. Never quote another agent's numbers that are under embargo (see Rules).
5. If two consecutive turns cannot make progress on the top item, mark it **STUCK** with the reason and move on.

## Calendar and frozen artifacts (3-year OKX, frozen 2026-11-01)

- Search 2023-10-01 → 2025-02-28 · validation 2025-03-01 → 2026-01-31 · holdout 2026-02-01 → 2026-10-28.
- Hourly panel `2262134d…`; daily panel `7aef07bd…`, its frozen config `de588938…`; 39 registered rules; `prior_trials=200`.
- Primary rule `claude2-trend-carry-lowvol-7d` (`111fe82b…`), declared in the ledger before any evaluation.
- Search-only export: CSV `c16cc3c3…`, config `1674e683…` (252 symbols, last row 2025-02-28). Copy in the private data repo.

## Data

- Private repo **`BogdanAIP/rakazo-data`** holds only outputs of `export-search` (no validation or holdout rows by construction), under `exports/<calendar>/`, each with a `manifest.json` of SHAs. Full panels never leave the research computer. Market data never goes into the public repo.
- Claude reads exports from `rakazo-data`; GPT writes new exports there (e.g. Binance).

## Rules

- **Embargo:** development results of the 39 registered rules (including the primary verdict) go only to `docs/trading/bench/results/` and are **not opened by Claude** until the round-1 promotion batch is committed. After that the embargo is lifted.
- **Search budget on this calendar:** at most **4 rounds**, at most **5 rules promoted per round**. Then stop and review with the owner.
- **Owner-only decisions [OWNER]:** any holdout run (per exact rule, after an independent sign-off), calendar or data-source changes, gate/cost changes, new spending.

## Lane: GPT

1. **Evaluate the 39 registered rules** on the hourly panel, one batch per process, order `claude-2026-10-31`, `gpt-2026-10-31`, `gpt-medium-horizon-2026-10-31`, `claude-composites-2026-11-01`; ledger `docs/trading/bench/ledger.jsonl`; table in `results/` (embargo). — *status: ready*
2. **Promote search round 1** when Claude adds `docs/trading/bench/hypotheses/search-r1.json`: `promote` on the full daily panel with config `de588938…`, same ledger; commit the result; hand back to Claude. — *status: waiting for Claude*
3. **Binance audit** (no panel yet): as-of universe, earliest complete month, quote-volume and funding coverage; report. — *status: ready, parallel*

## Lane: Claude

1. **Search round 1** on the export (population 80 × 30 generations, beta-neutral, holds 1–10 days). Commit `search-r1.json` and a report; hand item 2 to GPT. — *status: running*
2. After the embargo lifts: review registered results and the primary verdict; review promotion results; plan round 2 from the failure analysis. — *status: waiting*
3. Push the current search-only export to `rakazo-data` once the repo exists. — *status: waiting for repo*

## Blocked on owner

- Create the private repo `BogdanAIP/rakazo-data` and add it to the Claude GitHub app (requested 2026-11-01 22:48).
