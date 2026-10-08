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
