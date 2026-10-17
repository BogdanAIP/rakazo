# Rakazo Trading — Market Resolver / Skills bridge

## Purpose

This follow-on starts after P11F-5 completed the low-level automatic PAPER lifecycle.

The trading worker must no longer grow one hard-coded research implementation per exchange,
strategy or data source. Market Resolver and Market Skills are the reusable research layer;
Trading Core remains the authority and state-transition layer.

Target composition:

```text
Trading bot
  -> Market Resolver
  -> selected read-only Market implementation / Skill
  -> normalized TradingResolvedResearchEnvelope
  -> explicit strategy/risk approval
  -> PAPER reserve / fill / close core
  -> position management
  -> post-mortem / analysis Skills
```

Resolver selection is never execution authority.

## G0 — normalized research boundary

`TradingResolvedResearchEnvelopeSchema` is the first branch-independent contract between the
Market line and Trading Core.

It requires:

- `mode = research_only`;
- `executionAuthority = none`;
- pinned Resolver provenance and digest;
- one concrete Resolver implementation with `readOnly = true`;
- optional pinned Market Skill provenance and source digest;
- an existing `TradingSignal`, which is either a research-only proposal or explicit
  `NO_TRADE`.

The envelope cannot reserve, fill, close, sign, broadcast or submit any order. Any future PAPER
transition must pass a separately persisted and versioned strategy/risk approval after the envelope
has been verified.

### G0.1 — immutable approval scope

`TradingResolvedResearchApprovalScope` reduces a validated envelope to the immutable identity that
a future owner-approved PAPER strategy gate may authorize:

- Resolver semantic key, entry key and digest;
- exact selected implementation reference;
- optional pinned Market Skill source digest;
- strategy id and strategy version;
- proposal venue, market kind and action class (or null for `NO_TRADE`).

The scope deliberately excludes symbol-specific price levels, evidence ids, risk budget and
execution authority. `assessResolvedTradingResearch` is a pure read-only helper that validates the envelope,
derives that scope and returns only `proposal`, `no_trade` or `expired`. It performs no ledger
write and grants no PAPER authority.

## G0.2 — direct Market pinned-provenance intake

The Trading-side helper `buildTradingResolvedResearchEnvelope` now accepts the immutable,
data-only provenance produced by the Market Resolver preparation boundary plus one
`TradingSignal`, and validates the complete `TradingResolvedResearchEnvelope`.

This is intentionally a validation/mapping step only. It does not know how Market stores Resolvers
or Skills, does not install or invoke a Skill, and grants no PAPER/live authority. Market-native
keys that exceed Trading's narrower contract, write-capable implementations, malformed source
digests or non-research signals fail closed rather than being truncated or coerced.

Once the Market and Trading lines share an integration base, the intended handoff is therefore:
`market/prepare.provenance -> buildTradingResolvedResearchEnvelope(...) -> G1`.

## G1 — explicit generic PAPER research-source approval

G1 adds a separate persisted permission boundary for Resolver-produced research. It does **not**
reuse or widen the legacy `breakout_20_1h_v1` worker signal gate.

An owner-approved `paper_resolved_research_control` effect may enable exactly one
`TradingResolvedResearchApprovalScope` for one PAPER ledger and the currently authorized worker
revision. The stored gate binds:

- Resolver semantic key, resolver key and digest;
- exact selected implementation reference;
- optional Market Skill source digest;
- strategy id/version plus proposal venue, market kind and action class;
- current PAPER policy revision and worker gate revision;
- a monotonically increasing research approval revision and the exact approval effect id.

The G1 preflight validates a fresh `TradingResolvedResearchEnvelope`, rejects `NO_TRADE` and
expired proposals, verifies the completed explicit approval provenance, rechecks current D2 worker
authority, and requires the derived scope to exactly match the persisted approved scope. Any worker
revision change invalidates the gate until a new explicit approval is recorded.

G1 is permission-only. Enabling, disabling or checking it writes no PAPER ledger event, creates no
outbox item and cannot reserve, fill, close, sign, broadcast or submit any exchange order. The
`paper_resolved_research_control` builtin is a separate explicit-approval tool: every enable or
disable requires a fresh owner confirmation and is excluded from Auto Review/permanent allow.
Connecting a G1-ready proposal to the existing PAPER reserve writer remains a later separately
reviewed step.

## G2 — transactional Resolver proposal -> PAPER reserve bridge

G2 connects one **already G1-approved** Resolver proposal to the existing B7 PAPER reserve/risk
writer. It is deliberately limited to the reserve stage.

