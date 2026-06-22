# BLUE-TANUKI Implementation Instructions v13

## Role of This File

This file is the active implementation instruction for Codex / LLM coding agents.

It is not a marketing roadmap.

It is a completion-oriented execution contract from the current repository state to v1.0-class completion.

It incorporates a rejection audit of OpenClaw. OpenClaw is treated as a **rejected design pattern**, not a master plan. BLUE-TANUKI exists because OpenClaw-style strategy produces unsafe software promoted as successful, and Codex must not import OpenClaw assumptions as design starting points.

Use this file with `AGENTS.md`.

If `docs/ROADMAP.md` conflicts with this file, treat `docs/ROADMAP.md` as context and this file as the active execution plan.

---

# P-Series Product Completion Roadmap

The product-completion roadmap is now the P-series defined in `docs/PRODUCT_ROADMAP.md`.

- Product phases are named `Phase Pn-SY`.
- P-series names must not collide with the existing `Phase X-SY` / Band A-F history.
- The active instruction is `Phase P13 — Owner GO / Product Release Boundary`.
- The Universal Phase Template below continues to apply to P-series phase instructions.
- Detailed phase scope and dependencies are referenced from `docs/PRODUCT_ROADMAP.md`.
- Former `Phase 11-S13 Owner GO Decision / v1.0.0 Promotion` is no longer active; D2 absorbs the old Bar G GO into the P13 product-release decision.

## Active P-Series Phase Detail

# Phase P13 — Owner GO / Product Release Boundary

## Objective

P13の製品release decision境界を固定する。owner GO、Windows実機E2E、version promotion、public claim activationが揃わない限りGAへ進まないことをproduct gateと文書で検査できる状態にする。

## Scope

- Add P13 owner-GO readiness documentation that records current pre-GO state and release blockers.
- Extend `validate:product -- --phase P13` with an owner-GO release-boundary check.
- Verify `validate:ga` pre-GO result stays `public_claim_allowed=false`.
- Verify `validate:ga -- --require-owner-go` remains blocked without owner decision.
- Keep package version `1.0.0-rc.1` and public claim inactive.
- Align docs index, release notes, roadmap, and validation docs with P13 boundary.

## Non-Goals

- Do not create `docs/ga-owner-decision.json`.
- Do not promote package version to `1.0.0`.
- Do not activate public GA / complete-superiority claims.
- Do not implement installer signing, automatic updater, Windows E2E execution, live external credential smoke, or manual app replacement.
- Do not promote Slack / Discord / Teams / LINE from preview.
- Do not promote WhatsApp from `reserved-third-party`.
- Do not add GUI Shell dependency, new runtime dependency, or new authority path.

## Inspect First

```bash
git status --short
rg -n "owner GO|ga-owner-decision|public_claim_allowed|require-owner-go|P13|validate:product|validate:ga|Windows実機E2E|1.0.0-rc.1" README.md QUICKSTART.md CLAIM.md docs scripts package.json apps
rg -n "PRODUCT_CHECKS|ProductPhase|PHASE_ORDER|p12.docs_support_claims|validateGaPromotionGate|OWNER_DECISION_PATH" scripts apps/gateway/test docs
```

## Implementation Requirements

- `docs/P13_OWNER_GO_READINESS.md` must record current pre-GO state, P13 criteria, GO blockers, and fail-closed rule.
- `scripts/validate_product.ts` must register `p13.owner_go_release_boundary`.
- The P13 check must assert pre-GO readiness, `owner_go=false`, `public_claim_allowed=false`, RC version, Bar G pending, and `require-owner-go` blocking without owner decision.
- The P13 check must assert D1-D8 decision ledger presence and P13 readiness/GA review/release notes consistency.
- `scripts/check_docs.mjs` and README / docs index must include the P13 readiness document.
- `apps/gateway/test/validate_product.test.ts` must assert P13 registration.

## Safety Requirements

- HDS-BRAIN remains the only authority source.
- P13 readiness docs and product validation evidence remain `used_for_authority=false`.
- Public claim remains blocked with `public_claim_allowed=false`.
- Owner GO cannot be inferred from validation success, bundle generation, docs presence, remote runner status, or LLM output.
- Preview status cannot be promoted by wording, Control Center state, plugin review evidence, channel metadata, or release readiness docs.
- Signed native installer, automatic updater, runtime auto-apply, and WhatsApp first-party support remain not shipped unless a future owner-scoped phase changes them.

## Operator Usability Requirements

- The owner must be able to see why P13 is still `PENDING_OWNER_GO`.
- The owner must be able to see which evidence is still required before actual GO.
- The owner must be able to run `validate:product -- --phase P13` and observe that the release boundary is fail-closed without owner decision.

## Audit Requirements

- P13 product validation evidence must keep `used_for_authority=false`.
- Evidence source class for P13 is `CONFIG` / `EXTERNAL_EVIDENCE`.
- Owner-GO readiness evidence is release evidence only, not runtime authority.

## Tests

- Unit tests must cover P13 product-check registration.
- Product validation must cover P13 owner-GO release boundary.
- Existing P2-P12 gates must remain passing.

## Docs

- Add `docs/P13_OWNER_GO_READINESS.md`.
- Update `docs/VALIDATE_PRODUCT.md`.
- Update `docs/PRODUCT_ROADMAP.md`.
- Keep `docs/ROADMAP.md` active phase pointer aligned.
- Update README / docs index / GA promotion review / release notes as needed.

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
pnpm validate:packaging
pnpm validate:ga
pnpm validate:product -- --phase P13 --evidence .codex-tmp/validate-product-p13-owner-go-local
pnpm release:bundle
pnpm release:verify
```

## Manual Smoke

Open P13 readiness, GA promotion review, release notes, and validate product docs. Confirm they state `PENDING_OWNER_GO`, `public_claim_allowed=false`, owner decision required, Windows実機E2E required, and no actual GA claim.

## Permanent-Use Check

The owner can identify the exact remaining release blockers and cannot accidentally interpret passed validation as owner GO.

## Acceptance Criteria

- Local validation passes.
- `validate:product -- --phase P13` passes on Linux as a pre-GO fail-closed boundary check.
- `validate:ga` remains pre-GO with `public_claim_allowed=false`.
- `validate:ga -- --require-owner-go` remains blocked without owner decision.
- P13 readiness document is indexed, linked, and checked by docs/product gates.
- Release claim remains pre-GO with `public_claim_allowed=false`.

## Final Report Format

Use the repository report format in `AGENTS.md`.

---

# 0. Product Definition

BLUE-TANUKI is a local owner-operated resident AI control plane.

Permanent principle:

```md
HDS-BRAIN owns authority.
LLMs, tools, channels, plugins, skills, memory, cron, browser automation, UI, onboarding, update flows, companion apps, and external services are downstream devices.
```

Completion means:

- not maximum feature count,
- not maximum channel count,
- not LLM autonomy,
- not a chatbot clone,
- not superficial "5-minute demo" success,
- but a resident control plane where broad local capability can exist without hidden authority, untraceable side effects, or final-review bypass.

---

# 1. OpenClaw Rejection Audit

## 1.1 Position

OpenClaw is rejected as a design pattern. This section exists only to make the rejection criteria explicit so that no Codex run reintroduces those patterns by drift.

## 1.2 Comparison Target

OpenClaw demonstrates a broad multi-channel assistant strategy:

- onboarding-oriented setup,
- daemon/service installation,
- dashboard/control UI,
- many channels,
- DM pairing / allowlist model,
- doctor/update/rollback docs,
- companion apps / nodes / voice / canvas,
- skills/plugin ecosystem.

BLUE-TANUKI must not copy this as-is.

The comparison question is:

```md
Does this actually make a beginner safely and permanently operational,
or does it only make first contact easy while pushing complexity into long-term operation?
```

## 1.3 Key Finding

OpenClaw-style "5-minute setup" is not equivalent to permanent usability.

Risks:

- first-run success can hide long-term service/config/credential complexity,
- many channels increase failure surface,
- pairing and allowlists improve safety but increase cognitive load,
- daemon/service installation can become opaque under failure,
- updates require package/service/config coordination,
- doctor output must be actionable or it becomes developer-only diagnostics,
- companion apps can improve UX but create extra support surfaces,
- channel count can become a distraction from safe operation.

## 1.4 BLUE-TANUKI Response

BLUE-TANUKI must answer with:

```md
Safety-first permanence.
```

Meaning:

1. HDS authority and final-review remain non-bypassable.
2. First-run path must become simple, but only after the safe path exists.
3. Permanent-use UX is a release gate, not a marketing claim.
4. Channel selection must be intentional.
5. OpenClaw's useful UX patterns are adapted under BLUE-TANUKI's authority model.
6. Unsupported or high-maintenance channels remain preview/third-party/reserved.

## 1.5 Adopt / Adapt / Reject / Reserve

| OpenClaw pattern | Assessment | BLUE-TANUKI action |
|---|---|---|
| Guided onboarding | Useful but can hide complexity | Adapt under HDS/doctor/actionable setup |
| Daemon/service install | Useful for permanence but failure-prone | Adapt after safety kernel |
| Dashboard / Control UI | Useful if it closes next-action loop | Adapt as Control Center |
| Many channels | Feature breadth, high operational burden | Reject as core strategy |
| Telegram as fastest channel | Valid practical starter | Adopt |
| WhatsApp ecosystem | Third-party extension surface, audit/authority boundary cannot be guaranteed | Reject as first-party; reserved-third-party only as deliberate safety + liability boundary |
| DM pairing / allowlist | Strong inbound safety idea | Adapt into owner access model |
| Device/node pairing | Useful later, not core v0.1 | Reserve for v0.3+ |
| Update / rollback docs | Necessary for permanence | Adopt |
| Doctor diagnostics | Necessary only if actionable | Adapt with "what next" output |
| Skills/plugin marketplace | Supply-chain risk | Reject for first-party core |
| Companion apps / voice / canvas | UX-expanding but support-heavy | Reserve for later phases |

---

# 2. Global Completion Strategy

The repository must move through these completion bands:

## Band A — Safety Kernel

Goal:

- authority path closed,
- Approval Gate closed,
- audit closed,
- runtime invariants visible.

Already mostly implemented.

## Band B — v0.1 Completion

Goal:

- local owner setup works,
- WebChat / Telegram smoke works,
- runtime schedule is safe,
- approval levels are first-class,
- operator usability closure exists,
- release bundle and validation pass.

Repository health phase 2 adds a core release path purity gate: production
runtime must not static-import doctor/setup/audit/installer utilities, preview
credentials must not fail core doctor, and `pnpm validate:repo-health` must pass
before release-path changes are considered complete.

Remaining primary work:

- v0.1 live smoke cleanup
- docs consistency

## Band C — v0.1.x Stabilization

Goal:

- GitHub write downstream tool,
- Slack / Discord release polish,
- browser automation preview,
- stronger live smoke,
- conformance test expansion.

## Band D — v0.2 Capability Expansion

Goal:

- Google integrations,
- Teams / LINE,
- F-reference audit integration,
- memory continuity not authority,
- adapter maturity.

## Band E — v0.3 Resident UX

Goal:

- Control Center polish,
- notification center,
- approval UX,
- settings UX,
- installer experience,
- local app feel.

## Band F — v1.0 Release Hardening

Goal:

- repeatable install,
- documented recovery,
- stable extension boundary,
- security review checklist complete,
- permanent-use UX proven,
- v1.0 support/non-support boundary clear,
- no critical preview paths in main release.

---

# 3. Global Invariants

These must remain true:

```json
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "complete_history_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

