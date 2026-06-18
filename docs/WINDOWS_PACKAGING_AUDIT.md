# Windows Packaging Audit

This audit records the current Windows packaging boundary.

## Artifact

`pnpm package:windows` creates:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.manifest.json
release/windows/README_INSTALL_WINDOWS.txt
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
- bundled Node runtime SHA-256 against Node.js `SHASUMS256.txt`,
- `README_INSTALL_WINDOWS.txt` availability and source-tree warning,
- no `.env`, `.npmrc`, private key, `.blue-tanuki`, `.git`, or `GUI-Shell` entries,
- manifest boundaries:
  - unsigned installer,
  - secrets excluded,
  - GUI Shell not modified,
- HDS authority not modified,
- autostart disabled by default.

`python tooling/windows/assert_windows_oneclick_artifact.py .` is the
deterministic Ubuntu-side static artifact audit. It requires exactly one
`blue-tanuki-<version>-windows-x64-installer.zip` under `release/windows/`,
verifies the `.sha256` sidecar, manifest boundary fields, bundled Windows Node
runtime, built app output, launcher/runtime/app directories, and confirms the
normal installer scripts do not invoke Corepack, pnpm, npm install, Git, or a
source build.

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

Source zip is developer source. End users should receive the installer zip from
GitHub Releases or `release/windows/`. Normal Windows users should not run
source builds. Download `blue-tanuki-<version>-windows-x64-installer.zip`,
extract it, and run `BlueTanukiSetup.cmd`. Do not run `install/windows/product/BlueTanukiSetup.cmd`
from the source tree.

Root `INSTALL_WINDOWS.cmd` may use a verified local installer zip or download
and verify the matching GitHub Release asset. If neither path verifies, it fails
fast with wrong-asset guidance. Developer source build is explicit only through
`INSTALL_WINDOWS.cmd -BuildFromSource`.

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
- GitHub Releases for Windows users must attach the installer zip, `.sha256`,
  `.manifest.json`, and `README_INSTALL_WINDOWS.txt`; source zip alone is not
  the end-user Windows artifact.
- The official source release bundle includes generated `release/windows/`,
  `release/linux/`, and `release/macos/` installer artifacts when produced by
  `pnpm release:bundle`.
- Automatic update is not implemented.
- Desktop shortcut is optional through installer argument, not a GUI checkbox.
