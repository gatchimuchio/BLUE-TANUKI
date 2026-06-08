# CONFORMANCE

この文書は adapter / plugin / skill / runtime automation を main release に入れる前の conformance 条件を定義する。

## Active Test Coverage

現在の main release gate として扱うテスト群:

- `apps/gateway/test/adapter_conformance.test.ts`
  - Teams / LINE inbound normalization and canonical outbound dispatch
  - Slack / Discord / Telegram の inbound normalization
  - canonical `InboundRequest` / `ChannelSendPayload` の利用
  - channel metadata が authority metadata を持ち込まないこと
  - credential / transport 不在時に silent failure しないこと
- `packages/channel-slack/test/slack.test.ts` / `packages/channel-discord/test/discord.test.ts`
  - adapter-level retry/backoff
  - typed recoverable / non-recoverable delivery errors
  - credential missing, rate limit, and permission failure handling
- `packages/channel-teams/test/teams.test.ts` / `packages/channel-line/test/line.test.ts`
  - preview adapter silent fail-closed mode
  - Graph / Messaging API request shape
  - adapter-level retry/backoff and typed delivery errors
  - credential value non-leakage in history
- `apps/gateway/test/compatibility_matrix.test.ts`
  - `docs/compatibility-matrix.json` と first-party / preview channel manifest の整合
  - WhatsApp が `reserved-third-party` のまま維持されること
  - first-party channel manifest が wildcard permission を持たないこと
- `apps/gateway/test/channel_promotion_gate.test.ts`
  - Slack / Discord / Teams / LINE が owner evidence なしに first-party 昇格しないこと
  - complete evidence がある channel だけ future promotion 可能であること
  - Teams / LINE は gateway-owned inbound listener closure なしに昇格しないこと
  - WhatsApp が first-party core に昇格しないこと
- `apps/gateway/test/plugin_review_gate.test.ts`
  - complete Layer B submission が entry import なしに accept されること
  - `blue-tanuki.review.json` 不在、wildcard capability、manifest drift、`kind=core` submission を reject すること
  - lifecycle install scripts、runtime dynamic import、WhatsApp-specific scope、final-review declaration 不足を reject すること
  - bundled workspace packages が basic non-submission gate を通ること
- `apps/gateway/test/runtime_schedule.test.ts`
  - runtime schedule create/update/delete が pending approval を経由すること
  - pending / rejected / timed-out schedule が発火しないこと
  - schedule snapshot が content を露出しないこと
  - approved runtime schedule が既存 cron lane を通ること
- `packages/hds-brain/test/approval_policy.test.ts`
  - `ApprovalRisk` は `low | medium | high` の3段階であること
  - `ApprovalLevel` が L1/L2/L3 として authority trace に残ること
  - full access / reusable grant が L3 final-review を bypass しないこと
- `packages/hds-brain/test/standalone_boundary.test.ts`
  - HDS-BRAIN package が gateway / core / channel / operator / plugin loader / downstream client に依存しないこと
  - public exports を単体 import できること
  - `HDSUpperController` が gateway なしで instantiate / decide できること
  - LLM / tool command envelope を downstream 実行なしで返すこと
  - standalone approval evaluation / audit verification / runtime health が動くこと
- `packages/hds-brain/test/runtime_invariants.test.ts`
  - Runtime Invariants evidence report が HDS-BRAIN standalone で生成されること
  - fixed display tuple だけではなく expected/actual/evidence/digest/all-ok を持つこと
  - failed invariant が silent normalization されず failed evidence として残ること
  - runtime invariant evidence が HDS audit chain に append できること
- `packages/hds-brain/test/final_review_operations.test.ts`
  - `FINAL_REVIEW_OPERATION_LIST` が HDS-BRAIN の単一ソースであること
  - Approval Gate set / process profile / authority trace / Runtime Invariants evidence が同じリストから派生すること
  - `tool.call` / `google.write` / `unknown` を含む L3 boundary drift を検出すること
- `packages/hds-brain/test/compound_attack_scenarios.test.ts`
  - wildcard `full_access` grant が L3 final-review を bypass しないこと
  - shell / schedule / GitHub / Google / browser automation の複合 privileged envelope が L3 に残ること
  - owner / approval metadata spoof が authority に昇格しないこと
  - forged channel-send metadata が process policy を越えないこと
  - downstream feedback が suspended request を lift しないこと
  - complete-history / history update が authority にならないこと
- `packages/hds-brain/test/detector_lifecycle.test.ts`
  - missing detector が auto-allow せず `SUSPEND` すること
  - detector exception が authority path を crash させず `SUSPEND` すること
  - invalid detector score が lifecycle failure として `SUSPEND` すること
  - invalid detector pattern が `detector_unknown_pattern` として `SUSPEND` すること
  - duplicate policy axis が detector conflict として `SUSPEND` すること
