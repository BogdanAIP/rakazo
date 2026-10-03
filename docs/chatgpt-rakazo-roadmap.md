# ChatGPT + Rakazo roadmap

Status: **authoritative architecture and migration plan**  
Last updated: **2026-10-01**  
Primary working branch: `feature/chatgpt-mcp-upstream-2026-09-29`

**Physical-pilot evidence (2026-10-01):** [Windows Host capability audit and blocker log](./windows-host-capability-audit-2026-10-01.md). Earlier sections below are historical and may describe an earlier migration state; use the live consolidated-state decision here instead. The native Windows fd/HANDLE bridge and file containment smoke passed on the physical Windows laptop; full Windows Host tests passed **28/28**. The original Plugin R tunnel now uses the MCP from the new checkout, its `health` and `windowsHosts/list` pass, one physical Windows Host is paired and sends fresh heartbeat. User physically verified the internal API dispatched `identity.get` to the correct installation and `process.list` returned five processes. This is successful native read-only dispatch, **not yet proof of bot-linked commands through R**. An attempted new read-only test bot returned a server error and `bots/list` confirmed it was not created; preserve the original ChatGPT Compute anchor, which still reports an existing Docker computer.

### One Rakazo application, manually launched (corrected decision, 2026-10-01)

**The user explicitly does NOT want Rakazo to start automatically with Windows.** One desktop/Start Menu shortcut manually starts one native Rakazo application, which in turn starts/reuses native API, Worker, Web, the SAME existing Plugin R tunnel alias/ID, and the SAME already paired Windows Host using its protected stored credential. One original-style tray icon shows state and offers explicit Quit. Repeated clicks focus the existing instance, never duplicate API/Worker/tunnel/Host. Closing/Quit gracefully stops only owned Rakazo app/tunnel/Host processes; never blanket-kill other tunnel aliases, other apps, shared Docker or databases. While Rakazo is open it may supervise/restart its owned components; after Windows logout/reboot it must remain off until the user clicks Rakazo again.

**Prohibited:** a new Rakazo Scheduled Task, Run registry entry, Startup-folder shortcut, boot service or automatic start after sign-in. Desktop and Start Menu shortcuts are welcome, but not Startup shortcuts. Existing PostgreSQL container/engine is a dependency, not a second Rakazo runtime: detect/reuse it and if needed offer or perform only narrowly scoped startup; do not run the old Rakazo Docker stack or `compose down -v`. User's latest read-only inspection found no Scheduled Tasks with a `Rakazo|Tunnel` name and no matching *user* Startup-folder items; Registry Run, all-users Startup and indirectly named tasks remain to inspect before cutover.

**Implementation checkpoint (2026-10-01):** `scripts/windows/manual-rakazo/` now includes one manual controller, guarded existing-alias lifecycle helper, authenticated read-only diagnostics, native child process ownership, existing PostgreSQL-only startup, static parser gate, and an opt-in desktop shortcut. Nothing is installed or physically cut over yet; the user's working V4 tray and manual foreground services remain active. The most recent authenticated status confirms the exact existing tunnel is remotely ready/healthy with a live local health endpoint, but it reports no verified managed PID, so the new app must not automatically take it over. A cold launch is allowed only after the user deliberately stops the old runtime and foreground services, closes the old tray, and the read-only Preflight establishes both matching alias and completely inactive old runtime. Targeted Stop is permitted only when the controller itself started R and verified its process identity. First run the Windows `Validate.ps1` and read-only Preflight from the updated branch, then arrange one explicitly supervised handoff and test start, second click, tray Quit and restart. Never register a boot or logon task.

Manual lifecycle: launch -> reuse/start one PostgreSQL dependency where needed -> start/reuse new native API+Worker+Web -> resume the same R tunnel with its new-checkout MCP -> start the same paired Windows Host (process/GUI/file-write remain disabled until separately approved) -> verify R health/catalog and fresh host heartbeat -> show one truthful colour/status tray. Quit stops only owned app processes; old launcher remains rollback until new click-to-run controls are proven. Test first launch, repeated click, clean quit, partial failure, and manual restart, without affecting other tunnels or original database.


The user requested **one new Rakazo, no parallel old/new installations**. Canonical source is ``%USERPROFILE%\rakazo-upstream-integration`` (branch `feature/chatgpt-mcp-upstream-2026-09-29`); existing Plugin R alias and Tunnel ID, DPAPI tunnel state, existing paired physical Windows Host and its protected credential are preserved. Native Rakazo API/Worker/Web are the intended application stack. Continue using only the current PostgreSQL container and cloned database `rakazo_next` until a separate, verified DB transition; retain the original `rakazo` database as rollback, do not delete or reset. Docker for PostgreSQL is not a second Rakazo execution runtime.

The former `Desktop\\Rakazo Tunnel` V4 tray/config still controls the **same** existing tunnel but its `Repo` points to the original checkout and its obsolete Docker-stack health indicator may show yellow or engine-stopped despite healthy new API/Host. It is **transitional compatibility plumbing only**, not an independent application installation. Do not delete it or interfere with its running process while it owns the working tunnel; do not introduce any automatic startup. Move its tunnel/tray management to one native-stack-aware controller in the canonical checkout, preserving the existing tunnel alias/ID and registered MCP command, then retire the old launcher after independent verification of one-click manual startup, avoiding deletion of its secrets or the registered existing tunnel. Do not overwrite unrelated `apps/desktop/src/docker-cli.ts` local change or indiscriminately kill `tunnel-client.exe` processes (other aliases exist).

Target steady state: `ChatGPT -> existing Plugin R / existing OpenAI tunnel -> new checkout MCP -> native API + Worker + Web -> one physical Windows Host`, and `PostgreSQL (rakazo_next)`. Only one set of manual start/stop/status controls, with no Rakazo autostart. No second tunnel, no second Windows Host or re-pairing, no second Rakazo server. **Do not force tray green** by starting old Docker containers. Temporary manual foreground Host must eventually be supervised only while the manually launched Rakazo application is open, using its existing stored credential; process, GUI and file-write capabilities stay disabled until individually approved and verified. Implement/check the new manual one-click controller (not a Scheduled Task or boot service), prove start/quit/start and reconnect, verify actual physical bot routing, then retire old launcher; do not reverse this order.

