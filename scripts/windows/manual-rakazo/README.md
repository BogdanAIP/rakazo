# Manually launched native Rakazo (Windows pilot)

This is a **staged pilot**, not an installed replacement for the currently working launcher. It is deliberately fail-closed. Do not run Start Rakazo.cmd until its physical validation gates pass and the foreground API/Worker/Web/Host pilot windows have been deliberately handed off. The existing Plugin R tunnel/alias and Windows Host pairing remain authoritative; this code creates neither.

- Check Rakazo.cmd (or Rakazo.ps1 -Action Preflight) is read-only and prints booleans only; it never prints the local .env, session material or tunnel keys.
- Validate.ps1 parses the PowerShell script and checks that it does not contain obvious Windows-autostart, remote tunnel creation or destructive Compose commands.
- Start Rakazo.cmd runs only when prerequisites pass and no existing API/Web, old tray, external Worker or Windows Host is detected. It launches one API, Worker, Web and **already-paired** Windows Host and displays a tray icon. It requires a conclusively stopped existing R before attempting same-alias connection; an already-live or ambiguous R is never taken over or duplicated.
- Quit Rakazo first requests targeted shutdown of R only when its exact managed process identity was recorded after this controller's own successful connect, then stops its API/Worker/Web/Host child process trees. It never mass-stops tunnel-client.exe, unrelated node.exe processes, PostgreSQL or Docker Engine.
- The controller uses the source checkout, Corepack, the existing .env and existing PostgreSQL container. No second database, Docker application stack, Host pairing, API secret or remote tunnel.
- Status is a **local** indicator. An R runtime reporting ready does not prove ChatGPT can see the Host; confirm real Plugin R health, Windows Host list and fresh heartbeat separately.
- Logs go to the current user's LocalAppData/Rakazo/manual-launcher directory. These logs can contain application details; do not upload or commit them without review.

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

The single-click source now includes authenticated status, exact-alias serialized connect/stop, an explicit cold-start gate and process identity evidence for shutdown. It also starts/reuses Docker Desktop only to run the existing named PostgreSQL container, waiting for its health check; never creates or resets the database, starts the old application Compose stack, or stops the shared engine on Quit. Run is **not a live takeover action** and will reject the currently active V4 tray, foreground API/Web, Worker/Host and live tunnel. These new routines still require the current user's Windows parser gate and one planned physical start/stop/restart test. The historical notes above record earlier revisions; they are not the current source behavior.

## Remaining gates before retiring the old launcher

1. Port exact existing R start/stop/recovery semantics from the current V4 controller without changing its registered tunnel or credentials. Prove start-after-full-exit and stop of just that alias.
2. Verify the root .env and native dispatcher, child ownership/recovery, the dedicated Host identity, and complete read-only physical commands via R (not the legacy Docker computer).
3. Exercise one-click start, second click, tray quit, and start again on the physical Windows laptop. Ensure the old tray has exited through its **Close indicator only** action before new-tray testing, not by stopping unrelated processes.
4. Make one normal shortcut on Desktop or Start Menu **only**. Do not place it in the Startup folder or register a Scheduled Task, Run key, Windows service, or login trigger.
5. Only then retire obsolete old application/launcher shortcuts. Preserve the original database, repository, protected credentials and rollback path until new operation is proven.

This pilot makes no host capability escalation: RAKAZO_WINDOWS_PROCESS_ENABLED, RAKAZO_WINDOWS_FILE_WRITE_ENABLED and RAKAZO_WINDOWS_GUI_ENABLED remain false.
