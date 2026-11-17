# BLUE-TANUKI Update / Rollback / Recovery Runbook

BLUE-TANUKI does not implement an automatic updater. Packaged Windows Setup has explicit manual `-Update` and `-Rollback` source paths. Packaged Linux/macOS Setup has matching explicit `--update` and `--rollback` paths; the macOS app asks the operator before either operation. Updates require a newer semantic version, exact product data-schema agreement, a verified installed app/runtime tree, a retained regular configuration, a passing candidate doctor, and confirmed resident shutdown. The candidate is staged before app/runtime replacement, and one verified previous app/runtime pair is retained. Rollback requires matching schemas and verified active/previous trees, then restores the retained package after stopping the resident. Neither path migrates product data. Windows and Unix source paths have not been exercised as installed update/rollback and are not release evidence. Release and packaged-installer manifests declare the product-wide data-schema version defined in [`PERSISTED_DATA_SCHEMA.md`](PERSISTED_DATA_SCHEMA.md); matching declarations do not enable schema migration. `--force` never authorizes replacement.

## Distribution readiness gate

`doctor` validates that installer docs, update/rollback guidance,
uninstall/purge guidance, and release bundle checks remain present. Treat a
`distribution_readiness` error as a release blocker. Fix the listed docs or
scripts, then rerun `pnpm run doctor` and `pnpm validate:packaging`.

Run `pnpm validate:release-hardening` for release-path work. It verifies that
any GitHub Actions workflow uses only manual `workflow_dispatch`, has explicit
read-only workflow-level token permissions without job overrides, that local
release validation commands remain available, that the signed native installer boundary remains explicit,
and that updater state remains
`manual_update_only` with `runtime_auto_apply_available=false`. For a future
signed release, `pnpm validate:release-hardening -- --require-signing` must
fail closed until all signing and notarization/GPG credentials are present and
separate signing evidence is produced.

The Phase 11-S9 guided first-run installer is part of this gate. It is a
portable setup wrapper, not a signed native installer and not an automatic
updater. If `pnpm installer:run` fails, keep the existing env file and `.bak`
files in place, fix the reported preflight/setup/doctor issue, and rerun:

```bash
pnpm installer:verify
pnpm installer:run -- --no-serve
```

Use the Control Center Settings `Verify LLM` action before saving any provider,
endpoint, model, or API key change after update.

## Control Center recovery controls

P10 adds token-gated local recovery controls to the WebChat Control Center
Backup / Restore screen:

- `Load Recovery` calls `GET /recovery/snapshot` and shows env backup inventory,
  recovery pack inventory, persistent runtime paths, and non-authority flags.
- `Backup Now` calls `POST /recovery/backup` and creates a recovery pack under
  `BLUE_TANUKI_RECOVERY_DIR`, or under `BLUE_TANUKI_FILE_ROOT/recovery` when the
  recovery dir is unset.
- `Restore` calls `POST /recovery/restore` with explicit confirmation and a
  selected canonical store, then creates a pre-restore backup before changing
  that store. Package-level restore without `store_key` is currently blocked;
  see the status note below.
- `Reset Provider` clears LLM provider key/config material and writes
  `LLM_BACKEND=stub`. After L3 review, the Gateway pauses Cron and drains active
  commands before mutation; new work stays blocked until Gateway restart.
- `Reset Connector` clears Composio key/allowlist/user config and writes
  `COMPOSIO_DRY_RUN=true` plus `COMPOSIO_LIVE_EXECUTION=false`. It uses the same
  runtime quiescence and restart hold.
- `Factory Reset` clears local session, memory, failure-memory, schedules, and
  logs, while preserving `BLUE_TANUKI_AUDIT_DIR` and the recovery backup root.
  It also uses the runtime quiescence and restart hold.

2026-11-18 status: package-level `Restore` with no `store_key` is blocked by the
running Gateway. It would replace the persistent audit hash-chain and runtime
files while their consumers remain loaded; the live restore path has no complete
consumer quiescence and reload boundary. The endpoint returns a blocked result
before creating an L3 request or changing restore targets. Do not treat the
Control Center button as a successful restore. Individual canonical-store
restores remain available only through their existing store-specific gates. A
stopped-Gateway package restore path is not yet connected.

2026-11-18 status: Provider Reset, Connector Reset, and Factory Reset require
the HDS L3 owner review. Before the mutation, Gateway pauses Cron and drains
active command finalizations and executor tasks. It then blocks new commands,
approval resumes, and Recovery mutation requests until the Gateway restarts.
If Cron cannot be proven quiescent, the reset is not invoked; the runtime hold
remains closed and a Gateway restart is required before further work.

Recovery metadata, backup manifests, and action results are evidence only:
`used_for_authority=false`. They cannot approve commands, resume suspended HDS
work, classify risk, or bypass final review.

Env files and recovery packs are secret-bearing. Do not upload or paste recovery
pack contents into issue trackers or chat logs.

Phase 11-S10 resident launcher commands are part of the distribution surface.
Before replacing an installed app directory, stop the resident gateway and record
autostart state:

```bash
blue-tanuki resident-status
blue-tanuki resident-autostart-status
blue-tanuki resident-stop
```

## 1. Before Update

1. Stop the gateway if it is running.
   - Packaged Setup confirms resident shutdown before changing app/runtime files.
   - Portable resident users can run `blue-tanuki resident-stop`.
2. Record the current commit or release bundle name and inspect the installed
   package version.
3. Back up local config and data:
   - Prefer Control Center `Backup Now` when the gateway is healthy enough to
     serve the WebChat UI.
   - env file
   - env `.bak` files
   - `BLUE_TANUKI_AUDIT_DIR`
   - `BLUE_TANUKI_SESSION_DIR`
   - `BLUE_TANUKI_MEMORY_DIR`
   - `BLUE_TANUKI_SCHEDULES_DIR`
   - `BLUE_TANUKI_APPROVALS_FILE`
4. Run audit verification:

```bash
node apps/gateway/dist/main.js --audit-verify
```

If audit verification fails, stop the update and handle audit recovery first.

P10 does not implement update-before-backup. P11 adds manual update readiness,
pre-update recovery backup, and rollback-plan evidence. Packaged Setup now also
retains one verified app/runtime package generation for an explicit local
rollback. Neither rollback path restores product data or replaces the
Control Center's recovery backup.

P11 keeps Control Center update manual-only. The Control Center Update screen verifies a
configured release bundle sidecar set and records rollback evidence, but it does
not inspect every installed persisted-data store, apply migrations, replace app
files, download updates, run a background updater, or provide a signed native
installer. It compares the declared product data-schema version from the
candidate manifest with the installed marker. A match is version-declaration
evidence only; no application replacement may proceed on that evidence.
Packaged Setup's separate explicit update flow is narrower: it requires the
exact shared data-schema version and a newer package version, preserves
configuration, runs the packaged doctor against the candidate, stops the
resident, and retains one verified previous package. It does not apply a schema
migration or claim complete product-data backup coverage.

## Packaged Setup update and rollback

Linux users run the verified .run installer with --update or --rollback.
macOS command-installer users use --update or --rollback; the bundled macOS
product app offers explicit confirmation buttons for update and rollback.
The Windows self-extracting installer presents an explicit update, rollback,
or cancel choice when it finds a verified existing installation. Setup
revalidates the selected operation before any replacement. Users running the
packaged ZIP command directly can still choose `-Update` or `-Rollback`.
In-place replacement without an explicit action remains blocked, and `-Force`
does not authorize it.

The installer keeps the current settings and product data in place. It requires
matching product data-schema declarations and one verified previous app/runtime
pair. An update candidate must have a strictly newer semantic version. Rollback
uses the retained pair and consumes that pair only after the active package is
verified; the package that was active before rollback becomes the new retained
version. A stale or ambiguous transaction path blocks the operation and is
preserved for inspection. Runtime execution on packaged Windows/Linux/macOS
installations remains unverified; this source implementation is not release
evidence.

## Control Center update controls

Use the Update screen when the gateway is healthy enough to serve WebChat:

1. Generate or place a release bundle with matching `.sha256` and
   `.manifest.json` sidecars.
2. Optionally point `BLUE_TANUKI_UPDATE_BUNDLE` at that archive. If unset,
   BLUE-TANUKI checks the default `release/blue-tanuki-<version>-source-bundle`
   archive for the current platform.
3. Open Control Center, enter the maintenance token, and run `Load Update`.
4. Run `Verify Bundle`. The archive sha256, sha sidecar, manifest, unsigned
   source bundle boundary, no-secret boundary, and core release paths must match.
5. Run `Prepare Update`. This requires explicit confirmation, creates a P10
   recovery backup, and writes a rollback plan under `BLUE_TANUKI_UPDATE_DIR` or
   `BLUE_TANUKI_FILE_ROOT/update`. This records recovery evidence only; it does
   not establish complete backup coverage or update readiness.
6. Read the compatibility result in the Update screen. Legacy installs without
   a product data-schema marker remain `unknown`; a schema-version mismatch is
   `blocked`. A matching declaration does not by itself enable application
   replacement.
   The release-manifest format version is not a product data-schema version.
7. The Control Center path remains evidence-only and never replaces application
   files. Packaged Setup has a separate manual update / rollback path for
   Windows, Linux, and macOS, but installed update/rollback has not been run and
   remains unverified. Do not use `--force` or copy source files over an installed
   product.
8. After a verified packaged update or rollback, start the product and inspect
   doctor/audit state. A source parse/build alone does not establish installed
   update success.

After uninstall with data retained, product Setup permits reattachment only
when the retained marker has the same product data-schema version as the
candidate package and all product roots match. Legacy or missing markers and a
different version are treated as unknown/incompatible; the retained data is not
changed. A matching schema declaration permits data reuse after uninstall; it
does not by itself authorize in-place application replacement.

If post-update validation fails, restore the previous app directory or source
commit and restore only data covered by a verified recovery backup. If any data
store changed by the update is outside that verified scope, stop and preserve
the current files and recovery evidence; do not claim that rollback is safe or
complete. The rollback plan is evidence only and has `used_for_authority=false`;
it cannot approve commands or bypass HDS-BRAIN.

