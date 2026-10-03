# Rakazo Trading P0 audit and first P1 slice

Recorded: 2026-10-03. Scope: documentation plus code on the isolated trading branch. **Not deployed**, no machine access, no wallet, no account, no private API, no live execution.

## Existing Rakazo integration points reviewed

| Existing owner | Concrete code | Trading integration decision |
| --- | --- | --- |
| Shared validation | packages/contracts/src/index.ts, rpc.ts, domain.ts | New trading.ts contains common market, ticker and proposal schemas; add read-only trading/list in appContract so Plugin R discovers it without another MCP server |
| Read-authority gateway | apps/api/src/router.ts (authed middleware) | Public scanner is an authenticated handler; no account access; network GET only on explicit invocation |
| MCP interface | packages/adapters/src/chatgpt-rakazo.ts, chatgpt-mcp.ts | trading/list is classified as read by the existing READ_ACTIONS set; no new exposed executor |
| Deterministic domain logic | packages/core/src/index.ts | scanTradingMarkets is pure and returns shortlist/exclusion reasons, NOT buy/sell instructions |
| Venue adapter | packages/adapters/src/index.ts | First keyless BingX spot snapshot with injectable fetch, bounded response, strict error and data validation |
| Background work | packages/adapter-kit/src/background-jobs.ts, packages/adapters/src/background-job-handlers.ts, apps/worker/src/index.ts | No recurring trading jobs yet; add only after explicit ownership, idempotency and recovery design |
| Durable storage | packages/db/prisma/schema.prisma, packages/adapters/src/job-reconciler.ts | No trading schema/migration yet; journal, account states and execution intent require separate ADR and tests |
| Risk / approvals | existing Rakazo permissions, approval and execution primitives | These are NOT assumed sufficient for money movement; separate deterministic risk gateway and explicit live/wallet authorization required |

## Read-only prototype delivered in this branch

- Public BingX spot symbol catalog: GET /openApi/spot/v1/common/symbols.
- Public BingX 24-hour ticker catalog: GET /openApi/spot/v1/ticker/24hr.
- No API keys, signature, user-supplied URL or order endpoints. No automatic network calls during module import.
- Market universe is dynamic, including altcoins; inactive/missing/stale/wide-spread/low-volume observations get explicit exclusion reasons.
- Public RPC: trading/list. Default quote allowlist USDT, minimum quote volume and maximum spread/age are **configurable prefilter assumptions**, not recommended live risk thresholds.
- An empty shortlist is allowed and must not be interpreted as a trading signal. Market-selection metrics do not predict returns.
- Schemas include spot, dated/perpetual futures and research-only proposal/NO_TRADE, but there is **no functioning futures adapter, strategy generator, order route, live enablement, funding or wallet signer**.
- Tests use recorded synthetic fixtures/mocked transport; tests cannot call a real exchange or user device.

## Endpoint source and open questions

BingX official public spot specification: https://github.com/BingX-API/api-ai-skills/blob/main/skills/spot-market/api-reference.md . Spot documentation identifies symbol catalog and all-market 24hr ticker, whereas the swaps documentation describes a different signed request boundary; do not extend spot GET assumptions to futures. Reconfirm API terms, limits, schema and user region/product eligibility before deployment.

The first probe will not be treated as successful until PR CI verifies TypeScript and Vitest; the real BingX public API is not verified from the user's runtime here. Follow-up work should separately add a second read-only venue, optional bounded cache/rate limiter, proper source timestamp telemetry and one approved futures data path (public feed or explicitly credentialed read-only connection with consent).

## P1 acceptance still outstanding

- Offline tests + TypeScript/lint pass in CI.
- After merging and explicitly deploying the updated Rakazo, use normal Plugin R procedure discovery; verify trading/list returns an authenticated read-only response or an explicit API failure, and never an invented signal.
- Live public data checked for currency and schema without user account or trade authority; verify API reachability and rate limits for actual installed network.
- The code is **not** a continuously running market scanner. No Worker schedule has been registered.
