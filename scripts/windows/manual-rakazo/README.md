# Manually launched native Rakazo (Windows pilot)

This is a **staged pilot**, not an installed replacement for the currently working launcher. It is deliberately fail-closed. Do not run Start Rakazo.cmd until its physical validation gates pass and the foreground API/Worker/Web/Host pilot windows have been deliberately handed off. The existing Plugin R tunnel/alias and Windows Host pairing remain authoritative; this code creates neither.

- Check Rakazo.cmd (or Rakazo.ps1 -Action Preflight) is read-only and prints booleans only; it never prints the local .env, session material or tunnel keys.
- Validate.ps1 parses the PowerShell script and checks that it does not contain obvious Windows-autostart, remote tunnel creation or destructive Compose commands.
- Start Rakazo.cmd runs only when prerequisites pass and no existing API/Web, old tray, external Worker or Windows Host is detected. It launches one API, Worker, Web and **already-paired** Windows Host and displays a tray icon. Until tunnel-lifecycle integration is physically tested, it requires the **existing** tunnel alias to be ready; it must not create a second tunnel.
- Quit Rakazo stops only the API/Worker/Web/Host child process trees started by this controller. If R was already running before launch, this pilot leaves that external session alone. It never mass-stops tunnel-client.exe, all node.exe processes, PostgreSQL or other Docker containers.
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

## Remaining gates before retiring the old launcher

1. Port exact existing R start/stop/recovery semantics from the current V4 controller without changing its registered tunnel or credentials. Prove start-after-full-exit and stop of just that alias.
2. Verify the root .env and native dispatcher, child ownership/recovery, the dedicated Host identity, and complete read-only physical commands via R (not the legacy Docker computer).
3. Exercise one-click start, second click, tray quit, and start again on the physical Windows laptop. Ensure the old tray has exited through its **Close indicator only** action before new-tray testing, not by stopping unrelated processes.
4. Make one normal shortcut on Desktop or Start Menu **only**. Do not place it in the Startup folder or register a Scheduled Task, Run key, Windows service, or login trigger.
5. Only then retire obsolete old application/launcher shortcuts. Preserve the original database, repository, protected credentials and rollback path until new operation is proven.

This pilot makes no host capability escalation: RAKAZO_WINDOWS_PROCESS_ENABLED, RAKAZO_WINDOWS_FILE_WRITE_ENABLED and RAKAZO_WINDOWS_GUI_ENABLED remain false.