This document defines the intended architecture for the ChatGPT integration in this fork of Rakazo. It supersedes ad-hoc plans that treat CAP, OpenResearch, Codex, OpenCLI, UFO, or a second agent runtime as the center of the system.

The project goal is:

```text
ChatGPT Plus
    |
    | Plugin R
    v
Rakazo
    |
    +--> isolated Rakazo computers when useful
    |
    +--> physical Windows host
```

ChatGPT is the reasoning layer. Rakazo is the durable execution/control layer. The normal path must not require Codex, Work, CAP, OpenResearch, or another LLM. Ordinary Chat is the default reasoning surface; Work remains an optional escalation surface for long or strongly agentic tasks, never an infrastructure dependency or silent fallback.

Ordinary ChatGPT chat is the default reasoning surface. Work remains an optional escalation for long or strongly agentic tasks, and Codex remains an optional specialized coding escalation; neither is infrastructure and neither may be a silent fallback.

---

## 1. Why this roadmap exists

The original integration work proved that a normal ChatGPT conversation can use Rakazo directly through an OpenAI Secure MCP Tunnel. Since then, OpenAI has expanded the plugin platform substantially:

- plugins can contain skills, MCP servers, and optional UI;
- MCP Apps UI can render interactive components inside ChatGPT;
- Plugin Extensions can place an app in the sidebar, next to a conversation, or in supported file-viewer surfaces;
- UI can call MCP tools directly through the MCP Apps bridge instead of routing every button press through a model decision;
- MCP Events lets ChatGPT subscribe to server-side events and receive signed webhook callbacks asynchronously;
- ChatGPT and Codex now share a universal plugin directory;
- Codex/Work remain useful, but on Plus they can share the plan's agentic usage allowance, so they must not be the required execution path for ordinary local work.

Official OpenAI references, snapshot 2026-09-30:

- DevDay 2026 recap: <https://openai.com/ru-RU/index/devday-2026-recap/>
- Plugin architecture: <https://developers.openai.com/plugins/concepts/plugins>
- MCP Apps / ChatGPT UI: <https://developers.openai.com/plugins/build/chatgpt-ui>
- Plugin reference: <https://developers.openai.com/plugins/reference>
- MCP Events: <https://developers.openai.com/plugins/build/mcp-events>
- Codex/Work allowance guidance: <https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex>
- Codex plan usage: <https://help.openai.com/ru-ru/articles/11369540-using-codex-with-your-chatgpt-plan>

The architectural consequence is important: **Plugin R should evolve from a tool-only bridge into Rakazo's native ChatGPT surface, while Rakazo itself becomes the only local runtime.**

---

## 2. Non-negotiable architecture

### 2.1 ChatGPT is the brain

Reasoning, interpretation of the user's goal, planning, visual reasoning, code review, and decisions belong in ChatGPT.

Rakazo must not require its own LLM to interpret ordinary ChatGPT work.

Normal loop:

```text
user
  -> ChatGPT reasons
  -> Plugin R calls Rakazo
  -> Rakazo executes/stores/waits
  -> result/event returns
  -> ChatGPT reasons only when reasoning is needed
```

### 2.2 Rakazo is the one local control plane

Rakazo owns:

- durable state;
- computers and host capabilities;
- execution and process lifecycle;
- files;
- browser/desktop operations;
- jobs/runs;
- approvals;
- permissions and leases;
- reconnect/recovery;
- event history;
- plugin-facing schemas.

Do not build a second local control plane beside it.

### 2.3 CAP is frozen

CAP is not part of the target architecture. Do not port CAP into Rakazo and do not continue CAP as a parallel execution layer unless a specific capability gap is first demonstrated and cannot reasonably live in Rakazo.

### 2.4 OpenResearch is transitional

OpenResearch currently remains useful as a proven bridge to the physical Windows host. It is not the target runtime.

The final physical-host path is:

```text
ChatGPT -> R -> Rakazo -> Rakazo Windows host runtime -> Windows
```

not:

```text
ChatGPT -> R -> Rakazo -> OpenResearch -> Windows
```

### 2.5 Work/Codex are escalation surfaces, not infrastructure

The project exists partly because Plus users can exhaust Codex/Work agentic allowance quickly.

Default:

```text
ChatGPT -> R -> Rakazo -> local compute
```

Use Work or Codex only when their agentic execution model is materially valuable. Work is appropriate for long multi-step ChatGPT tasks; Codex is appropriate when its specialized coding harness or cloud execution is materially valuable, for example:

- a very large repository-wide refactor;
- a long autonomous coding task whose value justifies agentic allowance;
- work that must continue in OpenAI cloud while the local computer is unavailable.

Do not consume Codex merely to run tests, wait for processes, read files, poll status, drive a browser, or execute deterministic commands that Rakazo can perform locally.

### 2.6 Do not depend on Dots

Dots may later become a higher-level orchestration surface, but they are not required for this project and are not currently the Plus baseline.

If Dots become available, the intended integration is simply:

```text
Dot
  -> Plugin R
  -> Rakazo
```

No Rakazo redesign should be required.

---

## 3. Current verified state

### 3.1 Direct ChatGPT -> Rakazo bridge exists

The current integration is implemented in:

- `packages/adapters/src/chatgpt-mcp.ts`
- `packages/adapters/src/chatgpt-rakazo.ts`
- `apps/web/src/pages/ChatGptSessionBridge.tsx`
- `apps/web/src/lib/chatgpt-session-handoff.ts`
- `docs/chatgpt-mcp.md`

The MCP layer discovers procedures from Rakazo's live `appContract` rather than maintaining a duplicate API.

Current high-level tools:

