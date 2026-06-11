# BLUE-TANUKI Resident App Guide

## Purpose

The resident app path turns the portable install launcher into an OS-integrated
local lifecycle surface for the Gateway and Control Center. It does not add a
native signed app, does not add an automatic updater, and does not create a
second authority path. It does not provide a signed native app and does not provide an automatic updater.

HDS-BRAIN, Approval Gate, hash-chain audit, Runtime Invariants, WebChat tokens,
settings tokens, and Control Center APIs remain unchanged.

## Supported Command Surface

Portable installers create a `blue-tanuki` launcher. The resident commands are:

```bash
blue-tanuki resident-start
blue-tanuki resident-safe-mode
blue-tanuki resident-status
blue-tanuki resident-stop
blue-tanuki resident-open
blue-tanuki resident-logs
blue-tanuki resident-autostart-enable
blue-tanuki resident-autostart-disable
blue-tanuki resident-autostart-status
```

Windows users call the generated PowerShell launcher:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" resident-start
```

## Lifecycle

- `resident-start` starts `apps/gateway/dist/main.js --serve` in the background
  with the generated env file.
- `resident-safe-mode` starts the same gateway with external providers,
  connector credentials, channel tokens, daily brief, and schedules disabled for
  recovery.
- `resident-status` reports the resident process state, env file path, log
  directory, and Control Center URL.
- `resident-stop` stops only the recorded resident Gateway process.
- `resident-open` opens `http://127.0.0.1:8787/` when the OS has an opener.
- `resident-logs` prints the stdout/stderr log paths and recent tail output.

The resident process is still the normal Gateway serve process. It emits the
same audit records and uses the same Approval Gate as foreground `start`.

## Autostart

Autostart is opt-in only. Installers do not enable autostart during setup.

- Windows uses the current user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  entry and points it at `blue-tanuki.ps1 resident-start`.
- macOS writes a user `LaunchAgents/com.blue-tanuki.gateway.plist`.
- Linux prefers a user `systemd` unit and falls back to an XDG autostart
  desktop entry when user systemd is unavailable.

Use `resident-autostart-status` before enabling or disabling. Use
`resident-autostart-disable` before uninstalling manually.

## Uninstall Boundary

Portable uninstallers stop the resident process and disable autostart before
removing launcher/app files. Normal uninstall preserves env, audit, session,
memory, and local data. Purge removes retained data and must be treated as a
secret and audit-evidence deletion operation.

## Safety Boundary

The resident app path is downstream lifecycle glue only:

- it does not call LLMs,
- it does not approve commands,
- it does not bypass final-review,
- it does not write HDS-BRAIN policy,
- it does not expose token values,
- it does not mutate audit, history, or Runtime Invariants.

If `doctor` reports errors, stop the resident process, fix the reported
precondition, rerun `doctor`, then restart through the launcher.
