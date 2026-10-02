# Manually launched native Rakazo (Windows pilot)

This is a **physically exercised manual-launch pilot**, not a reason to delete the rollback launcher. It is deliberately fail-closed. The native Start → Quit → Start sequence, live Plugin R health and one Windows Host heartbeat were physically confirmed on 2026-10-02. The existing Plugin R tunnel/alias and Windows Host pairing remain authoritative; this code creates neither. A console-free shortcut upgrade is pending its physical Windows test.

- Check Rakazo.cmd (or Rakazo.ps1 -Action Preflight) is read-only and prints booleans only; it never prints the local .env, session material or tunnel keys.
- Validate.ps1 parses the PowerShell script and checks that it does not contain obvious Windows-autostart, remote tunnel creation or destructive Compose commands.
- Start Rakazo.cmd runs only when prerequisites pass and no existing API/Web, old tray, external Worker or Windows Host is detected. It launches one API, Worker, Web and **already-paired** Windows Host and displays a tray icon. For the existing R it has two disjoint modes: if conclusively stopped, connect the same registered identity and own only its verified newly started process; if fully live (same ID, ready/healthy, live loopback health, exact PID/path/UTC start time), borrow it **without a connect or stop entitlement**. Ambiguous R status fails closed.
- Quit Rakazo first requests targeted shutdown of R only when its exact managed process identity was recorded after this controller's own successful connect, then stops its API/Worker/Web/Host child process trees. A borrowed already-live R always remains running on Quit or startup failure; the next launch may reverify and borrow it again. It never mass-stops tunnel-client.exe, unrelated node.exe processes, PostgreSQL or Docker Engine.
- The controller uses the source checkout, Corepack, a locally updated private .env and the existing restored native PostgreSQL cluster. No Docker application stack, Host pairing, API secret or remote tunnel is created.
- Status is a **local** indicator. An R runtime reporting ready does not prove ChatGPT can see the Host; confirm real Plugin R health, Windows Host list and fresh heartbeat separately.
- Logs go to the current user's LocalAppData/Rakazo/manual-launcher directory. These logs can contain application details; do not upload or commit them without review.


## Orphaned first GUI-launch investigation (2026-10-02; recovery pending)

The user reported that an installed console-free shortcut upgrade was recognized correctly (`ShortcutTargetIsWscript=True`, `UsesGuiLauncher=True`), but before its physical retest the original launch at 22:55 local had left API and Web bound on host ports 3100/5173 while the native controller mutex was **free**. Read-only process trees showed the listener nodes descended from child-role PowerShell runners originally parented by controller PID 17172, which was no longer present. Last stage was `tray active`; there was no logged `FAILED` or Quit stage in that version, so controller's reason for exit is **not proven**. In parallel, the independent OLD Docker Rakazo application stack remained up with API/Web published on different ports (32768/45173), plus original PostgreSQL 16; Docker should NOT be mass-stopped as a substitute for recovering the separate native processes.

Two source-level safeguards were added but are not yet physically tested: the invisible WScript GUI entry now **waits for the PowerShell controller** and privately records its exit status; the controller logs Quit and finally cleanup, and uses `taskkill /PID <exact recorded owned launcher> /T /F` instead of a graceful parent-first stop that could strand descendants. It checks the host API/Web ports afterwards. This never grants ownership over borrowed R or changes PostgreSQL/Docker. A forceful shutdown of a verified controller-owned child tree is intentional; no `taskkill node.exe` or broad process-name termination is allowed.

**Before rerunning the updated shortcut**, inspect and clean up the pre-existing orphaned native child roots after verifying their original parent PID 17172, role-specific `Rakazo.ps1 -Action Child` commandline, exact checkout path, 22:55 start times, and their listener-descendant relationships. Verify all four expected role roots separately (api/worker/web/host); do not assume Worker/Host merely from the two port trees. Keep exact PID/start evidence and stop only the verified orphaned roots, with explicit user approval. The preserved original R and both PostgreSQL clusters are unrelated and must not be stopped. Re-run `Validate.ps1`, Preflight, and the shortcut only after native API/Web ports and external Worker/Host detection clear. Then test tray Quit, post-Quit Preflight and Plugin R reconnection before declaring console-free handoff finished.

## Console-free shortcut checkpoint (2026-10-02; physical retest required)

The first canonical `Rakazo.lnk` worked (browser opened, one tray appeared, API/Worker/Web/Host and R healthy), but Windows Terminal still displayed a foreground PowerShell tab despite `-WindowStyle Hidden`. The installed shortcut directly targeted `powershell.exe`, which can be intercepted by the user's default terminal configuration.

`Launch-Rakazo.vbs` is a minimal, standard Windows GUI host entry: `wscript.exe` invokes the **same** guarded `Rakazo.ps1 -Action Run` with `WScript.Shell.Run ... 0, False`, without adding another controller, alias, process manager, service, scheduled task or Startup registration. `Install-Shortcut.ps1 -Install` recognizes and upgrades **only** the exact shortcut created by the previous installer, preserving its name/icon; a different `Rakazo.lnk` is never overwritten. A later invocation is idempotent.

