# Browser Automation v2 — Playwright + OpenCLI

Status: **active implementation plan**  
Date: **2026-10-06**  
Branch: `feature/browser-automation-v2-2026-10-06`

## Goal

Upgrade Rakazo's physical-Windows browser automation before starting broad Market
Original vs WRAPPED/RCCL/HYBRID evaluation.

Keep one control plane:

```text
ChatGPT
  -> Plugin R
  -> Rakazo
  -> physical Windows Host
       -> Playwright CLI (preferred semantic browser backend)
       -> OpenCLI (bounded fallback / alternate backend)
       -> screenshot + Windows GUI/UIA fallback
```

Playwright and OpenCLI are implementation backends. They must not become new public
orchestration layers beside Rakazo.

## Current Rakazo baseline

Already delivered and retained:

- explicit server-minted `computer/browser` session tokens;
- per-task browser session isolation;
- OpenCLI navigate/snapshot/act;
- bounded find/wait/extract;
- bounded scroll and temporary screenshot capture;
- owned tab create/select/close;
- best-effort owned-session recovery after Windows Host restart;
- screenshot/coordinate fallback;
- read-only foreground-window UI Automation observation;
- one existing physical Windows Host and one existing Plugin R tunnel.

The existing OpenCLI path remains supported. Browser v2 is not a rewrite.

## Why Playwright CLI, not a second public MCP server

Microsoft now ships `@playwright/cli` specifically for agent/browser workflows.
Its CLI surface is token-efficient and maps naturally to the existing
Windows Host child-process model.

The official Playwright documentation explicitly distinguishes CLI from MCP:
CLI is the lighter command-oriented surface, while MCP is useful when a client
wants a full long-lived MCP tool catalog. Rakazo already provides the external
MCP surface through Plugin R, so a second public Playwright MCP layer would add
schema/context and lifecycle duplication.

Primary upstream references:

- <https://playwright.dev/agent-cli/introduction>
- <https://playwright.dev/agent-cli/commands/attach>
- <https://playwright.dev/agent-cli/snapshots>
- <https://playwright.dev/agent-cli/capabilities>
- <https://playwright.dev/mcp/configuration/browser-extension>
- <https://developer.chrome.com/blog/remote-debugging-port>

## Browser modes

### 1. Extension attach — preferred for the user's real signed-in Chrome/Edge

Playwright can attach through the official Playwright browser extension.

Benefits:

- reuse existing authenticated sessions and cookies;
- reuse SSO and 2FA-completed sessions;
- interact with already-open tabs;
- preserve installed browser extensions;
- detach without closing the user's browser.

This is the preferred mode for explicit work in the user's normal browser.

Security requirements:

- the extension token is a credential and must use protected local storage;
- never store the extension token, cookies or storage-state files in Git;
- attach to a named/profile-selected browser only after explicit local
  configuration;
- Rakazo still mints its own task session token. The Playwright extension token
  must never become the public ChatGPT capability;
- an attached external browser must be detached, not globally closed;
- do not enumerate or mutate unrelated user tabs unless they are explicitly
  adopted under a Rakazo-owned session policy.

### 2. Dedicated persistent Playwright profile — preferred for autonomous Rakazo work

Playwright CLI supports persistent profiles. Use a Rakazo-owned profile directory
for autonomous workflows that should preserve login state without controlling the
user's primary browser.

Benefits:

- persistent login/cookies;
- predictable ownership;
- easier concurrency isolation;
- no dependency on the user's current Chrome window.

The profile directory is a credential-bearing local artifact and must stay outside
the repository.

### 3. Isolated/storage-state session — preferred for reproducible tasks

Use isolated sessions when persistence is not needed. A bounded storage-state file
may seed authentication for explicitly approved workflows.

Storage-state files contain credentials. They require the same protected handling
as secrets and must never be returned to the model or committed.

### 4. CDP/channel attach — explicit diagnostic/alternate path

Current Playwright supports attaching to a running Chrome/Edge channel after the
user enables remote debugging at `chrome://inspect/#remote-debugging`.

Do not make legacy command-line remote-debugging against the user's default Chrome
profile the default. Chrome 136+ deliberately ignores remote-debugging switches
for the default data directory unless a non-standard `--user-data-dir` is used.

## Capability comparison

| Capability | Existing OpenCLI | Playwright CLI target |
| --- | --- | --- |
| Accessibility snapshot/refs | yes | yes, richer first-class snapshot/ref workflow |
| Find in large page | bounded CSS/text path | snapshot `find`, regex, scoped/depth snapshots |
| Click/fill/type | yes | yes |
| Hover/select/check | limited/current contract | native |
| Tabs | owned create/select/close | native list/new/select/close, must be re-wrapped by Rakazo ownership |
| Existing signed-in browser | existing connected OpenCLI profile | official extension attach |
| Persistent dedicated profile | existing OpenCLI profile model | native persistent profile |
| CDP attach | not primary | native |
| Screenshots | bounded PNG | page/element screenshots |
| Coordinate mouse | desktop fallback | native browser-relative mouse plus desktop fallback |
| Console | not exposed | native |
| Network inspection | not exposed | native |
| Trace | not exposed | native Playwright trace |
| Storage/cookies | deliberately not exposed | available but sensitive; off by default |
| JS eval/run code | deliberately not exposed | available but high-risk; off by default |
| Recording/video | not exposed | available; later opt-in diagnostic capability |
| Token/schema cost | small CLI surface | small CLI surface; preferable to nested public MCP |

