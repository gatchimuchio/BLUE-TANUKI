# Changelog

## Unreleased

### Changed

- Replaced repository-wide Codex agent rules in `AGENTS.md` with the Phase 8/v1.0 completion posture.
- Added `docs/IMPLEMENTATION_INSTRUCTIONS.md` as the active execution plan, with Phase 8-S1 (`ApprovalLevel` first-class + runtime schedule CRUD) as the next implementation lane.
- Replaced `docs/ROADMAP.md` with a v9 roadmap aligned to the active implementation instructions.
- Added Phase 8-S1: first-class `ApprovalLevel`, three-tier `ApprovalRisk`, L3 runtime schedule create/update/delete, safe schedule snapshots, and schedule lifecycle audit.
- Advanced active implementation docs to Phase 8-S2a after Phase 8-S1 completion.
- Added Phase 8-S2a operator-usability docs: first-run checklist, permanent-use checklist, channel readiness matrix, credential readiness matrix, update/rollback runbook, and docs static checker.
- Added Phase 8-S2b: actionable doctor remediation fields and safe runtime first-run status fields.
- Added Phase 8-S3: internal OpenClaw rejection audit document and advanced the active execution lane to GitHub write.
- Added Phase 8-S4: authenticated `github.write` tool with repository allowlist, L3 final-review mapping, capability envelope, and audit-safe result digests.
- Added Phase 8-S5: Slack / Discord release-polished preview with typed delivery errors, adapter retry/backoff, live smoke error detail, and updated readiness docs.
- Added Phase 8-S6: disabled-by-default browser automation preview with `browser.snapshot`, guarded `browser.automation`, L2/L3 ApprovalLevel mapping, credential denial, network/resource limits, smoke skip path, and advanced the active execution lane to F-reference audit integration.
- Added Phase 9-S1: `F:<id>` memory read/write references in audit and Control Center traces while preserving `memory_used_for_authority=false`.
- Added Phase 9-S2: read-only `gmail.read`, `google.calendar.read`, and `google.drive.read` tools, credential-scoped Google Daily Brief source, doctor/docs coverage, and advanced the active execution lane to Google write.
- Added Phase 9-S3: bounded `gmail.write`, `google.calendar.write`, and `google.drive.write` tools with L3 final-review mapping, fail-closed credential handling, audit-safe mutation summaries, and advanced the active execution lane to Teams / LINE adapters.
- Added Phase 9-S4: Microsoft Teams and LINE first-party-preview adapters with capability manifests, conformance tests, live smoke skip paths, doctor/compatibility gates, typed delivery failures, and updated readiness docs.
- Added Phase 10-S1: resident Control Center approval UX polish with permanent-use status, first-run next action, ApprovalLevel/final-review queue display, runtime schedule state, audit summaries, authority trace summaries, and redacted JSON panes.
- Added Phase 10-S2: display-only resident notifications for approval-required, schedule fired/failed, connector failure, and audit-warning states through `/notifications` and Control Center.
- Added Phase 10-S3: distribution readiness hardening with a `doctor` gate for installer/update/uninstall docs, release-bundle checks, packaging validation, and explicit no-signed-installer / no-automatic-updater boundaries.
- Added Phase 11-S1: v1.0 security and permanent-use review closure, documenting authority, Approval Gate, preview, distribution, recovery, and validation status.
- Added Phase 11-S2: v1.0 release-candidate preparation with workspace version `1.0.0-rc.1`, docs index, RC claim/support boundary, upgrade notes, validation matrix, and v1.0 compatibility targets.
- Added post-RC closure review covering bundle sidecar integrity, Windows `smoke:resume` proof, credentialed live-smoke blocker, preview-channel promotion decision, signed-installer decision, and updater decision.
- Fixed CI root smoke dependency resolution by declaring `ws` and `@types/ws` at the workspace root and updating `pnpm-lock.yaml`.
- Added CI placeholder env values so `pnpm run doctor` remains warning-free without enabling credentialed live smoke targets.
- Reclassified root `smoke:serve` / `smoke:resume` as actionable CI/release checks after the root smoke dependency repair.
- Fixed root workspace script delegation so `pnpm run setup -- --yes` and `pnpm run doctor` do not collide with pnpm built-ins.
- Added Phase Completion Discipline to `AGENTS.md` and changed backup policy to the fixed two-generation `codex/backup-main` / `codex/backup-main-prev` model.
- Added Phase 11-S3 strategic frame and GA bar closure docs, including Layer A/B strategy, OpenClaw two-dimensional position, and GA public-claim eligibility.
- Added Phase 11-S4 first-party operator surface specifications for Writing, Daily, and Developer Operator, plus shared substrate rules and AGENTS.md surface governance.
- Added Phase 11-S5 platform extension surface specifications for Plugin Review Gate, Plugin HIG, and Skill Loader Contract, plus Layer B review cross-references.
- Added Phase 11-S6 Writing Operator implementation with `@blue-tanuki/operator-writing`, HDS-BRAIN surface framing, Gateway surface export loading, runtime snapshot and `/operators/writing` exposure, and conformance coverage.
- Added Phase 11-S7 Daily Operator implementation with `@blue-tanuki/operator-daily`, Daily Brief env compatibility snapshots, HDS-BRAIN surface framing, runtime snapshot and `/operators/daily` exposure, and conformance coverage.
- Added Phase 11-S8 Developer Operator implementation with `@blue-tanuki/operator-developer`, browser-preview quarantine preservation, HDS-BRAIN surface framing, runtime snapshot and `/operators/developer` exposure, and conformance coverage.
- Added Phase 11-S9 Installer and Setup UX with `pnpm installer:verify`, guided `pnpm installer:run`, token-gated Settings `Verify LLM`, installer docs, doctor distribution readiness coverage, and packaging validation.
- Added Phase 11-S10 Resident Application Integration with portable launcher resident lifecycle commands, explicit autostart management, uninstall cleanup, resident docs, and packaging validation.
- Added Phase 11-S11 Channel First-Party Promotion gate with `pnpm validate:channels`, owner-evidence requirements for Slack / Discord / Teams / LINE promotion, Teams / LINE inbound-listener gating, and WhatsApp reserved-third-party enforcement.
- Added Phase 11-S12 Plugin Review Gate implementation with `pnpm plugin:review`, static Layer B submission evidence checks, bundled workspace package review before plugin import, doctor/packaging/release-bundle coverage, and non-authority review result flags.
- Added Phase 11-S13 GA promotion preflight with `pnpm validate:ga`, Bar A-F evidence checks, pre-GO public-claim/version-promotion blocking, CI/doctor/packaging/release-bundle coverage, and owner-GO decision boundary docs.
- Added Phase 12-S-1 HDS-BRAIN Standalone Completeness Lock with standalone harness, downstream port types, HDSBrainHealth baseline, dependency boundary tests, `pnpm hds:standalone`, standalone boundary docs, and Downstream Limbs Doctrine documentation.
- Added Phase 12-S0 Boundary Definition Lock with deterministic boundary policy tests, unknown/unclassified L3 escalation, reference/non-authority boundaries, fail-safe policy, and Trinity M policy model docs.
- Added Phase 12-S1 Output / Result Audit Plane with standalone OutputAudit records, gateway pre-release output audit calls, audit dump projection, and conformance/security docs.
- Added Phase 12-S2 Local Complete History Substrate with standalone `CompleteHistoryStore`, JSONL append/verify/replay/export baseline, non-authority history records, and conformance/security docs.
- Added Phase 12-S3 Runtime Invariants Evidence Upgrade with standalone evidence reports, audit-chain records, gateway snapshot integration, and conformance/security docs.
- Added Phase 12-S4 Final-review Operation Single Source of Truth with `FINAL_REVIEW_OPERATION_LIST`, derived process profiles, Runtime Invariants evidence alignment, and conformance tests.
- Added Phase 12-S5 Approval / Notification / History / Replay UI Completion with read-only `/history` and `/history/replay`, Gateway complete-history replay metadata, Control Center history display, payload stripping, and non-authority replay docs.
- Added Phase 12-S6 Root Full-access + Compound Attack Scenario Tests covering wildcard full-access grants, privileged envelopes, metadata spoofing, forged channel-send metadata, downstream feedback spoofing, and history authority conversion.
- Added Phase 12-S7 Detector Lifecycle and Unknown Pattern Escalation with lifecycle traces, fail-closed detector errors, invalid pattern suspension, and detector conflict coverage.
- Added Phase 12-S8 HDS-BRAIN Fail-safe / Self-health Policy with executable self-health preconditions, command-emission blocking, non-resumable fail-safe suspension, and audit-visible failed preconditions.
- Added repository health phase 4 final commissioning with AST-based repo-health import graph checks, safe malformed-inbound fallback content, extracted release bundle install/build/doctor/repo-health verification, core-release preview absence handling, docs alignment, and abnormal regression tests.
- Added BLUE-TANUKI development practice guidance adapted from GUI-Shell, covering evidence source classification, contract-to-runtime coverage, production path minimization, mutation verification, and release-claim separation.
- Aligned `AGENTS.md` with the GUI-Shell common development discipline while preserving BLUE-TANUKI HDS-BRAIN authority, backup branch, validation, and release-gate rules.
- Added GUI Shell responsibility-substrate strategy docs and updated the WebChat Control Center with owner-operation screens for dashboard, tasks, approvals, activity/audit, memory, skills, channels, doctor, settings, and developer evidence.
- Added unsigned Windows installer package generation with bundled Windows Node runtime, Start Menu shortcuts, current-user uninstall registration, Windows package verification, installed-app smoke script, and Windows first-run/uninstall docs.
- Added a functional Conversation / WebChat Control Center panel using `/ws-ticket`, WebSocket, and `/inbound`, plus live Doctor / Health runtime status fields for installed GUI use.
- Added optional OpenRouter LLM backend support and optional Composio dry-run connector support while preserving native-first configuration, HDS-BRAIN authority, Approval Gate, audit, and Windows user-data settings boundaries.

