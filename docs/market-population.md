# Market Skills + Market Resolver population

Rakazo Market is a searchable knowledge layer, not a replacement for Projects, Agent Skills,
Capability Profiles, permissions, Bots, Computers or Runs.

The goal is practical reuse:

- **Market Skills** answer "how should this task be done?"
- **Market Resolver** answers "what concrete implementation can satisfy this semantic need?"
- **MCP/API/CLI/native tools** are concrete executors.
- **Projects and policy** still decide what is available and authorized.

## Core rule

Reuse first. Adapt second. Create last.

Do not bulk-convert the Market to RCCL. Preserve the original source and adapt only Skills that
are actually selected for real work.

## Trust rule

Market population must stay fast enough to be useful. Do not turn each import into a separate
security project.

Use a simple admission rule:

1. Prefer official/vendor-maintained or otherwise clearly trusted GitHub repositories.
2. Require a full pinned commit SHA.
3. Record repository, source URL/path, license, SHA-256 digest and retrieval metadata.
4. Store text/data only; indexing an entry grants no permission and executes nothing.
5. Skip opaque, obfuscated, suspicious, abandoned or unclear sources.
6. If trust is uncertain, do not import it.

The initial pinned source set lives in `market/trusted-sources.v1.json`.

## Market entry lifecycle

```text
DISCOVER
  -> TRUST FILTER
  -> IMPORT ORIGINAL
  -> INDEX
  -> RANK
  -> FIRST REAL USE
  -> OPTIONAL RCCL ADAPT
  -> ORIGINAL vs ADAPTED COMPARISON
  -> STORE EVIDENCE
  -> SELECT PREFERRED VARIANT
```

An imported Market key is immutable with respect to its original source. Reusing the same key with
different source content is rejected. A new upstream source revision should be imported under a new
key.

## Original vs RCCL

RCCL is an experiment, not a doctrine.

The original Skill remains the control. Rakazo may store one adapted variant as:

- `rccl`
- `wrapped`
- `hybrid`

The preferred execution variant may be:

- `original`
- `rccl`
- `wrapped`
- `hybrid`

Comparison evidence can include task success, completeness, factual/tool errors, missed
requirements, verification success, retries, unnecessary actions, tool calls, latency/cost where
observable and reproducibility.

A strict `rccl` adaptation must pass the RCCL Skill Profile. Wrapped/hybrid adaptations remain
valid SKILL.md documents but are not forced into the full strict RCCL structure.

## Market Skills are not active Agent Skills

Market entries are stored separately from `AgentSkill`.

This is deliberate. Thousands of searchable Market candidates must not be injected into every
agent prompt.

Only `market/install` materializes one selected Skill variant into the ordinary Agent Skill
catalog.

The materialized copy gets provenance frontmatter:

- `rakazo-market-entry`
- `rakazo-market-key`
- `rakazo-market-repository`
- `rakazo-market-source-ref`
- `rakazo-market-source-digest`
- `rakazo-market-variant`

The Market original remains unchanged.

## Market Resolver

Resolver entries are JSON data, not executable instructions.

Example:

```json
{
  "semanticKey": "browser.semantic",
  "implementations": [
    {
      "name": "Playwright MCP",
      "kind": "mcp",
      "reference": "microsoft/playwright-mcp",
      "priority": 1,
      "constraints": ["must be installed and authorized"]
    },
    {
      "name": "Rakazo OpenCLI",
      "kind": "browser",
      "reference": "rakazo:opencli",
      "priority": 2,
      "constraints": ["requires linked Windows Host"]
    }
  ]
}
```

A resolver entry only describes known options and fallback order. It does not install the tool,
assign it to a Bot, grant access or bypass Capability Profile resolution.

The distinction remains:

```text
known in Market != installed != assigned != authorized != selected for this task
```

## Runtime Resolver selection

`market.resolve` produces a deterministic data-only candidate plan. A separate core adapter,
`selectMarketResolverReadOnlyImplementation`, converts that plan into a research-safe selection:

