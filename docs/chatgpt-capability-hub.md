# Rakazo Capability Hub — rollout (2026-10-04)

## Intent
Normal ChatGPT is the reasoning layer; Plugin R is the authenticated gateway; one Rakazo is the local execution/state layer. Do not add a second runtime, tunnel, Windows Host, model dependency, job queue or memory database.

## Verified live bootstrap seed
Bot anchor: `cmurgadpg000038dqw9fq7zcg`. Existing bot Memory was filled (revision 2), eleven user Agent Skills were created, and an open Scratchpad task `R-CAPABILITY-HUB-20261004` records the rollout. Cross-chat Scratchpad test from 2026-10-04 remains done.

The eleven skills: R-Bootstrap, R-Handoff, R-Memory, R-Skill-Discovery, R-Capability-Discovery, R-Skill-Installer, R-Tool-Selector, R-Workflow-Builder, R-Computer, R-Browser, R-Verification. These are saved SKILL.md records, not automatically injected into ordinary ChatGPT conversations.

## Shared context read path
New helper `packages/adapters/src/chatgpt-context.ts` uses the existing appContract to assemble bounded bot Memory, open Scratchpad items, Agent Skill metadata, active Runs, Routines and installed capabilities. It rejects ambiguous bot selection. It does NOT call an LLM or change anything. A second helper searches installed and optionally public capability catalog without installation.

**Deployment gate:** the existing MCP entrypoint `chatgpt-mcp.ts` has not yet registered these helpers. A write to that file was blocked by the execution environment. Do not claim `rakazo_context_bootstrap` or `rakazo_capability_search` are live until registration, targeted tests, deployment of the SAME borrowed MCP process, and fresh tool-catalog inspection are done.

Proposed registrations:
- `rakazo_context_bootstrap({botId?: string})` -> `loadChatGptContext(callRakazoRpc, botId)`;
- `rakazo_capability_search({query: string, includePublic?: boolean})` -> `searchChatGptCapabilities(callRakazoRpc, query, includePublic)`.
Use read-only MCP annotations and existing `textResult`. If multiple bots are visible, require explicit botId.
Checkpoint is currently via `scratchpad/create/update` and readback. Do not pretend to have atomic update: current `memory/update` and `scratchpad/update` have no expected-revision write guard. Add CAS or append-only idempotent receipts before automatic concurrent writers.

## Catalog policy
The built-in public `capabilities/catalogSearch({query,usePublicCatalog:true})` returns results from integrations.sh; its private catalog reports disabled at baseline. External directories can be indexed as references, not blanket-installed: Agent Skills, skills.sh, official MCP Registry, official vendor integrations and selected audited GitHub repositories. Preserve provenance, license, version/digest, dependency audit, auth and permissions. Search/load on demand via Rakazo's already existing lazy tool catalog (`DIRECT_TOOL_LIMIT=20`); do not preload huge tool schemas into model context.

Installed MCP/API/GraphQL connectors are currently dispatched in Rakazo's internal agent adapter; that dispatch is NOT automatically reachable from ordinary ChatGPT via generic R appContract. A future direct R execution bridge must reuse connector authorization, route resolution and approval enforcement instead of exposing arbitrary remote HTTP calls.

## Acceptance
1. Cold new ChatGPT conversation reads Memory and open Scratchpad without previous chat context.
2. Relevant Agent Skills are selectable via ID and loaded only on demand.
3. Two conversations exchange a checkpoint through shared Rakazo state without duplicating records or overwriting unrelated work.
4. Capability search clearly distinguishes discovered from installed/authorized and does not execute on search.
5. Physical Host/tunnel remain unchanged; tests classify pass/fail/not-run, and existing same-tunnel restart is separately coordinated.