The public entry point accepts the original `TradingResolvedResearchEnvelope`, the trusted public
quote evidence id and the exact G1 preflight authority. Inside the same serializable B7 transaction
it:

- rejects mixing legacy F0 authority with G1 authority;
- requires the proposed signal to be byte-for-byte the envelope signal;
- revalidates the current G1 authority against the same envelope and current D2 worker state;
- runs the unchanged PAPER risk, quote freshness/spread/deviation, capacity, policy and kill-switch
  checks before any virtual hold is created;
- records the G1 approval effect on the reserve decision plus a separate immutable
  `TradingPaperResolvedResearchReserveUse` row binding scope, revisions, evidence, signal and
  reserve sequence;
- verifies that provenance on duplicate/idempotent replay and in strict lifecycle audit.

G2 still cannot fill or close a position, call a private exchange endpoint, sign anything or submit
an order. In particular, a G2 reserve does **not** inherit the legacy F2
`breakout_20_1h_v1` automatic-fill authority. A future generic fill stage needs its own explicit
approval boundary and its own historical provenance.

## G3 — separate generic PAPER fill permission

G3 adds the next permission boundary but still does **not** perform a fill. It is intentionally
separate from both G1/G2 and the legacy F2 `breakout_20_1h_v1` fill gate.

The explicit `paper_resolved_research_fill_control` action binds a future generic fill permission
to:

- one exact normalized Resolver/Skill approval scope;
- the current PAPER policy and D2 worker-gate revisions;
- the exact G1 research revision and approval effect;
- its own monotonically increasing fill-permission revision and approval effect.

Every enable or disable requires a fresh owner confirmation and is excluded from Auto Review and
permanent allow. Enabling G3 revalidates the current G1 scope authority and fails closed if the
worker, policy, G1 scope or G1 revision changed.

G3 is permission-only: it creates no reserve, fill, close, ledger event or outbox item and does not
fetch market data. A later G4 fill bridge must revalidate G3 inside the same serializable fill
transaction, verify the exact G2 reserve provenance and require fresh trusted public quote evidence
before delegating to the existing synthetic PAPER fill/risk checks.

## G4 — transactional G3 -> synthetic PAPER fill bridge

G4 connects one verified G2 reservation to the existing synthetic full-fill writer only after a
separately approved G3 fill authority is present. The bridge remains entirely inside the PAPER
ledger.

Inside the same serializable fill transaction G4:

- rejects mixing generic G3 authority with the legacy F2/market-target authority pair;
- revalidates the current G3 gate, which in turn revalidates the exact G1 scope and current D2/PAPER
  revisions;
- verifies the reservation's immutable G2 provenance and requires its G1 approval effect to match
  the G3 scope lineage;
- requires a fresh trusted public quote evidence record for the exact reservation market;
- reuses the existing policy, kill-switch, reservation-expiry, spread, slippage, held-quote,
  stop-price and synthetic full-fill checks;
- records the G3 approval effect on the fill decision and a separate immutable
  `TradingPaperResolvedResearchFillUse` row binding the G1/G3 approvals, scope/revisions, original
  reserve evidence, fresh fill evidence and reserve/fill event sequences;
- verifies that historical provenance in strict lifecycle audit and on idempotent replay.

G4 adds no close authority and contains no exchange account, private endpoint, signing function,
wallet action or live-order payload. Generic automatic stop handling remains a separate future gate.

## G5 — generic G4 protective-stop monitoring

G5 extends the existing F4/F5 automatic protective-stop safety path to positions opened through the
generic Resolver/Skill G4 fill bridge. It does **not** add a new close authority.

The read-only G5 preflight runs the strict lifecycle audit and returns only currently open positions
with verified immutable G4 fill provenance. It cross-checks the open fill, quantity, persisted stop,
market and G1/G3 scope lineage before exposing a candidate.

The recurring protective-stop handler now combines F3 and G4 candidates in fill-sequence order.
Before any synthetic C2 close it still requires current D2 worker authority, obtains fresh trusted
keyless public spot evidence for the position's own historical venue/symbol, then rereads the worker
and exact candidate provenance. C2 remains the money boundary and independently rechecks the enabled
PAPER policy, kill switch, evidence freshness/spread and persisted stop trigger.

The current trusted public stop-capture adapter supports only OKX and BingX spot. A G4 position on
any other venue therefore fails closed before network access and blocks new same-wake exposure
instead of substituting a quote source. Expanding that capture coverage belongs in the Market
Resolver/Skills integration rather than another hard-coded trading-worker venue path.