Do not regress:

- hash-chain audit verification,
- runtime snapshot visibility,
- approval audit trace,
- plugin capability enforcement,
- file root sandbox,
- SSRF guard,
- resume token separation,
- one-time approval token behavior,
- boot-time schedule behavior,
- Daily Brief smoke behavior,
- release bundle secret exclusion,
- setup/config preservation,
- update/rollback clarity.

---

# 4. Current State Assumption

Codex must verify this by grep before coding, but current expected state is:

Completed or mostly completed:

- `AGENTS.md`
- `docs/ROADMAP.md`
- HDS-BRAIN authority path
- Runtime Invariants
- Approval Gate
- full-access local default
- final-review boundary
- hash-chain audit
- plugin loader
- capability envelope
- WebChat
- Telegram
- Slack release-polished preview
- Discord release-polished preview
- boot-time Daily Brief / generic scheduled messages
- file tools
- http / web search tools
- `github.read`
- `browser.read`
- `shell.exec`
- `github.write`
- local setup/settings/doctor/release bundle
- HDS long-term memory addendum as non-authority memory component
- ApprovalLevel first-class
- runtime schedule CRUD
- OpenClaw rejection audit document

Known gaps:

- Slack / Discord remain preview until owner credentialed live smoke is run
- browser automation is implemented as disabled-by-default preview
- Google write integrations are implemented as bounded L3 downstream tools
- Teams / LINE are implemented as first-party-preview target adapters; owner credentialed live smoke and permanent-use review are still required before first-party promotion
- resident native UX is not complete
- v1.0 hardening is not complete

---

# 5. Execution Queue

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

---

# 6. Universal Phase Template

Each phase must follow this pattern:

```md
# Phase X-SY — Title

## Objective

## Scope

## Non-Goals

## Inspect First

## Implementation Requirements

## Safety Requirements

## Operator Usability Requirements

## Audit Requirements

## Tests

## Docs

## Validation Commands

## Manual Smoke

## Permanent-Use Check

## Acceptance Criteria

## Final Report Format
```

Do not implement a phase if the instruction is not specific enough to satisfy this template.

---

# Phase 8-S1 — ApprovalLevel first-class + runtime schedule CRUD

## Objective

Convert the draft L1/L2/L3 approval model into a first-class TypeScript workflow layer, then implement runtime `schedule.*` CRUD on top of that layer.

This phase completes the missing foundation needed for runtime automation, GitHub write, browser automation, Google integrations, and resident automation.

## Critical Correction

Do **not** collapse `ApprovalRisk`.

Keep `ApprovalRisk` as the severity axis with three levels in v0.1:

```ts
type ApprovalRisk = "low" | "medium" | "high";
```

`critical` is intentionally deferred. A 4-tier severity axis multiplies enum-comparison, test, and docs cost everywhere it is referenced, and the present design has no operation that needs to be distinguished from `high`. If a future operation genuinely cannot be served by `high -> L3_final_review`, raise it as a separate security phase and add `critical` then.

Add:

```ts
type ApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";
```

Meaning:

- `ApprovalRisk` = severity
- `ApprovalLevel` = approval workflow

Mapping:

- low read/noop/llm operations -> L1
- ordinary non-final-review state change -> L2
- final-review operation -> L3
- high risk -> L3
- schedule create/update/delete -> L3
- schedule list -> L1

## Scope

Implement:

1. `ApprovalLevel` type and derivation
2. `ApprovalEvaluation.approval_level`
3. authority trace inclusion of `approval_level`
4. final-review expansion to include schedule update/delete
5. runtime schedule schema/store
6. `schedule.create`
7. `schedule.update`
8. `schedule.delete`
9. `schedule.list`
10. existing cron lane integration
11. safe runtime snapshot counters
12. audit lifecycle events
13. tests
14. docs
15. changelog
16. phase report

## Non-Goals

Do not implement:

- GitHub write
- browser automation
- Slack / Discord release polish
- Google integrations
- Teams / LINE
- native app/menu bar distribution
- arbitrary cron expression parser
- memory authority integration
- ApprovalRisk redesign
- guided onboarding
- daemon install changes
- new external npm dependency unless justified

## Inspect First

```bash
git status --short

grep -rn "ApprovalRisk" packages/hds-brain/src apps/gateway/src
grep -rn "FINAL_REVIEW_OPERATIONS" packages/hds-brain/src apps/gateway/src
grep -rn "ApprovalMode" packages/hds-brain/src apps/gateway/src
grep -rn "BLUE_TANUKI_SCHEDULES_JSON" .
grep -rn "CronSchedulerChannel" apps/gateway/src packages
grep -rn "cron.process" packages/hds-brain/src apps/gateway/src
grep -rn "pendingApprovals" apps/gateway/src
grep -rn "runtime/snapshot" apps/gateway/src packages/channel-webchat/src
grep -rn "TOOL_SPECS" packages/hds-brain/src
grep -rn "channel_send" packages/hds-brain/src apps/gateway/src
grep -rn "ToolRegistry" packages apps
grep -rn "registerBuiltinTools" packages apps
```

Expected anchors (estimated paths — confirm by grep before editing):

```txt
packages/hds-brain/src/approval_policy.ts
packages/hds-brain/src/action_router.ts
packages/hds-brain/src/controller.ts
apps/gateway/src/approval_runtime.ts
apps/gateway/src/serve.ts
apps/gateway/src/cron_channel.ts
apps/gateway/src/plugin_loader.ts
packages/blue-tanuki/src/tools/builtin.ts
SECURITY.md
CONFIG.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
```

These paths are inferred from the repository's documented architecture; not all are guaranteed to exist with these exact names. If grep returns no match for a listed file, Codex must:

1. Search for the equivalent symbol or responsibility using the grep commands above.
2. Use the actual discovered path.
3. Report the path correction in the Final Report `Files changed` section.

Do not invent a missing file. Do not create `packages/blue-tanuki/` if no such package exists in the workspace — the tool registration site is whichever package actually exports the tool registry.

## Implementation Requirements

### ApprovalLevel

Add:

```ts
export type ApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";
```

Add derivation:

```ts
export function approvalLevelFromContext(ctx: ApprovalContext): ApprovalLevel
```

or equivalent.

Update:

- `ApprovalEvaluation`
- `AuthorityTransparencyTrace.resolved_factors`
- approval docs
- tests

### Final-review set

Ensure it contains:

```txt
tool.file.delete
tool.shell.exec
external.send
credential.access
settings.write
schedule.create
schedule.update
schedule.delete
payment.charge
```

Note on `payment.charge`: no payment functionality exists in v0.1. The entry is a **defensive placeholder** so that any future payment-class operation is forced through L3 from the moment it is introduced. Tests must assert the placeholder is present in the final-review set; tests must not exercise an actual payment path.

### Runtime schedule schema

Use existing schedule semantics.

```ts
interface RuntimeSchedule {
  id: string;
  origin: "runtime";
  enabled: boolean;
  channel: string;
  target: string;
  content: string;
  time?: string;
  interval_ms?: number;
  created_at_ms: number;
  updated_at_ms: number;
  payload_hash: string;
  status: "pending" | "active" | "disabled" | "deleted" | "rejected";
}
```

Do not add arbitrary cron syntax.

### ENV

Add if needed:

```bash
BLUE_TANUKI_SCHEDULES_DIR=.blue-tanuki/schedules
BLUE_TANUKI_SCHEDULE_APPROVAL_TIMEOUT_MS=86400000
```

### Tool commands

Support:

```txt
tool:schedule.list
tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
tool:schedule.update id=<id> content="updated smoke"
tool:schedule.delete id=<id>
```

