# BLUE-TANUKI Roadmap v9

製品完成スコープは `docs/PRODUCT_ROADMAP.md`（P1〜P13）が本書のBand記述を上書きする。Band A–F / Phase X-SY の記述は履歴・参照として保持する。

この文書は `docs/IMPLEMENTATION_INSTRUCTIONS.md` と同じ実行順序を示す圧縮ロードマップである。
実装時の source of truth は常に `docs/IMPLEMENTATION_INSTRUCTIONS.md` と `AGENTS.md`。この文書は人間が全体像を素早く確認するための案内であり、詳細な phase 要件、検証コマンド、acceptance criteria は active instruction file を参照する。

## 0. 不変原則

BLUE-TANUKI は local owner-operated resident AI control plane である。

```md
HDS-BRAIN owns authority.
LLMs, tools, channels, plugins, skills, memory, cron, browser automation, UI, onboarding, update flows, companion apps, and external services are downstream devices.
```

優先順位は固定:

1. Safety
2. Robustness
3. Comfort / UX
4. Feature coverage / channel coverage / extensibility

OpenClaw は設計の出発点ではなく、拒否済み design pattern として扱う。BLUE-TANUKI は feature breadth や channel count ではなく、安全な永続運用を完成条件にする。

## 1. Completion Bands

### Band A - Safety Kernel

Goal:

- authority path closed
- Approval Gate closed
- audit closed
- Runtime Invariants visible

Status: mostly implemented.

### Band B - v0.1 Completion

Goal:

- local owner setup works
- WebChat / Telegram smoke works
- runtime schedule is safe
- approval levels are first-class
- operator usability closure exists
- release bundle and validation pass

Remaining primary work:

- v0.1 live smoke cleanup
- docs consistency

### Band C - v0.1.x Stabilization

Goal:

- GitHub write downstream tool
- browser automation preview
- stronger live smoke
- conformance test expansion

### Band D - v0.2 Capability Expansion

Goal:

- Google integrations
- Teams / LINE
- F-reference audit integration
- memory continuity without memory authority
- adapter maturity

### Band E - v0.3 Resident UX

Goal:

- Control Center polish
- notification center
- approval UX
- settings UX
- installer experience
- local app feel

### Band F - v1.0 Release Hardening

Goal:

- repeatable install
- documented recovery
- stable extension boundary
- strategic frame closure
- GA bar definition
- public claim eligibility gating
- security review checklist complete
- permanent-use UX proven
- v1.0 support / no-support boundary clear
- no critical preview paths in main release

## 2. Execution Queue

Codex must proceed sequentially unless explicitly instructed otherwise.