- `rakazo_procedures`
- `rakazo_describe`
- `rakazo_read`
- `rakazo_write`
- `rakazo_destructive`
- `rakazo_thread_events`
- `rakazo_computer_observe`
- `rakazo_computer_act`

The live deployment exposes well over 150 Rakazo procedures through that projection.

### 3.2 Access classes fail closed

Procedures are classified as read/write/destructive/stream. Unknown future mutation verbs default to the destructive class.

Keep this property.

### 3.3 Direct computer loop already exists

`rakazo_computer_observe` returns actual MCP image content. `rakazo_computer_act` batches up to 24 actions and drives the existing Rakazo control-lease path.

It deliberately does not invoke a Rakazo model.

### 3.4 Session handoff is already bounded

The current browser-assisted handoff sends the authenticated Rakazo session to a one-shot loopback callback; it does not place the token in a URL.

Longer-term hardening should replace a full session bearer with a narrower short-lived delegated capability, but the current mechanism is functional.

### 3.5 Current physical Windows path still uses OpenResearch

The live deployment currently has an `OpenResearch Windows` MCP server assigned to the ChatGPT Compute bot.

Therefore physical Windows remains:

```text
ChatGPT -> R -> Rakazo -> OpenResearch Windows MCP -> Windows
```

That dependency is the main execution-layer migration still outstanding.

### 3.6 Rakazo already contains native-host building blocks

Upstream Rakazo already includes a `DesktopSandboxProvider`, host-aware routing, Windows path-containment helpers, native process execution, file access, process-tree termination, snapshots, and the shared `SandboxProvider` contract.

However the existing desktop provider is not yet a full physical-Windows graphical backend:

- `graphical: false`;
- `takeover: false`;
- observation is placeholder-only;
- input is placeholder-only.

Also, the deployed API/worker run inside Linux containers. Merely selecting `desktop` there does not make execution native to Windows.

### 3.7 Direct browser/GUI prototypes are evidence, not final architecture

Previous local experiments with OpenCLI and Microsoft UFO are valuable for capability discovery. They are implementation candidates behind Rakazo, not new public control planes.

### 3.8 Microsoft UFO execution layer is now physically verified

On 2026-09-30 the UFO GUI path was re-verified on the physical Windows host without using UFO's HostAgent/AppAgent LLM hierarchy.

A temporary external FastMCP gateway mounted only these existing UFO execution components:

- `UICollector`;
- `HostUIExecutor`;
- `AppUIExecutor`.

The proof used no UFO LLM, planner, model API key, memory agent, or independent task loop.

Verified over real Streamable HTTP MCP:

- enumerate live Windows desktop windows;
- capture a real all-screen PNG screenshot;
- focus a selected application window;
- enumerate UI Automation controls;
- drive a disposable Notepad file semantically through the editor control;
- send keyboard input including `Ctrl+S`;
- independently verify the saved file content.

The Notepad proof returned 54 UIA controls and persisted the exact test value `UFO_CHATGPT_WEB_OK`.

A real limitation was also observed: the modern Windows Settings `ApplicationFrameWindow` could be discovered and focused, but its control enumeration returned an empty list. The final GUI backend therefore needs a deterministic fallback from semantic UIA actions to screenshot/vision plus bounded coordinate input when UIA is unavailable.

This gateway is proof evidence only. It is not the final host transport, is not a second control plane, and has not replaced OpenResearch in the live deployment. The final implementation must put the UFO execution layer behind Rakazo's existing computer semantics and Rakazo-owned host authority.

---

## 4. Target architecture

```text
+------------------------------------------------------+
| ChatGPT                                              |
|                                                      |
| normal Chat       future Dot (optional)              |
| reasoning         long-lived orchestration           |
+--------------------------+---------------------------+
                           |
                           | Plugin R
                           v
+------------------------------------------------------+
| Rakazo Plugin surface                               |
|                                                      |
| MCP tools | MCP Apps UI | Plugin Extension | Events |
+--------------------------+---------------------------+
                           |
                           | appContract / oRPC
                           v
+------------------------------------------------------+
| Rakazo core                                          |
|                                                      |
| auth | permissions | jobs | events | artifacts       |
| computer leases | browser | files | process lifecycle|
+---------------+----------------------+---------------+
                |                      |
                |                      |
                v                      v
       isolated computers      physical Windows host
       Docker/E2B/etc.          Rakazo-owned node
                                       |
                         +-------------+-------------+
                         |             |             |
                         v             v             v
                      process        browser       desktop
                      + files        backend       backend
```

Implementation details such as OpenCLI, CDP, Playwright, UIA, or selected UFO components remain behind the Rakazo contract.

ChatGPT should see Rakazo semantics, not backend names.

---

## 5. Track A — make physical Windows a first-class Rakazo host

### A0. Preserve the current working bridge while replacing it

Do not remove OpenResearch first.

Keep it as the known-good fallback until direct Rakazo Windows capabilities pass acceptance tests.

Record the current baseline:

- Windows identity;
- commands known to work;
- file operations known to work;
- browser operations known to work;
- failure/reconnect behavior;
- current OpenResearch assignment and endpoint.

### A1. Add a native Rakazo Windows host runtime

Add a small native Windows process owned by this repository.

Suggested project location:

```text
apps/windows-host/
```

or, if it is mostly reusable runtime code:

```text
packages/windows-host/
```

Responsibilities:

- pair with one Rakazo deployment;
- authenticate as a host, not as a human session;
- maintain heartbeat/reconnect;
- advertise capabilities;
- execute bounded host operations;
- stream process output;
- provide screen/browser primitives when enabled;
- persist only the minimum local host identity required for reconnect.

It must contain **no LLM, planner, memory agent, or independent task loop**.

### A2. Use an outbound authenticated connection

Target transport:

```text
Windows host runtime
       |
       | outbound authenticated connection
       v
Rakazo API
```

Prefer WebSocket or another long-lived Rakazo-owned transport.

Do not make an unrestricted public Windows HTTP listener the final design.