JSON form:

```txt
tool:schedule.create {"channel":"webchat","target":"local-user","content":"runtime smoke","interval_ms":120000}
```

Capabilities:

```txt
tool:schedule.list
schedule:read

tool:schedule.create
schedule:create

tool:schedule.update
schedule:update

tool:schedule.delete
schedule:delete
```

### Pending behavior

- create requested -> pending -> approval -> active
- create rejected/timeout -> not active
- update requested -> pending while old schedule remains active
- update approved -> atomic replace
- update rejected/timeout -> old schedule remains active
- delete requested -> pending while old schedule remains active
- delete approved -> disabled/deleted and unregistered
- delete rejected/timeout -> old schedule remains active
- conflicting update/delete while pending -> reject

### Scheduler lane

Boot-time and runtime schedules must share one effective scheduler lane.

Add `origin`:

```ts
origin: "boot" | "runtime"
```

Do not expose `content` in runtime snapshot.

Snapshot may expose:

```ts
runtime_schedules_count: number
pending_schedule_approvals_count: number
scheduled_tasks: safe metadata only
```

### Audit lifecycle

Record:

```txt
schedule.lifecycle.requested
schedule.lifecycle.approved
schedule.lifecycle.rejected
schedule.lifecycle.activated
schedule.lifecycle.updated
schedule.lifecycle.deleted
schedule.lifecycle.fired
```

Can use existing `authority_event` / `command_lifecycle` if new audit kind is too invasive.

Required fields:

- schedule_id
- origin
- operation
- actor
- approval_level
- risk
- payload_hash
- previous_payload_hash when applicable
- command_id
- request_id
- timestamp

## Operator Usability Requirements

This phase is not an onboarding phase, but schedule errors must already be owner-usable.

For every schedule rejection/error, output must answer:

- what failed,
- whether anything was activated,
- whether the schedule can still fire,
- next action,
- audit reference when available.

## Tests

Required:

- ApprovalLevel classification
- final-review operation list
- full_access containment
- reusable grant non-bypass
- schedule list L1
- schedule create/update/delete L3
- valid schedule create
- invalid id/channel/target/content/time/interval
- duplicate active schedule rejection
- create pending/approved/rejected/timeout
- update pending/approved/rejected/timeout
- delete pending/approved/rejected/timeout
- pending conflict rejection
- runtime schedule fires through cron/HDS path
- trusted metadata required for channel_send
- boot-time schedule regression
- Daily Brief regression
- audit chain valid
- runtime snapshot invariants unchanged

## Docs

Update:

```txt
SECURITY.md
CONFIG.md
AUDIT.md
README.md
CHANGELOG.md
docs/phase8-s1-approval-level-runtime-schedule.md
```

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm smoke:live
pnpm run doctor
pnpm validate:packaging
pnpm release:bundle -- --dry-run
```

For this phase, `pnpm smoke:serve` and `pnpm smoke:resume` are optional unless the task
explicitly targets smoke checks, root workspace resolution, or release validation.
They are no longer classified as known environment failures.

## Manual Smoke

1. Start gateway with full access.
2. Submit `tool:schedule.create ... interval_ms=120000`.
3. Confirm pending approval.
4. Approve.
5. Confirm activation.
6. Confirm message fires.
7. Confirm audit lifecycle.
8. Delete schedule.
9. Approve delete.
10. Confirm no further fires.

## Acceptance Criteria

- `ApprovalLevel` exists.
- `ApprovalRisk` is three-tier (`low | medium | high`) and `critical` is intentionally absent in v0.1.
- L1/L2/L3 behavior is tested.
- schedule create/update/delete are L3.
- schedule list is L1.
- pending schedules do not run.
- rejected schedules do not run.
- boot-time schedules still work.
- audit remains valid.
- runtime invariants unchanged.
- schedule errors are owner-actionable.
- docs updated.
- validation reported.

---

# Phase 8-S2a — Operator Usability Docs

## Objective

Produce the documentation that lets an owner safely run BLUE-TANUKI v0.1 beyond first-run success.

This Phase is docs-only. No runtime code changes. Splitting docs from the doctor/Control-Center code changes (Phase 8-S2b) keeps each PR reviewable and prevents the docs from drifting against not-yet-written code.

## Scope

Create or update:

1. First-run checklist
2. Permanent-use checklist
3. Channel readiness matrix
4. Credential readiness matrix
5. Update / rollback / recovery runbook
6. README.md operator path
7. QUICKSTART.md alignment
8. CONFIG.md alignment
9. TROUBLESHOOTING.md alignment
10. CHANGELOG.md entry
11. Phase 8-S2a report

## Non-Goals

- no doctor code change (Phase 8-S2b)
- no Control Center status endpoint change (Phase 8-S2b)
- no new channel
- no new tool
- no native app rewrite
- no "5-minute" marketing claim unless criteria are actually met

## Inspect First

```bash
grep -rn "setup" README.md QUICKSTART.md CONFIG.md docs apps/gateway/src
grep -rn "doctor" README.md QUICKSTART.md CONFIG.md docs apps/gateway/src
grep -rn "WEBCHAT_TOKEN" README.md QUICKSTART.md CONFIG.md docs apps/gateway/src
grep -rn "TELEGRAM_BOT_TOKEN" README.md QUICKSTART.md CONFIG.md docs apps/gateway/src
grep -rn "release:bundle" .
grep -rn "rollback\|update\|uninstall" README.md QUICKSTART.md docs install apps/gateway/src
grep -rn "runtime schedule outside v0.1" .
```

Note: `pnpm setup` is **already implemented** in Phase 6-S1 and exists in the repo. Phase 8-S2a strengthens the operator-usability surface around it, not the command itself.

## Implementation Requirements

### First-run checklist

Create:

```txt
docs/FIRST_RUN_CHECKLIST.md
```

Must include:

- prerequisites,
- setup command (reference existing `pnpm setup`),
- env/token expectations,
- start command,
- open Control Center,
- send first WebChat message,
- optional Telegram setup,
- expected success output,
- common failure cases,
- next action for each failure.

### Permanent-use checklist

Create:

```txt
docs/PERMANENT_USE_CHECKLIST.md
```

Must include:

- startup,
- stop/restart,
- config location,
- credential location/handling,
- audit verification,
- approval queue,
- runtime schedules,
- channel readiness,
- update,
- rollback,
- uninstall/purge,
- backup/restore,
- known limitations.

### Channel readiness matrix

Create:

```txt
docs/CHANNEL_READINESS_MATRIX.md
```

Fields per channel:

- channel,
- status (first-party / preview / reserved-third-party),
- setup difficulty,
- credential requirement,
- live smoke support,
- skip path support,
- inbound support,
- outbound support,
- rate limit/backoff status,
- known failure modes,
- next phase.

### Credential readiness matrix

Create:

```txt
docs/CREDENTIAL_READINESS_MATRIX.md
```

Fields per credential/env:

- credential/env,
- required for,
- secret class,
- setup source,
- doctor check (record current state; do not change doctor code here),
- safe missing behavior,
- failure message,
- rotation notes.

### Update / rollback runbook

Create:

```txt
docs/UPDATE_ROLLBACK_RUNBOOK.md
```

Do not claim auto-update unless implemented.

Must include:

- source install update,
- release bundle update,
- config preservation,
- audit/session/memory preservation,
- rollback,
- doctor after update,
- when to stop,
- when to purge.

### README / QUICKSTART / CONFIG / TROUBLESHOOTING alignment

- README.md must link to the new docs above.
- QUICKSTART.md must reference the first-run checklist as the long-form companion.
- CONFIG.md must be consistent with the credential readiness matrix.
- TROUBLESHOOTING.md must be consistent with documented failure modes.
- Any stale wording that describes runtime schedule creation as outside v0.1 must be removed (Phase 8-S1 supersedes it).

## OpenClaw Rejection Constraint

Do not claim "beginner can use in 5 minutes" unless the repo has a tested flow satisfying:

- clean environment,
- documented OS,
- prerequisite check,
- setup command,
- start command,
- Control Center open,
- first message success,
- doctor success or actionable warning,
- no unexplained daemon/credential state.

If the repo does not meet this, state in the docs:

```md
v0.1 provides a guided first-run path, not a verified 5-minute beginner guarantee.
```

The OpenClaw-style "5-minute" claim is treated as an anti-pattern. Honest first-run language is preferred over marketing parity.

## Tests

Static checks only (no runtime code change):

- every doc path referenced by README.md / QUICKSTART.md exists,
- readiness matrices parse if structured,
- no doc contradicts CONFIG.md ENV definitions,
- no stale runtime-schedule-disabled text remains after Phase 8-S1,
- compatibility matrix status is consistent across docs.

If the repo lacks a docs-link checker, add a minimal one under `scripts/` and wire it into `pnpm test` or a dedicated `pnpm docs:check` script.

## Docs

Update:

```txt
README.md
QUICKSTART.md
CONFIG.md
TROUBLESHOOTING.md
docs/FIRST_RUN_CHECKLIST.md
docs/PERMANENT_USE_CHECKLIST.md
docs/CHANNEL_READINESS_MATRIX.md
docs/CREDENTIAL_READINESS_MATRIX.md
docs/UPDATE_ROLLBACK_RUNBOOK.md
docs/phase8-s2a-operator-usability-docs.md
CHANGELOG.md
```

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm run doctor
pnpm validate:packaging
pnpm release:bundle -- --dry-run
```

No new runtime behavior expected, so smoke is unchanged.

## Acceptance Criteria

