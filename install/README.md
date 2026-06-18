# BLUE-TANUKI portable installers

These scripts and package builders are the installer layer.

There are three distinct paths:

1. source/dev run from the repository,
2. explicit developer source-build scripts,
3. unsigned packaged installer artifacts for users who should not run Node,
   Corepack, pnpm, Git, source builds, setup scripts, or repository commands manually.

The repository does not build signed native packages yet. The product packages
are unsigned archive-delivered installer packages, not signed MSI/EXE/DMG/DEB/RPM
native packages.

## One-click entrypoints

Use the packaged installer entrypoint for every normal user path:

```text
Windows: BlueTanukiSetup.cmd from blue-tanuki-<version>-windows-x64-installer.zip
macOS:   BlueTanukiSetup.command from blue-tanuki-<version>-macos-<arch>-installer.tar.gz
Linux:   BlueTanukiSetup.sh from blue-tanuki-<version>-linux-x64-installer.tar.gz
```

Normal Windows, macOS, and Linux users should not run source builds. The
installed launcher opens `http://127.0.0.1:8787/app` and does not require
user-installed Node.js, Corepack, pnpm, Git, or source-build troubleshooting.

The source-root entrypoints (`INSTALL_WINDOWS.cmd`, `INSTALL_MACOS.command`,
`INSTALL_LINUX.sh`, and `INSTALL.sh`) are convenience helpers only. They use a
verified packaged installer under `release/` or download the matching GitHub
Release asset. If the packaged installer cannot be verified, they fail fast
with wrong-asset guidance instead of building from source.

Developer source build is explicit only:

```bash
sh ./INSTALL_MACOS.sh --build-from-source
sh ./INSTALL_LINUX.sh --build-from-source
```

```powershell
.\INSTALL_WINDOWS.cmd -BuildFromSource
```

To install without launching from an extracted packaged installer:

```bash
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.command
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.sh
```

`NO_LAUNCH=1` is accepted as an equivalent suppression flag for macOS/Linux
entrypoints. Linux desktop double-click behavior depends on the desktop
environment; `INSTALL_LINUX.desktop` is provided for desktops that allow local
launchers, and `sh ./INSTALL_LINUX.sh` remains the portable fallback.

## Distribution readiness

`doctor` checks that this installer guide, update/rollback guidance,
uninstall/purge paths, and release-bundle verification scripts are present
before release. This is an operator-safety gate, not a claim that BLUE-TANUKI
ships as a signed native product or has an automatic updater.
The portable installer does not build signed native packages yet.
Use the uninstall dry-run option before destructive removal when available.

## Platform installer packages

Build from a prepared development workspace:

```bash
pnpm build
pnpm package:windows
pnpm package:windows:verify
pnpm package:linux
pnpm package:linux:verify
pnpm package:macos
pnpm package:macos:verify
```

