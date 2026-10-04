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

## Native Windows update controls (AIHOT-style UX)

Rakazo already has `DesktopUpdates.tsx` (packaged desktop) and `SoftwareUpdateSection.tsx` (updater-sidecar). The current native Windows installation does not configure the updater sidecar, so `updater/apply` MUST NOT be reused blindly. Extend the existing Settings/Updates UI with independent native controls:

1. **Check Rakazo updates (read-only):** show the current local HEAD and fetched remote HEAD, branch/source, changed files, dirty/untracked working tree, impact (app/DB/Host/R), current tunnel status, available backup and a dry-run compatibility report.
2. **Update native Rakazo (explicit confirmation):** protect dirty files; only fast-forward or explicitly reviewed merge, never reset/force-pull. Require verified backup before DB migration, test targeted changed packages, stage install/start under the original Windows controller, verify API/Web/Host heartbeat and same original tunnel. On failure show precise recovery/rollback instructions; never claim success from a completed shell command alone.
3. **Refresh Plugin R separately:** only if changed MCP adapter; verify the original alias/tunnel ID, actual process PID/start time and authenticated live health. Use a one-shot external launcher/scheduled job because the active R MCP cannot synchronously restart itself. Stop only the verified owned runtime, wait for fully stopped state, connect the SAME registered alias with existing protected credentials and MCP command, then verify new PID, health and exact tool catalog. Do not create a new tunnel, re-pair the Host or restart DB/API. Never expose keys, tokens or raw runtime JSON.
4. **UI status and cleanup:** show phases Check -> Ready -> Updating -> Verifying -> Success/Error; lock out duplicates and concurrent GUI ownership changes. Show unchanged/touched components and offer changelog. Remove the one-shot task/script after successful completion, preserving a redacted audit log. Explicitly indicate that already-open ChatGPT conversations may cache older tool schemas, so final acceptance includes a new-session discovery and actual bootstrap/discovery test.

The 2026-10-04 manual R refresh completed with `PASS_SAME_REGISTERED_TUNNEL_NEW_PROCESS`, task exit code 0, with original API and Windows Host healthy. One-shot scheduled task and script removed; the audit log remains. This is one observed manual run, NOT proof that the future UI exists yet.