G5 closes at most one position per wake and retains the existing no-same-wake-reentry behavior.
It adds no private exchange API, credential, wallet action, broker dispatcher or live-order path.

## G6 — generic Resolver/Skill worker composition seam

G6 removes the requirement that the recurring PAPER worker itself know how research was produced.
A new internal worker composition accepts one already prepared
`TradingResolvedResearchEnvelope` from an injected research-only provider plus an injected trusted
public-evidence capture function.

The G6 path is deliberately authority-free at its input boundary. For a proposal it:

- checks the explicit G1 scope before any quote capture;
- captures one deterministic trusted quote for the G2 reserve;
- delegates to G2, which rechecks G1 inside the same serializable risk/reserve transaction;
- returns the verified reserve without filling when the separate G3 fill permission is disabled;
- only when G3 is ready, captures a **second fresh** deterministic quote and delegates to G4;
- preserves all existing PAPER policy, risk, kill-switch, idempotency and historical provenance
  checks in G1-G4.

A Resolver `NO_TRADE` remains an abstention and causes no quote capture or PAPER write.

The recurring handler now has an optional G6 runner slot. When that slot is explicitly wired, the
worker services protective stops first and then uses G6 instead of the legacy hard-coded
OKX/BingX + `breakout_20_1h_v1` research chain. Without the slot, the legacy path remains unchanged.

There is intentionally **no default G6 provider** in the Trading branch. The provider must come
from the Market line after the branches share a common integration base. This prevents Trading from
copying Market storage, Resolver seeds or Skill invocation code. The Market side already has the
matching read-only `market/select` / `market/prepare` provenance boundary; its pinned provenance
shape is accepted directly by `buildTradingResolvedResearchEnvelope`.

G6 still contains no private exchange API, credential, wallet signer, live-order payload or
`trading.execute` capability. Resolver/Skill selection remains research authority only; G1 and G3
remain separate explicit owner approvals for PAPER state transitions.

## Why G0 is separate from Market storage

The Market/Capability Profile line and the stacked Trading PR line currently diverge from a common
ancestor. Market Resolver v2 already exists in Rakazo and the live Market catalog exposes the
trading routes, but the P11 branch does not contain the Market service or resolver seed files.

Therefore this branch intentionally does **not** copy resolver JSON, Market tables or Market service
code into the trading stack.

The integration plan is:

1. keep the normalized envelope contract independent of the concrete Market database/API;
2. after the Market and Trading lines share an integration base, add a small adapter that reads the
   selected Resolver/Skill provenance and emits this envelope;
3. add a new explicit generic strategy gate for Resolver-produced research instead of widening the
   legacy `breakout_20_1h_v1` F0 gate;
4. only then connect approved generic proposals to the existing PAPER risk and ledger writers;
5. keep live/private exchange execution outside this project gate.

## Existing Market routes to reuse

The current Market catalog already has semantic routes for:

- `market.data`
- `market.analysis`
- `signal.discovery`
- `market.risk`
- `futures.data`
- `strategy.framework`
- `backtest.quant`
- `paper.simulation`
- `trading.paper`
- `wallet.analytics`
- `defi.data`

These should be reused before any new market/research implementation is written.

## Safety boundary

The active Trading Project capability profile is research-oriented and denies
`trading.execute`. PAPER-only internal state transitions remain governed by the existing explicit
owner approvals, kill switch, audit trail, idempotency and fail-closed checks.

No Market Resolver or Market Skill entry may override those controls.


## G7 — adapter-neutral prepared Market research provider

`createPreparedMarketResearchProvider` in
`packages/adapters/src/paper-worker-market-prepared-provider.ts` is the
**internal, opt-in** connector between Market's existing `prepareMarketResolverResearch`
output and the already-present G6 `PaperWorkerResolvedResearchProvider`.

Composition remains dependency-injected:

```text
owner-scoped Market storage -> resolveMarketResolverPlanFromEntries
  -> selectMarketResolverReadOnlyImplementation
  -> prepareMarketResolverResearch (pinned Skill content)
  -> createPreparedMarketResearchProvider(prepare, authorizedReadOnlyRunner)
  -> buildTradingResolvedResearchEnvelope
  -> handlePreparedPaperWorkerResolvedResearch (G6 -> G1/G2/G3/G4)
```

The adapter verifies the complete selected Resolver identity and implementation
(name/kind/reference/priority/readOnly) against the pinned provenance; it also
checks the selected Skill entry/key/digest/variant and requires pinned content
exactly when a Skill is selected. A denial, stale/replaced source, unexpected
content or execution-capable Trading signal fails closed **before any PAPER
operation**. `NO_TRADE` stays an abstention.

