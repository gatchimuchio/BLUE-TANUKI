# Windows Packaging Audit

This audit records the current Windows packaging boundary.

## Artifact

`pnpm package:windows` creates:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.manifest.json
```

The package contains:

- `BlueTanukiSetup.cmd`,
- `BlueTanukiSetup.ps1`,
- launcher and uninstall scripts,
- built gateway and package `dist` outputs,
- physical runtime `node_modules` for `@blue-tanuki/*`, `ws`, and `zod`,
- bundled Windows Node runtime zip,
- docs and packaging scripts needed for diagnostics.

## Verification

`pnpm package:windows:verify` checks:

- required installer entries,
- required runtime package entries,
- bundled Node runtime declaration,
- Start Menu and uninstall registration source text,
- explicit owner autostart commands and default-disabled autostart boundary,
- SHA-256 sidecar and manifest availability,
- no `.env`, `.npmrc`, private key, `.blue-tanuki`, `.git`, or `GUI-Shell` entries,
- manifest boundaries:
  - unsigned installer,
  - secrets excluded,
  - GUI Shell not modified,
- HDS authority not modified,
- autostart disabled by default.

## Installed-App Evidence

`pnpm smoke:windows-installed` verifies the installed app on Windows and emits
the evidence markers listed in `docs/WINDOWS_EVIDENCE_PACK.md`, including
install, launch, GUI first message, repair retention, explicit HKCU Run-entry
reboot persistence, port conflict, approval API token separation, audit tamper
failure, watchdog crash recovery, stop/doctor/restart, safe mode, SmartScreen
guidance, and purge uninstall.

## Runtime Bundling

The installer package bundles Node.js `22.14.0` for Windows x64 as a zip and
expands it during install. The installed app launches using that bundled
`node.exe`.

The user does not run:

- `pnpm install`,
- `pnpm build`,
- Git commands,
- repository PowerShell setup scripts,
- Node.js installers.

## Security / Authority

Packaging does not alter:

- HDS-BRAIN authority model,
- Approval Gate,
- hash-chain audit,
- capability envelope,
- plugin review gate,
- Runtime Invariants.

The installed GUI uses existing WebChat endpoints. UI state remains display and
intent only.

## Known Limitations

- The package is unsigned.
- SmartScreen continuation requires operator-side SHA-256 verification against
  the `.sha256` sidecar.
- It is a zip-delivered installer package, not a signed MSI/EXE.
- Windows runtime install smoke must be run on Windows.
- Automatic update is not implemented.
- Desktop shortcut is optional through installer argument, not a GUI checkbox.
