# BLUE-TANUKI Installer Guide

## Purpose

The Phase 11-S9 installer provides a guided first-run path for local source
checkouts and portable release bundles. It also provides SIM-like LLM API settings
through Control Center verification. It coordinates setup, doctor, and Control
Center handoff while preserving the existing HDS authority, Approval Gate,
audit, and runtime invariant boundaries.

This guided source/bundle installer is not a signed native installer and not an automatic updater.

## Product Installer Packages

The Windows/macOS/Linux GUI product paths are separate from `pnpm installer:run`.
Normal users should not run source builds.

```bash
pnpm build
pnpm package:windows
pnpm package:windows:verify
pnpm package:linux
pnpm package:linux:verify
pnpm package:macos
pnpm package:macos:verify
pnpm package:installers
pnpm package:installers:verify
```

This creates unsigned payload/recovery archives and single-file normal user
installers under `release/windows/`, `release/linux/`, and `release/macos/`.
Each package bundles Node.js through the verified payload and installs
BLUE-TANUKI without asking the end user to run Node.js, Corepack, pnpm, Git,
shell/PowerShell setup scripts, nested extraction, or repository commands.

Normal Windows users should not run source builds. Download
`BlueTanukiSetup-<version>-windows-x64.cmd` and run it. The
`blue-tanuki-<version>-windows-x64-installer.zip` artifact is payload/recovery.

Normal macOS users should not run source builds. Download
`BlueTanukiSetup-<version>-macos-<arch>.command` and run it. The
`blue-tanuki-<version>-macos-<arch>-installer.tar.gz` artifact is
payload/recovery.

Normal Linux users should not run source builds. Download
`BlueTanukiSetup-<version>-linux-x64.run` and run it. The
`blue-tanuki-<version>-linux-x64-installer.tar.gz` artifact is payload/recovery.

See:

- [WINDOWS_INSTALLER_GUIDE.md](WINDOWS_INSTALLER_GUIDE.md)
- [WINDOWS_FIRST_RUN.md](WINDOWS_FIRST_RUN.md)
- [WINDOWS_PACKAGING_AUDIT.md](WINDOWS_PACKAGING_AUDIT.md)
- [WINDOWS_UNINSTALL.md](WINDOWS_UNINSTALL.md)

## Guided First-Run

Run from the repository or extracted bundle root:

```bash
pnpm installer:run
```

For setup without starting the gateway:

```bash
pnpm installer:run -- --no-serve
```

The flow performs:

- repository preflight via `pnpm installer:verify`
- Corepack/pnpm preparation when not skipped
- dependency install and build when not skipped
- env file generation through the existing setup path
- `doctor` validation
- Control Center Settings handoff

## SIM-like LLM API Settings

After the gateway is running, open Settings and configure the provider, model,
endpoint, and API key. Use `Verify LLM` before saving non-stub changes.

`Verify LLM` is non-mutating:

- it does not write the env file
- it does not print API key values
- it returns pass/fail detail and an owner next action
- the `stub` provider verifies without external network access

API key values are stored only through the env file/settings path and are
redacted from Control Center status, runtime snapshots, doctor output, and
audit output.

## Common Commands

```bash
pnpm installer:verify
pnpm installer:run -- --no-serve
pnpm installer:run -- --provider stub
pnpm installer:run -- --provider openai --model gpt-4.1-mini --no-serve
pnpm installer:run -- --provider openai-compatible --endpoint http://127.0.0.1:11434/v1 --model local-model --no-serve
```

Use `--force` only when intentionally replacing the target env file. Existing
env files are backed up through the setup/settings `.bak` path.

## Failure Handling

If preflight fails, fix the reported Node.js, package manager, or repository
layout issue, then rerun:

```bash
pnpm installer:verify
```

If setup or doctor fails, keep the env file and `.bak` files in place. Fix the
reported issue, then rerun:

```bash
pnpm installer:run -- --no-serve
```

If `Verify LLM` fails, do not save the candidate provider settings. Check the
provider, endpoint, model, and API key, then verify again.

## Boundaries

- The installer does not intervene in the HDS-BRAIN authority path.
- The installer does not bypass final-review operations.
- The installer does not change Layer A / Layer B boundaries.
- Resident OS integration is provided by Phase 11-S10 launcher commands and
  remains downstream lifecycle glue over the existing Gateway serve path.
- The installer does not provide a signed native installer.
- The installer does not provide an automatic updater.
- The installer is a guided first-run path, not a verified 5-minute setup
  guarantee.
- The Windows normal-user package is an unsigned single-file command installer.
  It is not a signed native installer package such as MSI/EXE, but it does
  provide internally verified payload extraction, bundled runtime install,
  Start Menu shortcuts, Control Center launch, Doctor shortcut, logs shortcut,
  and current-user uninstall.
- The Linux/macOS normal-user packages are unsigned single-file shell/command
  installers. They are not signed native installer packages such as
  DMG/DEB/RPM, but they do provide internally verified payload extraction,
  bundled runtime install, current-user launchers, Control Center launch,
  Doctor, logs, explicit autostart controls, and current-user uninstall.

## Cross-References

- [install/README.md](../install/README.md)
- [RESIDENT_APP_GUIDE.md](RESIDENT_APP_GUIDE.md)
- [FIRST_RUN_CHECKLIST.md](FIRST_RUN_CHECKLIST.md)
- [PERMANENT_USE_CHECKLIST.md](PERMANENT_USE_CHECKLIST.md)
- [UPDATE_ROLLBACK_RUNBOOK.md](UPDATE_ROLLBACK_RUNBOOK.md)
- [CONFORMANCE.md](CONFORMANCE.md)