- `packages/hds-brain/test/fail_safe_self_health.test.ts`
  - Runtime Invariants failure が command emission 前に `SUSPEND` すること
  - invalid policy が normal policy evaluation 前に `SUSPEND` すること
  - broken audit chain 後の request が fail-safe suspend になること
  - fail-safe suspension が human resume approve で解除されないこと
- `packages/hds-brain/test/complete_history.test.ts`
  - `CompleteHistoryStore` が standalone append / verify / replay / export baseline を持つこと
  - user input / LLM history / HDS decision / approval / execution / audit / final output を記録できること
  - complete-history entries / exports が non-authority であること
  - JSONL persistence の load-time chain verification が壊れた履歴を拒否すること
- `packages/operator-writing/test/writing.test.ts`
  - Writing Operator surface registration
  - L1 / L2 / L3 operation boundary declaration
  - digest-only invocation trace helpers
  - no raw authority capability declaration
- `packages/operator-daily/test/daily.test.ts`
  - Daily Operator surface registration
  - backward-compatible `BLUE_TANUKI_DAILY_BRIEF_*` env snapshot
  - L1 read, L2 reminder draft, and L3 schedule / Google write boundary declaration
  - no raw authority capability declaration
- `packages/operator-developer/test/developer.test.ts`
  - Developer Operator surface registration
  - L1 read, L2 file write/edit, and L3 shell / GitHub / browser automation boundary declaration
  - browser automation preview remains disabled-by-default
  - digest-only invocation trace helpers
  - no raw authority capability declaration
- `packages/hds-brain/test/operator_surface.test.ts`
  - Writing Operator frame recognition
  - Daily Operator frame recognition
  - Developer Operator frame recognition
  - untrusted metadata does not select a surface
  - surface recognition leaves the process as HDS-owned downstream chat
- `apps/gateway/test/plugin_loader.test.ts`
  - first-party surface exports are loaded only after manifest permission checks and bundled Plugin Review Gate checks
- `packages/channel-webchat/test/webchat.test.ts`
  - Complete History / Replay Control Center shell
  - `/history` / `/history/replay` require inbound auth
  - history replay strips raw payload before serialization
  - history replay rejects mutation methods
  - Writing Operator Control Center endpoints require inbound auth
  - Writing Operator invoke enters the existing inbound handler with gateway-owned surface metadata
  - Daily Operator Control Center endpoints require inbound auth
  - Daily Operator invoke enters the existing inbound handler with gateway-owned surface metadata
  - Developer Operator Control Center endpoints require inbound auth
  - Developer Operator invoke enters the existing inbound handler with gateway-owned surface metadata
  - Settings `Verify LLM` route requires the settings token and performs non-mutating verification
- `apps/gateway/test/settings_surface.test.ts`
  - SIM-like LLM API settings verification passes for the stub provider without external network access
  - non-stub provider verification returns safe failure without saving secrets or mutating the env file
- `install/installer/test/installer.test.ts`
  - guided first-run installer CLI parses provider and no-serve options
  - installer preflight reports owner next action when run outside a repo root
- `install/installer/test/resident_integration.test.ts`
  - portable installer launchers expose resident lifecycle commands
  - resident helpers provide explicit autostart enable/disable/status paths
  - uninstallers stop resident state and disable autostart before app removal
- `apps/gateway/test/doctor.test.ts`
  - doctor が manifest / compatibility matrix / schedule config の release gate を表示すること

## Required Test Groups

- Adapter conformance tests
- Plugin review gate tests
- Skill loader contract tests
- Permission enforcement tests
- Audit trace compatibility tests
- Runtime invariant preservation tests
- HDS-BRAIN standalone boundary tests
- HDS-BRAIN runtime invariant evidence tests
- HDS-BRAIN complete history substrate tests
- Complete history / replay UI tests
- HDS-BRAIN final-review single-source tests
- HDS-BRAIN root full-access compound attack tests
- HDS-BRAIN detector lifecycle tests
- HDS-BRAIN fail-safe self-health tests
- Runtime automation containment tests
- First-party operator surface tests
- Installer setup UX tests
- Resident application integration tests
- Channel first-party promotion gate tests
- SIM-like LLM API settings verification tests
- Preview quarantine rule
- Main release gate rule

Canonical negative target catalogue: [Conformance Targets](CONFORMANCE_TARGETS.md).

## Evidence Discipline

conformance は completion claim の一部だが、単独では release readiness ではない。各 gate は、観測している evidence source を明確にする。