A private/loopback HTTP prototype is acceptable only for early proof.

### A3. Add host pairing and revocation

Status: **core pairing/revocation and restart credential persistence implemented on the integration branch; physical end-to-end validation remains.**

Implemented evidence:

- short-lived single-use pairing records are persisted server-side;
- only deployment owners can create/list/revoke host pairings;
- host credentials are stored server-side only as hashes;
- heartbeat credentials are replay-fenced by connection id + monotonic sequence;
- the native runtime persists its paired credential using Windows DPAPI (`CurrentUser`) rather than a plaintext config file;
- pairing secrets and host credentials stay out of normal JSON request bodies;
- persisted credentials are restored automatically after host-process restart and cleared on explicit revocation.


Pairing flow:

1. signed-in deployment owner requests host pairing;
2. Rakazo creates a short-lived single-use pairing capability;
3. native Windows runtime presents it;
4. Rakazo returns a scoped host credential;
5. host identity is persisted server-side and in OS-protected local storage;
6. the owner can revoke it;
7. revocation immediately prevents reconnect and new execution.

Never reuse the user's full Better Auth browser session as the long-lived host credential.

### A4. Extend the existing computer contract rather than creating a second API

The Rakazo API side should map the Windows host to the existing `SandboxProvider` semantics.

Required host operations:

- lifecycle/probe/reconnect;
- command execution by argv + cwd + timeout;
- process status/cancel;
- file list/read/write;
- file metadata;
- observation;
- batched actions;
- browser snapshot/action where available;
- launch/open operations;
- terminal or terminal-equivalent session where supported;
- snapshot/recovery metadata.

A dedicated `WindowsHostSandboxProvider` is acceptable, but its public behavior must remain a normal Rakazo computer.

### A5. Native process and file execution first

Milestone before GUI work:

```text
ChatGPT -> R -> Rakazo -> Windows host
```

must be able to:

- read Windows host identity;
- list a bounded directory;
- read a text file;
- write a test file in an allowed workspace;
- start a harmless process;
- stream stdout/stderr;
- obtain terminal status;
- cancel a long-running process;
- survive Rakazo API restart and host reconnect.

Prefer argv execution over generic shell strings. PowerShell/cmd may be exposed as explicit capabilities when needed, with the same approval boundaries as other high-consequence actions.

Reuse existing Win32 path-containment code wherever possible.

### A6. Browser backend

The physical Windows browser path must support the user's real signed-in browser when explicitly enabled.

Candidate implementations must be evaluated, not assumed:

- OpenCLI;
- direct CDP;
- Playwright attached to a user-approved browser;
- BrowserSkill-derived browser bridge;
- another maintained backend.

Expose only Rakazo browser semantics:

```text
browser_snapshot
browser_act
browser_navigate
browser_download/status
```

Do not expose `opencli_*` tools to ChatGPT as the permanent API.

Acceptance:

- enumerate/choose the intended browser profile/session safely;
- read the current page;
- click/type in a harmless test page;
- preserve signed-in state;
- reject stale element references;
- surface uncertain action outcomes instead of replaying blindly;
- reconnect without silently attaching to the wrong browser profile.

### A7. GUI backend

After process/files/browser work, add physical desktop observation and input.

Primary implementation candidate, now physically proven:

- Microsoft UFO execution components: `UICollector`, `HostUIExecutor`, and `AppUIExecutor`.

Required supporting/fallback layers:

- Windows Graphics Capture / screenshot APIs where needed;
- UI Automation for semantic control discovery/actions;
- SendInput or equivalent bounded input for controlled visual fallback;
- screenshot/vision + bounded coordinate action when an application exposes insufficient UIA state.

Reuse UFO execution components only. Do **not** embed UFO's agent hierarchy or require another LLM. UFO must remain an implementation detail behind Rakazo's computer contract, not a ChatGPT-visible tool namespace.

Target:

```text
Rakazo observe() -> real Windows image
Rakazo act()     -> real mouse/keyboard/UI action
```

Then the existing Plugin R computer loop can drive physical Windows without learning a new tool family.

### A8. Capabilities, leases, and approvals

The Windows host must advertise capabilities explicitly, for example:

```text
process
files
browser
screen
input
terminal
uia
clipboard
```

Rakazo must keep authority over:

- user-control leases;
- one-writer rules where necessary;
- destructive action approval;
- protected input;
- cancellation;
- audit/event emission.

No backend library may bypass Rakazo's lease/approval path.

### A9. Cut over and remove OpenResearch from runtime

Cutover only after the direct path passes the physical test matrix.

Then:

1. disable the OpenResearch assignment for ChatGPT Compute;
2. repeat all acceptance probes through R;
3. restart Rakazo;
4. restart Windows host runtime;
5. verify reconnect;
6. verify browser and GUI state;
7. keep OpenResearch installed only as a separate research tool if desired;
8. remove any Rakazo-specific dependency on it.

Do not delete the fallback before the direct path is proven.

---

## 6. Track B — evolve Plugin R into a real ChatGPT application

The existing MCP bridge is a good base. Do not replace it.

### B1. Preserve the dynamic appContract projection

Keep the current generic projection as the compatibility layer:

- procedure discovery;
- exact schema description;
- read/write/destructive routing;
- fail-closed classification.

This prevents API duplication and keeps new upstream procedures reachable.

### B2. Add a small set of hot-path tools

The generic tools are excellent for broad coverage, but common workflows should not require:

```text
procedures -> describe -> generic call
```

every time.

Add specialized stable tools only for frequent high-value paths, approximately:

- `rakazo_job_submit`
- `rakazo_job_status`
- `rakazo_job_result`
- `rakazo_job_cancel`
- `rakazo_file_read` / bounded write or patch
- `rakazo_process_run`
- `rakazo_browser_snapshot`
- `rakazo_browser_act`
- existing computer observe/act

Keep the total small. The dynamic catalog remains the escape hatch.

### B3. Add MCP Apps UI before ChatGPT-specific extensions

