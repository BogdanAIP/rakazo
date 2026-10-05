# Hybrid Computer Use: incremental OpenCLI bridge

ChatGPT remains the decision maker; Rakazo is the existing local executor.
Windows Host reuses the already-connected OpenCLI Chrome profile and the
existing R tunnel. No new browser profile, server, LLM or Codex OAuth is needed.

## P1a: bounded read-only browser operations

- Installed OpenCLI 1.8.6 exposes find, wait and extract; this PR adds
  these to the existing typed computer/browser contract.
- All calls require the opaque, server-minted browser sessionToken and reuse
  that task's session. No arbitrary session names, cross-task tab selection or
  automatic binding to another user's open tab.
- Find is CSS-only (500 characters; at most 20 matches, 120 chars per text).
  Wait accepts only selector and text with up to 9000 ms timeout.
  Extract supports bounded CSS scope and start offset with a 16000-character
  requested chunk. Existing output and CLI execution bounds still apply.
- Responses expose content as bounded text. This is not a general-purpose
  script evaluator: eval, bind, and unrestricted network access are not
  exposed in P1a.
- These operations preserve the snapshot/act stale-reference guard.
  They do not automatically retry uncertain mutations.

## P1b: viewport control, screenshots and observation cost

- OpenCLI 1.8.6 exposes scroll and screenshot on the existing browser session.
  Rakazo exposes only up/down scrolling with 1-5000 pixels; every scroll drops
  cached element refs before execution because lazy rendering can mutate the DOM.
- Screenshot callers cannot supply a filesystem path. Windows Host creates a
  random temporary PNG, validates its PNG signature, caps it at 4 MiB, returns
  at most 6 MiB of base64, and removes the temporary file in a finally block.
  Only viewport captures are exposed; bounded dimensions and annotation are supported.
- Annotated screenshots refresh DOM refs inside OpenCLI, so Rakazo invalidates
  the prior observation before requesting one.
- Exact OpenCLI v1.8.6 source confirms state prints a leading URL header. Rakazo
  parses that header and therefore normally reduces snapshot observation from
  three CLI processes (state + get url + get title) to two (state + get title).
  A missing/unrecognized header falls back to get url rather than guessing.
- Tab management remains deliberately unexposed in this slice. Target IDs need
  an explicit ownership model before select/close can be safe on a shared Chrome
  profile.

## P1c: owned tab lifecycle

- Rakazo records only page target IDs returned by OpenCLI from navigation or
  tab creation inside the token-owned browser session. Caller-supplied arbitrary
  target IDs are never accepted as ownership proof.
- A task may create at most eight recorded tabs. Optional tab URLs are restricted
  to HTTP(S). Select and close require the page ID to already belong to that
  same opaque sessionToken; another token on the same bot cannot reuse it.
- Selecting or closing a tab clears cached element refs before OpenCLI runs.
  A successful close revokes the recorded page ID. A failed/uncertain close
  also drops that ownership grant, so callers cannot blindly repeat an
  ambiguous close; closing the whole owned session remains the safe cleanup path.
- If OpenCLI reports successful tab creation without a valid page identity,
  Rakazo returns an uncertain failure and does not mint ownership from guesses.
- Raw tab listing and bind/unbind remain unexposed. This avoids discovering or
  attaching to user-managed Chrome tabs outside the task-owned automation session.

## P2a: owned-session recovery after host restart

- Recovery accepts only the prior opaque sessionToken; callers still cannot
  supply an OpenCLI session name or enumerate arbitrary browser sessions.
- The token plus bot identity deterministically reconstructs the exact prior
  Rakazo OpenCLI session name. Windows Host internally runs tab list for that
  session and restores ownership only from valid unique page IDs returned there.
- An empty list, malformed/duplicate IDs, more than eight tabs, a different bot,
  or a tab-list failure does not mint session ownership. Recovery never calls
  bind and never exposes raw tab listing as a public browser command.
- If the in-memory Rakazo session still exists, recovery simply returns its
  already-recorded owned page IDs without probing OpenCLI again.