## 0.1.0 - 2026-05-06

v0.1 release-candidate completion.

### Added

- Telegram Bot API channel package: `@blue-tanuki/channel-telegram`.
- Gateway registration for Telegram with silent fallback when `TELEGRAM_BOT_TOKEN` is unset.
- Internal Daily Brief cron source that emits trusted `cron.process` requests and routes them through HDS-BRAIN as `channel_send`.
- HDS scheduled channel-send command construction from gateway-internal metadata only.
- v0.1 public docs: `QUICKSTART.md`, `CLAIM.md`, `SECURITY.md`, `AUDIT.md`, `CONFIG.md`, `TROUBLESHOOTING.md`.
- Runtime/config docs for Telegram and Daily Brief smoke.

### Boundary

- v0.1 Daily Brief is a scheduled-message smoke, not Gmail/GCal/Drive integration.
- WhatsApp, Voice, Mobile, rich Canvas, and public third-party skill registry remain out of completion-quality scope.
- HDS memory remains deterministic and `used_for_authority=false`.

### Verification

- Static syntax check for modified emitted JavaScript: PASS.
- Dependency-based `pnpm typecheck/test` must be run in a normal dev environment with workspace dependencies installed.

### Phase 7-S4 hotfix: typecheck/build green

- Replaced the unreachable trailing return in `scopeFromCommand` with an explicit `never` exhaustive check; the ExecuteCommand union is exhaustively narrowed earlier, so the previous `return { target_scope: "command", target: command.id }` was dead code that triggered TS2339 and broke `pnpm typecheck` / `pnpm build`. Runtime behavior unchanged.
- Clarified the `/resume` instruction text in `approvalRequiredMessage` to use `request_id=<command_id>` instead of the literal `request_id=command_id`, removing the impression that the parameter name and value were the same string.
- Verified: `pnpm install && pnpm typecheck && pnpm build && pnpm -r test` all pass. 352 tests across 8 packages.