| Phase | Band | Task | Priority | Dependency |
|---|---|---|---:|---|
| 8-S1 | B | ApprovalLevel first-class + runtime schedule CRUD | P0 | completed |
| 8-S2a | B | Operator Usability Docs (First-Run + Permanent-Use + Matrices + Runbook) | P0 | completed |
| 8-S2b | B | Doctor Actionable Output + Control Center First-Run Status | P0 | completed |
| 8-S3 | B | OpenClaw Rejection Audit document | P0 | completed |
| 8-S4 | C | GitHub write tool | P1 | completed |
| 8-S5 | C | Slack / Discord release polish + live smoke | P1 | completed |
| 8-S6 | C | Browser automation preview | P2 | completed |
| 9-S1 | D | F-reference audit integration | P1 | completed |
| 9-S2 | D | Gmail / Google Calendar / Drive read integration | P1 | completed |
| 9-S3 | D | Google write integration | P2 | completed |
| 9-S4 | D | Teams / LINE adapters | P2 | completed |
| 10-S1 | E | Control Center approval UX polish | P1 | completed |
| 10-S2 | E | Resident notification center | P2 | completed |
| 10-S3 | E | Distribution UX hardening | P1 | completed |
| 11-S1 | F | v1.0 security review closure | P0 | completed |
| 11-S2 | F | v1.0 permanent-use release candidate | P0 | completed |
| 11-S3 | F | Strategic Frame and GA Bar Closure | P0 | completed |
| 11-S4 | F | First-Party Surface Specification | P0 | completed |
| 11-S5 | F | Platform Extension Surface Specification | P0 | completed |
| 11-S6 | F | Writing Operator Implementation | P0 | completed |
| 11-S7 | F | Daily Operator Implementation | P0 | completed |
| 11-S8 | F | Developer Operator Implementation | P0 | completed |
| 11-S9 | F | Installer and Setup UX | P0 | completed |
| 11-S10 | F | Resident Application Integration | P0 | completed |
| 11-S11 | F | Channel First-Party Promotion | P0 | completed |
| 11-S12 | F | Plugin Review Gate Implementation | P0 | completed |
| 11-S13 | F | v1.0 GA Promotion Execution | P0 | pre-GO gate complete; owner GO required |
| 12-S-1 | G | HDS-BRAIN Standalone Completeness Lock | P0 | completed |
| 12-S0 | G | Boundary Definition Lock | P0 | completed |
| 12-S1 | G | HDS-BRAIN Output / Result Audit Plane | P0 | completed |
| 12-S2 | G | Local Complete History Substrate | P0 | completed |
| 12-S3 | G | Runtime Invariants Evidence Upgrade | P0 | completed |
| 12-S4 | G | Final-review Operation Single Source of Truth | P0 | completed |
| 12-S5 | G | Approval / Notification / History / Replay UI Completion | P0 | completed |
| 12-S6 | G | Root Full-access + Compound Attack Scenario Tests | P0 | completed |
| 12-S7 | G | Detector Lifecycle and Unknown Pattern Escalation | P0 | completed |
| 12-S8 | G | HDS-BRAIN Fail-safe / Self-health Policy | P0 | completed |

## 3. Current Active Phase

```txt
Phase P4-S1 — Control Center LLM settings integration and product smoke
```

旧 `Phase 11-S13 Owner GO Decision / v1.0.0 Promotion` はD2によりP13へ吸収。Phase 11-S13 pre-GO gate is complete. Actual v1.0.0 promotion is blocked until explicit owner GO.

## 4. Completed Phase Summaries

### Phase 8-S1

- First-class `ApprovalLevel`
- Three-tier `ApprovalRisk`
- L3 runtime schedule create/update/delete
- L1 runtime schedule list
- Schedule lifecycle audit
- Safe runtime schedule snapshot metadata

### Phase 8-S2a

- First-run checklist
- Permanent-use checklist
- Channel readiness matrix
- Credential readiness matrix
- Update / rollback / recovery runbook
- Quickstart and troubleshooting alignment
- Static docs checker

### Phase 8-S2b

- Actionable doctor remediation fields
- Safe first-run runtime snapshot status fields
- Runtime status helper and tests
- WebChat runtime snapshot auth / no-secret regression

### Phase 8-S3

- Internal OpenClaw rejection audit document
- Engineering rejection criteria for feature breadth, channel count, unsafe plugin surfaces, and first-run-only claims
- WhatsApp first-party exclusion recorded as deliberate safety and liability boundary
- Active execution lane advanced to Phase 8-S4 GitHub write

### Phase 8-S4

- Authenticated `github.write` downstream tool
- GitHub issue create/comment/update and PR create/comment operations
- `GITHUB_TOKEN` plus `BLUE_TANUKI_GITHUB_REPOS` fail-closed boundary
- L3 final-review mapping for GitHub write operations
- Audit-safe result digest and bounded output
- Active execution lane advanced to Phase 8-S5 Slack / Discord release polish

### Phase 8-S5

- Slack / Discord adapter-level retry/backoff confirmed and documented
- Typed recoverable / non-recoverable delivery errors added to downstream send results
- Live smoke failure output now includes typed delivery detail and owner next action
- Compatibility matrix keeps Slack / Discord as release-polished preview until owner credentialed live smoke
- Active execution lane advanced to Phase 8-S6 browser automation preview

### Phase 8-S6

- Disabled-by-default browser automation preview
- Guarded `browser.snapshot` and `browser.automation` tool paths
- L2/L3 ApprovalLevel mapping and credential denial
- Smoke skip path for preview-disabled operation

### Phase 9-S1

- `F:<id>` memory read/write references in audit and Control Center traces
- HDS long-term memory remains non-authority with `memory_used_for_authority=false`

