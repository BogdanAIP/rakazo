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
outbox item and cannot reserve, fill, close, sign, broadcast or submit any exchange order. Connecting
a G1-ready proposal to the existing PAPER reserve writer remains a later separately reviewed step.

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
