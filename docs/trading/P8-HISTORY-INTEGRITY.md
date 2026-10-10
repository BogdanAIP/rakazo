# P8 — Canonical historical dataset and content integrity

Status: stacked **DRAFT** after PR #8. Read-only and offline; no API keys, order execution, wallet, schedule, user-machine change or installation.

## Why

The P5/P7 experiment originally accepted a caller-supplied `datasetSha256`. A string that looks like a hash is not proof that the actual source input was hashed or remained unchanged. P8 introduces a one-way normalized snapshot boundary:

`fetchOkxClosedOneHourHistory(market)` -> `captureOkxClosedHistoryDataset()` -> `buildVerifiedTradingHistoryDataset()` -> `verifyTradingHistoryDataset()` -> `replayVerifiedSpotDataset()`.

The last function recalculates the digest and derived metadata before handing the **entire** historical dataset to P7. It rejects a history exceeding P7's 250-bar limit instead of hiding older data by truncation. There is no new Plugin R route, trade operation, recurring collector or storage mutation.

## Canonical format (versioned)

- `okx_normalized_closed_1h_v1`; exact field order in `prepareTradingHistoryCapture`: version, fixed source identifier, retrievedAt, all published market metadata including **status at capture**, then each normalized confirmed 1H bar in chronological order with full OHLC and quote volume decimal strings. Stable UTF-8 JSON serialized with `JSON.stringify`, and a **locally computed Node SHA-256** (not a caller-provided hash). Bound canonical length to 8 MiB; no additional package, binary or Python runtime.
- Only the prevalidated OKX public-history adapter provides the read path, bounded to its existing single-market fixed-origin GET. Raw network origin is **not cryptographically signed** by OKX: the digest establishes *local normalized data integrity*, not that the market feed was genuine or complete.
- Reject mixed markets, duplicates, reversed/unordered bars, unaligned times, invalid OHLC and future/unclosed bars. Do not interpolate absent history, fabricate candles or infer unobservable delisting dates.
- Preserve time holes as explicit `{afterOpenedAt,beforeOpenedAt,missingBars}` ranges; preserve inactive-at-capture market metadata in the archive. **Only** contiguous (22+ bars), active-at-capture **spot** snapshots are eligible for the P7 walk-forward bridge. Active status at collection is **not** a statement of historical listing or user's exchange/KYC/product eligibility. Delisted instruments must be retained in a broader future universe to reduce survivorship bias; never erase them just because they are not eligible for current paper orders.
- `verifyTradingHistoryDataset()` reconstructs the source canonical JSON and checks SHA-256, byte count, coverage flags, first/last bar and gap ranges. Changing a single valid candle close, capture time or market status changes the digest. Changing only a computed coverage field fails the consistency check.
- `datasetSha256` is tied to the entire normalized snapshot including `retrievedAt`; fetching the same historical bars later produces a distinct **capture** hash. A future immutable bar-only digest may complement it for equivalence comparisons across retrievals.

## Remaining authenticity and research work

Transport raw response body/page digests, UTC fetch timestamps and query cursors into an append-only collector with independently verified paging and source evidence. A capture hash is neither raw-response proof nor external attestation; current fixture tests are synthetic and do not demonstrate live OKX reachability. Archive listing/delisting histories and symbol aliases, freeze out-of-sample universes, allow deterministic multi-page >100-bar captures, compute time-split results and coverage/exclusion reports. Never infer current/tradable markets from historical data alone. No Paper/live installation or key access follows from this PR.

Tests use synthetic data and injected read-only GET to verify deterministic property-order hashing, data/provenance tampering refusal, gap reporting (no interpolation), duplicate/mixed/future refusal, inactive archive retention, stop-first guarded walk-forward and no-key network request shape. Exact-head CI required before acceptance.
