# Rakazo physical Windows integration: implementation audit and pilot log (2026-10-01)

Scope: `BogdanAIP/rakazo`, branch `feature/chatgpt-mcp-upstream-2026-09-29`, audited source baseline `32e04841031ab8ab303082cdd0c906c754f352b4`. This is a factual inventory, not a new architecture. ChatGPT -> Plugin R -> one Rakazo API/Worker -> native physical Windows Host. CAP is frozen, OpenResearch is transitional, and no second local control plane or separate Excel/Blender skill registry is required.

## 1. Existing extension surfaces: reuse, do not reinvent

| Surface | Implemented in source | Important limitation / pilot result |
| --- | --- | --- |
| Reusable Agent Skills | `packages/core/src/agent-skill.ts`, `apps/api/src/agent-skills.ts`, `packages/adapters/src/skill-tools.ts`. Persisted user `SKILL.md`, builtin/plugin read-only sources, create/read/update/delete and slash/routine prompt expansion. | Plugin R live `agentSkills/list` returned only builtin `Interrogate`; a skill is a recipe, **not** automatically an executable Windows app API. |
| Taught Skills | `apps/api/src/taught-skills.ts`: record/snapshot/draft/playbook/save/testRun. | Not physically validated in this Windows pilot. |
| Installed capabilities and connectors | `packages/adapters/src/installed-connectors.ts`, `lazy-tool-catalog.ts`: persisted MCP, API/OpenAPI and GraphQL installs, discovery, authorization and lazy search/load/execute of larger catalogs. | Plugin R live `capabilities/list` returned `[]` in the new API instance. No installed Excel/Blender-specific connector was established. |
| Managed integrations | `integration-provider-settings.ts`: configured Composio/Pipedream provider resolution. | Plugin R live `connections/list` returned `[]`. |
| Generic agent computer tools | `packages/adapters/src/builtin-tools.ts`, `executor.ts`: observe/act, page browser, workspace files, shell, open_path, launch_app. | These are general contracts, **not** proof of complete physical-Windows support. |
| Native Windows Host | `apps/windows-host/src/runtime.ts`, `native-process.ts`, `windows-files.ts`, `windows-gui.ts`, `opencli.ts`, `packages/contracts/src/windows-host.ts`, `packages/adapters/src/windows-host-sandbox.ts`. | Pairing, typed identity/process/files/browser/screen/input commands are implemented; physical pairing and full end-to-end test remain unverified. |
| ChatGPT plugin R | `packages/adapters/src/chatgpt-mcp.ts`, `chatgpt-rakazo.ts`: appContract projection. | Live `health` reaches new API but existing tunnel still lists an older MCP catalog: `rakazo_procedures(query="windowsHosts")` returned 0 despite new `packages/contracts/src/rpc.ts` having `windowsHosts`. Update **existing** tunnel/stdio MCP child rather than start a duplicate. |

No verified automatic discovery of arbitrary locally installed Windows programs or generic on-demand loading of Excel COM/Blender bpy adapters was found in these paths. **Do not claim these are shipping features.** Use established skill/connector/computer mechanisms and add app-specific support only after a concrete gap is measured.

### Confirmed Windows-specific contract gaps

- `packages/adapters/src/windows-host-sandbox.ts` explicitly rejects generic `open`/`launch` actions (lines 240+). Thus generic `open_path`/`launch_app` from `executor.ts` are not yet working via this native provider.
- Generic `shell` in `executor.ts` builds `bash -c` / background launch; native `WindowsProcessBackend` executes a bounded `argv` in its workspace. Do not describe these as interchangeable without an adapter.
- Dedicated host `computer/exec` and `computer/browser` appear in the new `rpc.ts`; test them through updated R after host pairing.
- `native-process.ts` is opt-in via `RAKAZO_WINDOWS_PROCESS_ENABLED`, with argument, timeout and output limits; `windows-gui.ts` is separately opt-in. Access to arbitrary program data or host files must not be inferred from skill availability.
- The Windows files backend intentionally checks opened directory/file handles, path containment and reparse points. Keep these guards intact; never "fix" a smoke failure by removing them.