## 2. Manual packaged replacement status

Windows packaged Setup exposes `-Update` and `-Rollback` in source. `-Update`
requires a verified existing Windows product, a strictly newer semantic version,
matching installed/candidate/data-marker product data-schema versions, an
existing regular env file, and the candidate doctor. It refuses config reset,
doctor skip, schema migration, downgrade, and force-style replacement. The
resident is stopped and rechecked before the app directory is swapped. Failed
or interrupted swaps restore the previous app and preserve the failed candidate
for inspection; successful swaps retain one prior app version beside the
install root. `-Rollback` uses a compatible packaged Setup, restores the
retained app, and retires the replaced app after verification; data roots are
not migrated or deleted. Windows Uninstall preflights and removes verified
previous/interrupted app trees while retaining product data unless explicit
data purge is requested.

This is source-level behavior only. Runtime confirmation for installed Windows
update, interruption recovery, rollback, configuration preservation, and
uninstall cleanup is `NOT_RUN`; do not treat the path as release-ready. Linux
and macOS packaged Setup also contain explicit `--update` and `--rollback`
source paths with schema, version, candidate-doctor, resident-stop, and retained
package checks; their installed flows are likewise unverified. No source-tree
replacement, background updater, network download, signature, or OS-protection
bypass is introduced. Release verification still does not prove these installed
flows.

## 3. Fresh install and retained data

A fresh install into empty product roots remains available and records the
current product data-schema version. After uninstall, retained product data may
be reattached only to a package that declares the same version. Missing legacy
markers and changed versions remain blocked; no migration is performed.

## 4. Config Preservation

Do not overwrite these unless intentionally resetting:

- `WEBCHAT_TOKEN`
- `WEBCHAT_RESUME_TOKEN`
- `BLUE_TANUKI_MAINTENANCE_TOKEN`
- `BLUE_TANUKI_SETTINGS_TOKEN`
- LLM provider settings
- audit/session/memory/schedule paths
- approval grants path

If setup or settings writes a new env file, confirm the `.bak` exists before deleting anything.

## 5. Audit / Session / Memory Preservation

- Audit is evidence. Keep it unless deliberately purging the installation.
- Session history is downstream LLM continuity. Losing it should not affect authority.
- Memory is not authority. Losing it should not grant or remove permission.
- Runtime schedule store controls future actions; back it up and validate it after update.

## 6. Rollback

### Source rollback

```bash
git status --short
git log --oneline -5
git switch main
git pull
```

Use the previously recorded commit or backup branch according to local policy, then rerun:

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm run doctor
```

### Release bundle rollback

1. Stop gateway.
   - Portable resident users should run `blue-tanuki resident-stop`.
2. Restore the previous app directory or previous release bundle.
3. Reuse the preserved env file and local data directories.
4. Run `doctor`.
5. Run `--audit-verify`.
6. Start gateway.

Rollback must not silently reset tokens or delete audit evidence.

### Control Center restore / reset

Use these controls when the gateway still starts and maintenance token access is
available:

1. Open Control Center.
2. Go to Backup / Restore.
3. Enter the maintenance token and load recovery state.
4. Run `Backup Now` before any reset.
5. Do not use package-level `Restore` (`store_key` omitted) while Gateway is
   running; it returns a blocked result and makes no restore request. The
   stopped-Gateway package restore path is not yet connected. Individual
   canonical-store restores use their store-specific controls and gates.
6. Use `Reset Provider` when provider credentials, endpoint, or model config
   prevents normal operation.
7. Use `Reset Connector` when Composio credentials/allowlists/live execution
   settings are broken or should be disconnected.
8. Use `Factory Reset` only when local runtime state should be cleared. Audit and
   recovery roots are preserved; this is not an audit purge.
9. After a reset, do not start new work until Gateway restart. After restart or
   an approved individual-store restore, run `doctor` and audit verification.

## 7. Recovery: Audit Chain Broken

If boot fails because the audit chain is broken:

1. Stop gateway.
2. Run:

```bash
node apps/gateway/dist/main.js --audit-verify --json
node apps/gateway/dist/main.js --audit-dump --json
```

3. Quarantine the broken file or truncate to a verified good prefix.
4. Keep the broken file for post-incident analysis.
5. Restart gateway and confirm a new or repaired chain verifies.

Audit is tamper-evident, not magically self-healing. Do not edit the live chain casually.

## 8. When To Stop

Stop and do not continue the update when:

- `doctor` exits with code `2`
- `--audit-verify` reports broken chain
- release verification reports a secret-like file inside the bundle
- Runtime Invariants differ from expected values
- Approval Gate no longer stops final-review operations
- schedule content appears in runtime snapshot

## 9. Uninstall / Purge

Default uninstall preserves local data. Purge deletes it.

Use purge only after deciding that env, audit, session, memory, schedule, and approval grant data may be destroyed.

Platform commands are documented in [install/README.md](../install/README.md).