### Phase 9-S2

- Read-only Gmail, Google Calendar, and Google Drive tools
- Optional Google Daily Brief source with credential-scoped fail-closed behavior

### Phase 9-S3

- Bounded Gmail, Google Calendar, and Google Drive write tools
- Google writes map to L3 final-review and return audit-safe mutation summaries

### Phase 9-S4

- Microsoft Teams and LINE first-party-preview channel adapters
- Teams Graph send and LINE Messaging API push live smoke skip paths
- Conformance, doctor, compatibility matrix, and permanent-use docs updated
- Active execution lane advanced to Phase 10-S1 Control Center approval UX polish

### Phase 10-S1

- Control Center resident status polished around approval queue, runtime schedules, audit chain, and authority trace visibility
- Approval Queue now surfaces ApprovalLevel, final-review labeling, one-time token expiry, and redacted authority trace context
- Runtime schedules now show active/pending state, approval lifecycle metadata, and payload hashes without schedule content
- Runtime snapshot display now includes first-run next action and permanent-use status cards
- Active execution lane advanced to Phase 10-S2 resident notification center

### Phase 10-S2

- Display-only resident notifications added to WebChat at `/notifications`
- Control Center Notification Center surfaces approval-required, schedule fired/failed, connector failure, and audit-warning states
- Authority Trace now includes executor feedback summaries so downstream delivery failures can be surfaced without becoming authority
- Notification metadata is explicitly `display_only` and cannot approve, execute, mutate audit, or grant authority
- Active execution lane advanced to Phase 10-S3 distribution UX hardening

### Phase 10-S3

- Distribution readiness is now a `doctor` gate covering installer docs, update/rollback guidance, permanent-use checklist boundaries, release bundle checks, packaging validation, and uninstall/purge scripts
- Installer and rollback docs now make the no-signed-native-installer and no-automatic-updater boundaries explicit
- Packaging validation checks the distribution readiness surfaces
- Active execution lane advanced to Phase 11-S1 v1.0 security review closure

### Phase 11-S1

- v1.0 security and permanent-use review created at `docs/v1.0-security-and-permanent-use-review.md`
- Reviewed authority path, approval model, final-review operations, runtime automation, external write tools, channel adapters, memory/F-reference, browser preview, Google integrations, install/update/uninstall, audit, capability envelope, secret handling, sandboxes, docs, compatibility matrix, first-run UX, permanent-use UX, and recovery/rollback
- No release-blocking final-review bypass, hidden authority source, undocumented privileged operation, stale preview promotion, or false 5-minute claim was identified
- Active execution lane advanced to Phase 11-S2 v1.0 permanent-use release candidate

### Phase 11-S2

- Workspace package and plugin manifest versions advanced to `1.0.0-rc.1`
- v1.0 release-candidate document created at `docs/v1.0-release-candidate.md`
- Docs index created at `docs/INDEX.md`
- Compatibility matrix advanced first-party channels to `v1.0` and preview channels to `v1.0-preview` without promoting previews to first-party
- Release-candidate support/no-support boundary, upgrade notes, first-run proof, permanent-use proof, and validation matrix recorded
- Post-RC closure review records bundle sidecar integrity, Windows `smoke:resume` proof, credentialed live-smoke blocker, preview-channel promotion decision, signed-installer decision, and updater decision

### Phase 11-S3

- Strategy frame created at `docs/STRATEGY_FRAME.md`
- GA bar definition created at `docs/GA_BAR_DEFINITION.md`
- Layer A / Layer B split, OpenClaw two-dimensional position, Stage 1 role, and public claim eligibility recorded
- `AGENTS.md`, OpenClaw audit, docs index, roadmap, implementation instructions, and changelog aligned for the GA path
- Active execution lane advances to Phase 11-S4 First-Party Surface Specification

### Phase 11-S4

- First-party operator surface specs created under `docs/operator-surfaces/`
- Writing Operator, Daily Operator, and Developer Operator defined as equal Layer A surfaces
- Shared substrate for HDS-BRAIN authority, Approval Gate, audit, Runtime Invariants, and downstream tool dispatch documented
- `AGENTS.md` now includes the First-Party Surface Rule before Adapter Rule
- Active execution lane advances to Phase 11-S5 Platform Extension Surface Specification