### Phase 7-S4: Transparent full-access authority

- Added machine-readable `authority_trace` to every approval evaluation.
- Fixed the product boundary as `full_access` default + `none_in_hds_authority_path`.
- Audit text output now prints the approval authority boundary.
- Added `docs/phase7-s4-transparent-full-access-authority.md`.
- Fixed duplicate `reason` key in the resume audit commit object.


## 0.0.3-phase7-s3b - 2026-05-05

Full-access product stance clarification.

### Changed

- Clarified that BLUE-TANUKI is designed as an owner-operated resident console with full access as the normal local default.
- Clarified that safety is implemented through HDS self-norms, final-review operations, and hash-chain audit closure rather than permission nagging.
- Clarified that disclaimers are release/responsibility boundaries, not the primary control mechanism.

### Verified

- Default approval mode: `full_access` when `BLUE_TANUKI_APPROVAL_MODE` is unset.
- Ordinary local non-final-review command: auto-allowed after HDS ASSERT.
- Shell execution: still requires final review under full access.

## 0.0.3-phase7-s3 - 2026-05-05

Resident full-access default.

### Changed

- Approval runtime now defaults to `full_access` when `BLUE_TANUKI_APPROVAL_MODE` is unset.
- Approval policy core now treats full access as the resident local-operator default.
- Control Center UI now shows Full Access as the default approval stance.
- README and Phase 7 approval docs now frame BLUE-TANUKI as a local resident control app, not a permission-nagging chatbot.

### Boundary

- Full access still does not bypass final review for file delete, shell exec, external send, credential access, settings write, payment, or schedule creation.
- `ask_every_time` remains available as explicit strict mode.

### Verified

- Static smoke confirmed default full-access allows non-final-review file write.
- Static smoke confirmed default full-access still asks for shell exec.
- Release bundle regenerated with updated manifest and SHA256.

## 0.0.3-phase7-s2 - 2026-05-05

Approval gate connected to the live executor path.

### Added

- Runtime approval gate between HDS `ASSERT` and executor execution.
- Pending approval queue for WebChat `/resume` approval by command id.
- Optional reusable approval grants via `remember=true` or `approval_mode=full_access`.
- JSON approval grant store controlled by `BLUE_TANUKI_APPROVALS_FILE`.
- Audit records for `approval_gate` and `command_lifecycle`.
- CLI/serve approval runtime with default low-risk local LLM/noop system grants.
- Phase 7-S2 design document.

### Boundary

- Full-access mode remains final-review guarded for delete, shell exec, external send, credential access, settings write, payment, and scheduling.
- Visual approval editor and native tray packaging remain deferred.