- OpenCLI owned sessions have their own idle lease, so recovery is intentionally
  best-effort after a short Windows Host restart; expired sessions must be
  reopened rather than guessed or rebound to a user tab.

## P3a: read-only Windows UI Automation semantics

- Physical screen observations remain screenshot-first, but Windows Host also
  attempts a bounded UI Automation ControlView snapshot for the foreground
  window. Failure to load or query UIA never removes the screenshot fallback.
- The semantic snapshot is read-only in this slice: up to 256 controls, maximum
  traversal depth 8, bounded names/stable invariant control roles/automation
  IDs/class names and optional virtual-screen-relative rectangles. References
  such as u1 are observation-local
  labels only and cannot yet be used to invoke controls.
- Only the foreground window subtree is inspected; Rakazo does not enumerate
  every desktop process/window and does not launch a second UI agent or LLM.
- Windows GUI hosts advertise the existing uia capability only with the same
  explicit GUI opt-in. Native Windows CI parses the GUI executor and verifies
  the standard UIAutomationClient/UIAutomationTypes assemblies are loadable.
- P3b will add narrowly typed semantic actions with stale-observation/window
  guards; coordinate/pixel input remains the fallback rather than the primary
  targeting model.

## P3b: guarded UIA semantic actions

- A semantic action accepts only the observation-local UIA ref returned by a
  prior Rakazo observation plus the exact foreground window id and a SHA-256
  observationId for that bounded UIA tree.
- Windows Host supports only focus, InvokePattern invoke, and a guarded center
  click using the current UIA bounding rectangle. It does not expose arbitrary
  UIA patterns, unrestricted value setting, raw PowerShell, process-wide window
  enumeration, or another UI agent.
- Immediately before acting, the native script verifies that the foreground
  window and UIA tree still match the caller's observation. After resolving the
  local ref it verifies the same window/tree again to narrow the race window.
  Stale state fails closed and requires a fresh observation.
- The normal Rakazo Computer control lease still applies. Semantic refs are not
  authority and cannot bypass takeover, Project policy, or Computer ownership.
- Coordinate/pixel input remains a fallback for applications whose UIA tree is
  incomplete.

## P4: durable uncertain-action recovery

- Before every semantic UIA mutation, Windows Host writes a small recovery
  latch under the Rakazo Windows Host local state directory.
- The latch is cleared only after the host receives a definite successful
  result, or after a fresh observation explicitly re-establishes current state.
- If the PowerShell child, Windows Host, transport, or caller disappears while
  the mutation outcome is uncertain, the latch survives restart and blocks
  another semantic mutation until a new observation.
- This prevents blind retry of a potentially completed click/invoke. A
  deterministic stale/unsupported-control failure may conservatively require
  one extra observation; safety is preferred over guessing.
- No action replay log is introduced in this slice. Recovery is deliberately
  fail-closed rather than trying to infer whether an uncertain mutation should
  be repeated.

## P5: physical observation benchmark

A read-only physical Windows acceptance run on 2026-10-05 used the checked-in
PowerShell executor directly three times with the same foreground window. The
cold/warm observation times were 1894 ms, 1127 ms and 1107 ms; median 1127 ms.
Each run returned 68 UIA ControlView elements, truncated=false, and a valid
64-hex observationId.

The earlier browser optimization remains relevant: OpenCLI snapshot normally
uses two CLI processes after parsing the URL from state, with a bounded fallback
to the previous extra URL lookup when the header is unavailable. Owned-session
recovery remains one bounded tab-list probe after a short host restart.

These measurements are a practical baseline, not a claim that UIA is always
faster than screenshot/vision. The intended win is fewer ambiguous visual
targeting steps when a useful semantic tree exists, while preserving the visual
fallback when it does not.

## Remaining optional slice

P2b remains intentionally deferred: current-tab bind should be exposed only
after a trustworthy local user-confirmation primitive proves intentional
handoff of the active tab. Raw bind/unbind remain unexposed.

This PR alone is source code, not a deployment: upgrade the native controller
only after CI, safe checkout review, and a normal planned restart. Keep the
separate PostgreSQL crash-recovery task independent.