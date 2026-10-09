# BLUE-TANUKI v1.0 RC Audit

## Audit files

Set:

```bash
export BLUE_TANUKI_AUDIT_DIR=.blue-tanuki/audit
export BLUE_TANUKI_MEMORY_DIR=.blue-tanuki/memory
export BLUE_TANUKI_APPROVALS_FILE=.blue-tanuki/approvals/grants.json
```

## Runtime snapshot

```bash
curl -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  http://127.0.0.1:8787/runtime/snapshot
```

Expected invariant fields:

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

## HDS-BRAIN standalone audit

HDS-BRAIN は gateway なしでも in-memory `AuditLog` を生成・検証できる。

```bash
pnpm hds:standalone
```

The standalone smoke appends the HDS decision and approval evaluation to an HDS-owned hash-chain audit log, then reports `audit_chain_valid=true` when the chain verifies. The smoke does not execute LLMs, tools, channels, browser automation, or external APIs.

Downstream limbs return result / feedback / event material. That material is audit evidence only; it does not become authority, approval, or privilege escalation.

## Boundary definition audit

Phase 12-S0 adds a deterministic boundary policy surface in `packages/hds-brain/src/boundary_policy.ts`.

Audit expectations:

- unknown / unclassified command operations resolve to L3 final-review before execution;
- memory, complete history, session, tool result, LLM output, and metadata remain reference/evidence only;
- fail-safe states suspend downstream execution instead of delegating authority;
- policy, detector, approval, and history updates require L3 final review;
- detector lifecycle failures and unknown detector patterns resolve to `SUSPEND` with lifecycle traces in the decision log;
- self-health fail-safe decisions record failed preconditions and command/downstream execution denial before command emission;
- Trinity `M` closure failures are suspend conditions, not silent allow conditions.

## Output / result audit

Phase 12-S1 adds `output_audit` records before final user-visible output or external result handoff.

`output_audit` records:

- command id and upstream commit hash;
- output kind (`llm_raw_output`, `tool_result`, `external_action_result`, `scheduler_result`, `plugin_result`, `noop_result`);
- feedback status;
- result digest and rendered output digest when present;
- target surface;
- user-visible and external-side-effect flags;
- `used_for_authority=false`.

Raw LLM/tool output content is not stored in the audit entry. Complete raw history belongs to the separate CompleteHistoryStore substrate and remains non-authority replay/evidence material.

復旧済みまたは保留済みの終端J資料整理projectionは、専用の`j_projection_output_audit`へ記録する。requestとHDS commit参照、task/revision/status、表示先、rendered outputのdigestと文字数だけを持ち、原文・引用・section label・表示内容を持たない。`used_for_authority=false`、`may_execute=false`、`may_commit_to_memory=false`、`external_side_effect_result=false`を固定する。この記録はCを実行しない表示の監査であり、表示判断は行わない。権限境界はHDS-BRAINに残る。

## Complete history substrate

Phase 12-S2 adds `CompleteHistoryStore` as a standalone original-record substrate in `packages/hds-brain`.

It can append, verify, replay, and export records for:

- user input
- LLM history
- HDS decisions
- approval history
- execution history
- audit history
- final output

When a filepath is supplied, records are persisted as JSONL with payload digests and entry hashes. Loading an existing file verifies the chain before accepting it.

This store is not the hash-chain authority audit log and is not an approval source. It is replay/evidence material only, with `used_for_authority=false` and `complete_history_used_for_authority=false`.

Gateway serve mode now appends safe replay metadata into `CompleteHistoryStore` for user input, HDS decisions, approval evaluations, execution feedback, and final output audit. The Control Center `/history` and `/history/replay` APIs project only replay metadata and digests; raw payloads, approval tokens, credentials, command content, rendered output, and raw tool/LLM result values are not serialized through that API.

## Runtime Invariants evidence audit

Phase 12-S3 adds `runtime_invariants` records to the HDS hash-chain audit.

`runtime_invariants` records contain:

- all-ok status
- report digest
- evidence count
- invariant values
- full HDS-BRAIN evidence report
- reason
- `used_for_authority=false`

Runtime Invariants evidence is inspectable audit material. It does not approve commands, classify risk, rewrite policy, bypass final review, infer consent, or create fallback authority.

## Final-review boundary audit

Phase 12-S4 makes `FINAL_REVIEW_OPERATION_LIST` in `packages/hds-brain/src/approval_policy.ts` the single source for final-review operations.

The HDS audit surfaces this source through:

- Approval Gate evaluations and authority traces;
- process `approval_profile.final_review_operations`;
- Runtime Invariants evidence metadata;
- tests that compare those projections against the same HDS-BRAIN list.

Audit viewers and Control Center projections may display this boundary, but they cannot mutate it or become a second authority path.

## Audit dump

```bash
pnpm --filter @blue-tanuki/gateway run doctor
node apps/gateway/dist/main.js --audit-dump --json
```

## Chain Integrity Verification

