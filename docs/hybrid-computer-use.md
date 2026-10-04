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

## Follow-up slices

P1b: controlled scrolling, screenshots and owned-tab operations, followed by
actual output-format measurement and reduction of redundant OpenCLI processes.
P2: explicit bind/recovery with proof of tab ownership and physical GUI
coordination. P3: UIA/UFO semantic control inside Windows Host. P4: durable
verification and failure reconciliation, never blindly repeating uncertain
actions. P5: before/after speed, model/process-call and recovery benchmarks.

This PR alone is source code, not a deployment: upgrade the native controller
only after CI, safe checkout review, and a normal planned restart. Keep the
separate PostgreSQL crash-recovery task independent.