Neither Skill instructions nor selection metadata grant capability authority.
The integration caller MUST resolve only within the correct owner scope and
invoke only explicitly authorized, read-only market/research tools; it must
never evaluate a Skill file as executable code, escalate a connector assignment,
or turn on private/account/trading CCXT tools. The adapter does not implement
those external tool calls and does not enable any default provider.

**Outstanding integration:** PR #38 and Market PR #40 are based on divergent
code lines. After both features share a reviewed integration base, wire the
Market prepare implementation and a genuinely read-only runner into this seam,
then opt in the G6 handler and verify a complete PostgreSQL PAPER lifecycle.
This G7 change is a contract/validation boundary, **not** a running market-data
feed or a deployed worker.


## G8 — exact selected RCCL / WRAPPED / HYBRID Skill invocation

`createSelectedMarketSkillResearchRunner` in
`packages/adapters/src/paper-worker-market-selected-skill-runner.ts`
takes the pinned `market/prepare` output already validated by G7 and
passes its **actual selected instructions** to one *injected*, authorized
read-only research invoker.

It preserves `original`, `rccl`, `wrapped` and `hybrid` variants
without auto-fallback to the original. Every invocation includes the
original immutable Market entry's `sourceDigest`, the chosen `variant`,
and a separately computed SHA-256 of the *actual selected instruction
text* (`contentSha256`). The output is validated against the existing
research-only `TradingSignalSchema`; `NO_TRADE` stays an abstention.

No Skill text is executed as a program or installed globally, no MCP
authorization is widened, and the runner is not enabled by default.
The injected invoker MUST enforce read-only scopes independently, treat
Skill instructions as lower-trust instructions than trading policy, and
decline trading/private-account tool calls regardless of Skill wording.

**Critical remaining approval work:** the current G1/G3
`TradingResolvedResearchApprovalScope` binds the original Skill
`sourceDigest` but does **not** bind the selected variant or its actual
instruction-content digest. The runtime integration MUST bind both to the
versioned, owner-approved PAPER scope and immutable transaction/audit
provenance *before adapted-Skill proposals can be allowed to reserve or
fill*. G8 by itself is **research-only** and must not be wired as an
automatically paper-trading default until that separate gate is updated
and tested.

In particular, an existing approval for `original` must never silently
authorize `rccl`, `wrapped` or `hybrid` following a preference change.
The Market catalogue's general `market/evaluate` preferred-variant
change is not PAPER trading owner consent.


## G9 — selected Skill variant + exact instruction digest in PAPER approval

G7 now hashes **the actual selected Market Skill body** (SHA-256 UTF-8) after
verifying the pinned Resolver / Skill entry and before invoking the read-only
research runner. The returned Trading envelope records this
`provenance.skill.contentSha256` alongside the immutable upstream source digest.

The G1/G3 `TradingResolvedResearchApprovalScope` uses two explicitly versioned
formats:

- `scope-v1` is preserved for historical, already-recorded source-only approvals
  and tool-only/legacy original-Skill research, so verified old JSON/digest/ledger
  audit history is not rewritten or silently upgraded.
- `scope-v2` is derived whenever selected instruction bytes were actually
  pinned. It includes `skillVariant` (`original`, `rccl`, `wrapped`, `hybrid`)
  and `skillContentSha256` in addition to the original source digest and
  existing Resolver/strategy/venue/action scope.

**Non-bypass rule:** an adapted-Skill envelope without a pinned selected-text
digest is rejected instead of being reduced to the historical `scope-v1`.
A v1 owner approval **cannot** authorize a v2 execution. A v2 approval for
RCCL cannot authorize WRAPPED, ORIGINAL, HYBRID or an edited RCCL instruction
body, even when the Market source digest remains unchanged. Both G1 reserve
and G3 fill inherit the canonical versioned scope through the existing
transactional authority verification. Historic G2/G4 immutable approval-use
records and lifecycle audit continue to compare the complete canonical scope.

The full read-only market-invocation binding and the G9 approval scope are
code/test changes only, not deployment or authorization. Live credentials and
order placement remain completely outside this design. No automatic PAPER
recurrence or order-writing tool is enabled merely by this change.

**Integration remaining:** PR #38 and Market PR #40 must share a reviewed
integration base; attach a real owner-scoped `market/prepare` and an existing
authorized read-only research executor, then run the whole synthetic
PAPER lifecycle with the selected Skill. Existing explicit G1/G3 approvals
remain required for any reserve or fill.
