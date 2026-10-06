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

### Browser mode target

Target steady state:

```text
browser.semantic
    |
    +-- Playwright CLI extension mode
    |     existing user's Chrome/Edge
    |     existing tabs + authenticated sessions + SSO/2FA + installed extensions
    |     explicit browser-side approval
    |
    +-- Playwright CLI CDP mode
    |     existing user's Chrome/Edge
    |     browser-side Remote Debugging explicitly enabled
    |     direct DevTools-level attach to the current browser instance
    |
    +-- Playwright CLI persistent mode
    |     dedicated Rakazo automation profile
    |     long-lived autonomous login/session state
    |
    +-- OpenCLI
    |     proven structured alternate backend
    |
    +-- screenshot + Windows GUI/UIA
          visual/non-DOM fallback
```

All three Playwright modes are first-class. Rakazo must not hard-code one universal winner before physical acceptance and benchmark evidence.

Backend/mode selection must be policy/config driven and observable. It must never silently weaken browser ownership or reduce the user's available browser operations.

### Playwright mode selection matrix

| Mode | Use when | Strengths | Trade-offs |
| --- | --- | --- | --- |
| Extension | Work should happen in the user's ordinary signed-in Chrome/Edge and existing tabs/extensions matter | Reuses real browser state, SSO/2FA, cookies, installed extensions, explicit user handoff | Requires Playwright extension and browser confirmation/approval flow |
| CDP | Work should happen in the currently running real browser and DevTools-level attachment is acceptable | Direct attach to the current browser instance, no separate automation profile, easy detach without closing Chrome | Requires browser-side Remote Debugging to be explicitly enabled; grants powerful browser control while enabled |
| Persistent | Autonomous/repeatable work should not depend on the user's everyday browser session | Dedicated long-lived automation profile, deterministic state, suitable for bots/background workflows | Separate login/session state from the user's everyday Chrome; profile lifecycle/locking must be managed |

Mode choice is per task/session, not a permanent global decision. A project or bot may express a preferred mode, but the effective mode must remain visible and overridable.

Initial routing policy must be conservative:
- if the user explicitly selects a mode, use that mode if available;
- if a task explicitly requires the user's existing browser state, choose between Extension and CDP according to the requested interaction model and current readiness;
- if a task is autonomous/repeatable and does not require the user's daily browser state, prefer Persistent;
- if Playwright cannot satisfy the stable Rakazo browser contract for the selected task, keep or fall back to OpenCLI rather than silently reducing capability;
- automatic routing is accepted only after BV2-07 benchmark/acceptance data exists.

### No-regression capability policy

Browser v2 is additive. Existing Rakazo browser capabilities must not disappear merely because a new backend exists.

- OpenCLI remains the production/default backend until Playwright reaches the required operational parity.
- A partially implemented Playwright backend may exist in a draft branch or tests, but it must not become the active production backend.
- Playwright activation requires, at minimum, working `navigate`, `snapshot`, `find`, `wait`, `extract`, `scroll`, `screenshot`, `tabNew`, `tabSelect`, `tabClose`, `act`, `recover` and `close/detach` semantics compatible with the stable `computer/browser` contract.
- If an upstream Playwright feature is intentionally not exposed (for example raw `eval`), the omission must be recorded in the capability matrix with the reason. It must never be silently omitted.
- Backend-specific capabilities beyond the common contract (console, network, tracing, storage, downloads, etc.) must be tracked explicitly as available / gated / unsupported.
- A backend may not be selected automatically if doing so would reduce capabilities relative to the currently active backend.


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

### BV2-03 — Playwright CLI backend implementation (draft-only until parity)

Implement the bounded runner and read/observe path without activating it as the production backend:

- server-minted Rakazo token maps to a generated Playwright CLI named session;
- implement all three first-class modes: Extension, CDP and Persistent;
- implement `snapshot`, `find`, bounded text extraction, screenshot and correct `detach/close`;
- map Playwright semantic references to Rakazo observation-local refs;
- preserve Rakazo session/token ownership and do not expose raw session enumeration.

This implementation remains draft/non-activated until BV2-04 completes required operational parity.

### BV2-04 — navigation, actions, owned tabs and parity gate

Add:

- `navigate`;
- `scroll`;
- bounded click/fill/type and the existing `act` semantics;
- `tabNew/tabSelect/tabClose`;
- stale-observation guards;
- uncertain-action handling and ownership revocation matching the OpenCLI path;
- capability-matrix tests proving that selecting Playwright does not silently reduce the stable browser contract.

Only after this gate may Playwright become selectable as a production backend.

Raw `eval`, `run-code`, WebMCP, unrestricted storage mutation, network routing or arbitrary downloads/uploads are not part of the stable Rakazo browser contract. Any future exposure is an explicit separately gated capability, not a hidden removal.


### BV2-05 — mode-complete profile/session lifecycle

Complete lifecycle handling for all three Playwright modes:

- Extension: browser approval/handoff lifecycle and reconnect semantics;
- CDP: browser-side Remote Debugging readiness/probe and safe detach semantics;
- Persistent: dedicated user-data-dir under Rakazo-controlled local state, one-writer profile lock handling and project/task isolation policy;
- optional explicit storage-state import/export with credential treatment;
- expose the effective mode in status/diagnostics so it is never hidden from the user/operator.

### BV2-06 — mode/backend routing and fallback

Measure and define routing across Extension, CDP, Persistent, OpenCLI and visual fallback:

- choose Playwright mode per task/session instead of globally;
- allow explicit user/project/bot preference without making it irreversible;
- keep OpenCLI as an alternate/fallback backend;
- use screenshot/UIA/coordinate fallback for visual/non-DOM surfaces;
- no automatic fallback after an uncertain mutation unless reconciliation proves safety;
- surface the selected mode/backend in diagnostics and task evidence.

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
