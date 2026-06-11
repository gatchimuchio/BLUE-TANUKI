# Windows Installer Guide

This guide defines the Windows GUI product path.

BLUE-TANUKI now has an unsigned Windows x64 installer package produced by:

```bash
pnpm build
pnpm package:windows
pnpm package:windows:verify
```

The package artifact is:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
```

The package build also emits:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.manifest.json
```

## Scope

The Windows package is installer-first for a normal Windows user:

- The user extracts the zip and double-clicks `BlueTanukiSetup.cmd`.
- The installer copies the built app into `%LOCALAPPDATA%\Programs\BlueTanuki`.
- The package includes a Windows Node runtime zip and expands it during install.
- The installed app does not require user-installed Node.js, pnpm, Git, or repository commands.
- Start Menu shortcuts are created under `BLUE-TANUKI`.
- Desktop shortcut creation is optional via `-DesktopShortcut`.
- Windows Apps / Control Panel uninstall is registered under the current user.
- Autostart is not enabled by install.

This does not build signed native packages yet. It is not a signed MSI/EXE, not
an automatic updater, and not a GA public-claim artifact.

## Unsigned Package / SmartScreen / SHA-256

The v1 Windows package is unsigned. If Microsoft Defender SmartScreen shows a
warning, verify the package hash before continuing.

From PowerShell in the folder containing the zip:

```powershell
Get-FileHash -Algorithm SHA256 .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
Get-Content .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
```

Proceed only when the displayed SHA-256 digest matches the `.sha256` sidecar
provided with the same release. After verification, use SmartScreen's
`More info` and `Run anyway` path only for the verified package. Do not bypass a
hash mismatch.

## User Flow

1. Download or receive the Windows installer zip.
2. Extract it to a normal folder.
3. Double-click `BlueTanukiSetup.cmd`.
4. Open BLUE-TANUKI from the Start Menu.
5. The launcher starts the resident gateway with the bundled Node runtime.
6. The Control Center opens at `http://127.0.0.1:8787/app`.
7. Use stub mode for first conversation without external API credentials.

## Locations

| Item | Location |
|---|---|
| Install files | `%LOCALAPPDATA%\Programs\BlueTanuki` |
| User data | `%APPDATA%\BlueTanuki` |
| Logs | `%APPDATA%\BlueTanuki\logs` |
| Env/settings | `%APPDATA%\BlueTanuki\blue-tanuki.env` |
| Start Menu | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\BLUE-TANUKI` |

Secrets must remain under the user data path, not the install directory.
This includes OpenRouter and Composio API keys.

## Repair / Reinstall

Re-running `BlueTanukiSetup.cmd` with the same install and data locations
repairs the install files and keeps the existing env/settings file by default:

```text
%APPDATA%\BlueTanuki\blue-tanuki.env
```

Use `-ResetConfig` only when the owner intentionally wants to regenerate the env
file. A normal repair install must not rotate `WEBCHAT_TOKEN`,
`WEBCHAT_RESUME_TOKEN`, or `BLUE_TANUKI_SETTINGS_TOKEN`.

## Included Shortcuts

- `BLUE-TANUKI` opens the Control Center.
- `BLUE-TANUKI Doctor` runs Doctor and opens the doctor log.
- `BLUE-TANUKI Logs` opens the logs folder.
- `BLUE-TANUKI Safe Mode` starts the Control Center with external LLM
  providers, channel tokens, Composio, and schedules disabled for recovery.
- `BLUE-TANUKI Stop` stops the resident runtime.
- `Uninstall BLUE-TANUKI` removes the app while preserving user data by default.

## Port Conflicts and Safe Mode

The launcher reads `WEBCHAT_HOST` and `WEBCHAT_PORT` from
`%APPDATA%\BlueTanuki\blue-tanuki.env` before starting the resident runtime.
If the configured local port is already in use, startup fails before spawning a
resident process and prints a `port_conflict=<host>:<port>` message with the env
file and log locations.

To recover, stop the process using the port or change `WEBCHAT_PORT` in the env
file, then start BLUE-TANUKI again. Use `BLUE-TANUKI Safe Mode` when you need
the Control Center and Doctor without external providers, connector calls,
channel connections, or schedules.

## Installer UX Boundary

The installer may create shortcuts and an uninstall registration. It must not:

- enable autostart silently,
- grant capability permissions,
- approve actions,
- alter HDS-BRAIN authority,
- bypass Approval Gate,
- persist credentials in the install directory,
- print API keys in logs or installer output.

Autostart can be added only later as an explicit owner action.

## Scripts

```bash
pnpm package:windows
pnpm package:windows:verify
pnpm installer:windows
pnpm installer:windows:verify
pnpm smoke:windows-installed
```

`smoke:windows-installed` performs artifact structure verification on non-Windows
hosts and full installed-app smoke on Windows.
