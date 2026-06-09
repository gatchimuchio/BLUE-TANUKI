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

## Included Shortcuts

- `BLUE-TANUKI` opens the Control Center.
- `BLUE-TANUKI Doctor` runs Doctor and opens the doctor log.
- `BLUE-TANUKI Logs` opens the logs folder.
- `BLUE-TANUKI Stop` stops the resident runtime.
- `Uninstall BLUE-TANUKI` removes the app while preserving user data by default.

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