## Backend policy

Target backend selection:

```text
browser.semantic
  1. Playwright CLI
     a. extension attach when configured for explicit real-profile work
     b. Rakazo-owned persistent profile for autonomous work
     c. isolated session when requested
  2. OpenCLI fallback / alternate path
  3. screenshot + desktop input/UIA fallback
```

Do not silently switch from an owned Playwright session to an unrelated user tab.

Backend selection must be observable in result metadata and logs without exposing
credentials.

## P6a — backend abstraction and safe Playwright discovery

Implement first, without changing the live browser behavior:

1. introduce an internal Windows browser-backend interface;
2. preserve the current `WindowsOpenCliBackend` behind it without behavior change;
3. add Playwright CLI availability/config discovery;
4. pin an audited `@playwright/cli` version rather than runtime `npx @latest`;
5. reject wrong package identity/version and unsafe discovery paths;
6. unit-test the discovery and fail-closed behavior.

P6a must not select Playwright, auto-install it, or attach to the user's real
Chrome. OpenCLI remains the runtime backend throughout this slice.

## P6b — Playwright owned session parity

P6b introduces actual backend selection and observability:

- allow an explicit `auto | playwright | opencli` preference;
- prefer Playwright only after its owned-session implementation is usable;
- keep OpenCLI as fallback in `auto`;
- advertise browser capability when at least one backend is usable;
- expose bounded backend status diagnostics without secrets.

Then translate the existing Rakazo browser contract to Playwright:

Translate the existing Rakazo browser contract to Playwright:

- open;
- navigate;
- snapshot;
- find;
- wait;
- bounded extract;
- scroll;
- screenshot;
- act click/fill/type;
- owned tab new/select/close;
- close/detach;
- recovery behavior where upstream session state permits it.

Keep the existing Rakazo session token and ownership rules. Do not expose raw
Playwright session names as authority.

## P6c — explicit signed-in Chrome/Edge attach

Add a local configuration flow for Playwright Extension.

Acceptance:

- explicit user chooses Chrome/Edge/profile;
- protected extension token is stored locally, outside DB-visible/general logs;
- attach succeeds to an already signed-in harmless site;
- a Rakazo browser task can snapshot and interact through existing
  `computer/browser`;
- detach leaves the user's browser and unrelated tabs running;
- two task tokens cannot acquire each other's tab ownership;
- no cookie/storage dump is returned to ChatGPT.

Known upstream extension-mode issues have existed around profile discovery and tab
context after manual interaction. Treat extension attach as recoverable, verify
the selected page after manual handoff, and keep OpenCLI/desktop fallback until
physical acceptance is complete.

## P6d — richer safe browser commands

After parity, add narrowly typed capabilities:

Default-safe candidates:

- hover;
- select;
- check/uncheck;
- history back/forward/reload;
- scoped/depth snapshots;
- console errors;
- bounded network request metadata;
- page/element screenshot;
- browser-relative mouse for canvas/custom controls.

Separately gated sensitive capabilities:

- cookies;
- localStorage/sessionStorage;
- storage-state save/restore;
- JavaScript evaluate/run-code;
- request interception/mocking;
- unrestricted file upload/download;
- tracing/video artifacts containing potentially sensitive page data.

Default capability set must remain minimal.

## P6e — benchmark and resolver cutover

Run the same physical tasks through Playwright and OpenCLI and record:

- success/failure rate;
- median/p95 latency;
- child-process count;
- returned text size/token pressure;
- stale-ref recovery;
- tab isolation;
- manual-interaction recovery;
- session recovery after Windows Host restart;
- visual fallback rate.

Only after these results should the Market resolver prefer one backend for a
particular capability.

Do not remove OpenCLI merely because Playwright reaches parity.

## Acceptance gate before Market adaptation

Browser v2 is complete only when:

1. Playwright backend passes physical Windows tests;
2. real-profile extension attach works with explicit user opt-in;
3. dedicated persistent-profile mode works independently;
4. two concurrent Rakazo task tokens remain isolated;
5. detach/close never kills unrelated user tabs/browser processes;
6. protected browser credentials are absent from tool output, logs and Git;
7. OpenCLI fallback remains operational;
8. restart/recovery behavior is measured;
9. browser resolver routing has verified evidence;
10. the existing Plugin R tunnel and Windows Host architecture remain unchanged.

After this gate, resume the open task
`Rakazo — Market Original vs WRAPPED/RCCL/HYBRID evaluation`.