On the laptop, leave the currently running Rakazo alone while fetching new source and running `Validate.ps1` and `Install-Shortcut.ps1` without `-Install` (preview). Then use the tray's `Quit Rakazo`, confirm API/Web ports clear and existing R is eligible for read-only borrow, and invoke `Install-Shortcut.ps1 -Install` exactly once. Double-click the updated desktop icon. Verify **no visible terminal**, one browser page/tray, `launcher-stage.log` reaching `tray active`, Plugin R health and a fresh one-Host heartbeat. If a terminal still appears, retain logs and report it; do not disable the Windows default terminal or mass-close processes to hide this issue. The original V4 shortcut and database rollback remain preserved.

## Live R recovery checkpoint (2026-10-02)

The physical pilot successfully started native PostgreSQL, API, Worker, Web and the previously paired Host. Its first R verification failed because the existing CLI returns an unzoned **UTC** `process.started_at` value, which Windows PowerShell had interpreted as local time (+03:00). A read-only physical check showed the exact client path and process identity matched and the difference fell from 10800.5 to 0.5 seconds when parsed using `AssumeUniversal`. The fix is in `Tunnel.Diagnostics.ps1`, and the user's read-only `Check-ExistingR.ps1` then passed all checks, including local health and identity.

The original registered R was left **running** by that failed attempt. Current `Run` code therefore permits the verified live identity as **borrowed/unowned**, rechecking its exact PID and start record after other local services start. This path never invokes `runtimes connect` or records R stop authority. Its Preflight reports `ExistingTunnelAttachAllowed=True`; `ExistingTunnelColdStartAllowed=False` is expected while R remains live. An ambiguous or changed identity fails closed. This is source-code status; perform local Validate, live Preflight, Run, Plugin R health/Host heartbeat, Quit and repeat Run before calling the pilot complete.

## Native PostgreSQL cutover checkpoint (2026-10-02; physically started and health-tested)

The restored database is now in a **separate native PostgreSQL 17.11** cluster, not the AIHOT instance:
- Runtime: $HOME/RakazoRuntime/postgresql; data: $HOME/RakazoData/postgres17; loopback port: 5434; database/user: rakazo_next / rakazo
- Source Docker PostgreSQL 16 and both backups remain untouched for rollback. The source and target have 71 user tables, 458 total rows, 90 finished Prisma migrations, one Windows Host and matching per-table row-count fingerprint; this does not prove byte-for-byte row equality
- A source archive created on 2026-10-02 has SHA-256 D209391019CF07D213A565E35414D7ED742EA1F1F00E4AD9663B9B857377A974; keep backups and local credentials private
- Native controller now **requires** DATABASE_URL to name postgresql://rakazo@127.0.0.1:5434/rakazo_next (password omitted here). It must not print connection secrets. The local .env has NOT been switched by a GitHub commit
- Read-only Preflight checks the expected paths, PG_VERSION, exact live PID/path/start/port evidence and port readiness. When stopped, Run may start only this prepared cluster through pg_ctl. It does not create/reset a database, touch AIHOT, start Docker, register Windows autostart or stop PostgreSQL on Quit
- Run only after local Validate and Preflight, with the private .env backed up and edited, no legacy API/Web/Worker/Host, and existing R either conclusively stopped or fully verified for read-only reuse. A live but ambiguous R still blocks Run.
- Static code changes in GitHub are **not** evidence of a successful native Run; perform an explicit Start → R health/Host read-only verification → Quit → Start pilot before retiring V4

## First physical validation

From a regular (non-administrator) PowerShell in the source checkout:

~~~powershell
& "$HOME\rakazo-upstream-integration\scripts\windows\manual-rakazo\Validate.ps1"
& "$HOME\rakazo-upstream-integration\scripts\windows\manual-rakazo\Rakazo.ps1" -Action Preflight
~~~

Both commands must complete before trying Run. This pilot is expected to report API/Web occupied while the current manual service windows are still open: **do not close them merely to make the status green**. First validate remaining tunnel lifecycle behavior, backup the launcher, and agree on an explicit handoff. Do not use Run as a repair for a yellow legacy tray.

## First local read-only evidence

On 2026-10-01 the canonical checkout fast-forwarded to the first pilot revision while preserving the unrelated local desktop edit. `Validate.ps1` returned `STATIC MANUAL LAUNCHER GATE PASSED`; `-Action Preflight` reported the correct checkout, cloned database, Host flag, worker dispatcher config, protected credential, Corepack, healthy API and Web. It also reported both ports in use, old tray/foreground Worker/Host running, so **Run must not be invoked over these live services**. `ExistingTunnelReady=False` disagreed with contemporaneous successful Plugin R calls (`health` and one Windows Host with a fresh heartbeat), so status parsing was revised to use an explicit bounded regex, ANSI-stripping and comparison to the ID loaded from the existing local launcher config (not from public source). This fix **still requires a local retest**. `runtimes connect --help` exposes `--alias`, `--tunnel-id`, `--mcp-command` and `--runtime-api-key`; inspect the existing V4 protected-key flow before wiring same-alias cold start. Never persist or paste a key into public source.