### Phase 11-S5

- Plugin Review Gate, Plugin HIG, and Skill Loader Contract docs created
- Layer B review boundary connected to Adapter Contract, Capability Envelope, Conformance, and LLM Development Guide
- AGENTS.md Adapter Rule now records the Layer A / Layer B Boundary references
- WhatsApp unofficial routes, agent-driven authority, emotion functionality, and 5-minute setup guarantee claims remain reject criteria
- Active execution lane advances to Phase 11-S6 Writing Operator Implementation

### Phase 11-S6

- `@blue-tanuki/operator-writing` workspace package added as a Layer A first-party surface
- Writing operation specs define L1 in-memory, L2 sandboxed local file, and L3 Gmail / Google Drive write boundaries
- HDS-BRAIN frame recognition records Writing Operator surface binding without adding authority
- Gateway plugin loader now supports first-party surface exports and exposes Writing Operator state in the runtime snapshot
- WebChat exposes authenticated `/operators/writing` display and invoke endpoints through the existing inbound handler
- Conformance evidence added for surface registration, metadata non-escalation, and permission-enforced surface loading
- Active execution lane advances to Phase 11-S7 Daily Operator Implementation

### Phase 11-S7

- `@blue-tanuki/operator-daily` workspace package added as a Layer A first-party surface
- Daily operation specs define L1 Daily Brief / Google read / schedule list, L2 reminder draft, and L3 schedule / Google write boundaries
- Existing `BLUE_TANUKI_DAILY_BRIEF_*` environment compatibility is preserved through safe metadata snapshots
- HDS-BRAIN frame recognition records Daily Operator surface binding without adding authority
- Gateway exposes Daily Operator state in the runtime snapshot, and WebChat exposes authenticated `/operators/daily` display and invoke endpoints
- Conformance evidence added for Daily Brief env compatibility, metadata non-escalation, schedule mutation final-review declaration, and permission-enforced surface loading
- Active execution lane advances to Phase 11-S8 Developer Operator Implementation

### Phase 11-S8

- `@blue-tanuki/operator-developer` workspace package added as a Layer A first-party surface
- Developer operation specs define L1 file/GitHub read, L2 local file write/edit and browser snapshot, and L3 shell / GitHub write / browser automation boundaries
- Browser automation remains preview and disabled-by-default behind `BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW=1`
- HDS-BRAIN frame recognition records Developer Operator surface binding without adding authority
- Gateway exposes Developer Operator state in the runtime snapshot, and WebChat exposes authenticated `/operators/developer` display and invoke endpoints
- Conformance evidence added for Developer surface registration, preview quarantine preservation, metadata non-escalation, and permission-enforced surface loading
- Active execution lane advances to Phase 11-S9 Installer and Setup UX

### Phase 11-S9

- Guided first-run installer added under `install/installer/` with preflight, setup, doctor, and Control Center Settings handoff
- Root scripts `installer:verify` and `installer:run` added
- Settings surface adds token-gated, non-mutating `Verify LLM` for SIM-like LLM API provider setup
- Installer guide, first-run checklist, permanent-use checklist, rollback runbook, RC docs, conformance docs, doctor distribution readiness, and packaging validation updated
- Signed native installer, automatic updater, and verified 5-minute setup guarantee remain out of scope
- Active execution lane advances to Phase 11-S10 Resident Application Integration

### Phase 11-S10

- Portable resident helpers added under `install/resident/`
- Installed launchers expose `resident-start`, `resident-status`, `resident-stop`, `resident-open`, `resident-logs`, and explicit `resident-autostart-*` commands
- Resident autostart is opt-in only and uses current-user OS facilities where supported
- Uninstallers stop resident state and disable autostart before removing app/launcher files
- Resident app guide, permanent-use checklist, update/rollback runbook, RC docs, conformance docs, doctor distribution readiness, and packaging validation updated
- Signed native tray app and automatic updater remain out of scope
- Active execution lane advances to Phase 11-S11 Channel First-Party Promotion

### Phase 11-S11