- `CONFIG`: manifest、compatibility matrix、package metadata、docs。
- `INTERNAL_STATE`: generated snapshot、local store、runtime object。
- `LIVE_RUNTIME`: 起動中の gateway / HDS-BRAIN / channel / resident process。
- `EXTERNAL_EVIDENCE`: GitHub Actions、extracted release bundle、installed path、credentialed live smoke。
- `FIXTURE`: mock、negative fixture、unit fixture。

`CONFIG` / `INTERNAL_STATE` / `FIXTURE` の成功を `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` の成功として報告してはならない。release path の変更は extracted bundle verification と GitHub Actions green なしに release-ready と扱わない。

## Contract-to-Runtime Coverage

contract、policy、manifest、capability、audit record、Runtime Invariants evidence を追加または変更する conformance は、次を示す。

- consuming production / runtime / validator path
- positive path
- negative path
- fail-closed / SUSPEND / audit behavior
- HDS-BRAIN standalone boundary preservation
- downstream UI / adapter / plugin が authority を作らないこと

contract が存在するだけでは conformance complete ではない。実際に governed path が consume し、失敗 path が検出される必要がある。

## Mutation Verification

safety-critical な conformance が tautology になる危険がある場合は、必要に応じて mutation verification を行う。

対象例:

- final-review operation single source
- Approval Gate bypass prevention
- full access L3 containment
- channel / plugin metadata authority escalation prevention
- Runtime Invariants evidence generation
- complete history raw-payload stripping
- release bundle secret exclusion

mutation verification を実施した場合は、mutation target、expected failure、observed failure、revert confirmation、final validation result を記録する。破壊用 mutation code は commit しない。

## Adapter Conformance Tests

adapter は以下を test で示す。

- inbound event が canonical inbound message type に正規化される
- outbound operation が canonical outbound request type を経由する
- recoverable / non-recoverable error が typed result に分類される
- channel metadata が authority escalation に使われない

## Permission Enforcement Tests

- manifest に宣言した capability だけを使う
- undeclared network / fs / process / credential / memory / notification access は拒否される
- capability 不足時は fail closed する

## Plugin / Skill Conformance Tests

Layer B plugin / skill submissions must include tests for:

- manifest schema validation
- declared capability use
- undeclared capability hard reject
- HDS authority non-bypass
- Approval Gate non-bypass
- audit trace compatibility
- credential redaction
- disable / revoke fail-closed behavior
- no hot reload for skills
- no external npm dynamic import at runtime

The repository gate is:

```bash
pnpm plugin:review -- --package <plugin-package-dir>
```

Bundled workspace packages are reviewed through the non-submission path before load. Layer B submission packages require `blue-tanuki.review.json` evidence and remain downstream-only; review results are non-authority evidence.

Review docs:

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Plugin HIG](PLUGIN_HIG.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)

## Runtime Automation Tests

runtime automation は未来の action を作るため、通常の tool より強い conformance を要求する。

- create/update/delete は L3 final-review
- list は L1 observe
- pending automation は実行されない
- rejected / timed-out automation は実行されない
- old active schedule は update/delete approval まで維持される
- snapshot は content を露出せず、safe metadata と payload hash のみを出す
- lifecycle は hash-chain audit に残る

## Resident Application Integration Tests

resident application integration は Gateway lifecycle を OS に寄せるが、authority path ではない。

- portable launcher は resident start/status/stop/open/logs を提供する
- autostart は owner が明示的に enable した場合のみ設定される
- autostart は current-user OS facility に限定される
- uninstall は resident process を止め、autostart を disable してから app/launcher を削除する
- normal uninstall は env/audit/session/memory を保持する
- resident helpers は token 値を表示せず、HDS-BRAIN / Approval Gate / audit / Runtime Invariants を変更しない

## Audit Trace Compatibility Tests

- request_id と operation trace が残る
- Approval Gate の decision と downstream action が追跡可能
- `approval_level` が authority trace に残る
- schedule lifecycle が audit に残る
- F-reference がある場合は `F:<id>` として trace に残る
- hash-chain validator が pass する

## Runtime Invariant Preservation Tests

- HDS-BRAIN does not call LLM
- memory is not authority
- channel metadata cannot escalate authority
- privileged operation cannot bypass Approval Gate
- Runtime Invariants remain externally inspectable
- Runtime Invariants expose evidence reports with non-authority flags
- Runtime Invariants evidence can be audited without creating authority

## HDS-BRAIN Final-review Single-source Tests

- `FINAL_REVIEW_OPERATION_LIST` is unique and exported from `packages/hds-brain`.
- `FINAL_REVIEW_OPERATIONS` is derived from the list.
- `resolveProcess()` approval profiles use the same list.
- Authority traces expose the same sorted boundary.
- Runtime Invariants evidence reports the same required and configured boundary.
- Gateway, UI, channel, operator, and plugin code do not own a parallel final-review list.

