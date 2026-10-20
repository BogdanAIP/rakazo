# Offline PAPER review bundle provenance

This document tracks the source of offline-gap-runtime.mjs in this candidate.
The generated file must never be accepted merely because it passes unit tests.

- Source repository: BogdanAIP/rakazo
- Source branch: feature/paper-offline-review-core-2026-10-19
- Exact source commit: 368e88e86ba2f2edc5110ad0046b0b48417be239
- Source entrypoint: scripts/paper-offline-review.entry.ts
- Additional sources: packages/adapters/src/trading-okx-history.ts and
  packages/core/src/trading-paper-offline-gap.ts and their dependencies
- Build program: esbuild 0.28.2 (Node 22 target, bundle, platform=node, format=esm)
- Source alias: @rakazo/contracts -> source worktree packages/contracts/src/index.ts
- Bundle under test: scripts/local-paper-journal/offline-gap-runtime.mjs
- Bundle size: 950470 bytes
- Verified SHA-256:
  886B8E020C15CBD9596C883558CBB63781D4168F09FA82F70E0413450840F12E

An isolated Windows reproduction used the source commit worktree and esbuild
0.28.2 to produce a sibling temporary bundle next to the submitted bundle.
The two files had EXACTLY the same byte count and SHA-256. The verification
file was deleted without changing the submitted artifact, live data or services.

Build argument outline (replace bracketed paths with isolated local paths):
node [esbuild-bin] [source-entry.ts] --bundle --platform=node --format=esm
  --target=node22 --outfile=[temporary-sibling-bundle]
  --alias:@rakazo/contracts=[source-worktree]/packages/contracts/src/index.ts

The recorded original builder is scripts/local-paper-journal/build-offline-gap.mjs.
It uses a private runtime config to locate the external canonical source repo.
Do not copy credentials or live runtime config into Git.

Release blockers remain:
- These canonical source files and their trading ledger dependencies are not
  in the target browser-v2 branch or this PR. Explicitly retain the source
  branch/commit and design a pinned, source-addressed release build.
- Review all offline gap and auth behavior, including fail-closed session
  authorizations, funding gaps and no historical synthetic fills.
- Obtain green combined CI and end-to-end tests on disposable PAPER data.
- Require explicit operator approval before changing any live PAPER service.