- Channel first-party promotion gate added through `pnpm validate:channels`
- Slack / Discord / Teams / LINE remain `first-party-preview` until owner-run credentialed live smoke and recovery evidence are present
- Teams / LINE additionally require gateway-owned inbound listener closure before first-party promotion
- WhatsApp remains `reserved-third-party`
- Channel promotion gate docs, tests, conformance docs, readiness docs, and release docs updated
- Active execution lane advances to Phase 11-S12 Plugin Review Gate Implementation

### Phase 11-S12

- Plugin Review Gate implemented through `reviewPluginPackage()` and `pnpm plugin:review`
- Layer B submissions require `blue-tanuki.review.json` evidence for conformance, audit, safety, disable/revoke, failure modes, dynamic-import denial, hot-reload denial, and final-review capability declaration
- Gate rejects wildcard capabilities, package/manifest drift, lifecycle install scripts, runtime dynamic import, forbidden WhatsApp-specific routes, `kind=core` Layer B submissions, and final-review bypass claims
- Bundled workspace plugin loading now runs the non-submission Plugin Review Gate before importing entries
- Doctor, packaging validation, release bundle requirements, RC docs, conformance docs, and Plugin Review Gate docs updated
- Active execution lane advances to Phase 11-S13 v1.0 GA Promotion Execution

### Phase 11-S13

- Added `pnpm validate:ga` as the v1.0 GA promotion preflight.
- Added `scripts/ga_promotion_gate.ts`, `apps/gateway/test/ga_promotion_gate.test.ts`, `docs/v1.0-ga-promotion-review.md`, and the Phase 11-S13 report.
- GA Bar A-F evidence is machine-checked.
- Bar G remains `PENDING_OWNER_GO`; `public_claim_allowed=false` until explicit owner GO.
- Gate rejects `1.0.0` version promotion or README / QUICKSTART / CLAIM public claim activation before owner GO.
- CI, doctor, packaging validation, release bundle requirements, RC docs, post-RC review, GA bar docs, and docs index updated.
- Actual v1.0.0 promotion remains pending explicit owner GO.

### Phase 12-S-1

- HDS-BRAIN standalone completeness locked as a package-level boundary
- `runStandaloneHDSBrain` harness and `pnpm hds:standalone` smoke added
- `HDSBrainHealth` baseline and downstream port types exported
- Dependency boundary tests confirm no gateway/core/channel/operator dependency
- Standalone tests cover controller decide, LLM/tool command envelopes, approval evaluation, audit verification, runtime snapshot, and health
- Downstream Limbs Doctrine documented: downstream devices are limbs, not authority
- Active execution lane advances to Phase 12-S0 Boundary Definition Lock

### Phase 12-S0

- Boundary policy module added inside standalone `packages/hds-brain`
- `tool.call` and `unknown` now map to high-risk `L3_final_review`
- Reference/non-authority boundary locked for memory, complete history, session, tool result, LLM output, metadata, audit viewer, and Control Center
- Unknown / ambiguous / unclassified / missing capability / mismatch / conflict states never auto-allow
- Fail-safe policy suspends downstream execution when authority prerequisites are invalid
- Trinity M policy model documented as deterministic identity, boundary, judgement, log, and suspend rules
- Active execution lane advances to Phase 12-S1 HDS-BRAIN Output / Result Audit Plane

### Phase 12-S1

- Standalone OutputAudit module added inside `packages/hds-brain`
- HDS hash-chain audit now includes `output_audit` records
- Gateway CLI and serve mode audit rendered command output before operator log or channel dispatch
- Audit dump and Control Center authority trace project output audit records without raw output content
- Output result material remains `used_for_authority=false`
- Active execution lane advances to Phase 12-S2 Local Complete History Substrate

### Phase 12-S2

- Standalone `CompleteHistoryStore` added inside `packages/hds-brain`
- Complete history kinds cover user input, LLM history, HDS decisions, approvals, execution, audit, and final output
- Append / verify / replay / export / JSONL persistence baseline implemented
- Load-time chain verification rejects tampered persisted history
- Complete history material remains `used_for_authority=false` and `complete_history_used_for_authority=false`
- Active execution lane advances to Phase 12-S3 Runtime Invariants Evidence Upgrade

### Phase 12-S3

