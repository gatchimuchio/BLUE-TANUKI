# BLUE-TANUKI Agent Instructions

This file defines repository-wide work discipline, prohibitions, validation, and reporting rules for AI agents working in **BLUE-TANUKI**. It is not a philosophy document or a normal app-scaffold guide.

If a short rule in this opening section overlaps with later detail, apply the stricter rule that preserves HDS-BRAIN authority, release integrity, and operator safety.

## Core Rule

Do not treat this repository as a normal app scaffold.

BLUE-TANUKI is an HDS-BRAIN upstream control-plane project.
HDS-BRAIN owns authority. LLMs, channels, plugins, operators, installers, external tools, memory, history, UI, schedulers, and downstream automation are downstream only.

## Rule Precedence

Apply rules in this order:

1. Explicit owner/user instruction for the current task, unless it weakens safety, HDS-BRAIN authority, Approval Gate, audit, recovery, release-gate, owner GO, public-claim, or operator-safety boundaries
2. Common Development Discipline in this `AGENTS.md`
3. BLUE-TANUKI repository extension rules in this `AGENTS.md`
4. Active implementation instruction / roadmap / phase document
5. Repository contracts, policies, manifests, tests, validation scripts, and existing implementation patterns

When rules appear to conflict, apply the stricter interpretation that preserves HDS-BRAIN authority, release integrity, auditability, recovery, and operator safety.

## Non-Negotiable Priorities

1. Safety
2. Robustness
3. UX / operator clarity / auditability
4. Contract and runtime integrity
5. Features
6. Convenience

Feature completion never outranks safety, authority boundaries, auditability, recovery, validation evidence, or contract/runtime integrity.

Convenience never justifies hidden authority, false completion claims, unverified runtime guarantees, unexplained workarounds, or weakened failure handling.

## Common Development Discipline

This section is the BLUE-TANUKI version of the shared GUI-Shell development discipline. It applies to all work in this repository unless a stricter BLUE-TANUKI rule appears later in this file.

### Bounded Implementation

Do not treat a broad specification as permission for broad generation.

For every task:

- inspect existing files, contracts, tests, validation commands, and relevant documentation before editing;
- implement the smallest maintainable change that satisfies the task;
- preserve HDS-BRAIN, Approval Gate, audit, Runtime Invariants, capability envelope, and Layer A / Layer B boundaries;
- do not perform opportunistic refactors;
- do not add speculative features;
- do not broaden permissions, authority, runtime reachability, dependencies, toolchains, or environment assumptions without explicit requirement;
- remove debris, stale TODOs, abandoned partial paths, and temporary implementation residue introduced by the task before reporting completion.

A large amount of generated structure is not evidence of completeness.

### Completion Evidence

A completion claim is not evidence.

Before reporting a work block as complete, identify:

- the behavior implemented;
- the production, runtime, contract, authority, audit, or validation path that exercises it;
- the exact validation commands actually run;
- the exact results;
- validation that was not run;
- remaining stubs, mocks, placeholders, TODOs, unconnected contracts, environment limitations, or known limitations.

Documentation, manifest presence, schema presence, mock success, fixture success, or unit-test success alone must not be reported as proof that a production path or product behavior is complete.

For security-critical, authority-critical, audit-critical, recovery-critical, release-critical, or operator-safety-critical changes, state what evidence demonstrates that the real governed path is exercised.

For any repository-state-modifying task, completion also requires repository-state closure under the Git Operation Policy unless the owner explicitly limits the task to local-only, audit-only, review-only, or no-commit/no-push work.

### Evidence Source / No Ghost Invariants

Do not report runtime health, authority integrity, Runtime Invariants, security invariants, release readiness, or GA readiness based only on:

- configuration validation;
- schema or manifest validation;
- self-generated state objects;
- mocked runtime state;
- fixture-only results;
- static object or dictionary consistency checks.

When adding or modifying a health check, invariant check, conformance check, integrity report, doctor check, release gate, or claim review, classify its evidence source as one or more of:

- `CONFIG`
- `INTERNAL_STATE`
- `LIVE_RUNTIME`
- `EXTERNAL_EVIDENCE`
- `FIXTURE`

Each evidence class proves only the scope it actually observes. `CONFIG`, `INTERNAL_STATE`, or `FIXTURE` results must not be promoted into live-runtime, installed-path, external-integrity, or release-readiness guarantees without corresponding evidence.

If required evidence is unavailable, report the limitation, classify the release impact, or return `SUSPEND` where the repository contract requires fail-closed behavior.

### Trust Boundary and Input Verification

Do not assume inbound data is safe merely because it is structured, parsed, schema-shaped, or supplied by another component.

For any input that may affect authority, permission, execution, approval, audit identity, workspace scope, command scope, content visibility, recovery, release behavior, or operator-visible output, the responsible boundary must explicitly account for the applicable parts of:

- raw input retention for HDS-BRAIN fail-closed audit when applicable;
- canonicalization / normalization;
- schema or structural validation;
- origin or source validation;
- integrity or tamper checks;
- replay protection;
- authority or execution-eligibility evaluation;
- audit emission;
- fail-closed or `SUSPEND` behavior.

External data, UI state, adapter metadata, channel metadata, plugin metadata, previous state, memory, complete history, diagnostics, tool output, and LLM output must not create, escalate, replace, or bypass authority.

### Active Production Path Minimization

Keep the normal production or runtime execution path minimal and responsibility-bounded.

Do not silently mix ordinary runtime behavior with:

- diagnostic functionality;
- setup / installer tooling;
- repair or recovery tooling;
- migrations;
- release-only verification;
- development-only fixtures;
- bootstrap-only tooling;
- administrative commands.

When adding privileged or operational functionality, classify it as one of:

- runtime path;
- control path;
- diagnostic path;
- repair / recovery path;
- build / release path;
- development-only path.

If non-runtime functionality must be reachable from an ordinary runtime path, document why, identify its authority and audit consequences, and validate that it does not expand hidden execution power.

### Wrapper / Workaround Accountability

Do not introduce wrapper scripts, shims, custom execution layers, alternate build paths, environment bypasses, or host-specific workaround logic merely to make a failing task appear complete.

If such a mechanism is required and not prohibited by this file, document:

- the original failure;
- the root cause;
- why the native or existing repository mechanism is insufficient;
- the exact responsibility of the added mechanism;
- the environments in which it applies;
- validation performed;
- whether it is temporary or permanent;
- its removal condition or formalization condition.

A deliberate, tested, bounded, documented normalization mechanism may be acceptable. An unexplained, unbounded, or symptom-hiding workaround is not acceptable.

### Environment and Product-Proof Separation

Keep development environment, CI environment, validation environment, release-proof environment, and target product environment conceptually separate.

Do not report success in one environment as proof of success in another environment unless the repository explicitly defines that equivalence and evidence supports it.

When validation is blocked or distorted by host environment limitations:

- identify the environment limitation;
- distinguish it from a product regression;
- do not modify product architecture merely to hide the host failure;
- report what remains unverified in the target environment.

Local development convenience must not silently become permanent product architecture or release evidence.

### Contract-to-Runtime Connection

A schema, interface, protocol object, adapter contract, capability, manifest, policy, audit contract, invariant contract, fixture, or success profile is not complete merely because it exists.

When adding or modifying a contract intended to affect real behavior, identify:

- its consuming production, runtime, validator, or governed execution path;
- the validation or conformance path that exercises it;
- the negative or failure case that must be rejected, blocked, audited, or suspended;
- any part that remains intentionally unconnected or deferred.

Do not claim behavioral completion for contracts that are defined but not exercised by the intended governed path.

### Audit Outcome and Reporting

Every completed work report must distinguish:

- observed implementation facts;
- validation actually executed;
- unverified claims;
- environment-limited checks;
- remaining risks;
- intentionally deferred scope;
- repository-specific release blockers.

Where a safety-critical, authority-critical, execution-critical, audit-critical, or release-critical requirement cannot be verified, do not infer success. Report `SUSPEND`, blocker, or the repository-specific equivalent.

For detailed examples and the GUI-Shell-derived mapping, see `docs/DEVELOPMENT_PRACTICE.md`.

## Forbidden Patterns

- Do not add custom pnpm wrappers.
- Do not bypass workspace tooling because of host friction.
- Do not make Windows-native workaround scripts unless explicitly requested.
- Do not add preview packages as gateway hard dependencies.
- Do not static-import doctor / setup / audit / installer / repair modules from production runtime.
- Do not pass raw invalid inbound into gateway history, reply, approval origin, or execution path.
- Do not mark required credential errors as `safe_to_ignore`.
- Do not claim release readiness without extracted bundle verification and GitHub Actions green.

## Required Before Any Commit

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

For release-path changes also run:

```bash
pnpm validate:packaging
pnpm validate:ga
pnpm release:bundle
pnpm release:verify
```

## Boundary Semantics

Gateway boundary and HDS-BRAIN boundary are separate.

Gateway history / reply / execution paths must use only a canonical request or safe fallback request.
Raw invalid input may be passed only to HDS-BRAIN for independent fail-closed authority audit.
Raw invalid input must never be used for execution.

## Environment

Preferred dev loop:

- WSL / native Linux
- Corepack pnpm 9.12.0
- Node 22.14.0+

Avoid `/mnt/c` pathing for the active workspace.

## Report Format

Every change report must include:

1. Summary
2. Changed files
3. Risk classification
4. Path classification and evidence source class
5. Contract-to-runtime / authority-boundary impact
6. Validation results
7. Release-gate classification
8. Remaining risks
9. Working branch
10. Commit hash
11. Push result and remote HEAD verification
12. Backup generation refs and rollback point

## Purpose

This file defines repository-wide operating rules for Codex / LLM coding agents working on **BLUE-TANUKI**.

BLUE-TANUKI is a safety-first, owner-operated, local resident AI control plane.

It is not an agent-driven chatbot clone.

The permanent design principle is:

> HDS-BRAIN owns authority.<br>
> LLMs, tools, channels, plugins, skills, memory, cron, UI, browser automation, external APIs, onboarding, update flows, companion apps, and distribution surfaces are downstream devices.

All work in this repository must preserve that relationship.

---

## Completion Mindset

Codex must treat this repository as a product moving through a full completion path, not as disconnected tasks.

The completion path is:

1. Safety kernel
2. Approval and audit closure
3. Runtime automation
4. Operator usability closure
5. External write tools
6. Channel release quality
7. Browser automation preview
8. Memory / F-reference integration
9. Google / Teams / LINE integrations
10. Resident UX and distribution
11. v1.0 release hardening

Each phase must preserve all earlier guarantees.

Do not optimize a local task in a way that makes a later completion phase harder, less safe, or less inspectable.

---

## Git Operation Policy

This repository uses a direct-main owner workflow.

Default Codex workflow for this repository:

1. Work on `main`.
2. Do not create feature branches or pull requests unless the owner explicitly asks.
3. Before committing a completed work block on `main`, rotate the two-generation backup pair:
   - First, force-update `codex/backup-main-prev` to the current HEAD of `codex/backup-main` (demote the previous-latest backup to the prev slot).
     - On the very first phase where `codex/backup-main` does not yet exist, skip this rotation step. `codex/backup-main-prev` will be created on the next phase.
   - Then, force-update `codex/backup-main` to point at `main`'s current HEAD (pre-commit state of the new work block).
4. Force push `codex/backup-main-prev` (when applicable) and then `codex/backup-main` to `origin` when credentials allow it.
5. Commit the completed work block directly on `main` after validation.
6. Push `main` to `origin` when credentials allow it.
7. If backup creation, commit, or push cannot be completed, report the exact failed command and reason.

The repository maintains exactly two backup branches:

- `codex/backup-main` — most recent backup (pre-current-commit state, i.e. previous phase completion state)
- `codex/backup-main-prev` — one phase older

Older backups are intentionally not retained on a branch. Recovery beyond two phases falls back to `main` commit history.

Do not create per-phase backup branches. Do not create a third or fourth generation (`codex/backup-main-prev-prev` etc.).

Do not stage local secret files, generated runtime state, or `.blue-tanuki/` data when applying this policy.

---

## OpenClaw Rejection Posture

OpenClaw is a **rejected design pattern**, not a neutral reference.

Canonical internal audit artifact: `docs/OPENCLAW_REJECTION_AUDIT.md`.

