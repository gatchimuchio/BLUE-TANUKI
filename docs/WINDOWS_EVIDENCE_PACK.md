# Windows Evidence Pack

This document defines the Windows installed-app evidence expected before owner GO.
It is evidence only; it does not activate GA, public claims, or authority.

## Evidence Source

- `CONFIG`: package manifest, docs, sidecar SHA-256, unsigned-package boundary.
- `LIVE_RUNTIME`: installed gateway, WebChat, approval API, audit verifier,
  resident launcher, watchdog, safe mode, uninstall.
- `EXTERNAL_EVIDENCE`: Windows artifact, extracted install tree, HKCU Run entry,
  owner-run `validate-product-windows` evidence pack.

## Required Markers

`scripts/smoke_windows_installed.ts` must emit these markers on Windows:

- `install_result=pass`
- `source_tree_setup_guidance_result=pass`
- `root_source_entrypoint_result=pass`
- `root_source_entrypoint_build_from_source_result=pass`
- `root_source_entrypoint_cmd_result=pass`
- `installer_zip_setup_result=pass`
- `launch_result=pass`
- `gui_result=pass`
- `first_message_result=pass`
- `repair_install_result=pass`
- `reboot_persistence_result=pass`
- `port_conflict_result=pass`
- `approval_flow_result=pass`
- `audit_tamper_result=pass`
- `crash_recovery_result=pass`
- `stop_result=pass`
- `doctor_result=pass`
- `restart_result=pass`
- `safe_mode_result=pass`
- `defender_smartscreen_guidance_result=pass`
- `uninstall_result=pass`

`validate:product` treats these markers as required for
`p3.windows_installed_smoke`.

## Boundary

The reboot persistence check verifies explicit owner opt-in autostart by
creating and removing an HKCU Run entry under a smoke-specific name. Install and
setup still must not enable autostart by default.

The Defender / SmartScreen check verifies packaged SHA-256 and unsigned-package
guidance. It does not claim Microsoft SmartScreen reputation, code signing, or a
signed native installer.

The source-tree guidance check verifies that direct execution of
`install/windows/product/BlueTanukiSetup.cmd` from source does not expose raw
package-layout errors and points the operator to the packaged installer zip or
explicit developer source build.

The root entrypoint check verifies that a missing local installer zip uses a
verified release download/fail-closed path and does not run source build by
default. The separate `root_source_entrypoint_build_from_source_result=pass`
marker verifies that source build is available only through explicit
`-BuildFromSource`.

The approval flow check verifies installed WebChat approval API token separation.
It does not make the UI an authority path.

The audit tamper check verifies that a copied and modified audit chain fails
audit verification. It does not corrupt the live audit store.

`used_for_authority=false`.