- owner can follow docs without knowing code internals,
- no false 5-minute claim anywhere in repo,
- first-run and permanent-use are separated documents,
- channel and credential readiness are explicit,
- update/rollback story exists,
- runtime invariants remain unchanged (no code changed),
- docs-link checker passes,
- validation reported.

---

# Phase 8-S2b — Doctor Actionable Output + Control Center First-Run Status

## Objective

Make `doctor` diagnostics owner-actionable and expose enough safe runtime state through Control Center / runtime snapshot to answer first-run and permanent-use questions without leaking secrets.

This Phase is code-focused. It depends on Phase 8-S2a docs being in place so that doctor and Control Center output can link to authoritative docs.

## Scope

1. Doctor JSON / human output gains structured remediation fields.
2. Control Center / runtime snapshot exposes first-run status answers.
3. Tests for doctor schema and runtime snapshot fields.
4. Docs updated to reflect the new fields.

## Non-Goals

- no new doc creation (Phase 8-S2a covers docs)
- no new channel
- no GitHub write
- no browser automation
- no Google integration
- no native app rewrite

## Inspect First

```bash
grep -rn "doctor" apps/gateway/src scripts packages
grep -rn "runtime/snapshot" apps/gateway/src packages/channel-webchat/src
grep -rn "ControlCenter\|control_center\|control-center" .
grep -rn "first_run\|first-run\|firstRun" .
```

## Implementation Requirements

### Doctor actionable output

Every warning/error in doctor output must map to:

```md
status         (ok | warning | error)
cause          (one-line)
impact         (what is affected)
next_action    (concrete command or doc reference)
doc_ref        (doc file or anchor in this repo)
safe_to_ignore (true | false)
```

Both JSON and human-readable output must carry these fields (JSON authoritative; human output derived).

If, after this PR, certain legacy doctor messages still cannot be mapped, the PR must:

- list them explicitly in `docs/phase8-s2b-doctor-gap.md` as a follow-up,
- mark each as `safe_to_ignore: false` with `next_action: "report to maintainer"` until properly mapped.

### Control Center first-run status

Control Center or runtime snapshot must expose enough safe information to answer:

- Is gateway running?
- Is HDS invariant state healthy?
- Is WebChat ready?
- Is Telegram configured?
- Are there pending approvals?
- Are runtime schedules pending/active?
- Is audit chain valid?
- What is the next recommended action?

No secrets. No schedule payload content. No credential values. Counts and statuses only.

Extend `/runtime/snapshot` (or equivalent) with:

```ts
{
  gateway_status: "running" | "starting" | "degraded",
  hds_invariants_ok: boolean,
  webchat_ready: boolean,
  telegram_configured: boolean,
  pending_approvals_count: number,
  runtime_schedules_count: number,
  pending_schedule_approvals_count: number,
  audit_chain_valid: boolean,
  next_recommended_action: string | null
}
```

`next_recommended_action` must be a short human-readable hint such as `"Configure TELEGRAM_BOT_TOKEN to enable Telegram"` or `null` if the system is healthy and idle.

## Safety Requirements

- doctor output must not leak secret values,
- runtime snapshot must not expose schedule payload `content`,
- `next_recommended_action` must not contain credentials,
- runtime invariants 5-tuple remains unchanged,
- audit chain validation result must reflect the actual chain state.

## Tests

- doctor JSON schema validation,
- doctor remediation fields present for every status entry,
- runtime snapshot new fields present and typed,
- secrets-leak negative test on doctor and snapshot output,
- runtime invariants unchanged,
- existing doctor / snapshot regression tests still pass.

## Docs

Update:

```txt
README.md
TROUBLESHOOTING.md
docs/phase8-s2b-doctor-and-status.md
CHANGELOG.md
```

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm smoke:live
pnpm run doctor
pnpm validate:packaging
pnpm release:bundle -- --dry-run
```

For this phase, `pnpm smoke:serve` and `pnpm smoke:resume` are optional unless the task
explicitly targets smoke checks, root workspace resolution, or release validation.
They are no longer classified as known environment failures.

## Manual Smoke

1. Start gateway with no Telegram token configured.
2. Call `pnpm run doctor`; confirm every warning includes `status / cause / impact / next_action / doc_ref / safe_to_ignore`.
3. Hit `/runtime/snapshot`; confirm new fields including `telegram_configured: false` and a meaningful `next_recommended_action`.
4. Configure Telegram; rerun doctor and snapshot; confirm `telegram_configured: true` and `next_recommended_action` advances.

## Acceptance Criteria

- doctor output is owner-actionable,
- doctor JSON schema is tested,
- Control Center / snapshot answers first-run status questions,
- no secret leakage,
- runtime invariants unchanged,
- validation reported.

---

# Phase 8-S3 — OpenClaw Rejection Audit Document

## Objective

Create an explicit internal engineering document recording the criteria by which OpenClaw's design pattern is rejected as a basis for BLUE-TANUKI, and the specific roadmap consequences that follow.

This is an internal engineering document, not marketing material. It exists so that no future Codex run reintroduces OpenClaw assumptions by drift, and so that the rejection criteria are reviewable as a single artifact.

## Output

Create:

```txt
docs/OPENCLAW_REJECTION_AUDIT.md
```

## Required Sections

1. Scope and intent (engineering audit, not commentary)
2. What OpenClaw appears to optimize
3. Why BLUE-TANUKI rejects each of those optimizations
4. 5-minute setup claim — rejection of marketing parity
5. Permanent-use UX — why BLUE-TANUKI treats this as a release gate instead
6. Channel breadth — why count is rejected as a quality metric
7. Safety boundary — what BLUE-TANUKI requires that OpenClaw's pattern does not
8. Update/rollback — what BLUE-TANUKI requires that OpenClaw's pattern does not
9. Skills/plugin supply-chain — why BLUE-TANUKI rejects unsigned third-party skill execution
10. WhatsApp ecosystem — why first-party exclusion is a safety + liability boundary, not a deferral
11. Adopt / Adapt / Reject / Reserve table (carried from this instruction file)
12. Resulting BLUE-TANUKI roadmap effects

## Acceptance Criteria

- no marketing tone,
- no feature-count framing,
- explicit rejection criteria stated in engineering terms,
- WhatsApp exclusion explained as deliberate safety + liability boundary,
- concrete roadmap effects listed,
- claims about OpenClaw phrased as "comparison target observations" rather than asserted facts about that project,
- file committed and linked from AGENTS.md if appropriate.

---

# Phase 8-S4 — GitHub Write Tool

## Objective

Add authenticated GitHub write operations as downstream tools using the Phase 8-S1 ApprovalLevel model.

## Scope

Initial supported operations:

- issue create
- issue comment create
- issue update
- PR create
- PR comment create

Deferred:

- merge PR
- close issue/PR
- delete branch
- force update
- release publish
- workflow dispatch
- secrets
- repository settings

## Approval Mapping

- `github.read` remains read-only.
- issue/PR/comment create is external write.
- public mutation defaults to L3 unless specifically proven safe as L2.
- destructive operations, when later added, must be L3.

## Capabilities

Possible capabilities:

```txt
tool:github.write
network:api.github.com
secrets:GITHUB_TOKEN
github:issue.write
github:pr.write
github:comment.write
```

## Safety Requirements

- no GitHub metadata as authority
- no approval bypass
- token required
- fail closed without token
- repository allowlist if implemented must be documented
- audit every write attempt and result digest
- user-visible error must identify safe retry state

## Docs

Update:

```txt
README.md
CONFIG.md
SECURITY.md
AUDIT.md
CHANGELOG.md
docs/phase8-s4-github-write.md
```

---

# Phase 8-S5 — Slack / Discord Release Polish + Live Smoke

## Objective

Move Slack and Discord adapters from preview toward first-party release quality.

## Scope

- rate limit handling
- backoff
- recoverable/non-recoverable typed errors
- improved user-visible error messages
- docs
- live smoke credential path
- skip path remains green without credentials
- conformance tests
- audit-compatible traces

## Non-Goals

- no authority model change
- no external write policy change
- no new channel expansion

## Acceptance Criteria

- Slack/Discord conformance tests pass
- live smoke skips safely without credentials
- live smoke can run with credentials
- compatibility matrix accurately reflects status
- no channel metadata authority escalation
- permanent-use failure modes documented

---

# Phase 8-S6 — Browser Automation Preview

## Objective

Add headless browser automation as disabled-by-default preview.

## Scope

- preview package or module
- explicit env enable
- sandbox policy
- network policy
- resource limits
- no credential leakage
- ApprovalRisk / ApprovalLevel mapping
- audit trace
- smoke skip path

## Non-Goals

- not main release quality
- not enabled by default
- not a general remote-control browser without guardrails
- not a replacement for `browser.read`

## Approval Mapping

- read-only page snapshot may be L1/L2 depending network risk
- click/navigation with side effect potential is L3
- form submit is L3
- file upload/download is L3
- credential usage is L3

## Acceptance Criteria

- preview quarantine documented
- disabled by default
- tests pass
- runtime invariants unchanged
- permanent-use limitations explicit

---

# Phase 9-S1 — F-reference Audit Integration

## Objective

Integrate F-reference audit traces without making memory authority.

## Scope

- memory read references as `F:<id>`
- memory write references as `F:<id>`
- audit trace inclusion
- safe Control Center display of references
- no authority escalation

## Non-Goals

- no memory-based permission grant
- no memory-based owner consent
- no memory-driven privileged action

## Acceptance Criteria

- `memory_used_for_authority=false`
- F-reference visible in audit
- memory cannot bypass approval
- tests cover non-escalation

---

# Phase 9-S2 — Gmail / Google Calendar / Drive Read Integration

## Objective

Add Google read integrations for Daily Brief and local assistant utility.

## Scope

- Gmail read summary
- Calendar read summary
- Drive read/search metadata
- credential capability declarations
- read-only audit traces
- Daily Brief source integration

## Approval Mapping

- read-only summaries may be L1/L2 depending credential sensitivity
- credential access is final-review where needed
- no write operations in this phase

## Non-Goals

- no email send
- no calendar write
- no Drive write
- no autonomous cross-service action

## Completion Notes

- Added read-only `gmail.read`, `google.calendar.read`, and `google.drive.read` tool envelopes.
- Added credential capability declarations and credential-access approval mapping for Google read tools.
- Added optional read-only Google Daily Brief source with dynamic cron payload hashes.
- Added doctor/docs/tests for missing-token fail-closed behavior and no Google writes.

---

# Phase 9-S3 — Google Write Integration

## Objective

Add write operations only after read integration is stable.

## Scope

Potential operations:

- Gmail draft create
- Gmail send
- Calendar create/update/delete
- Drive file create/update

## Approval Mapping

- drafts: L2 or L3 depending external visibility
- send email: L3
- calendar create/update/delete: L3
- Drive create/update: L3
- Drive delete/share: deferred and must be L3 if added later

## Requirements

- explicit approval
- audit trace
- no metadata authority
- credential capability declarations
- safe failure modes

## Completion Notes

- Added `gmail.write`, `google.calendar.write`, and `google.drive.write`.
- Mapped Google writes to `google.write`, high risk, and `L3_final_review`.
- Added bounded Gmail draft/send, Calendar event create/update/delete with `sendUpdates=none`, and Drive file create/update.
- Added capability declarations, docs, and tests for fail-closed token/argument handling.

---

# Phase 9-S4 — Teams / LINE Adapters

## Objective

Add Teams and LINE as first-party target adapters.

## Requirements

- adapter contract
- capability envelope
- conformance tests
- live smoke skip path
- no authority metadata escalation
- docs
- compatibility matrix update
- permanent-use failure modes

## Non-Goals

- WhatsApp first-party support

## Completion Notes

- Added `@blue-tanuki/channel-teams` and `@blue-tanuki/channel-line` as first-party-preview channel adapters.
- Teams outbound uses Microsoft Graph chatMessage send; LINE outbound uses Messaging API push.
- Missing credentials fail closed through silent mode with typed downstream delivery results.
- Adapter conformance, compatibility matrix, doctor, live smoke skip paths, docs, and capability envelopes are updated.
- First-party promotion remains gated on owner-run credentialed live smoke and permanent-use recovery review.

---

# Phase 10-S1 — Control Center Approval UX Polish

## Objective

Make Approval Queue, Authority Trace, Runtime Schedules, and Audit visibility usable as a resident console.

## Scope

- approval queue clarity
- final-review labeling
- ApprovalLevel display
- schedule pending/active display
- authority trace display
- audit chain status
- first-run next action
- permanent-use status card
- no secret/content leakage

## Non-Goals

- no native app shell
- no mobile
- no voice

## Completion Notes

- Control Center now exposes first-run next action and permanent-use status cards.
- Approval Queue displays pending count, ApprovalLevel, final-review status, token expiry, reason, and redacted authority trace.
- Runtime Schedules display active/pending counts, lifecycle metadata, approval linkage, timing, and payload hashes without schedule content.
- Authority Trace and Audit views now render operator-readable summaries while redacting token, secret, credential, password, and content-like keys in raw JSON panes.

---

# Phase 10-S2 — Resident Notification Center

## Objective

Add resident notification behavior without creating a second authority path.

## Scope

- local notifications or in-app notification center
- approval required notifications
- schedule fired/failed notifications
- connector failure notifications
- audit status warning notifications

## Safety

- notification is display only
- notification cannot approve by itself
- notification metadata is not authority

## Completion Notes

- WebChat exposes `GET /notifications` with the normal inbound token.
- Control Center includes a read-only Notification Center panel.
- Notifications are projected from existing runtime, approval, audit, and authority trace state.
- Covered notification kinds: approval required, schedule fired, schedule failed, connector failure, and audit warning.
- Notification metadata is marked `authority=display_only` and cannot approve, reject, execute, mutate audit, or grant authority.

---

# Phase 10-S3 — Distribution UX Hardening

## Objective

Improve installation/update/uninstall experience without pretending to be a signed native product unless actually implemented.

## Scope

- installer docs
- doctor gates
- config preservation
- release bundle checks
- platform notes
- recovery docs
- rollback docs
- uninstall/purge docs

## Non-Goals

- no false claim of signed installer
- no automatic updater unless explicitly implemented
- no commercial SaaS framing

## Completion Notes

- `doctor` now includes a `distribution_readiness` check for installer docs, update/rollback guidance, permanent-use checklist boundaries, release bundle creator/verifier coverage, packaging validation, and platform uninstall/purge scripts.
- Installer and rollback docs explicitly state the portable distribution boundary: no signed native installer and no automatic updater.
- `pnpm validate:packaging` now checks the distribution readiness gate and Phase 10-S3 report.
- Completion report: `docs/phase10-s3-distribution-ux-hardening.md`.

---

# Phase 11-S1 — v1.0 Security + Permanent-Use Review Closure

## Objective

Run a full security, architecture, and permanent-use closure before v1.0.

## Required Review Areas

- authority path
- approval model
- final-review operations
- runtime automation
- external write tools
- channel adapters
- memory / F-reference
- browser automation preview
- Google integrations
- install/update/uninstall
- audit verification
- capability envelope
- secret handling
- SSRF/file/process sandbox
- docs consistency
- compatibility matrix
- first-run UX
- permanent-use UX
- recovery/rollback

## Output

Create:

```txt
docs/v1.0-security-and-permanent-use-review.md
```

## Acceptance Criteria

- no known final-review bypass
- no hidden authority source
- no undocumented privileged operation
- no stale preview promoted as release
- no false 5-minute claim
- permanent-use checklist passes
- all validation reported

## Completion Notes

- Created `docs/v1.0-security-and-permanent-use-review.md`.
- Reviewed all required areas and recorded PASS/known-preview boundaries.
- No release-blocking final-review bypass, hidden authority source, undocumented privileged operation, stale preview promotion, or false 5-minute claim was identified.
- Validation record is captured in the review document.

---

# Phase 11-S2 — v1.0 Release Candidate

## Objective

Prepare a v1.0 release candidate.

## Scope

- changelog consolidation
- docs index
- release bundle
- validation matrix
- known limitations
- non-goals
- support boundary
- upgrade notes
- compatibility matrix
- final smoke
- first-run proof
- permanent-use proof

## Acceptance Criteria

- v1.0 claim is accurate
- no unsupported channel is described as supported
- no preview feature is described as complete
- release bundle validates
- security/permanent-use review exists
- smoke/test results reported

## Completion Notes

- Workspace package and plugin manifest versions are `1.0.0-rc.1`.
- Created `docs/INDEX.md`.
- Created `docs/v1.0-release-candidate.md`.
- Compatibility matrix first-party targets are `v1.0`; preview channels remain `first-party-preview` with `v1.0-preview` targets.
- RC document records support/no-support boundary, upgrade notes, first-run proof, permanent-use proof, validation matrix, and release decision boundary.
- Post-RC closure review records bundle integrity sidecar policy, Windows `smoke:resume` proof, credentialed live-smoke blocker, preview-promotion decision, signed-installer decision, and updater decision.

---

# Phase 11-S3 — Strategic Frame and GA Bar Closure

## Objective

Close the repository-level strategy frame and v1.0 GA promotion bar.

This phase is documentation-only. It defines Layer A / Layer B separation, product experience direction, OpenClaw two-dimensional position, platform strategy, Stage 1 role, and public claim eligibility.

## Scope

Create:

```txt
docs/STRATEGY_FRAME.md
docs/GA_BAR_DEFINITION.md
```

Update:

```txt
AGENTS.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/OPENCLAW_REJECTION_AUDIT.md
docs/INDEX.md
CHANGELOG.md
```

## Non-Goals

- implementation code changes
- version promotion
- README / QUICKSTART external OpenClaw complete-superiority claims
- Writing / Daily / Developer Operator details
- Plugin Review Gate implementation
- installer, resident app, or LLM API setup implementation
- GA promotion execution

## Required Checks

- `docs/STRATEGY_FRAME.md` exists and contains sections 1 through 8.
- `docs/GA_BAR_DEFINITION.md` exists and contains sections 1 through 7.
- `AGENTS.md` contains Strategic Frame Reference and GA Bar Reference.
- `docs/OPENCLAW_REJECTION_AUDIT.md` contains Two-Dimensional Position.
- `docs/INDEX.md` references both new docs.
- `docs/ROADMAP.md` records Phase 11-S3 completion and identifies Phase 11-S4 as the current active phase.
- `CHANGELOG.md` records Phase 11-S3.
- Package versions remain `1.0.0-rc.1`.
- README / QUICKSTART / CLAIM do not activate the external OpenClaw complete-superiority claim.

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm docs:check
```

## Completion Notes

- Created `docs/STRATEGY_FRAME.md`.
- Created `docs/GA_BAR_DEFINITION.md`.
- Recorded the OpenClaw two-dimensional position without weakening the design-posture rejection.
- Public OpenClaw complete-superiority claims remain gated until Phase 11-S13.
- Active execution lane advances to Phase 11-S4 First-Party Surface Specification.

---

# Phase 11-S4 — First-Party Surface Specification

## Objective

Specify the three v1.0 GA first-party operator surfaces without implementing them.