BLUE-TANUKI rejects OpenClaw's strategy of:

- feature breadth over safety,
- channel count as a product-quality metric,
- agent autonomy as default,
- skills/plugin ecosystem before authority closure,
- 5-minute setup as a completion claim,
- companion-apps/voice/canvas expansion before safe permanence.

BLUE-TANUKI exists because that approach produces unsafe software that is nonetheless promoted as successful.

Codex must not under any circumstance import OpenClaw assumptions as design starting points.

OpenClaw is referenced in this repository only as a contrast target for these audit questions:

1. Can a beginner actually reach first successful use in about 5 minutes?
2. Can the same beginner continue using it safely and comfortably over time?
3. Does multi-channel breadth improve usability, or does it increase permanent operational burden?
4. Are update, rollback, doctor, daemon, pairing, credentials, sandboxing, and channel state understandable to a non-expert?
5. Are safety boundaries visible, enforceable, and recoverable under failure?

BLUE-TANUKI's response is not:

```md
Implement every OpenClaw feature.
```

BLUE-TANUKI's response is:

```md
Preserve HDS authority safety first.
Then make the safe path understandable, recoverable, and pleasant enough for permanent owner operation.
```

### Comparison Rule

When comparing against OpenClaw, Codex must classify every candidate idea into one of four buckets:

| Bucket | Meaning | BLUE-TANUKI action |
|---|---|---|
| Adopt | improves safety/robustness without weakening authority | implement in phase |
| Adapt | useful UX pattern but must be rebuilt under HDS authority | redesign and implement later |
| Reject | feature breadth or convenience weakens safety/operability | do not implement |
| Reserve | useful for third-party/preview but not first-party core | adapter/preview only |

Do not import OpenClaw assumptions unexamined.

### OpenClaw-Derived Risks to Audit

The following are permanent usability risk classes:

- "5-minute setup" that hides long-term maintenance complexity
- onboarding that succeeds once but leaves unclear ownership/state
- channel sprawl that increases failure surface
- daemon/service install that works but becomes hard to debug
- credential storage that is configured but not understandable
- pairing/allowlist state that is safe but cognitively heavy
- update that works until package state, service state, or config migration diverges
- doctor output that diagnoses but does not tell the operator exactly what to do next
- dashboard/UI that shows status but does not close the next-action loop
- multi-app ecosystem that increases support burden before the core product is stable

Codex must convert these risks into BLUE-TANUKI tests, docs, UX gates, and release gates.

### Two-Dimensional OpenClaw Position

BLUE-TANUKI keeps the design-posture rejection dimension and the feature-coverage target dimension separate.

The design-posture rejection remains unchanged: OpenClaw is not a design starting point.

The feature-coverage target is selected-scope complete superiority, as defined in `docs/STRATEGY_FRAME.md`. This target does not weaken the rejection posture and does not mean implementing every OpenClaw feature.

---

## Strategic Frame Reference

Canonical strategy frame: `docs/STRATEGY_FRAME.md`.

BLUE-TANUKI separates Layer A (pre-installed responsibility: HDS-BRAIN authority, Approval, Audit, first-party channels, first-party operator surfaces, installer, Control Center, and resident app) from Layer B (third-party extension surface: Plugin API, Skill loader, third-party channel adapters, and Plugin Review Gate).

Layer B must not reduce Layer A completion quality and must not bypass Layer A authority.

The product experience image is iPhone-like comfort and BlackBerry-like robustness/safety. These are target experience images, not business-model references.

In the strategic sequence, BLUE-TANUKI v1.0 GA is the Stage 1 artifact: proof that LLMs can be used completely as downstream tools under HDS authority.

---

## GA Bar Reference

Canonical GA bar: `docs/GA_BAR_DEFINITION.md`.

RC is not GA. `1.0.0-rc.1` means technical release candidate; GA means the repository has enough evidence to publicly claim OpenClaw complete superiority inside the selected scope.

Until the GA bar passes and the owner explicitly decides GO, Codex must not add external-facing OpenClaw complete-superiority claims to README, QUICKSTART, CLAIM, or release copy.

`pnpm validate:ga` is the machine preflight for this boundary. Before owner GO,
the expected state is `public_claim_allowed=false`.

When Codex proposes or executes a new phase, it must check whether the change advances, preserves, or conflicts with the GA bar.

---

## Language Policy

- Primary documentation language: Japanese.
- English is allowed for code comments where conventional, protocol terms, LLM/Codex instruction blocks, and package metadata.

### Established terms (already in repo, must be preserved exactly)

- HDS-BRAIN
- authority path
- Approval Gate
- ApprovalRisk
- hash-chain audit
- Runtime Invariants
- capability envelope
- F-reference
- resident control plane
- first-party

### Terms introduced by Phase 8 series (preserve once introduced)

- ApprovalLevel
- operator usability closure
- permanent-use UX
- preview quarantine
- signed third-party

If Codex encounters a term in the "introduced by Phase 8" list during work on an earlier phase, the term may not yet exist in code. Do not invent placeholder usages.

---

## Sacred Constraints

Priority order is immutable:

1. Safety
2. Robustness
3. UX / operator clarity / auditability
4. Contract and runtime integrity
5. Feature coverage / channel coverage / extensibility
6. Convenience

If a requested change improves feature coverage but weakens safety or robustness, reject it or isolate it behind a disabled preview boundary.

Feature coverage never outranks safety.

Convenience never outranks UX / operator clarity / auditability, and UX / operator clarity / auditability is mandatory only after safety and robustness are preserved.

Contract and runtime integrity are required before feature coverage is treated as complete.

---

## Product Stance

BLUE-TANUKI assumes local owner operation.

```md
Full access may be the default.
Final-review remains non-bypassable.
No black box exists in the HDS authority path.
HDS-BRAIN is a standalone authority control kernel.
```

Therefore:

- Do not turn BLUE-TANUKI into a permission-nagging chatbot.
- Do not weaken final-review to improve comfort.
- Do not move authority into LLM, memory, plugins, channels, external APIs, cron, browser automation, companion apps, onboarding, update flows, or UI.
- Do not use "owner-operated" or "use at your own risk" as an excuse to reduce robustness.
- Do not add feature coverage that creates invisible authority.
- Do not treat first-run success as product completion.
- Do not treat channel count as superiority.