Artifacts:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
release/linux/blue-tanuki-1.0.0-rc.1-linux-x64-installer.tar.gz
release/macos/blue-tanuki-1.0.0-rc.1-macos-x64-installer.tar.gz
release/macos/blue-tanuki-1.0.0-rc.1-macos-arm64-installer.tar.gz
```

User flow:

```text
1. Extract the zip.
2. Double-click BlueTanukiSetup.cmd.
3. Start BLUE-TANUKI from the Start Menu.
4. Use Conversation / WebChat in the Control Center.
```

Do not run `install/windows/product/BlueTanukiSetup.cmd` from the source tree.
Normal Windows users should not run source builds. Download
`blue-tanuki-<version>-windows-x64-installer.zip`, extract it, and run
`BlueTanukiSetup.cmd`.

Normal macOS users should not run source builds. Download
`blue-tanuki-<version>-macos-<arch>-installer.tar.gz`, extract it, and run
`BlueTanukiSetup.command`.

Normal Linux users should not run source builds. Download
`blue-tanuki-<version>-linux-x64-installer.tar.gz`, extract it, and run
`BlueTanukiSetup.sh`.

Root platform entrypoints use an existing installer artifact or download and
verify the matching GitHub Release installer asset. If the packaged installer
cannot be verified, they fail fast with wrong-asset guidance. They do not build
from source unless a developer explicitly runs:

```powershell
.\INSTALL_WINDOWS.cmd -BuildFromSource
```

The package bundles Windows Node.js `22.14.0`, installs to
`%LOCALAPPDATA%\Programs\BlueTanuki`, stores env/settings/logs under
`%APPDATA%\BlueTanuki`, creates Start Menu shortcuts, and registers current-user
uninstall. Desktop shortcut creation is optional via `-DesktopShortcut`.

The Linux/macOS packages bundle Node.js `22.14.0`, install to current-user
locations, create current-user launchers, leave autostart disabled by default,
and preserve user data on normal uninstall.

The installer runs first-run setup in stub mode and post-install doctor. The
installer does not silently enable autostart and does not change HDS-BRAIN
authority, Approval Gate, audit, capability envelope, or Plugin Review Gate.

Windows installed-app smoke:

```bash
pnpm smoke:windows-installed
pnpm smoke:linux-installed
pnpm smoke:macos-installed
```

Platform installed-app smoke installs into temporary locations, launches the
bundled runtime, sends one stub WebChat message, checks approval token
separation, verifies audit tamper detection, exercises crash recovery, safe
mode, port-conflict handling, repair install, and uninstall. Runtime smoke is
skipped only when the current host does not match the target platform.

## Guided first-run installer

Phase 11-S9 adds a guided first-run wrapper for source and release-bundle users:

```bash
pnpm installer:run
```

This path performs preflight checks, uses the workspace package manager, runs
setup, runs `doctor`, and opens the path toward the Control Center settings UI.
It is a developer/source guided first-run accelerator, not the normal Windows
user install path and not a verified 5-minute setup guarantee.

Use the Control Center Settings page and the `Verify LLM` action before saving
LLM provider changes. On Windows, settings-saved LLM API keys are stored as
DPAPI CurrentUser secret references next to the env file; on other platforms
they remain env-file material until a later keychain phase. API key values are
not printed by the installer, doctor, runtime snapshot, or audit output.

For a non-serving setup pass:

```bash
pnpm installer:run -- --no-serve
```

For local OpenAI-compatible endpoints:

```bash
pnpm installer:run -- --provider openai-compatible --endpoint http://127.0.0.1:11434/v1 --model local-model --no-serve
```

## Requirements

These requirements apply to source/dev and guided first-run paths. They do not
apply to normal packaged installer users.

- Node.js `>=22.14.0`
- Corepack or pnpm
- Network access for the first dependency install

## Windows

Run from an extracted release bundle:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\install.ps1
```