- Standalone Runtime Invariants evidence module added inside `packages/hds-brain`
- `HDSRuntimeSnapshot` now includes `runtime_invariants` evidence while preserving legacy `invariants`
- Runtime Invariants evidence can be appended as `runtime_invariants` records in the HDS hash-chain audit
- Gateway startup records runtime invariant evidence and runtime snapshot exposes the report as downstream display data
- Audit dump and authority trace project runtime invariant evidence without creating authority
- Active execution lane advances to Phase 12-S4 Final-review Operation Single Source of Truth

### Phase 12-S4

- `FINAL_REVIEW_OPERATION_LIST` is now the HDS-BRAIN-owned source of truth for L3 final-review operations
- `FINAL_REVIEW_OPERATIONS`, process approval profiles, authority traces, and Runtime Invariants evidence derive from that list
- Tests cover drift across Approval Gate, process profile, authority trace, and runtime evidence projections
- `tool.call`, `google.write`, and `unknown` remain included in the canonical L3 boundary
- Active execution lane advances to Phase 12-S5 Approval / Notification / History / Replay UI Completion

### Phase 12-S5

- WebChat exposes read-only `/history` and `/history/replay` endpoints using the inbound token
- Gateway serve mode records safe complete-history replay metadata for user input, HDS decisions, approvals, execution feedback, and final output
- Control Center includes Complete History / Replay with digest/metadata-only entries
- WebChat strips raw `payload` before serializing history snapshots
- `complete_history_used_for_authority=false` remains explicit and history replay cannot approve, execute, mutate, or grant authority
- Active execution lane advances to Phase 12-S6 Root Full-access + Compound Attack Scenario Tests

### Phase 12-S6

- Added compound attack scenario tests for root/full-access operation
- Wildcard `full_access` grants cannot bypass L3 final-review for shell, schedule, GitHub, Google, or browser automation operations
- External metadata spoofing cannot impersonate owner approval or approval process state
- Forged channel-send metadata remains blocked by process execution policy
- Executor feedback cannot lift suspended requests or substitute human resume
- Complete-history references and history updates remain non-authority
- Active execution lane advances to Phase 12-S7 Detector Lifecycle and Unknown Pattern Escalation

### Phase 12-S7

- Added detector lifecycle traces to HDS-BRAIN axis scores
- Missing detectors, detector exceptions, invalid detector scores, duplicate policy axes, and unknown detector patterns now suspend before normal thresholds
- Invalid `risk_keyword` regex patterns classify as `detector_unknown_pattern`
- Detector lifecycle failures are audit-visible through commit thresholds and axis lifecycle traces
- Active execution lane advances to Phase 12-S8 HDS-BRAIN Fail-safe / Self-health Policy

### Phase 12-S8

- Added executable HDS-BRAIN self-health fail-safe preconditions
- New command emission suspends when policy validity, audit chain, Runtime Invariants, Approval Gate, HDS availability, or configured memory chain is unhealthy
- Fail-safe suspensions cannot be approved through human resume
- Fail-safe decisions expose failed preconditions and owner next action in audit-safe metadata
- HDS-BRAIN quality lock sequence reaches a natural audit boundary; active lane resumes to Phase 11-S10 Resident Application Integration

## 5. Non-Goals

Do not add:

- agent-driven authority core
- emotion functionality
- WhatsApp first-party core implementation
- ClawHub compatibility
- unsafe third-party skill execution
- CLI-only final UX
- unsupported preview features in main release
- commercial SaaS roadmap
- hidden privilege escalation
- black-box authority path
- channel-count competition

## 6. Reference Docs