- it independently requires `readOnly = true`;
- it follows Resolver priority/name/reference ordering deterministically;
- a `market:` implementation or `skillReference` is eligible only when the plan carries one
  exact owned Market Skill entry id/key/source digest/preferred variant;
- missing or ambiguous Skill links are skipped explicitly rather than guessed;
- direct non-Market routes cannot smuggle unrelated Market Skill provenance;
- inconsistent `preferred` versus candidate order is treated as plan-integrity failure.

The selector does not install or invoke a Skill and grants no PAPER or live execution authority.
The Resolver seed must reference real Market Skill entries, not individual subcommands hidden inside a
broader write-capable Skill. For example, OKX `security token-scan` currently belongs to the
`okx-agentic-wallet` Skill, whose surface also includes signing and broadcasting. It is therefore
not exposed as a `market.risk` fallback until a separately bounded read-only Skill/wrapper exists;
the read-only Binance token-audit Skill remains the current token-risk route.

`market/select` exposes the same selector as a read-only RPC: it internally resolves the candidate
plan, applies the fail-closed selection rules and returns either one pinned research route or an
explicit `no_eligible_read_only_implementation` denial. For Trading, this selected/pinned provenance
is the object that should later be mapped into the research-only Trading Resolver envelope once the
Market and Trading lines share an integration base.

## RPC surface

Read:

- `market/search`
- `market/get`
- `market/resolve`
- `market/select`

Write:

- `market/import`
- `market/adapt`
- `market/evaluate`
- `market/install`

`market/import` requires curated GitHub provenance and a full 40-character commit SHA.

`market/adapt` never replaces `originalContent`.

`market/evaluate` records comparison evidence and the preferred variant.

`market/install` is the explicit boundary that creates an active Agent Skill.

## Initial trusted sources

The first source set intentionally favors official repositories:

- Anthropic Claude plugins: Skills.
- Chrome DevTools MCP: browser/debugging Skills plus resolver/MCP knowledge.
- OpenAI Cookbook: selected Skills only.
- GitHub MCP server: resolver/MCP knowledge.
- Microsoft Playwright MCP: resolver/MCP knowledge.
- Model Context Protocol reference servers: resolver/MCP knowledge.
- Rakazo itself: internal/native resolver knowledge.

Community collections can be considered later, but are not required to get useful coverage.

## Initial acceptance domains

The first population/evaluation wave covers:

1. GitHub development.
2. Scientific/research paper analysis.
3. Browser investigation.
4. Media capture/approval.
5. PAPER trading research.

Not every domain must come from an external Skill. Reuse trusted external material when it exists;
otherwise derive a Rakazo-owned Skill only after search fails.

## Deterministic population batches

`market/population-batches.v1.json` is the first concrete population manifest. It currently
contains 113 curated entries:

- 36 general first-party Skills;
- 55 trading/research Skills;
- 22 Rakazo-owned Resolver entries.

The two Skill batches use `market/importGithubBatch`. Each item still goes through the exact same
curated-repository, pinned-commit, safe-path, redirect and content-size checks as
`market/importGithub`; the batch RPC is only an orchestration convenience.

Resolver seeds use `market/importBatch` because each Resolver entry is a JSON fragment owned by
Rakazo rather than a complete upstream file. They remain data-only and grant no installation,
assignment or execution authority.

Both batch RPCs are idempotent at the individual Market key/provenance boundary. Re-running a batch
does not duplicate unchanged entries. Batch responses contain compact catalog entries only; Original
and adapted content remain retrievable only through an explicit `market/get`, so population does not
dump dozens of Skill bodies into the caller context. A changed upstream revision must still use a new
immutable Market key.

For the Trading Project, indexing a live-capable original remains allowed as reference knowledge.
It does not make the Skill active. Installation or execution still requires the normal Project
capability/permission boundary and, where applicable, a PAPER-only adaptation.

## Population strategy

Do not preload every source file.

For a trusted repository:

1. enumerate candidate SKILL.md or capability documentation;
2. rank against actual task families;
3. import only useful candidates;
4. keep source content pinned;
5. adapt on first real use;
6. retain measured evidence.

This keeps the Market broad without turning ingestion into an uncontrolled dependency installer.