### Verified

- Emitted JavaScript syntax checks for approval policy/store/runtime/controller/gateway serve path: PASS.
- Direct approval-policy runtime smoke for allow / ask / full-access-final-review containment: PASS.
- Full `pnpm install && pnpm typecheck && pnpm test` was not run in this container because workspace dependencies and `@types/node` were unavailable.

## 0.0.3-phase7-s1 - 2026-05-05

Resident Control Center and approval-policy foundation.

### Added

- Local Control Center shell served by WebChat at `/` and `/app`.
- Static app layout for Control Center / Console / Notifications / Chat.
- HDS approval-policy model: operation × target scope × risk × actor × duration.
- Approval matcher with three modes: ask every time, remember this decision, full access.
- Final-review exception list for delete, shell exec, external send, credential access, settings write, payment, and scheduling.
- Unit tests for approval matching and full-access final-review containment.
- Phase 7-S1 design document.

### Boundary

- Approval policy persistence and live approval endpoints are not implemented yet.
- Windows tray / Electron / Tauri packaging is intentionally deferred.

## 0.0.3-phase6-s10 - 2026-05-05

HDS audit-closure and release-boundary hardening.

### Added

- HDS-BRAIN now appends executor feedback as a first-class hash-chain audit event.
- Unknown/stale executor feedback is recorded as `known_command=false` instead of being silently ignored.
- Feedback audit records include command id, upstream commit hash, status, metrics, error, and SHA256 digest of returned result data.
- `/settings` is loopback-only by default when a settings token is configured; non-loopback binds require explicit `BLUE_TANUKI_ENABLE_SETTINGS=1`.

### Changed

- Human resume commit hashes are now real SHA256 hashes over the resume event, previous commit hash, actor, verdict, and timestamp.
- Release archives are named `source-bundle` instead of `portable` to avoid implying standalone execution.
- Release manifest boundary now declares `unsigned_source_bundle=true`.
- `release:verify` supports both `.tar.gz` and `.zip` archive listing.
- Audit dump renders executor feedback entries without assuming every audit record is a decision.

### Boundary

- Release archives still exclude `node_modules`; operators must run dependency installation before use.
- This remains an engineering preview, not a production autonomous agent or trust root.

### Verified

- HDS-BRAIN runtime smoke for ASSERT → executor feedback hash-chain: PASS.
- Human resume hash format and chain verification smoke: PASS.
- `release:bundle`: PASS, wrote `source-bundle.tar.gz` plus `.sha256` and `.manifest.json`.
- `release:verify`: PASS for generated `.tar.gz`.
- `release:verify -- --file <zip>` smoke: PASS with a generated test zip.
- Full `pnpm` test/build were not run in this container because `pnpm` and `@types/node` were not installed.

## 0.0.3-phase6-s9 - 2026-05-05

Release secret-backup exclusion.

### Added

- Release bundle creation now excludes env backup and secret-like files:
  `.env.bak`, `*.env.*.bak`, `blue-tanuki.env.*.bak`, key/cert-like files,
  and `.npmrc`.
- Release verification now rejects secret-like backup files if they appear in
  an archive.
- `.gitignore` now ignores env backups and common local key material.
- Packaging validation coverage for release secret-backup exclusion.
- Phase report at `docs/phase6-s9-release-secret-exclusion.md`.

### Not Added

- No encrypted secret store.
- No OS keychain integration.
- No new npm dependencies.

### Verified

- Release/packaging scripts TypeScript check: PASS
- `validate:packaging`: PASS
- Secret-exclusion smoke with dummy `*.env.bak` and `*.pem`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS

## 0.0.3-phase6-s8 - 2026-05-05

Env backup and atomic writes.

### Added

- Atomic env-file write helper in `apps/gateway/src/env_file.ts`.
- Timestamped `.bak` backups for existing env files before overwrite.
- `setup --force` now backs up the previous env file before replacing it.
- `/settings/config` writes now back up the previous env file before saving.
- Tests for env atomic write backup, setup force backup, and settings backup.
- Packaging validation coverage for env backup wiring.
- Phase report at `docs/phase6-s8-env-backups.md`.

### Not Added

- No encrypted secret store.
- No OS keychain integration.
- No cloud backup/sync.
- No new npm dependencies.

### Verified

- Gateway typecheck: PASS
- Gateway build: PASS
- Full test suite: PASS, 337 tests
- `smoke:serve`: PASS
- `smoke:resume`: PASS
- `smoke:live`: PASS, skip path with no live credentials/targets
- `doctor`: PASS, exit 0 with CI-equivalent dummy env
- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS

## 0.0.3-phase6-s7 - 2026-05-05

Upgrade-safe portable installers.

### Added

- Portable installers now preserve an existing env file during app reinstall
  or portable upgrade.
- Windows `-ResetConfig` installer option for intentional env regeneration.
- macOS/Linux `RESET_CONFIG=1` installer option for intentional env
  regeneration.