The surfaces are Writing Operator, Daily Operator, and Developer Operator. They are equal Layer A surfaces with no priority order.

## Scope

Create:

```txt
docs/operator-surfaces/INDEX.md
docs/operator-surfaces/SHARED_SUBSTRATE.md
docs/operator-surfaces/WRITING_OPERATOR.md
docs/operator-surfaces/DAILY_OPERATOR.md
docs/operator-surfaces/DEVELOPER_OPERATOR.md
```

Update:

```txt
AGENTS.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
CHANGELOG.md
```

## Non-Goals

- implementation code changes
- new operator packages
- new tool definitions
- Approval policy structure changes
- Plugin Review Gate specification or implementation
- version promotion

## Required Checks

- All five operator-surface docs exist.
- Each surface spec contains sections 1 through 11.
- The three surfaces are described as equal with no priority ordering.
- Existing downstream tools are referenced accurately.
- Each surface records Layer A / Layer B boundaries.
- `AGENTS.md` contains First-Party Surface Rule before Adapter Rule.
- Adapter Rule remains intact.
- `docs/INDEX.md` references `docs/operator-surfaces/INDEX.md`.
- `docs/ROADMAP.md` records Phase 11-S4 completion and identifies Phase 11-S5 as current active phase.
- `CHANGELOG.md` records Phase 11-S4.

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm docs:check
```

## Completion Notes

- Created `docs/operator-surfaces/`.
- Defined Writing Operator, Daily Operator, and Developer Operator as equal first-party surfaces.
- Defined shared substrate usage for HDS-BRAIN authority, Approval Gate, audit, Runtime Invariants, and downstream tools.
- Added AGENTS.md First-Party Surface Rule.
- Active execution lane advances to Phase 11-S5 Platform Extension Surface Specification.

---

# Phase 11-S5 — Platform Extension Surface Specification

## Objective

Specify the Layer B platform extension boundary: Plugin Review Gate, Plugin HIG, and Skill Loader Contract.

This phase is documentation-only. Implementation comes in Phase 11-S12.

## Scope

Create:

```txt
docs/PLUGIN_REVIEW_GATE.md
docs/PLUGIN_HIG.md
docs/SKILL_LOADER_CONTRACT.md
```

Update:

```txt
AGENTS.md
docs/INDEX.md
docs/ADAPTER_CONTRACT.md
docs/CAPABILITY_ENVELOPE.md
docs/CONFORMANCE.md
docs/LLM_DEVELOPMENT_GUIDE.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
CHANGELOG.md
```

## Non-Goals

- Plugin Review Gate implementation
- skill loader implementation
- existing plugin loader changes
- new plugin addition
- version promotion
- compatibility matrix changes

## Required Checks

- `docs/PLUGIN_REVIEW_GATE.md`, `docs/PLUGIN_HIG.md`, and `docs/SKILL_LOADER_CONTRACT.md` exist.
- Each new document contains sections 1 through 10.
- Adapter Contract, Capability Envelope, Conformance, and LLM Development Guide reference the new Layer B docs.
- WhatsApp unofficial route rejection remains explicit.
- AGENTS.md Adapter Rule contains Layer A / Layer B Boundary.
- Implementation code is unchanged.
- Package versions remain `1.0.0-rc.1`.

## Validation Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm docs:check
```

## Completion Notes

- Created Layer B platform extension docs.
- Added review boundary cross-references to existing adapter/capability/conformance/development docs.
- Added AGENTS.md Layer A / Layer B Boundary under Adapter Rule.
- Active execution lane advances to Phase 11-S6 Writing Operator Implementation.

---

# Phase 11-S6 - Writing Operator Implementation

## Objective

Implement the Writing Operator first-party surface as a Layer A downstream device under HDS-BRAIN authority.

## Scope

Create:

```txt
packages/operator-writing/
docs/phase11-s6-writing-operator.md
```

Update:

```txt
apps/gateway/src/plugin_loader.ts
apps/gateway/src/serve.ts
packages/hds-brain/src/frame.ts
packages/hds-brain/src/types.ts
docs/operator-surfaces/WRITING_OPERATOR.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
CHANGELOG.md
```

## Non-Goals

- Daily Operator implementation
- Developer Operator implementation
- new raw authority, filesystem, network, credential, or external write capability
- Layer B plugin creation
- installer or resident app implementation
- version promotion

## Completion Notes

- Added `@blue-tanuki/operator-writing` with operation specs for drafting, proofreading, summarization, translation, sandboxed file read/write/edit, Gmail write, and Google Drive write.
- L1 / L2 / L3 boundaries are explicit in the surface package.
- HDS-BRAIN frame recognition records Writing Operator binding while keeping the process under HDS authority.
- Gateway plugin loader now supports first-party surface exports after manifest permission checks.
- WebChat runtime snapshot exposes `operator_surfaces.writing`.
- WebChat exposes `GET /operators/writing` and `POST /operators/writing/invoke` using the existing inbound bearer token and inbound handler.
- Conformance coverage records surface registration, metadata non-escalation, digest-only invocation traces, and plugin permission enforcement.
- Active execution lane advances to Phase 11-S7 Daily Operator Implementation.

---

# Phase 11-S7 - Daily Operator Implementation

## Objective

Implement the Daily Operator first-party surface as a Layer A downstream device under HDS-BRAIN authority.

## Scope

Create:

```txt
packages/operator-daily/
docs/phase11-s7-daily-operator.md
```

Update:

```txt
apps/gateway/src/serve.ts
packages/channel-webchat/src/webchat.ts
packages/hds-brain/src/frame.ts
packages/hds-brain/src/types.ts
docs/operator-surfaces/DAILY_OPERATOR.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
CHANGELOG.md
```

## Non-Goals

- Writing Operator implementation changes beyond shared endpoint support
- Developer Operator implementation
- new raw authority, Google, email, schedule, or channel-send capability
- removal of `BLUE_TANUKI_DAILY_BRIEF_*` compatibility
- Layer B plugin creation
- version promotion

## Completion Notes

- Added `@blue-tanuki/operator-daily` with operation specs for Daily Brief status, Google read summaries, schedule list/create/update/delete, reminder drafting, Google writes, and Daily Brief channel-send.
- Existing `BLUE_TANUKI_DAILY_BRIEF_*` environment variables remain the compatibility surface.
- Daily Brief snapshots expose only safe metadata and do not expose content or credentials.
- HDS-BRAIN frame recognition records Daily Operator binding while keeping the process under HDS authority.
- WebChat runtime snapshot exposes `operator_surfaces.daily`.
- WebChat exposes `GET /operators/daily` and `POST /operators/daily/invoke` using the existing inbound bearer token and inbound handler.
- Conformance coverage records surface registration, Daily Brief env compatibility, metadata non-escalation, schedule final-review declaration, and plugin permission enforcement.
- Active execution lane advances to Phase 11-S8 Developer Operator Implementation.

---

# Phase 11-S8 - Developer Operator Implementation

## Objective

Implement the Developer Operator first-party surface as a Layer A downstream device under HDS-BRAIN authority.

## Scope

Create:

```txt
packages/operator-developer/
docs/phase11-s8-developer-operator.md
```

Update:

```txt
apps/gateway/src/serve.ts
packages/channel-webchat/src/webchat.ts
packages/hds-brain/src/frame.ts
packages/hds-brain/src/types.ts
docs/operator-surfaces/DEVELOPER_OPERATOR.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
CHANGELOG.md
```

## Non-Goals

- Writing Operator or Daily Operator behavior changes beyond shared endpoint support
- new raw authority, filesystem, process, GitHub, browser, credential, or external write capability
- browser automation promotion out of disabled-by-default preview
- shell or GitHub write final-review relaxation
- Layer B plugin creation
- version promotion

## Completion Notes

- Added `@blue-tanuki/operator-developer` with operation specs for file read/write/edit, GitHub read/write, browser snapshot/automation, and shell exec.
- L1 / L2 / L3 boundaries are explicit in the surface package.
- Browser automation remains preview and disabled-by-default behind `BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW=1`.
- HDS-BRAIN frame recognition records Developer Operator binding while keeping the process under HDS authority.
- Gateway plugin loader registers the Developer Operator surface only after manifest permission checks.
- WebChat runtime snapshot exposes `operator_surfaces.developer`.
- WebChat exposes `GET /operators/developer` and `POST /operators/developer/invoke` using the existing inbound bearer token and inbound handler.
- Conformance coverage records surface registration, metadata non-escalation, preview quarantine preservation, digest-only traces, and plugin permission enforcement.
- Active execution lane advances to Phase 11-S9 Installer and Setup UX.

---

# Phase 11-S9 Completion Notes

- Added guided first-run installer files under `install/installer/`.
- Added root `installer:verify` and `installer:run` scripts.
- Added token-gated Settings `Verify LLM` route and UI for non-mutating provider checks.
- Added installer guide and Phase 11-S9 report.
- Updated first-run, permanent-use, rollback, RC, conformance, doctor, and packaging validation references.
- The guided installer remains portable setup UX: no signed native installer, no automatic updater, and no verified 5-minute setup guarantee.
- Active execution lane advances to Phase 11-S10 Resident Application Integration.

---

# Phase 11-S10 Completion Notes

- Added portable resident helpers under `install/resident/`.
- Installed launchers expose `resident-start`, `resident-status`, `resident-stop`, `resident-open`, `resident-logs`, and explicit `resident-autostart-*` commands.
- Resident autostart is opt-in only and uninstallers stop resident state before app/launcher removal.
- Resident app guide, permanent-use checklist, update/rollback runbook, RC docs, conformance docs, doctor distribution readiness, release bundle, and packaging validation were updated.
- Signed native tray app and automatic updater remain out of scope.
- Active execution lane advances to Phase 11-S11 Channel First-Party Promotion.