`--audit-verify` is a read-only integrity check for the persisted JSONL
hash-chain. It does not feed results back into HDS-BRAIN or the authority path.

```bash
export BLUE_TANUKI_AUDIT_DIR=.blue-tanuki/audit
node apps/gateway/dist/main.js --audit-verify
node apps/gateway/dist/main.js --audit-verify --json
```

Valid chains exit with code `0`:

```text
blue-tanuki audit-verify - OK (2026-05-11T00:00:00.000Z)
  filepath:    .blue-tanuki/audit/audit.jsonl
  entries:     3
  chain_valid: true
  detail:      verified 3 entries; chain integrity OK

Exit code: 0
```

Tampering, order changes, or broken hashes exit with code `1` and report the
first failing entry index:

```text
blue-tanuki audit-verify - BROKEN (2026-05-11T00:00:00.000Z)
  filepath:    .blue-tanuki/audit/audit.jsonl
  entries:     1
  chain_valid: false
  detail:      chain verification failed at entry index 1: entry_hash does not match SHA-256(index|prev_hash|JSON.stringify(log))
  failure:     index=1 reason=entry_hash_mismatch

Exit code: 1
```

## What is recorded

- HDS decision logs
- approval evaluations
- authority events
- schedule lifecycle events
- command lifecycle
- executor feedback
- unknown/stale feedback
- runtime invariants evidence
- detector lifecycle traces inside HDS decision logs
- fail-safe self-health decisions and failed preconditions

## Schedule lifecycle audit

Runtime schedule create/update/delete requests are audited as lifecycle events in the hash-chain:

```text
schedule.lifecycle.requested
schedule.lifecycle.approved
schedule.lifecycle.rejected
schedule.lifecycle.activated
schedule.lifecycle.updated
schedule.lifecycle.deleted
schedule.lifecycle.fired
```

Schedule audit records include safe metadata such as `schedule_id`, `origin`, `operation`, `actor`, `approval_level`, `risk`, `payload_hash`, `previous_payload_hash`, `command_id`, and `request_id`. Schedule `content` is not exposed in runtime snapshots or schedule list output.

## GitHub write audit

`github.write` is audited through the normal Approval Gate and executor feedback chain:

- HDS decision log records the inbound request and ASSERT.
- `approval_gate` / `authority_event` records `operation=github.write`, `approval_level=L3_final_review`, risk, actor, and authority trace.
- `command_lifecycle` records pending/approved/rejected transitions.
- `executor_feedback` records status, error if any, metrics, and a digest of the bounded result object.

The tool result includes `result_digest`, GitHub request metadata, and safe issue/PR/comment ids or URLs. `GITHUB_TOKEN` is never written to audit output or tool result output.

## Google read audit

`gmail.read`, `google.calendar.read`, and `google.drive.read` are audited through the normal Approval Gate and executor feedback chain:

- Approval records credential-access context when OAuth token capabilities are present.
- Tool results include bounded summaries/metadata and `result_digest`.
- Executor feedback records status, error if any, metrics, and a digest of the bounded result object.
- Daily Brief Google source records the dynamic cron `payload_hash` and `blue_tanuki.cron.content_source=google_read`.

OAuth access tokens are never written to audit output, runtime snapshots, schedule snapshots, or tool result output.

## Google write audit

`gmail.write`, `google.calendar.write`, and `google.drive.write` are audited through the normal Approval Gate and executor feedback chain:

- `approval_gate` / `authority_event` records `operation=google.write`, `approval_level=L3_final_review`, risk, actor, and authority trace.
- `command_lifecycle` records pending/approved/rejected transitions.
- `executor_feedback` records status, error if any, metrics, and a digest of the bounded result object.
- Tool results include Google ids/URLs where returned, mutation status, request metadata, and `result_digest`.

OAuth access tokens and full request bodies are never written to audit output or tool result output. Calendar writes force `sendUpdates=none`; attendee invites, Drive delete/share, and autonomous cross-service actions are outside this phase.

## Channel delivery audit compatibility

Slack / Discord / Teams / LINE delivery failures are returned to executor feedback as typed downstream results:

- `error_kind`: `recoverable` or `non_recoverable`
- `error_code`: bounded machine-readable error code
- `retry_after_ms`: present when a rate-limit/backoff hint is known
- `next_action`: owner-facing remediation text

These fields are audit evidence only. They never feed back into HDS-BRAIN as authority and never let channel metadata escalate permissions.

## F-reference memory audit

HDS long-term memory references are rendered as `F:<id>`.

- Memory writes record a `memory_reference` audit event with `event=memory.write`.
- Memory reads appear in `DecisionLog.frame.memory_trace.hits[]` with `f_reference`.
- Control Center `/authority/trace` may display safe `memory_reference` items.
- `used_for_authority` is always `false`.
- F-references are trace labels only. They do not grant permission, owner consent, or privileged-action approval.

## What is not treated as authority

- LLM output
- session history
- semantic memory summary
- F-reference / HDS long-term memory hit
- downstream executor feedback
- complete history replay/export material
- runtime invariants evidence