- Installer docs now distinguish app replacement from config reset.
- Packaging validation coverage for config-preserving installer behavior.
- Phase report at `docs/phase6-s7-upgrade-safe-installers.md`.

### Changed

- Windows `-Force` and macOS/Linux `FORCE=1` replace the app directory only;
  they no longer imply env/token regeneration.

### Not Added

- No automatic remote update mechanism.
- No signed native updater.
- No package-manager integration.
- No new npm dependencies.

### Verified

- Packaging/release scripts TypeScript check: PASS
- Windows installer/uninstaller PowerShell syntax check: PASS
- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS
- macOS/Linux `bash -n`: not run locally; `bash` unavailable in this Windows
  environment

## 0.0.3-phase6-s6 - 2026-05-05

Portable uninstallers.

### Added

- Windows portable uninstaller at `install/windows/uninstall.ps1`.
- macOS portable uninstaller at `install/macos/uninstall.sh`.
- Linux portable uninstaller at `install/linux/uninstall.sh`.
- Default uninstall removes app and launcher while preserving env, audit,
  session, and local data.
- Purge mode for retained data removal: Windows `-Purge`, macOS/Linux
  `PURGE=1`.
- Dry-run mode: Windows `-DryRun`, macOS/Linux `DRY_RUN=1`.
- Safety guards against broad filesystem/user-directory deletion.
- Release manifest and archive verification now require uninstall scripts.
- Packaging validation coverage for uninstall scripts.
- Phase report at `docs/phase6-s6-portable-uninstallers.md`.

### Not Added

- No signed native uninstallers yet.
- No OS service removal automation.
- No registry/package-manager integration.
- No new npm dependencies.

### Verified

- Packaging/release scripts TypeScript check: PASS
- Windows installer/uninstaller PowerShell syntax check: PASS
- Windows uninstaller dry-run smoke: PASS
- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS
- macOS/Linux `bash -n`: not run locally; `bash` unavailable in this Windows
  environment

## 0.0.3-phase6-s5 - 2026-05-05

Installer launcher hardening.

### Added

- Post-install `doctor` gate for Windows, macOS, and Linux installers.
- Windows `-SkipDoctor` installer option.
- macOS/Linux `RUN_DOCTOR=0` installer option.
- Multi-command launchers with `start`, `doctor`, `setup`, `settings`, `env`,
  and `help`.
- `.cmd` launcher now delegates to the PowerShell launcher so commands stay
  consistent on Windows.
- Packaging validation coverage for launcher commands and post-install doctor.
- Phase report at `docs/phase6-s5-installer-launchers.md`.

### Not Added

- No signed native installers yet.
- No automatic browser opening.
- No OS service registration from the portable installer.
- No new npm dependencies.

### Verified

- Packaging/release scripts TypeScript check: PASS
- Windows installer PowerShell syntax check: PASS
- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS
- macOS/Linux `bash -n`: not run locally; `bash` unavailable in this Windows
  environment

## 0.0.3-phase6-s4 - 2026-05-05

Release integrity for portable bundles.

### Added

- Release bundle SHA256 sidecar generation.
- Release bundle manifest generation.
- `pnpm release:verify`.
- Archive verification for checksum, manifest consistency, required entries,
  and secret-like path exclusions.
- CI release bundle verification.
- Packaging validation coverage for release integrity files.
- Phase report at `docs/phase6-s4-release-integrity.md`.

### Not Added

- No signed native installers yet.
- No OS keychain integration yet.
- No new npm dependencies.

### Verified

- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote archive plus `.sha256` and `.manifest.json`
- `release:verify`: PASS

## 0.0.3-phase6-s3 - 2026-05-04

Portable installers.

### Added

- Windows portable installer at `install/windows/install.ps1`.
- macOS portable installer at `install/macos/install.sh`.
- Linux portable installer at `install/linux/install.sh`.
- Installer README at `install/README.md`.
- `pnpm release:bundle`.
- `scripts/create_release_bundle.ts`.
- Packaging validation for installer scripts and release bundle inputs.
- CI release bundle dry run.
- Phase report at `docs/phase6-s3-portable-installers.md`.

### Not Added

- No signed native installers yet.
- No Tauri/Electron desktop shell yet.
- No OS keychain integration yet.
- No bundled Node runtime yet.
- No new npm dependencies.

### Verified

- `validate:packaging`: PASS
- `release:bundle -- --dry-run`: PASS
- `release:bundle`: PASS, wrote `release/blue-tanuki-0.0.3-portable.zip`
- Portable zip contains Windows/macOS/Linux installer scripts

## 0.0.3-phase6-s2 - 2026-05-04

Local settings window.

### Added

- `/settings` HTML window served by WebChat.
- `/settings/config` API with dedicated `BLUE_TANUKI_SETTINGS_TOKEN` bearer
  auth.
