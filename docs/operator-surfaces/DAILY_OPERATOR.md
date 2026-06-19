# Daily Operator

## 1. Purpose

Daily Operator is the first-party surface for daily operational work: schedule review, Daily Brief, calendar/email/drive read tasks, reminders, and bounded daily write operations.

It is a Layer A surface and does not move authority into cron, Google services, or channel metadata.

Phase 11-S7 implements this surface in `packages/operator-daily/` and exposes its state through the Gateway runtime snapshot and WebChat `/operators/daily` endpoints.

The surface snapshot also exposes `operation_core_projection`, a read-only Operation Core view for Control Center. Contextual Daily Brief send metadata is normalized into a bounded L2 projection while the existing channel path remains downstream-only.

## 2. Scope (in-scope user goals)

- inspect Daily Brief state
- extend Daily Brief with configured Google read sources
- read Gmail, Calendar, and Drive summaries
- list or inspect schedules
- create/update reminders through approved schedule paths
- prepare daily outbound sends through existing channel and Google write tools

## 3. Non-Goals (out-of-scope user goals)

- autonomous calendar or email management
- hidden background mutation
- bypassing schedule final-review
- deleting Drive files or sharing Drive files
- Calendar attendee invite automation
- replacing boot-time Daily Brief env compatibility

## 4. Required Downstream Tools (existing tools)

Daily Operator reuses:

- `cron.process`
- `schedule.list`, `schedule.create`, `schedule.update`, `schedule.delete`
- `gmail.read` / `gmail.write`
- `google.calendar.read` / `google.calendar.write`
- `google.drive.read` / `google.drive.write`
- `channel_send`
- `BLUE_TANUKI_DAILY_BRIEF_*` env configuration

## 5. Approval Levels per Operation (L1/L2/L3 ApprovalLevel + ApprovalRisk)

| Operation | ApprovalLevel | ApprovalRisk | Notes |
|---|---|---|---|
| Daily Brief status view | L1_observe | low | metadata only |
| Gmail / Calendar / Drive read | L1_observe | low | bounded summaries only |
| schedule.list | L1_observe | low | safe metadata only |
| reminder draft or local note | L2_operate | medium | no future execution until approved |
| schedule.create/update/delete | L3_final_review | high | future action mutation |
| Gmail / Calendar / Drive write | L3_final_review | high | external write |
| Daily Brief channel send | existing channel approval path | medium/high by context | downstream only |

## 6. Audit Trace Requirements (authority trace items)

Daily operations must record:

- `surface=daily`
- schedule id and payload hash, never schedule content in snapshots
- selected Google service and bounded result digest
- Daily Brief source fingerprint
- channel target summary for sends
- ApprovalLevel / ApprovalRisk / final-review result

## 7. Failure Modes (owner next action)

- Daily Brief disabled: enable `BLUE_TANUKI_DAILY_BRIEF_ENABLED`
- target missing: set `BLUE_TANUKI_DAILY_BRIEF_TARGET`
- Google token missing: configure read-only or service-specific token
- malformed schedule JSON: fix or remove `BLUE_TANUKI_SCHEDULES_JSON`
- schedule approval pending: approve or reject through Approval Gate
- external write failure: inspect typed error and audit before retry

## 8. Layer Boundary (Layer A vs Layer B)

Daily Operator is Layer A. Layer B plugins may add source adapters or formatting helpers, but cannot schedule future actions, send externally, or use Google metadata as authority without the shared substrate and review gates.

## 9. Shared Substrate Usage

Daily Operator uses the shared substrate for:

- non-human cron actor containment
- schedule Approval Gate mapping
- Google tool downstream execution
- Daily Brief audit trace
- Operation Core projection
- Runtime Invariants preservation

## 10. Conformance Test Requirements (Phase 11-S7 target)

Phase 11-S7 must add tests for:

- Daily surface registration
- backward-compatible `BLUE_TANUKI_DAILY_BRIEF_*` env use
- L1 read paths
- L3 schedule mutation paths
- Google read/write approval separation
- Daily Brief payload hash and no content exposure
- final-review bypass denial

Implementation evidence:

- `packages/operator-daily/test/daily.test.ts`
- `packages/hds-brain/test/operator_surface.test.ts`
- `packages/channel-webchat/test/webchat.test.ts`
- `apps/gateway/test/plugin_loader.test.ts`

## 11. Cross-References

- [Shared Substrate](SHARED_SUBSTRATE.md)
- [Configuration](../../CONFIG.md)
- [Credential Readiness Matrix](../CREDENTIAL_READINESS_MATRIX.md)
- [Conformance](../CONFORMANCE.md)
- [Runtime schedule tests](../CONFORMANCE.md#runtime-automation-tests)
- [Phase 11-S7 Daily Operator Implementation](../phase11-s7-daily-operator.md)