OpenAI currently recommends starting with the open MCP Apps UI standard.

Implement UI resources with:

- `_meta.ui.resourceUri`;
- `text/html;profile=mcp-app`;
- `ui/initialize`;
- `ui/notifications/tool-input`;
- `ui/notifications/tool-result`;
- `tools/call`;
- `ui/message`.

Use `window.openai` only for capabilities that the shared MCP Apps standard does not cover.

The tool API must remain usable without UI.

### B4. Build a Rakazo Control Center, not a duplicate Rakazo frontend

The ChatGPT UI should be deliberately small.

Initial panel:

```text
Rakazo
--------------------------------
Host            Online
Windows         Connected
Browser         Connected

Active jobs     2

Current
repository tests
██████████ 84 %

[Open logs] [Cancel]
[Computer]  [Files]
[Ask ChatGPT]
```

Useful surfaces:

- host connectivity;
- active jobs;
- approvals;
- current repository/workspace;
- browser/computer status;
- compact logs;
- event subscriptions.

Do not port the entire existing Rakazo web application into ChatGPT.

### B5. Use direct UI -> MCP calls for mechanical actions

A major design goal is to avoid spending model turns on simple UI operations.

Examples:

```text
user clicks "Cancel job"
  -> MCP Apps tools/call
  -> Rakazo job cancel
```

and:

```text
user clicks "Open logs"
  -> tools/call
  -> Rakazo read
  -> UI renders result
```

No new ChatGPT reasoning turn is required merely to dispatch a known deterministic action.

When intelligence is needed, the component can send a follow-up message to ChatGPT.

Example:

```text
7 tests failed
[Ask ChatGPT to analyze]
```

### B6. Add Plugin Extensions surfaces when the SDK/API is stable

OpenAI DevDay 2026 explicitly announced:

- sidebar plugin apps;
- interactive panels beside conversation;
- supported file viewers.

Design the MCP Apps component so it can become the Rakazo sidebar/control-center surface without coupling core functionality to a ChatGPT-only API.

Target:

```text
ChatGPT
  sidebar: Rakazo
  conversation: normal model interaction
  fullscreen: detailed job/computer view when requested
```

Plugin Extensions are presentation. The authoritative state remains Rakazo.

### B7. File integration

Where useful, support ChatGPT file helpers for:

- selecting an existing ChatGPT file;
- uploading a result;
- obtaining a temporary download URL;
- later, a custom viewer only for a concrete Rakazo-specific file format.

Do not invent a custom file type merely to justify a viewer.

---

## 7. Track C — MCP Events and event-driven execution

The existing `rakazo_thread_events` is bounded pull/stream collection. It is not the new MCP Events webhook model.

Keep it for interactive streaming, but add true MCP Events separately.

### C1. MCP protocol requirement

OpenAI's current MCP Events documentation requires MCP 2.0 / protocol version `2026-07-28`.

Upgrade/verify the MCP SDK and negotiate the required protocol version before implementing events.

### C2. Implement the event subscription surface

Add support for:

- `events/list`;
- `events/subscribe`;
- `events/unsubscribe`.

Persist subscriptions in Rakazo storage. They must survive API restart.

### C3. Use signed webhook delivery

Store:

- subscription id;
- event/filter definition;
- callback URL;
- signing material as required by the OpenAI flow;
- creation/update/expiry metadata;
- cursor/replay state where supported.

Delivery needs:

- HTTPS callback;
- signature;
- stable event id;
- timestamp;
- idempotency;
- bounded retry;
- delivery status;
- no secrets in payload/logs.

### C4. Start with a small event vocabulary

Recommended first events:

- `host.online`
- `host.offline`
- `job.completed`
- `job.failed`
- `job.blocked`
- `approval.required`
- `browser.download.completed`

Later, only when there is a concrete workflow:

- `repository.changed`
- `tests.completed`
- `artifact.created`

Events should carry identifiers and summaries, not megabytes of logs. ChatGPT can call a read tool for details.

### C5. Events must not turn every local completion into an expensive agent run

Events are a wake-up/escalation mechanism, not a replacement for local orchestration.

Preferred:

```text
ChatGPT submits job
  -> Rakazo performs deterministic local steps
  -> job completes
  -> event
  -> ChatGPT reasons only if the subscription asks it to
```

Avoid:

```text
every process line
  -> event
  -> model turn
```

### C6. User-controlled subscriptions

The user decides what to monitor and what ChatGPT should do after an event.

Do not create broad hidden subscriptions automatically.

Provide UI for active subscriptions and an obvious way to revoke them.

---

## 8. Track D — persistent jobs without a second job system

Rakazo already has workers, runs, routines, events, DB state, computer leases, and artifacts.

Do **not** create another independent job database.

Expose a simple ChatGPT-facing projection over existing durable execution:

```text
job.submit
job.status
job.result
job.cancel
```

A long task should be able to run without holding a ChatGPT turn open.

Example:

```text
ChatGPT:
  submit repository verification

Rakazo:
  checkout
  install if needed
  build
  test
  collect artifacts
  persist result

ChatGPT:
  resumes only after result/event
```

Job state must survive:

- MCP process restart;
- Rakazo API restart where feasible;
- Windows host disconnect/reconnect;
- browser closure;
- conversation ending.

Terminal state must be explicit: completed/failed/cancelled/manual-recovery-required, not infinite pending when safe terminal evidence is unavailable.

---

## 9. Track E — optimize for Plus usage, not maximum agent nesting

### E1. Default execution policy

Use ordinary ChatGPT + R whenever the task can be completed through Rakazo tools.

Typical examples:

- inspect repository;
- read/edit files;
- search code;
- execute build/tests;
- inspect logs;
- operate browser;
- operate Windows;
- compare diffs;
- prepare a commit-ready result;
- monitor a durable local job.

### E2. Avoid model polling

Bad:

```text
ChatGPT -> status?
ChatGPT -> status?
ChatGPT -> status?
```