**Tunnel status diagnostic correction:** The physically installed CLI returns valid JSON with separate `ready`, `healthy`, `process_running`, `runtime_state`, and `tunnel_id` fields; it does not have a generic `status` field. Preflight now parses `--json` and reports each safe signal separately, with exact local config ID comparison. Do not infer that a false CLI `ready` flag means ChatGPT Plugin R is disconnected: verify R directly. Do not print the raw CLI JSON because it contains profile/connection metadata. The app still refuses duplicate native service processes, and the pilot cannot yet cold-start or own the R tunnel. No live cutover has been performed.

**Latest physical status (2026-10-01):** read-only CLI JSON `CliOk=True`, configured `tunnel_id` matches, `ready=True`, `healthy=True`, but `process_running=False` and `runtime_state=stopped`. Concurrent Plugin R `health` and `windowsHosts/list` **both succeed**, with fresh host heartbeat. Therefore remote-ready and locally-supervised runtime status must not be conflated; do not interpret CLI `ready` alone as ownership, or terminate unmanaged tunnel-client processes. The `Run` entry is **temporarily fail-closed** before starting any services until the original V4 `Start-RakazoRuntimeCore`/`Stop-RakazoRuntimeCore` flow is inspected, same registered alias is adopted safely, and exit semantics are tested. `Preflight` remains read-only. Existing working terminals/tray/tunnel are untouched.

## Implementation checkpoint — built, not yet physically cut over

The single-click source includes authenticated status, exact-alias serialized connect/stop, an explicit cold-start gate and process identity evidence for shutdown. The earlier Docker-based dependency has now been replaced in GitHub by the native PostgreSQL 17 controller described above; physical testing and local .env cutover are still pending. Run is **not a live takeover action** and will reject the currently active V4 tray, foreground API/Web, Worker/Host and live tunnel. These new routines still require the current user's Windows parser gate and one planned physical start/stop/restart test. The historical notes above record earlier revisions; they are not the current source behavior.

## Historical first physical handoff checklist (partially executed; see live R recovery checkpoint above)

After Windows Validate and Preflight pass, perform this deliberately with the owner present. First keep a record of which terminal owns each of the existing manual API, Worker, Web and Windows Host sessions. Stop only the original alias through the legacy tunnel-only Stop action (never its Docker app-stop action), close only the old tray indicator, then stop the four identified foreground sessions using their own Ctrl+C. Do not close other terminals, other tunnel aliases, Docker Desktop or the PostgreSQL database. Wait until Preflight reports old tray, external Worker/Host and API/Web ports clear and exact existing R identity matching, then require either ExistingTunnelColdStartAllowed=True (cold connect) or ExistingTunnelAttachAllowed=True (read-only borrow). An unverified R blocks Run. Confirm the physical Host has a fresh heartbeat through Plugin R, check repeated-click idempotency and its dedicated Quit/second-start behavior. Once successful, use Install-Shortcut.ps1 -Install to create a single normal desktop Rakazo shortcut. The installer never writes the Windows Startup folder.

If any gate fails, do not mass-kill processes or create another tunnel. Preserve the existing repo, original launcher and original DB for rollback; restore the prior foreground components individually, then use the original tunnel-only Start action with the existing registered identity. The new controller attempts a targeted tunnel Stop only after it verifies its own post-connect PID/path/start evidence. Borrowed R is never stopped by this controller. Do not delete the original launcher until physical start/stop/restart tests pass.

## Remaining gates before retiring the old launcher

1. Port exact existing R start/stop/recovery semantics from the current V4 controller without changing its registered tunnel or credentials. Prove start-after-full-exit and stop of just that alias.
2. Verify the root .env and native dispatcher, child ownership/recovery, the dedicated Host identity, and complete read-only physical commands via R (not the legacy Docker computer).
3. Exercise one-click start, second click, tray quit, and start again on the physical Windows laptop. Ensure the old tray has exited through its **Close indicator only** action before new-tray testing, not by stopping unrelated processes.
4. Make one normal shortcut on Desktop or Start Menu **only**. Do not place it in the Startup folder or register a Scheduled Task, Run key, Windows service, or login trigger.
5. Only then retire obsolete old application/launcher shortcuts. Preserve the original database, repository, protected credentials and rollback path until new operation is proven.

This pilot makes no host capability escalation: RAKAZO_WINDOWS_PROCESS_ENABLED, RAKAZO_WINDOWS_FILE_WRITE_ENABLED and RAKAZO_WINDOWS_GUI_ENABLED remain false.