---

# Phase 11-S11 Completion Notes

- Added `pnpm validate:channels` as the channel first-party promotion gate.
- Added `scripts/channel_promotion_gate.ts`, `apps/gateway/test/channel_promotion_gate.test.ts`, `docs/CHANNEL_PROMOTION_GATE.md`, and the Phase 11-S11 report.
- Slack / Discord / Teams / LINE remain `first-party-preview` unless owner-run credentialed live-smoke evidence and recovery review are present.
- Teams / LINE additionally require gateway-owned inbound listener closure before first-party promotion.
- WhatsApp remains `reserved-third-party`.
- Active execution lane advances to Phase 11-S12 Plugin Review Gate Implementation.

---

# Phase 11-S12 Completion Notes

- Added `pnpm plugin:review` as the Plugin Review Gate for Layer B submissions.
- Added `apps/gateway/src/plugin_review_gate.ts`, `scripts/plugin_review_gate.ts`, `apps/gateway/test/plugin_review_gate.test.ts`, and the Phase 11-S12 report.
- Layer B submissions now require `blue-tanuki.review.json` evidence for conformance, audit, safety, disable/revoke, failure modes, dynamic-import denial, hot-reload denial, and final-review capability declaration.
- Gate rejects wildcard capabilities, package/manifest drift, lifecycle install scripts, runtime dynamic import, forbidden WhatsApp-specific routes, `kind=core` Layer B submissions, and final-review bypass claims.
- Bundled workspace plugin loading now runs the non-submission Plugin Review Gate before importing entries.
- Doctor, packaging validation, release bundle requirements, RC docs, conformance docs, and Plugin Review Gate docs were updated.
- Active execution lane advances to Phase 11-S13 v1.0 GA Promotion Execution.

---

# Phase 11-S13 Pre-GO Completion Notes

- Added `pnpm validate:ga` as the v1.0 GA promotion preflight.
- Added `scripts/ga_promotion_gate.ts`, `apps/gateway/test/ga_promotion_gate.test.ts`, `docs/v1.0-ga-promotion-review.md`, and the Phase 11-S13 report.
- GA Bar A-F evidence is machine-checked.
- Bar G remains `PENDING_OWNER_GO`; `public_claim_allowed=false` until explicit owner GO.
- Gate rejects `1.0.0` version promotion or README / QUICKSTART / CLAIM public claim activation before owner GO.
- local validation, doctor, packaging validation, release bundle requirements, RC docs, post-RC review, GA bar docs, and docs index were updated.
- Actual v1.0.0 promotion remains pending explicit owner GO.

---

# Phase 12-S-1 - HDS-BRAIN Standalone Completeness Lock

## Objective

Lock HDS-BRAIN as a standalone authority control kernel before continuing resident application integration.

## Scope

Create:

```txt
packages/hds-brain/src/ports.ts
packages/hds-brain/src/health.ts
packages/hds-brain/src/standalone_harness.ts
packages/hds-brain/test/standalone_boundary.test.ts
examples/hds-brain-standalone.ts
docs/hds-brain-standalone-boundary.md
docs/phase12-s-1-hds-brain-standalone-completeness.md
```

Update:

```txt
packages/hds-brain/src/index.ts
package.json
AGENTS.md
SECURITY.md
AUDIT.md
CONFIG.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
```

## Non-Goals

- OutputAudit implementation
- CompleteHistoryStore implementation
- UI changes
- SQLite / SQLCipher
- external API integration
- LLM backend implementation
- plugin execution

## Completion Notes

- Added `runStandaloneHDSBrain` for standalone `InboundRequest` decision smoke.
- Added `HDSBrainHealth` baseline from runtime snapshot evidence.
- Added downstream port type declarations without binding HDS-BRAIN to downstream implementations.
- Added dependency boundary tests that reject gateway/core/channel/operator/plugin-loader/downstream-client references from `packages/hds-brain`.
- Added `pnpm hds:standalone`.
- Added standalone boundary docs and Phase 12-S-1 report.
- Recorded Downstream Limbs Doctrine: downstream devices may sense, generate, execute, store, display, or report, but cannot decide authority or substitute approval.
- Active execution lane advances to Phase 12-S0 Boundary Definition Lock.

---

# Phase 12-S0 - Boundary Definition Lock

## Objective

Fix HDS-BRAIN's decision boundary before output audit, complete history, runtime invariant evidence, and resident UI phases.

## Scope

Create:

```txt
packages/hds-brain/src/boundary_policy.ts
packages/hds-brain/test/boundary_policy.test.ts
docs/hds-brain-risk-approval-boundary.md
docs/hds-brain-reference-boundary.md
docs/hds-brain-fail-safe-policy.md
docs/hds-brain-unknown-escalation-policy.md
docs/hds-brain-trinity-m-policy-model.md
docs/phase12-s0-boundary-definition-lock.md
```

Update:

```txt
packages/hds-brain/src/approval_policy.ts
packages/hds-brain/src/index.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
```

## Completion Notes

- Added a standalone deterministic boundary policy module.
- Mapped `tool.call` and `unknown` to high-risk `L3_final_review`.
- Added tests for reference/non-authority boundaries, unknown escalation, fail-safe suspend, policy/detector/approval/history update review, and Trinity M closure.
- Added Risk/Approval, Reference, Fail-safe, Unknown Escalation, and Trinity M docs.
- Active execution lane advances to Phase 12-S1 HDS-BRAIN Output / Result Audit Plane.

---

# Phase 12-S1 - HDS-BRAIN Output / Result Audit Plane

## Objective

Route downstream results through HDS-BRAIN's audit plane before final user-visible output or external result handoff.

## Scope

Create:

```txt
packages/hds-brain/src/output_audit.ts
packages/hds-brain/test/output_audit.test.ts
docs/hds-brain-output-audit-plane.md
docs/phase12-s1-output-result-audit-plane.md
```

Update:

```txt
packages/hds-brain/src/types.ts
packages/hds-brain/src/controller.ts
packages/hds-brain/src/index.ts
apps/gateway/src/main.ts
apps/gateway/src/serve.ts
apps/gateway/src/audit_dump.ts
apps/gateway/test/audit_dump.test.ts
packages/channel-webchat/src/webchat.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
```

## Completion Notes

- Added standalone `OutputAudit` classification and digest module.
- Added `output_audit` audit record into the HDS hash-chain union.
- Added `HDSUpperController.onOutputAudit`.
- Gateway CLI and serve mode now call output audit before final operator log or channel dispatch.
- Audit dump and authority trace project output audit records without raw output.
- Active execution lane advances to Phase 12-S2 Local Complete History Substrate.

---

# Phase 12-S2 - Local Complete History Substrate

## Objective

Keep user history, LLM history, HDS decision history, approval history, execution history, audit history, and final output history as original records.

## Scope

Create:

```txt
packages/hds-brain/src/complete-history/types.ts
packages/hds-brain/src/complete-history/codec.ts
packages/hds-brain/src/complete-history/store.ts
packages/hds-brain/src/complete-history/index.ts
packages/hds-brain/test/complete_history.test.ts
docs/hds-brain-complete-history-substrate.md
docs/phase12-s2-local-complete-history-substrate.md
```

Update:

```txt
packages/hds-brain/src/index.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/hds-brain-standalone-boundary.md
```

## Non-Goals

- Gateway adapter wiring
- Control Center history / replay UI
- SQLite / SQLCipher
- encrypted history store
- LLM backend integration
- authority use of complete history

## Completion Notes

- Added standalone `CompleteHistoryStore` inside `packages/hds-brain`.
- Added complete-history entry kinds for user input, LLM history, HDS decisions, approval history, execution history, audit history, and final output.
- Added append / verify / replay / export / JSON export baseline.
- Added JSONL persistence with load-time chain verification.
- Public replay/export APIs return copies so callers cannot mutate the live in-memory chain.
- Complete history remains original-record/replay evidence with `used_for_authority=false` and `complete_history_used_for_authority=false`.
- Active execution lane advances to Phase 12-S3 Runtime Invariants Evidence Upgrade.

---

# Phase 12-S3 - Runtime Invariants Evidence Upgrade

## Objective

Promote Runtime Invariants from fixed display values to HDS-BRAIN-owned evidence that can be inspected, verified, and audited.

## Scope

Create:

```txt
packages/hds-brain/src/runtime_invariants.ts
docs/hds-brain-runtime-invariants-evidence.md
docs/phase12-s3-runtime-invariants-evidence.md
```

Update:

```txt
packages/hds-brain/src/controller.ts
packages/hds-brain/src/health.ts
packages/hds-brain/src/index.ts
packages/hds-brain/src/standalone_harness.ts
packages/hds-brain/src/types.ts
packages/hds-brain/test/runtime_invariants.test.ts
packages/hds-brain/test/standalone_boundary.test.ts
apps/gateway/src/audit_dump.ts
apps/gateway/src/runtime_status.ts
apps/gateway/src/serve.ts
apps/gateway/test/audit_dump.test.ts
apps/gateway/test/runtime_status.test.ts
packages/channel-webchat/src/webchat.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/hds-brain-standalone-boundary.md
```

## Non-Goals

- final-review operation single-source refactor
- fail-safe/self-health policy redesign
- detector lifecycle implementation
- Control Center visual redesign
- authority use of Runtime Invariants evidence

## Completion Notes