## HDS-BRAIN Root Full-access Compound Attack Tests

- Wildcard `full_access` grants do not allow L3 operations.
- Shell exec, schedule mutation, GitHub write, Google write, and browser automation remain `L3_final_review`.
- Untrusted external metadata cannot impersonate owner approval.
- Forged gateway channel-send metadata cannot bypass process execution policy.
- Executor feedback and claimed tool output cannot resume a suspended request.
- Complete-history references and history updates cannot become authority.

## HDS-BRAIN Detector Lifecycle Tests

- Registered detectors expose lifecycle state without downstream dependencies.
- Missing detectors, detector exceptions, invalid detector output, duplicate policy axes, and unknown detector patterns do not auto-allow.
- Lifecycle failures resolve to `SUSPEND` before normal score thresholds.
- Invalid `risk_keyword` regex patterns produce `detector_unknown_pattern`.
- Lifecycle evidence is present in HDS decision logs under `model.scoring.axis_scores[].lifecycle`.

## HDS-BRAIN Fail-safe Self-health Tests

- Self-health reports failed authority preconditions and owner next action.
- Failed Runtime Invariants, invalid policy, broken audit chain, unavailable HDS, unavailable Approval Gate, or invalid configured memory chain do not emit commands.
- Fail-safe decisions record `hds_fail_safe:*` triggered thresholds.
- Fail-safe suspensions are not human-resumable approval paths.
- Recovery requires repairing the failed precondition and retrying through the normal HDS authority path.

## HDS-BRAIN Standalone Boundary Tests

- `packages/hds-brain` has no gateway/core/channel/operator dependency.
- `HDSUpperController` can decide on an `InboundRequest` without gateway.
- LLM and tool requests become command envelopes, not direct execution.
- `AuditLog`, approval evaluation, runtime snapshot, and HDSBrainHealth run standalone.
- Downstream result/reference material remains evidence, not authority.

## HDS-BRAIN Boundary Definition Tests

- `tool.call` and `unknown` map to high-risk `L3_final_review`.
- unknown / ambiguous / unclassified / missing capability / mismatch / conflict / detector unknown pattern states never auto-allow.
- memory, complete history, session, tool result, LLM output, metadata, audit viewer, and Control Center projections are reference/evidence only.
- HDS fail-safe suspends downstream execution when policy, audit chain, runtime invariants, Approval Gate, or HDS availability is invalid.
- policy, detector, approval, and history updates require L3 final review.
- Trinity `M` closure suspends when X, R, or M is missing.

## HDS-BRAIN Output Audit Tests

- OutputAudit is pure and standalone inside `packages/hds-brain`.
- LLM raw output, tool result, scheduler result, plugin result, external action result, and noop result are classified deterministically.
- Output audit stores digests/metadata and not raw output content.
- Gateway-visible output is audited before CLI log or channel dispatch.
- Audit dump and authority trace can project `output_audit` records.

## HDS-BRAIN Complete History Tests

- `CompleteHistoryStore` is pure and standalone inside `packages/hds-brain`.
- It records `user_input`, `llm_history`, `hds_decision`, `approval_history`, `execution_history`, `audit_history`, and `final_output`.
- Entries preserve payload digests, previous-entry hashes, entry hashes, and `used_for_authority=false`.
- Replay and export expose copies, not mutable live records.
- JSONL persistence verifies the complete chain before accepting existing history.
- Complete history remains replay/evidence material and cannot substitute approval.

## Complete History / Replay UI Tests

- Control Center exposes Complete History / Replay without replacing Approval Queue or Notification Center.
- `/history` and `/history/replay` are read-only and require the WebChat inbound bearer token.
- WebChat strips raw `payload` from history snapshots before serialization.
- History entries expose digest/metadata fields only.
- `complete_history_used_for_authority=false` is preserved in the response.
- History replay cannot approve, reject, execute, mutate audit, mutate history, or grant authority.

## Preview Quarantine Rule

未完成、experimental、third-party-like、または support level が曖昧な実装は preview quarantine に置く。preview は README / docs / compatibility matrix に status を明記する。

## Main Release Gate Rule

main release へ昇格するには、conformance tests、permission enforcement tests、audit trace compatibility tests、runtime invariant preservation tests が pass し、support level と運用責任が docs に残っていること。

## Channel First-Party Promotion Gate Tests

- `pnpm validate:channels` must pass for the committed compatibility matrix.
- WebChat and Telegram remain the baseline v1.0 first-party channels.
- Slack / Discord / Teams / LINE cannot move from `first-party-preview` to
  `first-party` without owner-run live smoke evidence and recovery review.
- Teams / LINE cannot move to first-party until gateway-owned inbound listener
  behavior is release-complete.
- WhatsApp remains `reserved-third-party` with no core warranty.