Good:

```text
Rakazo owns the job
  -> local wait/retry/recovery
  -> final event/result
```

### E3. Codex escalation policy

Codex/Work may share the plan's agentic allowance on Plus. Therefore:

- never make Codex a dependency of Plugin R;
- do not silently fall back to Codex;
- do not use internal Rakazo `openai-codex` for user work;
- ask/choose Codex only when the benefit outweighs allowance cost.

Record in telemetry whether a workflow was completed with:

```text
normal ChatGPT + R only
```

This should become a project quality metric.

### E4. Success metric

Primary product metric:

> Percentage of useful end-to-end tasks completed from normal ChatGPT through R without a Codex/Work run.

A first target should be an end-to-end software task:

```text
read repo
-> inspect code
-> edit
-> run tests
-> inspect diff
-> produce commit-ready state
```

entirely through normal ChatGPT + R + Rakazo.

---

## 10. Track F — permissions and security

### F1. Preserve semantic authority boundaries

Do not expose a single unrestricted remote shell as the whole product API.

Prefer semantic/bounded actions and explicit high-consequence classes.

Generic process execution can exist behind authorization, but it must have:

- argv/cwd bounds;
- timeout;
- cancellation;
- output bounds;
- audit events;
- approval policy for sensitive operations.

### F2. App permissions

Plugin R must continue to mark read/mutation/destructive operations correctly so ChatGPT's app permission controls remain meaningful.

UI-triggered tools obey the same server-side authorization as model-triggered tools.

### F3. Secrets

Never return credentials, browser cookies, bearer tokens, signing secrets, or private host credentials in normal tool output.

Redact command lines/logs where they may carry secrets.

### F4. Host scope

The Windows host runtime needs explicit allowed roots and capabilities.

Do not assume that because a process runs under the user's account every path/action should be remotely available by default.

### F5. Replay and stale actions

For GUI/browser operations:

- identify observations/frames;
- reject stale references;
- report uncertain outcomes;
- never automatically replay an action whose success is uncertain.

---

## 11. Implementation phases

### Phase 0 — documentation and baseline

Status: **substantially complete as of 2026-09-30**.

Deliverables:

- this document;
- link from `docs/chatgpt-mcp.md`;
- record current physical Windows/OpenResearch baseline;
- recover any useful OpenCLI/UFO prototype notes/code;
- no runtime cutover.

Exit criteria:

- one authoritative architecture;
- no ambiguity that CAP is frozen and OpenResearch is transitional.

### Phase 1 — Windows host proof: identity/process/files

Status: **in progress as of 2026-09-30**.

Already implemented on `feature/chatgpt-mcp-upstream-2026-09-29`:

- `apps/windows-host` native runtime skeleton;
- stable Windows installation identity;
- protocol advertisement and capability schema;
- owner-created short-lived pairing;
- scoped host credential issuance, hashing, revocation and heartbeat replay protection;
- outbound host heartbeat;
- DPAPI-protected credential persistence and restart restoration;
- API/DB wiring and focused unit tests for transport and credential-source behavior;
- outbound long-poll `identity.get` command channel with per-host credential authentication and result correlation;
- opt-in `WindowsHostSandboxProvider` using the existing `desktop` computer kind, with identity verification in `prepare()`;
- a shared provider implementation in `packages/adapters`, used by both API and Graphile worker;
- a typed worker→API relay at `/api/windows-host/internal/dispatch` protected by a dedicated 32+ character token, owner check, non-revoked pairing and recent heartbeat;
- Compose worker routing to the private `http://api:3100` address;
- explicit rejection of remote host IDs by the local desktop provider; arbitrary process execution, file writes, GUI and snapshots remain fail-closed;
- restoration of DPAPI credentials before considering the original single-use pairing token, including after restart;
- read-only typed `process.list`, `files.list`, and `files.read` commands, with a maximum of 100 process entries, 128 directory entries, and 64 KiB per file read;
- a dedicated per-bot workspace under `stateDir/workspaces/<botId>`; normal Windows files and DPAPI credentials are not addressable by this API;
- focused tests for traversal, symlinks, read-size limits, unauthorized internal dispatch, command correlation and the read-only provider;
- a separate Windows-path typecheck CI job to distinguish Windows implementation failures from the existing mobile Expo version mismatch.

**Deployment boundary:** worker→API relay is implemented for the idempotent `identity.get` proof only; the API's host command hub is still process-local and its pending requests do not survive API restart. This is a transport bridge, **not a second durable-job store** and not yet a production-ready physical-host feature. `RAKAZO_WINDOWS_HOST_ENABLED` must remain off until the latest checks and a physical end-to-end test succeed; when enabled, both API and worker must share `RAKAZO_WINDOWS_HOST_INTERNAL_TOKEN`.

Still required for this phase:

- verify the latest focused typecheck, lint and unit tests, then validate `identity.get` plus read-only process/files on the target Windows machine through Plugin R;
- use the existing Win32 handle-relative containment implementation for race-resistant mutating filesystem access;
- add durable operation receipts, bounded process execution/output, cancellation and bounded file writes;
- prove cancellation and restart reconciliation on the physical Windows host through Plugin R.

Implement:

- native Windows host process;
- pairing;
- outbound connection;
- health/heartbeat;
- process execution;
- bounded file operations.

Exit test from ChatGPT through R:

1. report actual Windows host identity;
2. read a test file;
3. write a test file;
4. run a harmless command;
5. read stdout;
6. cancel a sleeping command;
7. reconnect after host restart.

OpenResearch remains enabled.

### Phase 2 — durable host jobs

Implement:

- durable job id;
- streamed/buffered output;
- status/result/cancel;
- reconnect reconciliation;
- terminal outcomes.

Exit:

- a 10+ minute local task can finish without keeping a ChatGPT tool call open;
- result is recoverable after conversation/tool restart.

### Phase 3 — direct browser

Implement and select the browser backend after testing OpenCLI/direct CDP/etc.

Exit:

- use the intended signed-in Chrome profile;
- snapshot current page;
- click/type;
- download a harmless file;
- recover after browser restart;
- no OpenResearch tool involved.

### Phase 4 — physical Windows GUI

Status: **execution-backend proof complete; Rakazo contract integration outstanding**.

Physical proof completed on the target Windows machine:

- external MCP gateway mounted UFO `UICollector`, `HostUIExecutor`, and `AppUIExecutor` without UFO HostAgent/AppAgent or any second LLM;
- the gateway enumerated real desktop windows and returned an all-screen PNG screenshot;
- semantic UIA selection focused a specific application window;
- a disposable Notepad file exposed 54 UIA controls, including the text editor;
- UFO semantic edit + keyboard save changed that disposable file to the independently verified value `UFO_CHATGPT_WEB_OK`;
- Windows Settings demonstrated a genuine UIA edge case (window selection worked while the controls list was empty), establishing the need for screenshot/vision + bounded coordinate fallback.

This proof selects UFO execution components as the current preferred GUI backend candidate. They remain an implementation detail behind Rakazo `observe/act`, not a public tool namespace or agent runtime.

Implement real `observe/act` behind the Rakazo computer contract.

Exit:

- R returns a real physical Windows screenshot;
- ChatGPT can perform a harmless multi-step Notepad/UI test;
- input leases work;
- stale frame handling works;
- no separate UFO/OpenCLI tool namespace is exposed.

### Phase 5 — R hot paths + MCP Apps UI

Implement:

- stable hot-path tools;
- first Rakazo Control Center UI resource;
- direct UI `tools/call`;
- model follow-up button for analysis/escalation.

Exit:

- common status/cancel/log operations work from UI without a new model decision;
- same workflows remain possible headlessly.

### Phase 6 — MCP Events

Implement:

- MCP 2.0 protocol support;
- events list/subscribe/unsubscribe;
- persistent subscriptions;
- signed callbacks;
- retry/idempotency;
- initial event vocabulary.

Exit:

- subscribe to `job.completed`;
- finish a local job after the initiating interaction is over;
- OpenAI receives the event;
- ChatGPT can continue the subscribed workflow;
- duplicate webhook delivery does not duplicate the action.

### Phase 7 — Plugin Extension surface

When the extension surface is stable/documented enough for production:

- expose Rakazo in the sidebar;
- use panel/fullscreen modes where useful;
- keep MCP Apps as the portable core;
- do not migrate authoritative state into the iframe.

Exit:

- Rakazo can be opened as a first-class ChatGPT app;
- the conversation and control panel operate on the same Rakazo state.

### Phase 8 — OpenResearch cutover

Run the final parity matrix.

Then:

- disable/remove the OpenResearch Windows assignment from Rakazo;
- repeat process/files/browser/GUI/job/restart tests;
- keep a documented rollback path for one release window;
- remove obsolete bridge-specific code/config after stability is proven.

### Phase 9 — optional future surfaces

Only after the core is stable:

- Dots as an optional long-lived orchestrator;
- custom file viewers for a real Rakazo-specific need;
- additional physical hosts;
- richer event filters;
- remote host pairing;
- reusable plugin skills for common Rakazo workflows.

None is required to finish OpenResearch removal.

---

## 12. Acceptance matrix

The migration is complete only when all required rows pass through **Plugin R**, not through an auxiliary admin script.

| Capability | Required final path | OpenResearch allowed? |
| --- | --- | --- |
| Rakazo health/state | ChatGPT -> R -> Rakazo | No |
| Windows identity | ChatGPT -> R -> Rakazo -> Windows host | No |
| Windows file read/write | same | No |
| Windows process start/log/cancel | same | No |
| Durable long-running job | same | No |
| Signed-in browser snapshot/action | same | No |
| Physical screen observe | same | No |
| Physical mouse/keyboard | same | No |
| Host reconnect | Rakazo <-> Windows host | No |
| ChatGPT UI status/cancel/logs | MCP Apps/Plugin Extension -> R | No |
| Async job completion wake-up | MCP Events -> ChatGPT | No |
| Ordinary coding workflow | normal ChatGPT + R + Rakazo | No Codex required |

---

## 13. Test strategy

### Unit tests

Required for:

- host protocol validation;
- pairing token expiry/single use;
- host credential revocation;
- capability negotiation;
- path containment;
- process timeout/cancellation;
- event signature generation;
- webhook idempotency;
- event subscription persistence;
- tool access classification;
- UI resource registration.

### Integration tests

Run against a test Windows host:

- connect/disconnect/reconnect;
- API restart while host is connected;
- host restart while a job is running;
- process output truncation/bounds;
- file race/junction cases;
- wrong host identity;
- revoked credential;
- browser stale ref;
- GUI stale frame;
- duplicate event callback.

### Physical tests

At least one real Windows machine must pass:

- signed-in Chrome;
- Notepad GUI;
- PowerShell/cmd process;
- long-running process;
- file download;
- reboot/relogin recovery where supported.

Mocks are not sufficient for declaring Windows parity.

### Usage tests

Track:

- number of ChatGPT tool turns per workflow;
- number of `procedures/describe` discovery calls;
- polling eliminated by jobs/events;
- whether Codex/Work was used;
- time spent executing locally vs waiting on model turns.

---

## 14. Cutover and rollback

Use explicit feature flags during migration.

Suggested flags:

```text
RAKAZO_WINDOWS_HOST_ENABLED
RAKAZO_WINDOWS_BROWSER_BACKEND
RAKAZO_WINDOWS_GUI_BACKEND
RAKAZO_MCP_EVENTS_ENABLED
RAKAZO_CHATGPT_UI_ENABLED
```

During parity testing, direct Windows and OpenResearch may coexist, but a single test must state which backend produced its evidence.

Cutover rule:

> No silent fallback from direct Windows to OpenResearch after the direct provider is declared active.

Otherwise tests can appear to pass while still depending on the old bridge.

Rollback:

