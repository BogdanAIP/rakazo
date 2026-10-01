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
- **Recovery confirmation:** the user ran a guarded restore from the local backup; terminal printed `ORIGINAL CRT RESTORED`, `git diff --exit-code -- packages/adapters/src/desktop-sandbox-win32-path.ts` passed, and the only remaining local modification in `git status --short` was `M apps/desktop/src/docker-cli.ts`. The UCRT experiment is no longer in the working tree. This does **not** fix or pass native file-write smoke.

## 2a. Subsequent physical probe and unverified code change

- User's separate read-only test resolved both `uv_get_osfhandle` and `uv_open_osfhandle` via `GetProcAddress(GetModuleHandleW(NULL), ...)` in the running Node executable; `PROBE EXIT CODE: 0`.
- A second independent read-only test invoked `uv_get_osfhandle` for a Node-opened directory and `GetFinalPathNameByHandleW`; terminal showed `LIBUV HANDLE VALID: true`, `DIRECTORY PATH MATCH: true`, `PROBE EXIT CODE: 0`.
- New source patch in `packages/adapters/src/desktop-sandbox-win32-path.ts` switches both fd/HANDLE conversions from `msvcrt.dll` to those **same-process libuv exports** using Koffi function pointers. It removes the CRT-only `_open_osfhandle` flags argument; libuv's `uv_open_osfhandle` takes one HANDLE and transfers ownership to the returned fd. Neither containment checks nor Windows Host opt-in flags were relaxed.
- New isolated `apps/windows-host/src/windows-handle-smoke.ts` exercises both conversions with an NT-relative open of a child under a disposable temp directory. **Physically verified** by the user after a fast-forward pull from `32e04841` to `7d6c58c9` on Windows Node 22.23.3: `@rakazo/adapters check` PASS, `@rakazo/windows-host check` PASS, `ROOT HANDLE PATH OK`, `CHILD HANDLE TO NODE FD OK`, `ISOLATED HANDLE SMOKE PASSED`. The only remaining local change was `M apps/desktop/src/docker-cli.ts`. This verifies the isolated bridge, **not** Windows full file-write smoke or host pairing.

## 2b. Full smoke: file stat BigInt regression (physical Windows)

- On Windows after pulling `71ce165b`, user launched `corepack pnpm --filter @rakazo/windows-host exec tsx src/windows-smoke.ts`. Native handle conversion advanced past both directory opens, but `validateFileHandle` rejected a newly created file: `Workspace target is not a regular single-link file`, exit code **1**. The following test stage was correctly not run.
- Exact source defect in `apps/windows-host/src/windows-files.ts`: `handle.stat({ bigint: true })` gives `BigIntStats.nlink` as a bigint, but guard compared `info.nlink !== 1` (number). Even `1n !== 1` is true, so this branch rejects a normal single-link file. The preceding `!info.isFile()` was not separately logged; full smoke will confirm the corrected full guard.
- Fix: `isSingleLinkRegularFile` keeps `isFile()` and checks `BigInt(info.nlink) === 1n`. Unit regression tests cover number/bigint `1` acceptance, `0`/`2` rejection, and directories. No NT handle, path/reparse, link-count restriction or opt-in capability was loosened.
- **Unverified until next local run:** Windows Host unit tests + typecheck + full native smoke; do not proceed to pairing until all pass.
- Subsequent user terminal: fast-forward to `6fd8f598` **succeeded** and Windows Host TypeScript check passed. Targeted `vitest run ... windows-files-validation.test.ts` did not execute because root `vitest.config.ts` omitted `apps/windows-host/src/**/*.test.ts` in `test.include`; Vitest reported **No test files found**, exit 1, so full smoke was correctly skipped. Fix now committed: add that existing package test directory to Vitest discovery. This is a test harness configuration gap, **not** evidence that the BigInt guard fix failed or passed.

## 2c. Full Windows file smoke passed; test fixture requires privilege-free link

- User pulled `6fd8f598..32aaef3f` by `git pull --ff-only`. The BigInt guard regression ran with **3 passed**. Full `apps/windows-host/src/windows-smoke.ts` emitted **`Windows native DPAPI, tasklist, installer syntax and bounded workspace read/write smoke passed`**; this clears the previously failing native file-write path.
- The subsequent complete `@rakazo/windows-host test` reported **27 passed / 1 failed** among 28 tests. The failure was *test fixture setup*, not an observed Rakazo containment bypass: `readonly.test.ts` attempted `symlink(secret, ...link.txt)` and native Windows returned `EPERM` because creating file symbolic links needs Developer Mode/elevated privilege in that environment. Execution stopped before the link-check assertion.
- The test now builds an *outside-directory junction* on Windows (`symlink(outsideDir, "link-dir", "junction")`) rather than requiring privileged file-symlink creation. It verifies `readFile("link-dir/secret.txt")` is rejected with `links`, that listing excludes the junction, and that the outside secret remains unchanged. Non-Windows retains a direct file-symlink assertion. **Only the test fixture changed; runtime traversal/link guards are untouched.**
- **Pending physical verification:** pull fixture-test commits `6bda0dc` and `e186abd`, rerun targeted `readonly.test.ts` and full Windows Host suite. Do not claim all tests pass before user results. Only proceed to host pairing after that gate.

## 3. Physical host gating sequence (evidence-required)

1. **Completed:** restore only the experimental UCRT edit locally from the saved backup, verify the restored file matches HEAD and preserve unrelated `docker-cli.ts` modification. Stop on nonzero exit *within one guarded script*, not separate paste submissions.
2. **Isolated bridge verified on physical Windows:** both same-process libuv exports and the fd -> HANDLE -> directory final path probe succeeded; the candidate patch passed both TypeScript checks and the isolated NT-relative round-trip smoke. Full file-write, containment, host pairing and reconnection remain unverified. Avoid native process crash as a test oracle.
3. **Full physical Windows smoke passed. Current gate:** pull privilege-free junction fixture test, run targeted `readonly.test.ts`, and the complete Windows Host test suite; retain path traversal, junction/reparse and hard-link assertions. No pairing or enabling write/GUI/process until suite passes.
4. Use existing owner-created one-shot pairing and DPAPI credentials; make installer compatible with `corepack pnpm` (on this machine bare `pnpm` is not on PATH), and do not spawn a second tunnel or desktop stack.
5. Update current R tunnel/stdio MCP process to new source, re-check `windowsHosts` catalog, pair native Host, verify live owner/heartbeat -> identity/process.list -> bounded files and process -> OpenCLI browser -> screen/input, with the required opt-in flags.
6. Reconcile native `computer/exec` / `computer/browser` with general `launch_app`, `open_path`, `shell` semantics using existing Rakazo contracts; verify each path rather than claiming parity in advance.
7. Only after those gates, pilot a disposable Excel file and Blender scene. Determine if existing GUI, process and installed connector/skill surfaces suffice; add a targeted adapter only for a proven missing capability. No separate extension framework.

**Status:** source audit completed; API/Worker started; isolated handle bridge and full native Windows DPAPI/tasklist/read/write smoke **passed**. Complete Windows Host unit suite is blocked by a Windows file-symlink fixture `EPERM` (27/28 passed), addressed by an unverified junction-based fixture patch. R catalog update and physical pairing pending; no full physical control through new R path yet.
