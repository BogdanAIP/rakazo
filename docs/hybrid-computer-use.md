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
  Full-page, annotation, and bounded viewport dimensions are supported.
- Annotated screenshots refresh DOM refs inside OpenCLI, so Rakazo invalidates
  the prior observation before requesting one.
- Exact OpenCLI v1.8.6 source confirms state prints a leading URL header. Rakazo
  parses that header and therefore normally reduces snapshot observation from
  three CLI processes (state + get url + get title) to two (state + get title).
  A missing/unrecognized header falls back to get url rather than guessing.
- Tab management remains deliberately unexposed in this slice. Target IDs need
  an explicit ownership model before select/close can be safe on a shared Chrome
  profile.

## Follow-up slices

P1c: owned-tab creation/selection/close with explicit target ownership and
recovery rules. P2: explicit bind/recovery with proof of tab ownership and
physical GUI coordination. P3: UIA/UFO semantic control inside Windows Host.
P4: durable verification and failure reconciliation, never blindly repeating
uncertain actions. P5: before/after speed, model/process-call and recovery
benchmarks.

This PR alone is source code, not a deployment: upgrade the native controller
only after CI, safe checkout review, and a normal planned restart. Keep the
separate PostgreSQL crash-recovery task independent.