- Redacted settings snapshots for LLM provider, WebChat bind settings, local
  paths, and plugin manifest status.
- Env-file write-back for settings changes when booted with `--env-file` or
  `BLUE_TANUKI_ENV_FILE`.
- Settings token generation in setup output.
- Tests for settings endpoint auth, settings update routing, redacted snapshots,
  and env-file persistence.
- Phase report at `docs/phase6-s2-settings-window.md`.

### Not Added

- No desktop shell yet.
- No OS keychain integration yet.
- No signed Windows/macOS/Linux installers yet.
- No live LLM connection test button yet.
- No new npm dependencies.

### Verified

- Full typecheck by package: PASS
- Full test suite: PASS, 335 tests
- Full build by package: PASS
- Settings-window serve smoke: PASS (`/settings` and `/settings/config`)
- `smoke:serve`: PASS
- `smoke:resume`: PASS
- `smoke:live`: PASS, skip path with no live credentials/targets
- `validate:packaging`: PASS
- `doctor`: PASS, exit 0 with dummy settings-token env

## 0.0.3-phase6-s1 - 2026-05-04

Setup and local install configuration.

### Added

- `pnpm setup` / `pnpm setup:dist` for first-run local configuration.
- Typed setup config schema for LLM provider, WebChat, and local runtime paths.
- Env generation for `stub`, `anthropic`, `openai`, and `openai-compatible`
  providers.
- Automatic `WEBCHAT_TOKEN` and `WEBCHAT_RESUME_TOKEN` generation.
- Automatic local `BLUE_TANUKI_FILE_ROOT`, `BLUE_TANUKI_SESSION_DIR`, and
  `BLUE_TANUKI_AUDIT_DIR` setup.
- `--env-file` and `BLUE_TANUKI_ENV_FILE` support before gateway mode
  selection.
- Tests for setup config rendering, env-file parsing/loading, and non-
  interactive setup.
- Phase report at `docs/phase6-s1-setup.md`.

### Not Added

- No desktop settings window yet.
- No OS keychain integration yet.
- No signed Windows/macOS/Linux installers yet.
- No new npm dependencies.

### Verified

- Gateway typecheck: PASS
- Full typecheck by package: PASS
- Full test suite: PASS, 326 tests
- Gateway build: PASS
- `apps/gateway/dist/setup.js --yes --no-doctor`: PASS
- `apps/gateway/dist/main.js --setup --yes --no-doctor`: PASS
- `apps/gateway/dist/main.js --doctor --env-file ... --json`: PASS with
  `ok=true`, exit code 1 from optional-token warnings only

## 0.0.3-phase5-s10 - 2026-05-04

Remaining local hardening.

### Added

- Request_id-bound one-time approval tokens for WebChat `/resume`.
- `ResumeApprovalTokenStore` and default `MemoryResumeApprovalTokenStore`.
- SUSPEND notifications now include an `approval_token` for the suspended
  request.
- `/resume` now requires `WEBCHAT_RESUME_TOKEN` plus the matching one-time
  `approval_token`.
- `smoke:resume` now verifies that approval tokens are emitted and accepted.
- `pnpm validate:packaging` static checks for Docker, compose, GitHub Actions,
  and systemd packaging.
- Packaging validation now runs in CI.
- Phase report at `docs/phase5-s10-remaining-hardening.md`.

### Not Added

- No Redis/Postgres backend without dependency approval.
- No credentialed live smoke.
- No HDS long-term-memory F-reference implementation.
- No external npm plugin import, hot reload, or dynamic permission mutation.

### Verified