## 2. Observed pilot (user-provided terminal evidence, 2026-10-01)

- Working tree: `C:\Users\eahra\rakazo-upstream-integration`; native Node 22.23.3 and `corepack pnpm`. API started, `/rpc/health` and Plugin R `health` passed. Worker logged `worker ready` and connected to Graphile.
- The sole overdue cloned Graphile job was `id=110`, `computer.sleep`, `attempts=0`. User rescheduled it to 2100-01-01 **only in cloned `rakazo_next`**; a queue guard then printed `QUEUE OK`. Keep original `rakazo`, legacy worktree, backups and existing Docker volumes intact. The only intended Docker container for this pilot is Postgres.
- Native Windows smoke initially failed at `WindowsHostFileMutationBackend.writeFile` -> `validateDirectoryHandle` -> `pathFromDirectoryFd` -> `koffiPointer`: `Path escapes the computer workspace`. A standalone call using `msvcrt.dll` `_get_osfhandle` on Node's directory fd `3` returned `-1`, confirming that conversion path does not work **in this environment**.
- A suggested probe of `ucrtbase.dll` did **not** pass. Nevertheless the user pasted and continued the later PowerShell commands: interactive `throw` did not prevent subsequent separately submitted commands. Their **local, uncommitted** `packages/adapters/src/desktop-sandbox-win32-path.ts` was changed from `msvcrt` to `ucrtbase` in three places after a local backup was made.
- After that change `corepack pnpm --filter @rakazo/windows-host exec tsx src/windows-smoke.ts` exited with `3221226505` (Windows `0xC0000409` process termination), **not** smoke success. `git diff --check` passed but is not a runtime test. The final echo `WINDOWS SMOKE OK` was emitted by a separately submitted command despite the preceding `throw`; it must not be counted as evidence. The local UCRT edit must be reverted/isolated before further native testing.
- Prior local `apps/desktop/src/docker-cli.ts` has an unrelated uncommitted environment-whitelist fix. Do not reset or overwrite it.

## 3. Physical host gating sequence (evidence-required)

1. **Restore only the experimental UCRT edit locally** using the saved backup after verifying its path and diff, or `git restore -- packages/adapters/src/desktop-sandbox-win32-path.ts` only when that file contains no other user changes. Never blanket-reset the worktree. Stop on nonzero exit *within one guarded script*, not separate paste submissions.
2. Diagnose Node fd -> Windows HANDLE without attempting unverified CRT interop again. Inspect a supported Node/libuv binding or another validated OS-handle acquisition design; verify exact ABI/ownership, 32/64-bit representation, and handle closure, then add a minimal independent Windows test. Avoid native process crash as a test oracle.
3. Add/keep regressions: successful directory and regular file handle paths, relative nested write/read, path traversal, junction/reparse and link escape rejection, no collateral outside workspace, `git diff --check`, Windows-native smoke. No pairing or enabling write/GUI/process until physical smoke passes.
4. Use existing owner-created one-shot pairing and DPAPI credentials; make installer compatible with `corepack pnpm` (on this machine bare `pnpm` is not on PATH), and do not spawn a second tunnel or desktop stack.
5. Update current R tunnel/stdio MCP process to new source, re-check `windowsHosts` catalog, pair native Host, verify live owner/heartbeat -> identity/process.list -> bounded files and process -> OpenCLI browser -> screen/input, with the required opt-in flags.
6. Reconcile native `computer/exec` / `computer/browser` with general `launch_app`, `open_path`, `shell` semantics using existing Rakazo contracts; verify each path rather than claiming parity in advance.
7. Only after those gates, pilot a disposable Excel file and Blender scene. Determine if existing GUI, process and installed connector/skill surfaces suffice; add a targeted adapter only for a proven missing capability. No separate extension framework.

**Status:** source audit completed; API/Worker started; direct native Windows Host is BLOCKED by failed smoke/native handle conversion; R catalog update and physical host pairing are pending. No full physical Windows control has been proven through the new R path.
