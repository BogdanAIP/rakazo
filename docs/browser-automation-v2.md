# Browser Automation v2: Playwright + OpenCLI

Status: **active architecture / implementation plan**  
Date: **2026-10-06**

## Goal

Upgrade Rakazo browser automation before broad Market Skill adaptation.

Keep one public control plane:

```text
ChatGPT -> Plugin R -> Rakazo computer/browser -> Windows Host -> browser backend
```

Backend names are implementation details. OpenCLI remains available; Playwright is added as an internal backend and is evaluated for semantic browser work.

## Current Rakazo baseline

Already implemented and verified:

- server-minted `sessionToken` per browser task;
- bot-scoped browser sessions;
- task-owned tab identities;
- bounded navigation, snapshot, find, wait, extract, scroll and screenshot;
- bounded semantic actions using observation-local refs;
- session recovery after Windows Host restart;
- screenshot / coordinate fallback;
- read-only Windows UI Automation observation.

The current Windows Host is directly coupled to `WindowsOpenCliBackend`. Browser v2 first removes that coupling without changing the external browser contract.

## Upstream Playwright findings

Official Playwright MCP supports three useful state models:

1. **Persistent profile** (default): cookies, login state and local storage survive between sessions in a dedicated Playwright profile. A custom `--user-data-dir` is supported.
2. **Isolated context**: fresh state per session, optionally seeded with `--storage-state`.
3. **Browser Extension mode**: `--extension` connects to existing Chrome/Edge tabs and reuses the browser profile's authenticated sessions, cookies and installed extensions.

Extension mode can pin a Chrome profile with `--profile-dir-name`. The Playwright extension uses a profile-specific `PLAYWRIGHT_MCP_EXTENSION_TOKEN` to authenticate the MCP server to the extension.

As of the audit date, the latest official `microsoft/playwright-mcp` release is `v0.0.83`.
Runtime integration should pin a reviewed version rather than executing `npx @latest`.

Official references:

- https://playwright.dev/mcp/configuration/browser-extension
- https://playwright.dev/mcp/configuration/user-profile
- https://playwright.dev/mcp/capabilities
- https://playwright.dev/mcp/snapshots
- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright/tree/main/packages/extension

## Architecture decision

### External contract stays stable

Do **not** expose a second Playwright MCP control plane to ChatGPT.

Keep:

```text
computer/browser
  open
  recover
  navigate
  snapshot
  find
  wait
  extract
  scroll
  screenshot
  tabNew
  tabSelect
  tabClose
  act
  close
```

Playwright/OpenCLI translate those semantics internally.

### Backend priority target

Target steady state:

```text
browser.semantic
    |
    +-- Playwright extension backend
    |     existing user's Chrome/Edge
    |     explicit profile selection
    |     authenticated sessions / SSO / 2FA
    |
    +-- Playwright persistent backend
    |     dedicated Rakazo automation profile
    |
    +-- OpenCLI backend
    |     bounded fallback / alternate path
    |
    +-- screenshot + Windows GUI/UIA fallback
```

Backend selection must be policy/config driven and observable. It must never silently weaken browser ownership.

## Security invariants

- Never copy Chrome cookies, storage-state or extension tokens into Git.
- Treat Playwright storage state and extension tokens as credentials.
- Never derive browser authority from a guessed tab/profile name.
- Preserve server-minted Rakazo `sessionToken`.
- Preserve per-task owned-tab tracking.
- Existing user tabs may only be attached through an explicit Playwright extension/profile handoff.
- Do not expose raw arbitrary JavaScript evaluation. The current official Playwright MCP core includes `browser_evaluate` and `browser_run_code_unsafe`; Rakazo must call a reviewed allowlist rather than projecting the upstream tool catalog.
- Disable upstream WebMCP discovery by default (`--no-webmcp`). Page-registered tools are untrusted dynamic input and must not silently become Rakazo capabilities.
- Network interception, cookies/storage mutation, downloads/uploads, tracing and devtools-style capabilities must be separately gated.
- An unavailable Playwright backend must fail closed or use an explicitly configured fallback; it must not attach to an arbitrary browser profile.

## Why Playwright is useful in addition to OpenCLI

Playwright provides a richer semantic browser model:

- accessibility-based snapshots / refs with stale-ref detection;
- existing-browser extension mode;
- persistent and isolated profile models;
- authenticated state reuse;
- tabs/pages/frames;
- screenshots and trace tooling;
- console and network inspection;
- web-first waits/assertions;
- storage-state workflows.

OpenCLI remains useful because it is already integrated, small, bounded, and proven with Rakazo's ownership model.

The decision is therefore **Playwright + OpenCLI**, not Playwright replacing OpenCLI on day one.

## Implementation slices

### BV2-01 — backend abstraction (this PR)

- add internal `WindowsBrowserBackend`;
- make Windows Host runtime depend on the interface instead of `WindowsOpenCliBackend`;
- preserve current OpenCLI behavior exactly;
- no new Playwright dependency;
- no runtime/config change.

Acceptance: all existing Windows Host/OpenCLI tests and CI remain green.

### BV2-02 — Playwright capability probe and configuration

Add config-only discovery, no browser mutation:

- backend mode: `opencli | playwright-extension | playwright-persistent | auto`;
- detect a pinned, reviewed official Playwright runtime/package without `npx @latest` at execution time;
- profile directory name is explicit;
- extension token comes only from protected local secret/env storage;
- probe reports readiness without logging credentials.

Acceptance: OpenCLI remains default; Playwright cannot become active accidentally.

### BV2-03 — Playwright extension backend, read-only semantic path

Implement:

- `open`, `snapshot`, `find`, `wait`, `extract`, `screenshot`, `close`;
- explicit existing Chrome/Edge profile selection;
- map Playwright semantic references to Rakazo observation-local refs;
- preserve Rakazo session/token ownership.

No arbitrary script evaluation, storage mutation, network interception or downloads.

### BV2-04 — navigation, action and owned tabs

Add:

- `navigate`;
- bounded click/fill/type;
- `tabNew/tabSelect/tabClose`;
- stale-observation guards;
- uncertain-action handling and ownership revocation matching the OpenCLI path.

### BV2-05 — dedicated persistent Playwright profile

For autonomous Rakazo tasks that should not use the human profile:

- dedicated user-data-dir under Rakazo-controlled local state;
- one-writer profile lock handling;
- project/task isolation policy;
- optional explicit storage-state import/export with credential treatment.

### BV2-06 — backend routing and fallback

Measure and define routing:

- Playwright primary for semantic browser work;
- OpenCLI fallback/alternate;
- screenshot/UIA/coordinate fallback for visual/non-DOM surfaces;
- no automatic fallback after an uncertain mutation unless reconciliation proves safety.

### BV2-07 — physical Windows acceptance and benchmark

Run the same harmless tasks through both backends:

- authenticated existing-profile page;
- SSO/2FA-preserved page;
- form interaction;
- multi-tab isolation;
- browser restart/recovery;
- DOM-heavy app;
- canvas/non-semantic fallback.

Measure:

- success rate;
- median/p95 latency;
- process calls;
- response/context size;
- model-visible text volume;
- recovery behavior;
- ambiguous mutation rate.

Only after this acceptance should Browser v2 be considered complete.

## Relationship to Market adaptation

The separate task **Market Original vs WRAPPED/RCCL/HYBRID evaluation** remains open and deferred.

Browser/debug Skill adaptation should start only after BV2 acceptance so adaptation is driven by the final browser capability surface and real benchmark evidence.
