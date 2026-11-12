# Windows Installer Guide

This guide defines the Windows GUI product path.

BLUE-TANUKI now has an unsigned Windows x64 installer package produced by:

```bash
pnpm build
pnpm package:windows
pnpm package:windows:verify
```

If the checkout is under OneDrive, set `BLUE_TANUKI_WINDOWS_ARTIFACT_DIR` to a
new local directory outside OneDrive before running these commands. The
packager rejects OneDrive artifact paths to avoid modifying synced files.

The Windows single-file package candidate is:

```text
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe.sha256
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe.manifest.json
```

The unsigned IExpress executable extracts its embedded setup command, which
verifies and internally extracts this payload/recovery artifact:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
```

The package build also emits:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.manifest.json
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.cmd.sha256
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.cmd.manifest.json
release/windows/README_INSTALL_WINDOWS.txt
```

The versioned `.cmd` is a build-time bootstrapper embedded inside the `.exe`;
normal users do not need it as a separate download. The ZIP remains available
as a recovery payload. Public distribution remains on hold pending signing and
owner release GO.

## User Entry Points

Do not run `install/windows/product/BlueTanukiSetup.cmd` from the source tree.
That file is copied to the root of the packaged installer zip and expects the
packaged `app/`, `runtime/`, `launcher/`, and manifest entries next to it.

Normal Windows users should not run source builds. The intended single-file
entrypoint is `BlueTanukiSetup-<version>-windows-x64.exe`. The
`blue-tanuki-<version>-windows-x64-installer.zip` artifact is payload/recovery
and should not require manual nested extraction during normal install.

1. Obtain the `.exe` together with its matching `.sha256` and `.manifest.json`.
2. Verify the SHA-256 sidecar, then double-click the `.exe`.
3. IExpress extracts the embedded setup command; the command verifies and extracts the payload/recovery ZIP.
4. BLUE-TANUKI installs, starts, and opens the Control Center.

This is the intended candidate flow. The current unsigned package is not
approved for public distribution or owner release GO.

The root entrypoint uses an existing `release/windows/*windows-x64-installer.zip`
when present. If no installer zip exists, it downloads the matching GitHub
Release installer asset plus `.sha256` and `.manifest.json`, verifies SHA-256
and manifest claims, then runs packaged setup. If the release asset cannot be
downloaded and verified, it fails fast with wrong-asset guidance instead of
building from source.

Developer source build is explicit only:

```powershell
.\INSTALL_WINDOWS.cmd -BuildFromSource
```

## Scope

The Windows package is installer-first for a normal Windows user:

- The user downloads one single-file installer and double-clicks it.
- The installer verifies and internally extracts the payload/recovery zip.
- The installer copies the built app into `%LOCALAPPDATA%\Programs\BlueTanuki`.
- The package includes a Windows Node runtime zip and expands it during install.
- The installed app does not require user-installed Node.js, pnpm, Git, or repository commands.
- Start Menu shortcuts are created under `BLUE-TANUKI`.
- Desktop shortcut creation is optional via `-DesktopShortcut`.
- Windows Apps / Control Panel uninstall is registered under the current user.
- Autostart is not enabled by install.

The generated `.exe` is an unsigned IExpress self-extracting package, not a
signed native MSI/EXE. This is not an automatic updater or a GA public-claim
artifact. Public distribution remains held until signing and owner release GO.
Release hardening is tracked by `pnpm validate:release-hardening`; a future
signed Windows release must also satisfy
`pnpm validate:release-hardening -- --require-signing` and produce separate
signing evidence.

## Unsigned Package / SmartScreen / SHA-256

The v1 Windows package is unsigned. If Microsoft Defender SmartScreen shows a
warning, verify the package hash before continuing.

From PowerShell in the folder containing the installer:

```powershell
Get-FileHash -Algorithm SHA256 .\BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe
Get-Content .\BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe.sha256
Get-FileHash -Algorithm SHA256 .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
Get-Content .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
```

