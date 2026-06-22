# BLUE-TANUKI Update / Rollback / Recovery Runbook

BLUE-TANUKI does not currently implement an automatic updater. Updates are operator-run source or release-bundle replacements, followed by validation.

## Distribution readiness gate

`doctor` validates that installer docs, update/rollback guidance,
uninstall/purge guidance, and release bundle checks remain present. Treat a
`distribution_readiness` error as a release blocker. Fix the listed docs or
scripts, then rerun `pnpm run doctor` and `pnpm validate:packaging`.

Run `pnpm validate:release-hardening` for release-path work. It verifies that
GitHub Actions workflows are absent, that local release validation commands
remain available, that the signed native installer boundary remains explicit,
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
- `Restore` calls `POST /recovery/restore` with explicit confirmation and creates
  a pre-restore backup before overwriting current files.
- `Reset Provider` clears LLM provider key/config material and writes
  `LLM_BACKEND=stub`.
- `Reset Connector` clears Composio key/allowlist/user config and writes
  `COMPOSIO_DRY_RUN=true` plus `COMPOSIO_LIVE_EXECUTION=false`.
- `Factory Reset` clears local session, memory, failure-memory, schedules, and
  logs, while preserving `BLUE_TANUKI_AUDIT_DIR` and the recovery backup root.

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
   - Portable resident users should run `blue-tanuki resident-stop`.
2. Record the current commit or release bundle name.
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
pre-update recovery backup, and rollback-plan evidence. It still does not
implement automatic update rollback.

P11 keeps update manual-only. The Control Center Update screen verifies a
configured release bundle sidecar set and records rollback evidence, but it does
not replace app files, download updates, run a background updater, or provide a
signed native installer.

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
   `BLUE_TANUKI_FILE_ROOT/update`.
6. Stop BLUE-TANUKI before replacing app files.
7. Apply the source or release-bundle update manually.
8. Restart and run doctor, audit verification, and release verification.

If post-update validation fails, restore the previous app directory or source
commit and restore the recorded recovery backup. The rollback plan is evidence
only and has `used_for_authority=false`; it cannot approve commands or bypass
HDS-BRAIN.

## 2. Source Install Update

```bash
git status --short
git pull
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm run doctor
```

Then start with the same env file as before:

```bash
pnpm gateway:serve -- --env-file .blue-tanuki/blue-tanuki.env
```

If using the portable resident launcher, restart with:

```bash
blue-tanuki resident-start
blue-tanuki resident-status
```

## 3. Release Bundle Update

1. Verify the downloaded archive and sidecars.
2. Extract to a new app directory when possible.
3. Preserve the existing env file and local data directories.
4. Run install/setup only if the bundle path requires it.
5. Run `doctor` before start.

```bash
pnpm release:verify -- --file <bundle>
pnpm run doctor
```

Portable installers preserve env/config by default during force reinstall. Use reset options only for intentional config regeneration:

- Windows: `-ResetConfig`
- macOS/Linux: `RESET_CONFIG=1`

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
5. Use `Restore` with the selected recovery pack id for accidental config/data
   corruption.
6. Use `Reset Provider` when provider credentials, endpoint, or model config
   prevents normal operation.
7. Use `Reset Connector` when Composio credentials/allowlists/live execution
   settings are broken or should be disconnected.
8. Use `Factory Reset` only when local runtime state should be cleared. Audit and
   recovery roots are preserved; this is not an audit purge.
9. Restart the gateway, run `doctor`, and run audit verification.

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
