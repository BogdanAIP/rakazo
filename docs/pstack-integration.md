# pstack integration (phase 1)

Rakazo Market remains a knowledge catalog. The upstream control is [cursor/plugins pstack](https://github.com/cursor/plugins/tree/b7b93c36be9bcc36a74db438e0fd385d660bc559/pstack), MIT (copyright Lauren Tan, 2026). The third-party [Codex-compatible mirror](https://github.com/backnotprop/pstack/tree/c81f1bf680803f9e3f0cade6adb62593f43fb61f) is a separate optional adaptation, not the original. Its policy files must be respected. See each pinned LICENSE before redistribution.

## Rakazo

The candidate manifest indexes 59 upstream SKILL.md paths; the separate pstack-priority.v1.json contains 12 pinned import items. Submit its items through the existing market/importGithubBatch RPC as the authorized Market owner, in schema-sized batches if needed. This only indexes original text. It does not install or execute anything. Review each candidate for external commands, supporting files, harness-specific APIs, explicit-only flags, name collisions (including built-in Interrogate), and license notice before installation. Preserve the original. Use existing Market adaptation/comparison and installation procedures for selected skills only; do not silently replace installed or builtin skills. The current metadata flag is advisory, not runtime enforcement. Do not install explicit-only candidates until the host enforces explicit invocation or a separately reviewed explicit-only wrapper is available.

Eight portable local SKILL.md files in .agents/skills are valid RCCL candidates; seven task skills and engineering as a workflow recommender. They are not automatically installed in Rakazo. The pinned import payload is market/rakazo-engineering.v1.json. Import its items via the existing Market importer; review, adapt if needed, then install explicitly. Engineering recommends rather than silently invoking explicit-only skills. No new capability or resolver route is granted.

## Codex

The mirror includes harness-neutral changes and Codex agents/openai.yaml policy. Review the exact pinned mirror revision and its license, then use the skills CLI or install approved full skill directories (including supporting files and policy) into the Codex user skills directory. For example, after reviewing the pinned checkout, run npx skills add <local-reviewed-checkout> and select Codex and global scope. Do not run a floating latest install automatically. The local .agents/skills files are portable candidates for the same global installation, with project-local copies available after checkout. Do not overwrite existing user skills without an explicit review. The user-level location and CLI options must be verified against the installed Codex version.

## Updating

Compare upstream tree and license at a new full commit SHA; review changes and dependencies, update trusted/candidate/batch manifests together, generate new immutable keys and re-run tests. Keep prior originals for comparison. No auto-update, auto-install or authorization changes.

## Remaining runtime work

Enforce explicit-only invocation at skill selection/load, including subagents and routines, with regression tests. Validate original vs adapted workflows with exact-head evidence, adapt Cursor-specific operations through existing capabilities, and test manual commands and optional skill selection on the running instance. No live trading operations are part of this integration. Local/global installation requires an available host.