Proceed only when the displayed SHA-256 digest matches the `.sha256` sidecar
provided with the same release. After verification, use SmartScreen's
`More info` and `Run anyway` path only for the verified package. Do not bypass a
hash mismatch.

## User Flow

1. Obtain `BlueTanukiSetup-<version>-windows-x64.exe` and verify its SHA-256 sidecar.
2. Double-click the `.exe`.
3. IExpress extracts the setup command; it verifies and internally extracts the payload/recovery zip.
4. The packaged setup installs the app and starts the resident gateway with the bundled Node runtime.
5. The Control Center opens at `http://127.0.0.1:8787/app`.
6. Use stub mode for first conversation without external API credentials.

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
`WEBCHAT_RESUME_TOKEN`, `BLUE_TANUKI_MAINTENANCE_TOKEN`, or
`BLUE_TANUKI_SETTINGS_TOKEN`.

## Included Shortcuts

- `BLUE-TANUKI` opens the Control Center.
- `BLUE-TANUKI Doctor` runs Doctor and opens the doctor log.
- `BLUE-TANUKI Logs` opens the logs folder.
- `BLUE-TANUKI Safe Mode` starts the Control Center with external LLM
  providers, channel tokens, Composio, and schedules disabled for recovery.
- `BLUE-TANUKI Stop` stops the resident runtime.
- `Uninstall BLUE-TANUKI` removes the app while preserving user data by default.

## Explicit Autostart / Reboot Persistence

Install and setup never enable autostart. Reboot persistence is available only
after an explicit owner action through the launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\BlueTanukiLauncher.ps1 resident-autostart-status
powershell -ExecutionPolicy Bypass -File .\BlueTanukiLauncher.ps1 resident-autostart-enable
powershell -ExecutionPolicy Bypass -File .\BlueTanukiLauncher.ps1 resident-autostart-disable
```

The Windows installed-app smoke uses a temporary Run-entry name and verifies the
enable/status/disable loop before reporting `reboot_persistence_result=pass`.

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

## Crash Recovery

`BLUE-TANUKI` start launches a small Windows watchdog alongside the resident
Gateway process. If the recorded resident process exits unexpectedly, the
watchdog restarts the same `apps/gateway/dist/main.js --serve` command with the
same env file and writes `watchdog_restarted=pass` to the watchdog log.

`BLUE-TANUKI Stop` stops the watchdog before stopping the resident process, so
manual stop and uninstall do not trigger automatic restart. The watchdog is
lifecycle glue only; it does not approve actions, change HDS-BRAIN policy,
change Approval Gate behavior, or create a second authority path.

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
pnpm package:installers -- --platform=windows
pnpm package:installers:verify -- --platform=windows
pnpm installer:windows
pnpm installer:windows:verify
pnpm smoke:windows-installed
```

`smoke:windows-installed` performs artifact structure verification on non-Windows
hosts and full installed-app smoke on Windows. The Windows evidence markers are
defined in [WINDOWS_EVIDENCE_PACK.md](WINDOWS_EVIDENCE_PACK.md).

## GitHub Release Artifact Policy

GitHub source zip is developer source. End users should use the Windows
single-file `.exe` installer package. Every GitHub Release intended for Windows users
must attach:

- `BlueTanukiSetup-*-windows-x64.exe`,
- `BlueTanukiSetup-*-windows-x64.exe.sha256`,
- `BlueTanukiSetup-*-windows-x64.exe.manifest.json`,
- `blue-tanuki-*-windows-x64-installer.zip`,
- `blue-tanuki-*-windows-x64-installer.zip.sha256`,
- `blue-tanuki-*-windows-x64-installer.zip.manifest.json`,
- `README_INSTALL_WINDOWS.txt`.

The source release bundle must include these generated `release/windows/`
artifacts or the GitHub Release must attach them as first-class assets. The
versioned `.cmd` bootstrapper is embedded and verified by the `.exe` manifest;
it is a local build input rather than a required public download. GitHub
auto-generated source zip is not a Windows user installer. Public GA claims
still require owner GO and must remain blocked before that decision.