- re-enable the known OpenResearch assignment;
- disable the direct host feature flag;
- do not roll back unrelated Rakazo state/schema unless necessary.

---

## 15. Repository workflow

### Current branch

Continue integration from:

```text
feature/chatgpt-mcp-upstream-2026-09-29
```

The older `feature/chatgpt-mcp` is not the preferred base because it is behind current upstream.

### Change discipline

Prefer small, reviewable increments:

1. contracts/protocol;
2. Windows host process;
3. server adapter;
4. physical tests;
5. browser backend;
6. GUI backend;
7. jobs;
8. UI;
9. Events;
10. cutover.

Each increment must retain the ability to sync future upstream Rakazo changes.

Avoid a giant Windows-specific fork of core computer code.

---

## 16. Decisions already made

Unless new evidence invalidates them:

- **ChatGPT is the primary reasoning runtime.**
- **Rakazo is the only local orchestration/execution runtime.**
- **CAP is not part of the target system.**
- **OpenResearch is a temporary Windows bridge and must leave the final runtime path.**
- **Codex is optional escalation, not a default dependency.**
- **Plugin R remains the ChatGPT-facing surface.**
- **The live Rakazo appContract remains the API source of truth.**
- **MCP Apps is the portable UI base; ChatGPT extensions are layered on top.**
- **MCP Events should replace model polling for meaningful asynchronous completion.**
- **Long deterministic work belongs in Rakazo jobs, not in an open ChatGPT turn.**
- **OpenCLI/UFO or alternatives are backend implementation options, not public orchestration layers.**
- **Future Dots may call R, but Rakazo does not depend on Dots.**

---

## 17. Immediate next work

Completed evidence:

- the OpenCLI/UFO role has been recovered and re-evaluated;
- UFO's LLM hierarchy is not required for our architecture;
- the physical Windows GUI execution path has been proven through an external MCP prototype using only UFO execution components;
- semantic UIA editing and keyboard input have been independently verified on a disposable Notepad file;
- a visual fallback requirement has been demonstrated by the Windows Settings UIA edge case.

The next implementation sequence should be:

1. finish the focused CI gates and physically test Graphile worker→API→Windows identity and bounded read-only commands through Plugin R;
2. integrate durable operation receipts with Rakazo's existing jobs; reconcile command delivery/results after API or host restart;
3. add bounded process execution, stdout/stderr, timeout and cancellation;
4. add race-resistant, bounded file writes via native Win32 containment and prove process + files through Plugin R;
5. select/integrate the browser backend;
6. move the proven UFO execution layer behind Rakazo `observe/act`, with visual fallback;
7. modernize R with hot paths and MCP Apps UI;
8. add MCP Events;
9. cut over from OpenResearch only after the parity matrix passes.

The important sequencing rule is:

> **Do not spend time polishing Plugin UI while the direct Windows execution path is still missing, and do not delete OpenResearch before direct Windows parity is proven.**

At the same time, all new Windows APIs should be designed so the later UI and MCP Events layers can use them without another backend rewrite.


---

## 2026-10-03 — Concurrent ChatGPT / OpenCLI browser session cutover

**Code committed in the native integration branch, NOT yet activated in the running
API/Host/original borrowed R tunnel.** The running Plugin R still reports the old
computer/browser schema without an open command or sessionToken. Do not attempt
live multi-chat tests against that old process.

Implemented:

- Physical Windows Host mints opaque UUID bearer tokens on explicit
  computer/browser open; all navigate/snapshot/act/close requests require a
  server-minted token. A second ChatGPT conversation using the same
  ChatGPT Windows bot obtains a different OpenCLI session and observation map.
- A close can only release the exact token's session; unknown, foreign-bot,
  closed and expired tokens fail without issuing CLI commands. Token idle
  expiry: 30 minutes, native OpenCLI idle tab lifetime remains independent.
- Generic internal Rakazo pageBrowser is unchanged and uses graphical fallback
  on Windows instead of silently opening a botId-wide shared tab.
- Physical direct sessions traverse the separate desktopBrowserSession method
  through HostAwareSandbox with the existing actor, computer-control and Host
  dispatcher checks.
- OPENCLI_WINDOW stays foreground as the owner requested. No second Chrome
  profile, pairing, plugin tunnel or internal Rakazo model was created.
- Plugin R tool description and chatgpt-mcp.md specify the open/use/close
  lifecycle for future chats. Plugin R does not expose an attested chat ID:
  the returned token is a task-owned bearer capability, not per-chat auth.
- The OpenCLI extension currently retains a reusable blank group after a
  scoped close. Removal of a truly empty owned group needs a separately
  verified change within OpenCLI's extension; Rakazo must NEVER delete
  Chrome groups by a shared title or touch tabs it cannot prove it owns.

Verified on physical checkout:

- Native windows-host unit tests: 7 files / 32 tests passed.
- New physical Host dispatcher tests: 2 passed.
- Plugin R adapter tests: 6 passed.
- Contracts, adapter-kit, windows-host, adapters and API typechecks passed
  after separation of the generic and explicit browser contracts.
- host-aware-sandbox focused runtime test did not produce a terminal result
  within the Windows Host's 18-second process command boundary. Do not claim
  that suite passed. Its types were checked successfully.

Before claiming production completion:

1. Finish a bounded host-aware focused test or capture its CI result.
2. Coordinate maintenance of the **same registered original R MCP process**
   so its statically loaded appContract is refreshed; do not create a second
   R tunnel and do not re-pair Windows Host.
3. Quit/reopen the existing native Rakazo tray so API/Host run updated code.
4. Check rakazo_describe("computer/browser") contains open and sessionToken.
5. Perform live two-token/same-bot A/B navigation, snapshot and scoped close
   via Plugin R on harmless example pages. Verify B remains after A closes.
6. Separately test OpenCLI extension group reclamation with genuine ownership
   evidence; until then close is session-scoped and does not guarantee the
   visual group disappears. Avoid disrupting other active ChatGPT chats.