Optional:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\install.ps1 -Force
powershell -ExecutionPolicy Bypass -File .\install\windows\install.ps1 -Force -ResetConfig
powershell -ExecutionPolicy Bypass -File .\install\windows\install.ps1 -SkipDoctor
powershell -ExecutionPolicy Bypass -File .\install\windows\uninstall.ps1
powershell -ExecutionPolicy Bypass -File .\install\windows\uninstall.ps1 -Purge
powershell -ExecutionPolicy Bypass -File .\install\windows\uninstall.ps1 -DryRun
```

The installer creates launchers under `%APPDATA%\BlueTanuki\bin`.

```powershell
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" start
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" doctor
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" settings
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" env
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" resident-start
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" resident-status
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" resident-stop
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\BlueTanuki\bin\blue-tanuki.ps1" resident-autostart-enable
```

## macOS

Normal user path:

```bash
mkdir blue-tanuki-macos-installer
tar -xzf blue-tanuki-<version>-macos-<arch>-installer.tar.gz -C blue-tanuki-macos-installer
cd blue-tanuki-macos-installer
sh ./BlueTanukiSetup.command
```

The source-root helper `INSTALL_MACOS.command` is not the normal user artifact.
It only verifies/runs a packaged installer from `release/macos/`, downloads a
matching GitHub Release asset, or fails fast as wrong asset.

Developer source-build path:

```bash
sh ./INSTALL_MACOS.sh --build-from-source
```

Developer-only options:

```bash
FORCE=1 sh ./install/macos/install.sh
FORCE=1 RESET_CONFIG=1 sh ./install/macos/install.sh
RUN_DOCTOR=0 sh ./install/macos/install.sh
LAUNCH_AFTER_INSTALL=0 sh ./install/macos/install.sh
sh ./install/macos/uninstall.sh
PURGE=1 sh ./install/macos/uninstall.sh
DRY_RUN=1 sh ./install/macos/uninstall.sh
```

The installer creates `~/.local/bin/blue-tanuki`.

```bash
~/.local/bin/blue-tanuki start
~/.local/bin/blue-tanuki doctor
~/.local/bin/blue-tanuki settings
~/.local/bin/blue-tanuki env
~/.local/bin/blue-tanuki resident-start
~/.local/bin/blue-tanuki resident-status
~/.local/bin/blue-tanuki resident-stop
~/.local/bin/blue-tanuki resident-autostart-enable
```

## Linux

Normal user path:

```bash
mkdir blue-tanuki-linux-installer
tar -xzf blue-tanuki-<version>-linux-x64-installer.tar.gz -C blue-tanuki-linux-installer
cd blue-tanuki-linux-installer
sh ./BlueTanukiSetup.sh
```

The source-root helper `INSTALL_LINUX.sh` is not the normal user artifact. It
only verifies/runs a packaged installer from `release/linux/`, downloads a
matching GitHub Release asset, or fails fast as wrong asset. `INSTALL_LINUX.desktop`
only dispatches to that source-root helper.

Developer source-build path:

```bash
sh ./INSTALL_LINUX.sh --build-from-source
```

Developer-only options:

```bash
FORCE=1 sh ./install/linux/install.sh
FORCE=1 RESET_CONFIG=1 sh ./install/linux/install.sh
RUN_DOCTOR=0 sh ./install/linux/install.sh
LAUNCH_AFTER_INSTALL=0 sh ./install/linux/install.sh
sh ./install/linux/uninstall.sh
PURGE=1 sh ./install/linux/uninstall.sh
DRY_RUN=1 sh ./install/linux/uninstall.sh
```

The installer creates `~/.local/bin/blue-tanuki`.

```bash
~/.local/bin/blue-tanuki start
~/.local/bin/blue-tanuki doctor
~/.local/bin/blue-tanuki settings
~/.local/bin/blue-tanuki env
~/.local/bin/blue-tanuki resident-start
~/.local/bin/blue-tanuki resident-status
~/.local/bin/blue-tanuki resident-stop
~/.local/bin/blue-tanuki resident-autostart-enable
```

## Resident app lifecycle

Phase 11-S10 adds portable resident integration commands to the generated
launchers. These commands start the normal Gateway serve process in the
background, report status, open Control Center, show logs, and manage explicit
current-user autostart where supported:

```bash
blue-tanuki resident-start
blue-tanuki resident-status
blue-tanuki resident-open
blue-tanuki resident-logs
blue-tanuki resident-stop
blue-tanuki resident-autostart-status
blue-tanuki resident-autostart-enable
blue-tanuki resident-autostart-disable
```

Autostart is never enabled by install/setup itself. It is only enabled when the
owner runs `resident-autostart-enable`. The resident app path does not provide a
signed native installer and does not implement an automatic updater.

## Settings

After launching, open:

```text
http://127.0.0.1:8787/settings
```

Use `BLUE_TANUKI_SETTINGS_TOKEN` from the generated env file. The settings API
edits that env file and requires restart.

## Post-install doctor

Installers run `doctor` after setup by default. Exit code `2` blocks the
install, while exit code `1` is treated as warnings so optional Slack/Discord
or live LLM credentials can remain unset during local setup.

## Reinstall and upgrade

`-Force` on Windows and `FORCE=1` on macOS/Linux replace the app directory but
leave an existing env file intact. The installer preserves WebChat tokens,
resume tokens,
settings tokens, LLM provider settings, audit paths, and session paths stable
across reinstall or portable upgrade.

Use `-ResetConfig` on Windows or `RESET_CONFIG=1` on macOS/Linux only when the
env file should be regenerated intentionally.

When setup or settings overwrites an env file, the previous file is kept as a
timestamped `.bak` file next to the env file.

## Uninstall

Uninstallers remove the installed app and launcher by default while preserving
the env file, audit chain, sessions, and local data. Use `-Purge` on Windows or
`PURGE=1` on macOS/Linux to remove the retained data as well. Use `-DryRun` or
`DRY_RUN=1` to preview the removal.