- Added standalone Runtime Invariants evidence generation inside `packages/hds-brain`.
- `HDSRuntimeSnapshot` preserves `invariants` and adds `runtime_invariants` evidence report.
- Added expected/actual values, per-invariant evidence, guarantee kind, all-ok status, report digest, and non-authority flags.
- Added `runtime_invariants` HDS audit record and `HDSUpperController.onRuntimeInvariantsEvidence`.
- Standalone harness emits runtime invariant evidence and appends it to audit.
- Gateway startup records runtime invariant evidence and runtime snapshot displays it as downstream data.
- Audit dump and authority trace project runtime invariant evidence.
- Active execution lane advances to Phase 12-S4 Final-review Operation Single Source of Truth.

---

# Phase 12-S4 - Final-review Operation Single Source of Truth

## Objective

Make final-review operations a single HDS-BRAIN-owned source of truth.

## Scope

Create:

```txt
packages/hds-brain/test/final_review_operations.test.ts
docs/phase12-s4-final-review-single-source.md
```

Update:

```txt
packages/hds-brain/src/approval_policy.ts
packages/hds-brain/src/process.ts
packages/hds-brain/src/runtime_invariants.ts
packages/hds-brain/src/index.ts
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
```

## Non-Goals

- Approval UI redesign
- history / replay UI wiring
- detector lifecycle changes
- fail-safe policy redesign
- new privileged operation classes
- gateway-owned final-review policy source

## Completion Notes

- Added `FINAL_REVIEW_OPERATION_LIST` as the canonical HDS-BRAIN final-review operation list.
- Kept `FINAL_REVIEW_OPERATIONS` as a derived set and added `finalReviewOperationList()` for copied projections.
- Process approval profiles, authority traces, and Runtime Invariants evidence now derive from the same HDS-BRAIN list.
- Tests cover drift across Approval Gate, process profile, authority trace, and runtime evidence.
- Active execution lane advances to Phase 12-S5 Approval / Notification / History / Replay UI Completion.

---

# Phase 12-S5 - Approval / Notification / History / Replay UI Completion

## Objective

Complete the resident UI/API surface for approval, notifications, complete history, and replay without creating a new authority path.

## Scope

Create:

```txt
docs/phase12-s5-approval-notification-history-replay-ui.md
```

Update:

```txt
apps/gateway/src/serve.ts
packages/channel-webchat/src/webchat.ts
packages/channel-webchat/src/index.ts
packages/channel-webchat/src/control_center_html.ts
packages/channel-webchat/test/webchat.test.ts
AGENTS.md
SECURITY.md
AUDIT.md
CONFIG.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/hds-brain-complete-history-substrate.md
```

## Non-Goals

- new approval authority
- raw payload display
- approval token display in history replay
- Control Center mutation through history/replay
- encrypted history storage
- SQLite / SQLCipher
- detector lifecycle implementation
- root full-access attack scenario tests

## Completion Notes

- Added WebChat `WebChatHistorySurface`.
- Added read-only `GET /history` and `GET /history/replay` using the inbound bearer token.
- WebChat strips raw `payload` from history snapshots before serialization.
- Control Center now displays Complete History / Replay entries with digest/metadata only.
- Gateway serve mode records safe complete-history replay metadata for user input, HDS decisions, approvals, execution feedback, and final output.
- Optional JSONL persistence is available through `BLUE_TANUKI_COMPLETE_HISTORY_FILE`; unset deployments keep process-local in-memory history.
- `complete_history_used_for_authority=false` remains explicit.
- Active execution lane advances to Phase 12-S6 Root Full-access + Compound Attack Scenario Tests.

---

# Phase 12-S6 - Root Full-access + Compound Attack Scenario Tests

## Objective

Lock root/full-access operation against compound attack chains.

## Scope

Create:

```txt
packages/hds-brain/test/compound_attack_scenarios.test.ts
docs/phase12-s6-root-full-access-compound-attack-scenarios.md
```

Update:

```txt
SECURITY.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
```

## Non-Goals

- ApprovalRisk redesign
- new `critical` risk level
- full-access default change
- Approval Gate UX changes
- detector lifecycle implementation
- fail-safe/self-health policy implementation

## Completion Notes

- Added compound attack scenario tests for wildcard full-access grants.
- Covered shell exec, schedule mutation, GitHub write, Google write, and browser automation privileged envelopes.
- Covered external metadata owner/approval spoofing.
- Covered forged channel-send metadata against process execution policy.
- Covered downstream feedback spoofing while a request is suspended.
- Covered complete-history reference authority conversion and history update classification.
- Active execution lane advances to Phase 12-S7 Detector Lifecycle and Unknown Pattern Escalation.

---

# Phase 12-S7 - Detector Lifecycle and Unknown Pattern Escalation

## Objective

Lock detector lifecycle failures and unknown detector patterns into fail-closed HDS-BRAIN decisions.

## Scope

Create:

```txt
packages/hds-brain/test/detector_lifecycle.test.ts
docs/hds-brain-detector-lifecycle.md
docs/phase12-s7-detector-lifecycle-unknown-pattern-escalation.md
```

Update:

```txt
packages/hds-brain/src/boundary_policy.ts
packages/hds-brain/src/detectors/index.ts
packages/hds-brain/src/detectors/risk_keyword.ts
packages/hds-brain/src/detectors/types.ts
packages/hds-brain/src/index.ts
packages/hds-brain/src/policy.ts
packages/hds-brain/src/types.ts
packages/hds-brain/test/boundary_policy.test.ts
packages/hds-brain/test/detectors.test.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/hds-brain-unknown-escalation-policy.md
```

## Non-Goals

- LLM-based detector fallback
- ApprovalRisk redesign
- new `critical` risk level
- full-access default change
- Approval Gate UX changes
- gateway-owned detector authority
- fail-safe/self-health policy implementation

## Completion Notes

- Added lifecycle traces to detector axis scores.
- Missing detectors, detector exceptions, invalid detector scores, duplicate policy axes, and unknown detector patterns suspend before normal score thresholds.
- Invalid `risk_keyword` regex patterns now classify as `detector_unknown_pattern` instead of being silently ignored.
- Detector lifecycle failures are visible in HDS decision logs and commit triggered thresholds.
- Active execution lane advances to Phase 12-S8 HDS-BRAIN Fail-safe / Self-health Policy.

---

# Phase 12-S8 - HDS-BRAIN Fail-safe / Self-health Policy

## Objective

Make HDS-BRAIN self-health an executable fail-safe boundary before downstream command emission.

## Scope

Create:

```txt
packages/hds-brain/test/fail_safe_self_health.test.ts
docs/phase12-s8-hds-brain-fail-safe-self-health-policy.md
```

Update:

```txt
packages/hds-brain/src/boundary_policy.ts
packages/hds-brain/src/controller.ts
packages/hds-brain/src/health.ts
packages/hds-brain/src/index.ts
packages/hds-brain/src/types.ts
packages/hds-brain/test/boundary_policy.test.ts
AGENTS.md
SECURITY.md
AUDIT.md
README.md
CHANGELOG.md
docs/CONFORMANCE.md
docs/INDEX.md
docs/ROADMAP.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/hds-brain-fail-safe-policy.md
```

## Non-Goals

- ApprovalRisk redesign
- new `critical` risk level
- Approval Gate UX changes
- gateway-owned authority checks
- Runtime Invariants as authority
- external watchdog/service-manager implementation
- resident application integration implementation

## Completion Notes

- Added HDS-BRAIN self-health failed preconditions and owner next action.
- New command emission suspends when policy, audit chain, Runtime Invariants, Approval Gate, HDS availability, or configured memory chain is unhealthy.
- Fail-safe suspensions are not human-resumable approval paths.
- Fail-safe decisions record `hds_fail_safe:*` triggered thresholds and audit-safe self-health metadata.
- Phase 12 HDS-BRAIN quality lock sequence reaches a natural audit boundary; active execution lane returns to Phase 11-S10 Resident Application Integration.

---

# Global Validation Command Set

Use this set after major phases:

Package-manager preflight:

```bash
node --version
corepack --version || true
pnpm --version || true
```

If `pnpm` is unavailable, follow `docs/known-environment-failures.md` and report validation as
environment-limited if recovery fails.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm docs:check
```

For implementation phases also run:

```bash
pnpm build
pnpm run doctor
pnpm validate:packaging
```

For unrelated feature work, follow the active phase validation boundary. `pnpm smoke:serve` and `pnpm smoke:resume` are skipped unless the phase targets root workspace resolution, smoke checks, or release validation. `pnpm smoke:live` may SKIP when credentials are absent.

For release phases also run:

```bash
pnpm release:bundle
pnpm release:verify
```

If unavailable, report exactly.

---

# Global Final Report Format

Every phase must end with:

```md
## Files changed

## Summary

## Strategic frame impact

## GA bar impact

## Layer separation impact

## HDS authority impact

## Approval Gate impact

## Runtime Invariants impact

## Audit impact

## Capability envelope impact

## Conformance impact

## Tests / validation

## Known environment failures

## Remaining risks

## Recommended next phase
```

Do not hide failed tests.

Do not claim completion unless acceptance criteria are satisfied.

---

# Current Active Phase

The active next phase is:

```txt
Phase P13 — Owner GO / Product Release Boundary
```

Scope: fix the owner-GO release decision boundary, record P13 readiness, and
keep actual GA promotion fail-closed until owner GO and required evidence exist.

Former `Phase 11-S13 Owner GO Decision / v1.0.0 Promotion` is no longer active; D2 absorbs the old Bar G GO into the P13 product-release decision. Phase 11-S13 pre-GO gate is complete. Actual v1.0.0 promotion remains blocked until explicit owner GO.
