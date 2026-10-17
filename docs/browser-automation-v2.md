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

The current official Playwright project now provides both **Playwright CLI** and **Playwright MCP**.

For Rakazo, the primary Browser v2 candidate is **Playwright CLI** because it matches the existing
OpenCLI architecture: concise commands, named sessions, snapshots/refs, explicit attach/detach,
persistent profiles and low model-context overhead. Microsoft explicitly positions the CLI as the
more token-efficient agent workflow, while MCP is aimed at richer persistent agentic loops.

Playwright CLI supports:

1. **Named sessions** via `-s=<name>`, allowing Rakazo to map one server-minted browser task to one
   backend session without sharing state accidentally.
2. **Browser Extension attach** via `attach --extension=chrome`, reusing the user's existing
   Chrome/Edge browser state and logged-in pages.
3. **CDP attach** via `attach --cdp=chrome|msedge|<endpoint>`, with explicit browser-side remote
   debugging opt-in.
4. **Persistent profiles** via `open --persistent` or `open --profile=<path>`.
5. **Accessibility snapshots and refs**, `find`, screenshots, tabs, console/network inspection,
   tracing/video and a visual session dashboard.
6. **Detach** semantics that leave an externally owned browser running.

As of the audit date, the latest official `microsoft/playwright-cli` release is `v0.1.22`
(`@playwright/cli@0.1.22`, Apache-2.0). The latest official Playwright MCP release is
`v0.0.83`. Runtime integration should pin reviewed versions rather than executing
`npm install @latest` or `npx @latest` during a task.

Playwright MCP remains a possible optional future backend for workflows that materially benefit
from its richer persistent MCP loop, but it is no longer the primary Browser v2 path.

Official references:

- https://playwright.dev/agent-cli/intro
- https://github.com/microsoft/playwright-cli
- https://github.com/microsoft/playwright
- https://playwright.dev/mcp/configuration/browser-extension
- https://github.com/microsoft/playwright-mcp

## Architecture decision

### External contract stays stable

Do **not** expose Playwright CLI or Playwright MCP as a second public control plane to ChatGPT.

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
    +-- Playwright CLI existing-browser backend
    |     CDP attach when browser-side Remote Debugging is explicitly enabled
    |     extension attach + browser confirmation as alternate path
    |     authenticated sessions / SSO / 2FA
    |
    +-- Playwright CLI persistent backend
    |     dedicated Rakazo automation profile
    |
    +-- OpenCLI backend
    |     bounded fallback / alternate path
    |
    +-- screenshot + Windows GUI/UIA fallback
```

Backend selection must be policy/config driven and observable. It must never silently weaken browser ownership.

## Security invariants

- Never copy Chrome cookies or storage-state into Git.
- Treat Playwright storage state as a credential.
- Never derive browser authority from a guessed tab/profile name.
- Preserve server-minted Rakazo `sessionToken`.
- Preserve per-task owned-tab tracking.
- Existing user tabs may only be attached through an explicit Playwright extension/CDP handoff.
- Never expose `eval`, `run-code`, raw WebMCP calls, cookie/storage mutation or unrestricted file upload merely because upstream CLI supports them. Rakazo must translate only a reviewed allowlist into its stable browser contract.
- Disable WebMCP collection by default (`webmcp: false` / `PLAYWRIGHT_MCP_WEBMCP=false`). Page-registered tools are untrusted dynamic input and must not silently become Rakazo capabilities.
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

### BV2-02 — Playwright CLI capability probe and configuration

Add config-only discovery, no browser mutation:

- backend mode: `opencli | playwright-cli-cdp | playwright-cli-extension | playwright-cli-persistent | auto`;
- detect a pinned, reviewed `@playwright/cli` entry without downloading `@latest` at execution time;
- CDP and extension attach both require an explicit browser channel;
- CDP attach requires the owner to enable the browser's own Remote Debugging control (for Chrome, `chrome://inspect/#remote-debugging`);
- extension attach is an alternate path authorized through Playwright's browser confirmation page; Rakazo does not invent or persist a second extension token;
- dedicated persistent profile path is explicit;
- probe reports readiness without reading cookies/storage.

Acceptance: OpenCLI remains default; Playwright CLI cannot become active accidentally.

### BV2-03 — Playwright CLI existing-browser backend, read-only semantic path

Implement a bounded CLI runner:

- server-minted Rakazo token maps to a generated Playwright CLI named session;
- prefer `attach --cdp=chrome` when the owner explicitly enabled browser Remote Debugging;
- allow `attach --extension=chrome` as an alternate browser-confirmed handoff;
- `snapshot`, `find`, bounded text extraction, screenshot and `detach`;
- map Playwright semantic references to Rakazo observation-local refs;
- preserve Rakazo session/token ownership and do not expose raw session enumeration.

No `eval`, `run-code`, storage mutation, network routing, WebMCP or downloads.

### BV2-04 — navigation, action and owned tabs

Add:

- `navigate`;
- bounded click/fill/type;
- `tabNew/tabSelect/tabClose`;
- stale-observation guards;
- uncertain-action handling and ownership revocation matching the OpenCLI path.

### BV2-05 — dedicated persistent Playwright CLI profile

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