- `pnpm --filter @blue-tanuki/channel-webchat typecheck`: PASS
- `pnpm --filter @blue-tanuki/channel-webchat test`: PASS, 43 tests
- `pnpm --filter @blue-tanuki/gateway typecheck`: PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 314 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm validate:packaging`: PASS
- `pnpm run doctor`: PASS, exit 0 with hardening dummy env

## 0.0.3-phase5-s9 - 2026-05-04

systemd packaging.

### Added

- `deploy/systemd/blue-tanuki.service`.
- `deploy/systemd/blue-tanuki.env.example`.
- `deploy/systemd/README.md`.
- systemd deployment notes in `docs/runbook.md`.
- Phase report at `docs/phase5-s9-systemd.md`.
- `ExecStartPre` doctor gate that allows warn exit code 1 and blocks error
  exit code 2.
- Non-root `blue-tanuki` user expectation and persistent
  `/var/lib/blue-tanuki` audit/session paths.

### Not Added

- No automatic installer script.
- No package publishing.
- No deployment automation.
- No new npm dependencies.

### Verified

- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 311 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with systemd-equivalent dummy env
- systemd execution: not run locally

## 0.0.3-phase5-s8 - 2026-05-04

GitHub Actions CI.

### Added

- `.github/workflows/ci.yml`.
- CI triggers for `main`, `codex/**`, pull requests, and manual dispatch.
- Verify job covering install, typecheck, build, tests, offline smoke, live
  smoke skip path, and `doctor` with separated dummy WebChat tokens.
- Docker build job gated on the verify job.
- Read-only workflow permissions and same-ref concurrency cancellation.
- Phase report at `docs/phase5-s8-ci.md`.

### Not Added

- No package publishing.
- No Docker image push.
- No deployment automation.
- No new npm dependencies.

### Verified

- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 311 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with CI-equivalent dummy env
- GitHub Actions workflow execution: not run locally

## 0.0.3-phase5-s7 - 2026-05-04

Docker packaging.

### Added

- Multi-stage `Dockerfile` for building the monorepo and running gateway serve.
- `.dockerignore` to keep local deps, build output, archives, logs, and env
  files out of the image build context.
- `docker-compose.yml` for single-host local deployment.
- Compose-required `WEBCHAT_TOKEN` and `WEBCHAT_RESUME_TOKEN`.
- Persistent `/data/audit` and `/data/sessions` wiring through
  `BLUE_TANUKI_AUDIT_DIR` and `BLUE_TANUKI_SESSION_DIR`.
- Non-root runtime user and `/healthz` container healthcheck.
- Phase report at `docs/phase5-s7-docker-packaging.md`.

### Not Added

- No external npm dependencies.
- No Redis/Postgres backend.
- No GitHub Actions CI.
- No systemd unit.

### Verified

- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 311 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `docker build`: not run; Docker CLI unavailable in this Codex environment

## 0.0.3-phase5-s6 - 2026-05-03

WebChat resume token separation.

### Added

- Required `WEBCHAT_RESUME_TOKEN` for human resume operations.
- Endpoint-scoped WebChat authentication:
  - `/inbound` and `/ws-ticket` accept only `WEBCHAT_TOKEN`.
  - `/resume` accepts only `WEBCHAT_RESUME_TOKEN`.
- Boot-time rejection when the resume token is missing, too short, or equal to
  the inbound token.
- `ResumeAuditTrace` on HDS-BRAIN decision logs.
- Resume audit context with human `actor` and `token_kind=resume`.
- WebChat plugin permission declaration for `secrets:WEBCHAT_RESUME_TOKEN`.
- Doctor checks for resume-token presence and separation.
- Phase report at `docs/phase5-s6-resume-token-split.md`.

### Not Added

- No one-time approval token in this phase; it shipped later in Phase 5-S10.
- No dynamic permission changes.
- No relaxation of upstream HDS-BRAIN containment.

### Verified

- `pnpm --filter @blue-tanuki/channel-webchat typecheck`: PASS
- `pnpm --filter @blue-tanuki/channel-webchat test`: PASS, 40 tests
- `pnpm --filter @blue-tanuki/hds-brain typecheck`: PASS
- `pnpm --filter @blue-tanuki/hds-brain test`: PASS, 72 tests
- `pnpm --filter @blue-tanuki/gateway typecheck`: PASS
- `pnpm --filter @blue-tanuki/gateway test`: PASS, 57 tests
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 311 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `pnpm gateway:dev "hello phase5-s6"`: PASS

## 0.0.3-phase5-s5 - 2026-05-03

Unicode normalization plus raw audit retention.

### Added

- Detector input normalization through `normalizeForDetection()`.
- NFKC normalization before detector scoring.
- Zero-width and bidi control-character removal before detectors run.
- Audit trace fields for `raw_content`, `normalized_content`, `changed`, and
  detected control characters.
- Control-character audit metadata with code point, kind, name, and raw index.
- Tests for zero-width risk keyword evasion and NFKC/bidi compliance matching.

### Verified

- `pnpm --filter @blue-tanuki/hds-brain typecheck`: PASS
- `pnpm --filter @blue-tanuki/hds-brain test`: PASS, 72 tests
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 305 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `pnpm gateway:dev "please run r<U+200B>m -rf foo"`: PASS, SUSPEND

## 0.0.3-phase5-s4 - 2026-05-03

`file.search` sandbox root enforcement.

### Added

- `BLUE_TANUKI_FILE_ROOT` is now required for `file.search`.
- Requested roots are confined to the configured sandbox root.
- Relative `root` arguments resolve from the sandbox root.
- Absolute `root` arguments are allowed only inside the sandbox.
- `fs.realpath` checks deny symlink escapes.
- Secret-like requested roots are denied, and secret-like paths are skipped
  during traversal.
- Tests for missing sandbox env, outside roots, symlink escape, secret root
  denial, and secret file skipping.

### Verified

- `pnpm --filter @blue-tanuki/core typecheck`: PASS
- `pnpm --filter @blue-tanuki/core test`: PASS, 71 tests
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 303 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `pnpm gateway:dev "tool:file.search root=. query=BLUE-TANUKI max_results=1"`: PASS

## 0.0.3-phase5-s3 - 2026-05-03

`http.fetch` SSRF hardening.

### Added

- DNS/IP validation for `http.fetch` before connecting.
- Deny rules for loopback, private, link-local, metadata, unique-local IPv6,
  documentation, multicast/reserved, and IPv4-mapped IPv6 targets.
- Manual redirect handling with a 3-hop limit and full validation on every
  redirect target.
- DNS-rebinding resistance by connecting with the validated resolved IP while
  preserving the original Host header / TLS server name.
- Optional domain allowlist mode via `BLUE_TANUKI_HTTP_ALLOWLIST`.
- SSRF tests for loopback, private, metadata, IPv6, IPv4-mapped IPv6, redirect
  escape, redirect limit, and allowlist behavior.

### Verified

- `pnpm --filter @blue-tanuki/core typecheck`: PASS
- `pnpm --filter @blue-tanuki/core test`: PASS, 67 tests
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 299 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `pnpm gateway:dev "tool:echo text=ssrf-guard-smoke"`: PASS

## 0.0.3-phase5-s2 - 2026-05-03

Plugin loader plus permission enforcement.

### Added

- Workspace plugin loader in `apps/gateway/src/plugin_loader.ts`.
- Boot-time discovery through `pnpm-workspace.yaml`.
- Workspace-only dynamic import of manifest `entry` modules.
- Manifest-driven registration for built-in tools and channel classes.
- Manifest-driven live smoke construction for Slack / Discord channel checks.
- Permission enforcement for tool capabilities, channel network/secrets,
  non-stub LLM provider access, session fs access, and audit fs append access.
- Boot-fail behavior when a required permission is missing.

### Not Added

- No external npm plugin discovery.
- No hot reload or runtime permission mutation.
- No detector loader.

### Verified

- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 290 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm smoke:live`: PASS, skip path with no live credentials/targets
- `pnpm run doctor`: PASS, exit 0 with dummy local env
- `pnpm gateway:dev "tool:echo text=loader-smoke"`: PASS

## 0.0.3-phase5-s1 - 2026-05-03

Manifest validation hardening.

### Added

- Gateway doctor now validates bundled plugin manifests with the protocol
  schema.
- Doctor now detects manifest/package name drift, version drift, and entry
  drift before a future dynamic loader consumes those manifests.
- Added 3 gateway tests for valid, schema-invalid, and metadata-drift manifest
  roots.

### Not Added

- No dynamic plugin loader.
- No manifest-driven permission enforcement.

### Verified

- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm test`: PASS, 284 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm run doctor`: PASS, exit 0 with dummy local env

## 0.0.3-phase4-s9 - 2026-05-03

Release-readiness pass for the Phase 4 workspace artifact.

### Added

- Internal HDS-BRAIN long-term memory addendum:
  - append-only JSONL-compatible store
  - TCP-closed ASSERT write gate
  - hash-chain verification
  - optional controller memory capture and frame reader plumbing
- Provider-neutral LLM routing:
  - arbitrary OpenAI-compatible provider catalogs via `LLM_PROVIDERS_JSON`
  - HDS-owned route hints via `BLUE_TANUKI_LLM_*`
- Tool permission envelope:
  - `allowed_capabilities`
  - built-in `echo`, `file.search`, and `http.fetch`
- HDS action routing for explicit safe tool requests.
- Gateway result rendering for `tool_call`, `noop`, and failure output.
- Live smoke harness for configured non-stub LLM, Slack, and Discord checks.

### Changed

- README and runbook now describe the current Phase 4-S9 state instead of the
  earlier S1/S3 checkpoint.
- Doctor documentation includes the current `audit_dir`, provider-catalog, and
  LLM command-route checks.
- Release checklist now includes `typecheck`, offline smokes, live smoke, and
  artifact zip refresh.
- Root `doctor` scripts now call package scripts via `run doctor` to avoid
  pnpm's built-in `doctor` command.

### Verified

- `pnpm build`: PASS
- `pnpm typecheck`: PASS
- `pnpm test`: PASS, 281 tests
- `pnpm smoke:serve`: PASS
- `pnpm smoke:resume`: PASS
- `pnpm run doctor`: PASS, exit 0 with dummy local env

Credentialed live smoke remains operator-gated because it can call external
APIs and post messages.
## Phase 7-S6 - HDS Authority / Process / Memory Hardening

- Hardened actor/process resolution: external metadata can no longer upgrade actor authority unless marked as gateway-internal authority context.
- Enforced `actor_policy` and `execution_policy` before emitting downstream commands.
- Added security FAIL outcomes for `process_authority_denied` and `process_execution_policy_denied`.
- Enriched HDS long-term memory with actor/process/commit/tags while keeping memory non-authority.
- Added deterministic actor/process lookup helpers for long-term memory.
- Exposed runtime safety invariants in `HDSRuntimeSnapshot` and Control Center copy.