### HDS-BRAIN Standalone Rule

`packages/hds-brain` must remain importable, instantiable, and testable without `apps/gateway`, `@blue-tanuki/core`, channel packages, first-party operator packages, plugin loader code, Control Center UI, LLM backends, browser implementations, GitHub clients, or Google clients.

Allowed dependencies are Node built-ins, `@blue-tanuki/protocol`, and local pure HDS-BRAIN modules. Gateway, executor, tools, channels, UI, scheduler, memory/history/session surfaces, and external services connect as downstream devices through command envelopes, ports, and audit/feedback events.

### Downstream Limbs Doctrine

Downstream devices are limbs, not authority.

LLM, Tool, Plugin, Skill, Channel, Executor, Scheduler / cron, Browser automation, External API, UI / Control Center, Memory store, Complete history store, Session store, Audit viewer, and Notification surface may sense, generate, execute, store, display, or report.

They must not:

- decide authority,
- substitute approval,
- escalate privileges,
- override risk / actor / process classification,
- bypass final review,
- rewrite policy or runtime invariants,
- convert memory / history / session / tool result / external metadata into authority,
- create a second authority path.

### Boundary Definition Lock Rule

Phase 12-S0 fixes the boundary model before later output audit/history/UI phases.

- `tool.call` and `unknown` are high-risk `L3_final_review` operations.
- Unknown, ambiguous, unclassified, missing capability, policy-version mismatch, reference ambiguity, approval ambiguity, external metadata conflict, detector conflict, and detector unknown pattern must not auto-allow.
- Memory, complete history, session, tool result, LLM output, channel metadata, plugin metadata, external metadata, audit viewers, and Control Center projections are reference/evidence only.
- Policy, detector, approval, and history updates require L3 final review.
- HDS-BRAIN fail-safe is `SUSPEND`, not fallback authority.
- HDS-BRAIN self-health fail-safe suspensions cannot be approved through human resume; repair the failed precondition and retry.
- Trinity `M` is deterministic policy: identity, boundary, judgement, log, and suspend rules.

### Output / Result Audit Plane Rule

Downstream results must pass through HDS-BRAIN output audit before final user-visible output or external result handoff.

- `OutputAudit` must live in `packages/hds-brain` and remain standalone.
- Gateway, executor, UI, channels, LLM backends, tools, plugins, and external APIs are adapters or downstream devices, not output authority.
- Output audit records digests and release metadata, not raw content.
- LLM output, tool result, scheduler result, plugin result, external result, and rendered output remain `used_for_authority=false`.
- Output audit must not approve, execute, classify risk, bypass final review, or create a second authority path.

### Complete History Substrate Rule

Complete history stores original records and replay evidence. It is not authority.

- `CompleteHistoryStore` must live in `packages/hds-brain` and remain standalone.
- It must provide append / verify / replay / export baseline behavior without gateway, executor, UI, channel, plugin, or LLM backend dependencies.
- It may record user input, LLM history, HDS decisions, approval history, execution history, audit history, and final output history.
- Gateway, Control Center, history UI, audit viewers, and replay tools are adapters over this substrate.
- Complete history entries and exports must keep `used_for_authority=false` / `complete_history_used_for_authority=false`.
- Control Center history/replay projections must expose digests and metadata only; raw payloads, tokens, credentials, command content, and rendered output content must not be serialized to the UI/API.
- Complete history must not classify risk, infer consent, substitute approval, bypass final review, rewrite policy, or create a second authority path.

### Runtime Invariants Evidence Rule

Runtime Invariants must be evidence-bearing and standalone.

- Runtime Invariants evidence must live in `packages/hds-brain`.
- Gateway runtime snapshot, Control Center, audit dump, and authority trace are downstream display/projection surfaces.
- Evidence reports must include expected/actual values, pass/fail status, guarantee kind, evidence text, report digest, and non-authority flags.
- Runtime Invariants evidence may be appended to the HDS hash-chain audit.
- Runtime Invariants evidence must not approve commands, rewrite policy, classify risk, bypass final review, infer consent, or create fallback authority.
- A failed invariant requires fail-safe inspection/remediation, not downstream continuation as authority.

---

## Global Invariants

These must remain true after every phase:

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

Additional invariants:

- LLM output is not final authority.
- Memory is not authority.
- Session history is not authority.
- Channel metadata cannot escalate authority.
- Plugin metadata cannot escalate authority.
- External service metadata cannot escalate authority.
- Cron / webhook / runtime automation actors are not humans.
- Executor feedback is audit evidence only.
- Tool output cannot create authority.
- Adapter metadata cannot create authority.
- Downstream limbs cannot create authority.
- Complete history cannot create authority.
- UI / Control Center cannot become a second authority path.
- Unknown or unclassified operations cannot auto-allow.
- HDS-BRAIN health failure cannot fall back to downstream authority.
- Trinity `M` cannot be supplied by LLM output, memory, session, plugin metadata, or channel metadata.
- Runtime Invariants must remain externally inspectable.
- Audit hash-chain compatibility must not be broken.
- Full access cannot bypass final-review.
- Reusable approval grants cannot bypass final-review.
- Onboarding cannot create authority bypass.
- Updates cannot silently change authority behavior.
- Daemon/service restart cannot skip Approval Gate.
- Dashboard/Control Center actions cannot become a second authority path.

If a task appears to require violating these invariants, stop and report the conflict.

---

## Known Environment Failures

The following failures are validation-environment failures, not product regressions, unless the task
explicitly modifies package-manager setup, root workspace resolution, or the related smoke-test
implementation.

### pnpm unavailable on PATH

`pnpm install` may fail because `pnpm` is not available on `PATH` in the current Codex/runtime
environment.

First inspect or recover the package manager:

```bash
node --version
corepack --version || true
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

If `pnpm` is still unavailable, report validation as environment-limited. Do not rewrite product code
to fix missing `pnpm`.

### Root workspace smoke checks

The prior root workspace smoke dependency issue is fixed. `pnpm smoke:serve`
and `pnpm smoke:resume` are no longer classified as known environment failures.

When a task explicitly targets CI, smoke checks, root workspace resolution, or a
release gate, run these checks and treat failures as actionable until proven
environment-specific:

```bash
pnpm smoke:serve
pnpm smoke:resume
```

For ordinary feature work, follow the active phase validation set. If these
smoke checks are skipped for scope, report them as "not run for this scope", not
as product failures or known environment failures.

See also:

```txt
docs/known-environment-failures.md
```

---

## Active Instruction File

Codex must use the active implementation instruction file as the task source of truth.

Preferred active file:

```txt
docs/IMPLEMENTATION_INSTRUCTIONS.md
```

If the repository still uses `docs/ROADMAP.md`, treat it as high-level context only.

A valid implementation instruction must define:

1. Objective
2. Phase boundary
3. Scope
4. Non-goals
5. Files / symbols to inspect first
6. Required grep commands
7. Existing anchors
8. Implementation requirements
9. Safety invariants
10. Operator usability requirements
11. Tests
12. Validation commands
13. Manual smoke
14. Permanent-use check
15. Final report format
16. Next-phase dependency

If a section is too broad to implement directly, convert it into a bounded implementation task before coding.

---

## Phase Execution Rule

Do not run multiple implementation tracks in parallel. This includes documentation-only tracks.

Default work style is end-to-end execution. Do not split a single requested phase or feature block into unnecessary user-facing subtasks, separate handoffs, feature branches, or pull requests. Internally decompose the work as needed, but carry the coherent work block through inspection, implementation, cleanup, validation, backup, direct-main commit, push, and final report unless a real blocker or phase boundary is reached.

Default sequence:

1. Read active instruction file.
2. Confirm current phase.
3. Run required grep commands.
4. Implement only that phase.
5. Update tests and docs in the same PR.
6. Run validation.
7. Report result.
8. Only then proceed to next phase.

Each Phase is a single Codex invocation lane. Within a Phase, all sub-tasks (code + tests + docs + changelog + phase report) run continuously to completion. Across Phases, the work must stop at the Phase boundary for audit before the next Phase begins.

If Codex receives instructions appearing to authorize parallel work, stop and verify with the operator.

---

## Section Hygiene Rule

For every coherent section of work, cleanup and review are mandatory implementation work, not optional polish.

At each natural section boundary, Codex must:

1. Clean up local implementation debris, dead code, stale wording, duplicated logic, and obsolete TODOs introduced by the section.
2. Slim the change to the smallest maintainable shape that satisfies the phase, removing opportunistic expansion and unrelated churn.
3. Reflect on whether the section preserved HDS authority, Approval Gate boundaries, audit closure, runtime invariants, and operator usability.
4. Re-review the touched files for consistency with repo conventions, docs, tests, error messages, and phase non-goals.

This rule applies to code, tests, docs, manifests, scripts, and operational instructions. A section is not complete until this hygiene pass is done.

---

## Phase Completion Discipline

各 Phase は次の 7 ステップをすべて完了して初めて完了とみなす。途中で停止することは Phase 未完了であり、次 Phase 着手前に必ず本ステップに戻る。

このディシプリンは BLUE-TANUKI の健全化を常に更新し続けるための必須ゲートである。Phase 完了報告 (Final Report Format) は本ディシプリンの全ステップ完了後にのみ許可される。

### Step 1 — Implementation Closure

Phase 仕様の全要件を実装完了する。

- Phase Execution Rule に従い Phase 内 sub-task (code + tests + docs + changelog + phase report) を連続実行する
- 機能塊「内」を途中で切らない
- Phase 仕様の Non-Goals に違反しないこと

### Step 2 — Repository-Wide Integrity Check

Phase で触った領域に関連するリポ整合性を確認する。

対象範囲:

- Phase で触ったファイルに関連する cross-reference / docs / 設定ファイル
- AGENTS.md ルールとの整合性
- compatibility-matrix.json / capability envelope manifest / plugin manifest と AGENTS.md 表記の一致
- docs/INDEX.md / docs/ROADMAP.md / CHANGELOG.md と Phase 状態の一致
- 関連する既存 docs (FIRST_RUN_CHECKLIST / PERMANENT_USE_CHECKLIST / SECURITY / AUDIT / CLAIM 等) との矛盾なし

対象外:

- Phase と無関係な領域の遡及整合 (Phase の肥大化を避けるため)

整合違反を発見した場合は本 Phase 内で解消する。解消できない場合は Phase 完了せず、ブロッカーとして報告する。

### Step 3 — Cleanup

本 Phase で導入した不要要素を除去する。

- debris / dead code / stale wording / 重複ロジック / 古い TODO の除去
- 試行錯誤コミットの統合
- 一時ファイル / 検証スクリプトの削除または明示的整理
- 部分実装 / 失敗実装の残骸の除去

Section Hygiene Rule の cleanup 項目を Phase 単位で適用する。

### Step 4 — Slim Down

本 Phase の変更を Phase 仕様を満たす最小形に絞る。

- opportunistic expansion (機会的な範囲拡大) の除去
- 無関係な churn (本 Phase と無関係な編集) の除去
- 過度な抽象化 / 過度な汎化の除去
- 「ついでに」の整理を排除し、Phase 仕様で要求された範囲のみ残す

Section Hygiene Rule の slimming 項目を Phase 単位で適用する。

### Step 5 — Safety Re-Review

Phase の変更が安全境界を破っていないことを再確認する。

- HDS authority 経路に介入していないこと
- Approval Gate 5 軸 + final-review bypass なし
- audit hash-chain 互換性維持
- Runtime Invariants 全 PASS (Global Invariants 章 5 項目 + 追加 invariants)
- containment property 維持 (HDS-BRAIN が LLM を呼ぶ経路を作っていない)
- Layer A (pre-installed) / Layer B (third-party extension) 境界維持
- channel / plugin / skill / external metadata からの authority 持ち込みなし

Safety violation を発見した場合は本 Phase 内で解消する。解消できない場合は Phase 完了せず、ブロッカーとして報告する。

### Step 6 — Validation

検証コマンドを実行する。

commit 前の必須セット (全 Phase 共通):

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

実装を含む Phase は追加で:

```bash
pnpm run doctor
pnpm validate:packaging
```

Release Phase は追加で:

```bash
pnpm validate:ga
pnpm release:bundle
pnpm release:verify
```

Release bundle の挙動を変更する場合は、必要に応じて `pnpm release:bundle -- --dry-run` も実行する。

既知環境失敗 (Known Environment Failures 章準拠):

- `pnpm smoke:serve` / `pnpm smoke:resume` は本 Phase が root workspace 解決を扱わない限り実行しない
- `pnpm smoke:live` は credentials 不在で SKIP 可

失敗を隠蔽しないこと。失敗の分類 (本 Phase 起因 / pre-existing / 環境限定) を明示すること。

### Step 7 — Git Closure

Git Operation Policy に準拠して main 更新と backup 更新を行う。

実行順序:

1. work block を 1 commit にまとめる準備をする (まだ main に commit していない状態)
2. backup branch 2 世代ローテーション:
   - 現在の `codex/backup-main` HEAD を `codex/backup-main-prev` に **force-update** する (1 個前へ降格)
   - 初回 (`codex/backup-main` 自体が存在しない場合) は本ステップ 2 を skip し、`codex/backup-main-prev` は作成しない
3. `codex/backup-main-prev` を `origin` に force push (credentials 可能なら、初回 skip 時を除く)
4. main の現在 HEAD (= 本 Phase commit 前 = 前 Phase 完了状態) を `codex/backup-main` に **force-update** する
5. `codex/backup-main` を `origin` に force push (credentials 可能なら)
6. main に本 Phase の work block を直接 commit
7. main を `origin` に push (credentials 可能なら)
8. backup / commit / push のいずれかが失敗した場合は失敗コマンドと理由を Final Report に記載

backup branch 2 世代のセマンティクス:

- `codex/backup-main` = 最新 backup (Phase N-1 完了状態 = 本 Phase commit 直前の main HEAD)
- `codex/backup-main-prev` = 1 個前 backup (Phase N-2 完了状態)
- それ以前の状態は main の commit history からのみ追跡可能
- 新規 backup branch を積み上げない
- backup branch は常にこの 2 本のみ。3 本目以降は作成しない

stage 禁止:

- secret / credentials / API キー
- runtime state (`.blue-tanuki/`)
- 一時ファイル / debug 出力

### Completion Definition

本ディシプリンの Step 1〜7 すべてが完了した時点で Phase 完了とみなす。Final Report Format での Phase 完了報告は本ディシプリンの全ステップ完了後にのみ許可される。

途中ステップで未解消ブロッカーが発生した場合は Phase 完了せずブロッカー報告とする。

---

## Approval Model Rule

Do not collapse `ApprovalRisk`.

Current risk model must remain a severity scale of three levels:

```ts
type ApprovalRisk = "low" | "medium" | "high";
```

`critical` is intentionally not part of the current release line. If a future phase needs a severity above `high`, it must be added as a standalone security phase, not as a side effect of feature work.

L1/L2/L3 must be represented as a separate workflow axis:

```ts
type ApprovalLevel =
  | "L1_observe"
  | "L2_operate"
  | "L3_final_review";