- [Active Implementation Instructions](IMPLEMENTATION_INSTRUCTIONS.md)
- [OpenClaw Rejection Audit](OPENCLAW_REJECTION_AUDIT.md)
- [Phase 8-S4 GitHub Write](phase8-s4-github-write.md)
- [Phase 8-S5 Slack / Discord Polish](phase8-s5-slack-discord-polish.md)
- [Phase 10-S3 Distribution UX Hardening](phase10-s3-distribution-ux-hardening.md)
- [v1.0 Security and Permanent-Use Review](v1.0-security-and-permanent-use-review.md)
- [v1.0 Release Candidate](v1.0-release-candidate.md)
- [v1.0 Post-RC Closure Review](v1.0-post-rc-closure-review.md)
- [Phase 11-S6 Writing Operator Implementation](phase11-s6-writing-operator.md)
- [Phase 11-S7 Daily Operator Implementation](phase11-s7-daily-operator.md)
- [Phase 11-S10 Resident Application Integration](phase11-s10-resident-application-integration.md)
- [Phase 11-S11 Channel First-Party Promotion](phase11-s11-channel-first-party-promotion.md)
- [Phase 11-S12 Plugin Review Gate Implementation](phase11-s12-plugin-review-gate-implementation.md)
- [v1.0 GA Promotion Review](v1.0-ga-promotion-review.md)
- [Phase 11-S13 v1.0 GA Promotion Execution](phase11-s13-v1-ga-promotion-execution.md)
- [Phase 11-S8 Developer Operator Implementation](phase11-s8-developer-operator.md)
- [Phase 11-S9 Installer and Setup UX](phase11-s9-installer-setup-ux.md)
- [HDS-BRAIN Standalone Boundary](hds-brain-standalone-boundary.md)
- [Phase 12-S-1 HDS-BRAIN Standalone Completeness](phase12-s-1-hds-brain-standalone-completeness.md)
- [HDS-BRAIN Risk / Approval Boundary](hds-brain-risk-approval-boundary.md)
- [HDS-BRAIN Reference Boundary](hds-brain-reference-boundary.md)
- [HDS-BRAIN Fail-safe Policy](hds-brain-fail-safe-policy.md)
- [HDS-BRAIN Unknown Escalation Policy](hds-brain-unknown-escalation-policy.md)
- [HDS-BRAIN Detector Lifecycle](hds-brain-detector-lifecycle.md)
- [HDS-BRAIN Trinity M Policy Model](hds-brain-trinity-m-policy-model.md)
- [Phase 12-S0 Boundary Definition Lock](phase12-s0-boundary-definition-lock.md)
- [HDS-BRAIN Output / Result Audit Plane](hds-brain-output-audit-plane.md)
- [Phase 12-S1 Output / Result Audit Plane](phase12-s1-output-result-audit-plane.md)
- [HDS-BRAIN Complete History Substrate](hds-brain-complete-history-substrate.md)
- [Phase 12-S2 Local Complete History Substrate](phase12-s2-local-complete-history-substrate.md)
- [HDS-BRAIN Runtime Invariants Evidence](hds-brain-runtime-invariants-evidence.md)
- [Phase 12-S3 Runtime Invariants Evidence](phase12-s3-runtime-invariants-evidence.md)
- [Phase 12-S4 Final-review Operation Single Source](phase12-s4-final-review-single-source.md)
- [Phase 12-S5 Approval / Notification / History / Replay UI Completion](phase12-s5-approval-notification-history-replay-ui.md)
- [Phase 12-S6 Root Full-access + Compound Attack Scenario Tests](phase12-s6-root-full-access-compound-attack-scenarios.md)
- [Phase 12-S7 Detector Lifecycle and Unknown Pattern Escalation](phase12-s7-detector-lifecycle-unknown-pattern-escalation.md)
- [Phase 12-S8 HDS-BRAIN Fail-safe / Self-health Policy](phase12-s8-hds-brain-fail-safe-self-health-policy.md)
- [Docs Index](INDEX.md)
- [First-Run Checklist](FIRST_RUN_CHECKLIST.md)
- [Permanent-Use Checklist](PERMANENT_USE_CHECKLIST.md)
- [Channel Readiness Matrix](CHANNEL_READINESS_MATRIX.md)
- [Credential Readiness Matrix](CREDENTIAL_READINESS_MATRIX.md)
- [Update / Rollback Runbook](UPDATE_ROLLBACK_RUNBOOK.md)
- [Adapter Contract](ADAPTER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [LLM Development Guide](LLM_DEVELOPMENT_GUIDE.md)
- [Security Review Checklist](SECURITY_REVIEW_CHECKLIST.md)
- [Non-Goals](NON_GOALS.md)
- [Compatibility Matrix](compatibility-matrix.json)
