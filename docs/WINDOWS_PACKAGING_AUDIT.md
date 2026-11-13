# Windows Packaging Audit

This audit records the current Windows packaging boundary.

## Artifact

`pnpm package:windows` creates:

```text
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
release/windows/blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.manifest.json
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe.sha256
release/windows/BlueTanukiSetup-1.0.0-rc.1-windows-x64.exe.manifest.json
release/windows/README_INSTALL_WINDOWS.txt
```

The unsigned IExpress `.exe` is the intended one-file entrypoint. Its cabinet
contains the generated setup command, which embeds and verifies the ZIP payload.
The ZIP remains a recovery/build artifact; normal users do not manually unpack
it. Public distribution is held pending signing and owner release GO.

`BLUE_TANUKI_WINDOWS_ARTIFACT_DIR` can select a local artifact directory. The
builder rejects a OneDrive path; use a fresh path under Windows Temp when the
checkout is synchronized.

The package contains:

- `BlueTanukiSetup.cmd`,
- `BlueTanukiSetup.ps1`,
- launcher and uninstall scripts,
- built gateway and package `dist` outputs,
- Windows `shell.exec` AppContainer and Job Object isolation helper in the `@blue-tanuki/core` runtime package,
- physical runtime `node_modules` for `@blue-tanuki/*`, `ws`, and `zod`,
- pinned `playwright-core` plus the matching Chromium runtime under
  `app/node_modules/playwright-core/.local-browsers` for the disabled-by-default,
  L3 browser preview,
- bundled Windows Node runtime zip,
- docs and packaging scripts needed for diagnostics.

## Verification

`pnpm package:windows:verify` checks the ZIP payload, its generated setup
command, and the IExpress `.exe`. The `.exe` verifier extracts only the embedded
command into a fresh temporary folder; it does not run setup or install the app.
It then checks the executable PE/CAB structure, manifest, SHA-256, extracted
command hash, and embedded ZIP hash/size. The command verifier checks:

- required installer entries,
- required runtime package entries,
- the Playwright Core version, manifest-bound Chromium executable, and
  package-local browser placement,
- bundled Windows shell isolation helper,
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

`python tooling/windows/assert_windows_oneclick_artifact.py .` audits the
payload ZIP on Ubuntu. It requires exactly one
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

Source zip is developer source. The intended Windows user artifact is
`BlueTanukiSetup-<version>-windows-x64.exe` with its matching SHA-256 and
manifest. The ZIP is the payload/recovery artifact and remains available for the
source-root helper. Normal Windows users should not run source builds or
manually extract the ZIP. Do not run `install/windows/product/BlueTanukiSetup.cmd` from the source tree.

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
- The IExpress `.exe` is unsigned and is not a signed native MSI/EXE.
- The `.exe` extraction verifier does not execute setup; installed runtime
  smoke must be run separately on Windows.
- Windows runtime install smoke must be run on Windows.
- GitHub Releases for Windows users must attach the `.exe`, its `.sha256` and
  `.manifest.json`, plus the payload ZIP and its matching sidecars and
  `README_INSTALL_WINDOWS.txt`; source zip alone is not the end-user Windows
  artifact.
- The official source release bundle includes generated `release/windows/`,
  `release/linux/`, and `release/macos/` installer artifacts when produced by
  `pnpm release:bundle`.
- Automatic update is not implemented.
- Desktop shortcut is optional through installer argument, not a GUI checkbox.