```

Rules:

- `ApprovalRisk` expresses severity.
- `ApprovalLevel` expresses approval workflow.
- `high` risk always maps to `L3_final_review`.
- final-review operations always map to `L3_final_review`.
- `tool.call` and `unknown` map to high-risk `L3_final_review`.
- `full_access` may auto-allow L1/L2, but never L3.
- reusable grants may apply to L2, but never bypass L3.
- schedule create/update/delete are L3.
- schedule list is L1.

---

## Final-review Operations

The canonical implementation source is `FINAL_REVIEW_OPERATION_LIST` in
`packages/hds-brain/src/approval_policy.ts`. Approval Gate checks, process
approval profiles, authority traces, and Runtime Invariants evidence must
derive from that HDS-BRAIN-owned source. Gateway, UI, channels, plugins,
operators, and other downstream limbs must not maintain a parallel
final-review authority list.

The final-review set must include at least:

- file delete
- shell exec
- external send
- credential access
- settings write
- payment charge
- schedule create
- schedule update
- schedule delete
- unknown / unclassified tool call
- GitHub publish/write operations that mutate public/external state
- browser automation operations that submit forms, click destructive controls, download files, upload files, or use credentials
- integration writes to Gmail / Google Calendar / Drive / Teams / LINE
- onboarding operations that install daemons/services, persist credentials, or expose network access
- update operations that change installed code, service metadata, or runtime authority policy

Adding a new privileged operation requires:

- explicit operation name,
- ApprovalRisk classification,
- ApprovalLevel classification,
- full-access containment tests,
- reusable-grant non-bypass tests,
- audit coverage,
- documentation update,
- rollback/failure behavior.

---

## Operator Usability Rule

BLUE-TANUKI must distinguish:

```md
First-run success != permanent usability.
```

A feature is not complete until it satisfies:

1. setup path,
2. normal use path,
3. failure path,
4. recovery path,
5. update path,
6. rollback/removal path when applicable,
7. user-visible next action,
8. audit trace where applicable.

For user-facing operations, error output must answer:

```md
What failed?
Why did it fail?
Is it safe?
What should the owner do next?
Can it be retried?
Was anything changed?
Where is the audit/log?
```

Do not output diagnostics that require source-code knowledge unless explicitly marked as developer diagnostics.

---

## Five-Minute First-Run Rule

BLUE-TANUKI may eventually claim "beginner can use in 5 minutes" only if all are true:

- documented supported OS path,
- Node/package prerequisite check,
- one command or guided setup path,
- token/credential check,
- local Control Center opens,
- first WebChat message succeeds,
- Telegram optional path is separately documented,
- doctor passes or gives actionable fix,
- no hidden credential or daemon state is left unexplained,
- failure rollback is documented.

Until then, use "first-run path" or "guided setup path", not "5-minute setup".

### Installer-Accelerated First-Run

installer (`install/installer/`) を経由した first-run 経路の存在は本ルールを変更しない。

- installer は guided first-run の加速を行うが、5-minute setup の保証主張ではない
- installer 提供によって docs 上の "guided first-run path" 表現が "verified 5-minute beginner guarantee" 表現に置き換わることは禁止
- installer 経由でも doctor の actionable remediation は維持する
- installer 失敗時の owner next action 表示は必須
- installer は HDS-BRAIN authority 経路に介入しない
- installer は env file / secrets を生成するが、生成された secret を表示・log 出力しない

---

## Permanent-Use UX Rule

Permanent use requires:

- startup reliability,
- daemon/service clarity,
- config preservation across updates,
- update/rollback runbook,
- doctor with actionable remediation,
- channel readiness matrix,
- credential readiness matrix,
- audit verification,
- approval queue visibility,
- runtime schedule visibility,
- notification/error visibility,
- safe uninstall/purge behavior,
- no unexplained background mutation.

Do not mark a release as "complete" if it only works in a happy-path demo.

---

## Runtime Automation Rule

Runtime automation creates future actions.

Rules:

- create/update/delete of future automation is L3.
- listing automation is L1.
- pending automation must not execute.
- rejected or timed-out automation must not execute.
- automation actors are not humans.
- runtime automation must enter HDS-BRAIN through a dedicated non-human actor path.
- schedule payload content must not be exposed in runtime snapshot.
- payload digest/hash may be exposed for auditability.
- boot-time schedule behavior must not regress.

---

## External Write Tool Rule

External write tools create durable external side effects.

Examples:

- GitHub issue/PR/comment creation
- GitHub issue/PR update/close/merge
- Gmail send/draft/update
- Google Calendar create/update/delete
- Drive write/update/delete
- Slack/Discord/Teams/LINE outbound sends
- browser submit/click/upload/download

Rules:

- external write must be downstream only,
- external metadata is not authority,
- credentials must be declared through capability envelope,
- writes must pass Approval Gate,
- public or irreversible writes default to L3,
- outputs must be audit-compatible.

---

## Browser Automation Rule

`browser.read` is not browser automation.

Headless browser automation must remain preview-only until:

- sandbox policy,
- network policy,
- credential boundary,
- ApprovalRisk/ApprovalLevel mapping,
- audit trace,
- resource limits,
- failure modes,
- live smoke skip path,

are implemented and tested.

Do not promote browser automation to main release quality in its first PR.

---

## Memory / F-reference Rule

Memory is not authority.

Memory may be used only as:

- context source,
- preference source,
- continuity source,
- audit reference source.

Memory must not be used to:

- escalate permissions,
- skip approval,
- justify privileged actions,
- infer owner consent,
- override current policy.

F-reference integration must preserve:

- append-only memory entries,
- `F:<id>` traceability,
- hash-chain compatibility,
- `used_for_authority=false` unless a future phase explicitly changes the model through a separate security review.

Any future memory authority change must be a standalone security phase. Do not bundle it with feature work.

---

## First-Party Surface Rule

BLUE-TANUKI の first-party operator surface は次の 3 surface である。3 surface は同格、優先順位なし。

- Writing Operator
- Daily Operator
- Developer Operator

詳細仕様は `docs/operator-surfaces/` 配下を参照。

Surface 追加 / 変更時の制約:

- Surface は HDS-BRAIN downstream device として実装する
- Surface 経由で authority 経路を作らない
- Surface は既存 tool (`file.*` / `shell.*` / `github.*` / `google.*` / `cron.process` / `channel_send` / LLM tool) を downstream として利用し、新規 raw 権限を追加しない
- L1 / L2 / L3 ApprovalLevel を operation 単位で明示する
- L3 final-review bypass を作らない
- audit hash-chain への記録を遵守する
- containment property を破らない
- Layer A (プリインストール責任範囲) 内のモジュールであり、Layer B プラグインは surface 機能を拡張できるが置き換えられない

Surface 追加判断:

- 新規 surface の追加は Owner 決定事項
- v1.0 GA 範囲では 3 surface 固定
- v1.1 以降の追加は別途 Phase で扱う

---

## Adapter Rule

A channel / plugin / skill adapter is downstream only.

Adapters must:

- declare all capabilities in a manifest,
- use only declared capabilities,
- fail closed when a required capability is unavailable,
- normalize inbound events into canonical inbound type,
- send outbound actions through canonical outbound request type,
- map errors to typed recoverable / non-recoverable results,
- emit audit-compatible traces,
- preserve Runtime Invariants.

Adapters must not:

- call LLMs from the authority path,
- bypass Approval Gate,
- mutate HDS-BRAIN authority rules,
- treat user/channel metadata as authority,
- request undeclared filesystem/network/process/credential access.

(Memory non-authority rules are covered by the Memory / F-reference Rule above and apply to adapters as well.)

### Layer A / Layer B Boundary

Adapter / plugin / skill は Layer B (third-party extension surface) に属する。

Layer A (pre-installed responsibility) は HDS-BRAIN authority / Approval / Audit / first-party channels / first-party operator surfaces / installer / Control Center / resident application から構成され、Layer B 経路で Layer A authority が破られることは禁止である。

Layer B の境界は次の文書群で確定する:

- `docs/PLUGIN_REVIEW_GATE.md`
- `docs/PLUGIN_HIG.md`
- `docs/SKILL_LOADER_CONTRACT.md`
- `docs/ADAPTER_CONTRACT.md`
- `docs/CAPABILITY_ENVELOPE.md`
- `docs/CONFORMANCE.md`

新規 plugin / skill / adapter を作成・受け入れる際は本群を通読し、認められない受け入れは reject する。

Layer B submission は `pnpm plugin:review -- --package <plugin-package-dir>` を通すこと。Review result は non-authority evidence であり、HDS-BRAIN / Approval Gate / Runtime Invariants / audit を代替しない。

---

## Channel Policy

First-party completion path:

- WebChat: resident control plane and local console
- Telegram: first-party release channel
- Slack: first-party-preview pending owner credentialed live smoke and permanent-use recovery review
- Discord: first-party-preview pending owner credentialed live smoke and permanent-use recovery review
- Teams: first-party-preview pending webhook/listener closure, owner credentialed live smoke, and permanent-use recovery review
- LINE: first-party-preview pending webhook/listener closure, owner credentialed live smoke, and permanent-use recovery review

Channel count is not a product-quality metric.

A channel is first-party only if:

- setup is documented,
- credentials are checked,
- live smoke has skip path and credential path,
- inbound/outbound behavior is tested,
- rate limit/backoff is handled,
- user-visible errors are actionable,
- conformance tests pass,
- channel metadata cannot escalate authority,
- compatibility matrix is accurate.

Phase 11-S11 adds the machine promotion gate: `pnpm validate:channels` must
pass before any Slack / Discord / Teams / LINE entry is promoted from
`first-party-preview` to `first-party`. Owner-run live smoke evidence must be
redacted and must not contain token values, raw live targets, bearer headers, or
message content. Teams / LINE also require gateway-owned inbound listener
closure before promotion.

WhatsApp policy:

WhatsApp is intentionally excluded from first-party core. This is **not a "too hard, defer later"** decision. It is a deliberate safety strategy:

- WhatsApp's ecosystem (Baileys, WAHA, browser automation, unofficial Business API access patterns) invites third-party extension where authority/audit boundaries cannot be guaranteed.
- BLUE-TANUKI does not leave hidden extension surfaces that downstream operators or third-party adapters could exploit beyond the HDS authority path.
- Refusing first-party support is also a liability boundary: BLUE-TANUKI does not warrant operation through these surfaces.

Therefore:

- WhatsApp is not first-party core.
- Do not implement Baileys.
- Do not implement WAHA.
- Do not implement WhatsApp Web automation.
- Do not implement first-party WhatsApp Business API.
- Do not implement Twilio WhatsApp as first-party core.
- Do not add WhatsApp-specific hidden hooks.
- Only the generic adapter interface may exist.
- Third-party adapters are outside first-party responsibility.

Compatibility status:

```json
{
  "status": "reserved-third-party",
  "core_supported": false,
  "warranty": "none"
}
```

---

## Preview Quarantine

Incomplete, experimental, risky, or third-party-like functionality must be isolated as preview.

Preview code must not be promoted unless:

- conformance tests pass,
- permission enforcement tests pass,
- audit trace tests pass,
- Runtime Invariants remain preserved,
- documentation states support level,
- failure modes are documented.

---

## Documentation Rules

When updating architecture, roadmap, or instruction documents:

- Keep internal-design perspective.
- Do not over-optimize for external marketing.
- Do not add unnecessary legal commentary.
- Do not weaken Sacred Constraints.
- Use precise engineering language.
- Keep unsupported or unsafe paths explicitly out of first-party scope.
- State non-goals clearly.
- State implementation gaps as gaps, not as completed features.
- Distinguish current implementation from target state.
- Distinguish first-run UX from permanent-use UX.
- Do not expand private HDS/source-philosophy material or sealed core details in public process docs.

Important active files (currently existing):

```txt
AGENTS.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/OPENCLAW_REJECTION_AUDIT.md
README.md
QUICKSTART.md
SECURITY.md
AUDIT.md
CONFIG.md
TROUBLESHOOTING.md
CLAIM.md
CHANGELOG.md
```

Files that may be created by later phases (do not assume they currently exist):

```txt
docs/ROADMAP.md
docs/ADAPTER_CONTRACT.md
docs/CAPABILITY_ENVELOPE.md
docs/CONFORMANCE.md
docs/LLM_DEVELOPMENT_GUIDE.md
docs/SECURITY_REVIEW_CHECKLIST.md
docs/NON_GOALS.md
docs/compatibility-matrix.json
docs/FIRST_RUN_CHECKLIST.md
docs/PERMANENT_USE_CHECKLIST.md
docs/CHANNEL_READINESS_MATRIX.md
docs/CREDENTIAL_READINESS_MATRIX.md
docs/UPDATE_ROLLBACK_RUNBOOK.md
docs/OPENCLAW_REJECTION_AUDIT.md
docs/v1.0-security-and-permanent-use-review.md
```

If a Phase creates a file from the second list, treat that creation as part of the Phase's deliverable, not as a precondition.

---

## Default Codex Workflow

Before editing:

```bash
git status --short
node --version
corepack --version || true
pnpm --version || true
```

Read:

```txt
AGENTS.md
docs/IMPLEMENTATION_INSTRUCTIONS.md
docs/ROADMAP.md
SECURITY.md
AUDIT.md
CONFIG.md
README.md
CHANGELOG.md
```

Then run the grep commands required by the active phase.

During implementation:

- keep one direct-main work block to one coherent feature or phase,
- do not opportunistically refactor unrelated areas,
- do not silently change public behavior,
- do not silently change environment variable semantics,
- update docs and tests in the same PR,
- prefer fail-closed behavior,
- preserve release-bundle validation.

After implementation and before commit, run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

For release-path changes also run:

```bash
pnpm validate:packaging
pnpm validate:ga
pnpm release:bundle
pnpm release:verify
```

Run `pnpm run doctor`, `pnpm smoke:serve`, `pnpm smoke:resume`, and `pnpm smoke:live` when the task explicitly targets CI, smoke checks, root workspace resolution, runtime behavior, release validation, or operator setup. For unrelated feature work, follow the active phase validation set and report skipped smoke checks as scope-limited. If `pnpm` remains unavailable after the Corepack recovery path in `docs/known-environment-failures.md`, stop pnpm-based validation and report it as an environment limitation.

If a command is unavailable or fails, report:

- command,
- result,
- whether the failure appears caused by this change or pre-existing repository state,
- files modified,
- mitigation or next action.

Never hide failed tests.

---

## Final Report Format

Every phase's Final Report must only be emitted after Phase Completion Discipline (Step 1 through Step 7) is fully complete. If any step is incomplete or blocked, do not emit a Final Report; emit a blocker report instead, naming the blocking step and the unresolved condition.

Every change report must include:

1. Summary
2. Changed files
3. Risk classification
4. Validation results
5. Remaining risks
6. Commit hash

For larger implementation phases, also include safety boundary impact, Runtime Invariants impact, Approval Gate impact, operator usability impact, and audit impact where relevant.

Do not claim validation passed unless the command actually ran and passed.

---

## Non-Goals

Do not add:

- agent-driven authority core,
- emotion functionality,
- WhatsApp first-party core implementation,
- ClawHub compatibility,
- unsafe third-party skill execution,
- CLI-only final UX,
- unsupported preview features in main release,
- commercial SaaS roadmap,
- hidden privilege escalation,
- black-box authority path,
- channel-count competition.

---

## Core Reminder

OpenClaw gives an agent hands.<br>
BLUE-TANUKI gives authority a body.

OpenClaw may optimize for quick reach and breadth.<br>
BLUE-TANUKI must optimize for safe permanence.

Do not invert that relationship.
