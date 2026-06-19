# Writing Operator

## 1. Purpose

Writing Operator is the first-party surface for drafting, editing, proofreading, summarizing, and translating text under HDS-BRAIN authority.

It is a Layer A surface and a downstream device, not an authority source.

Phase 11-S6 implements this surface in `packages/operator-writing/` and exposes its state through the Gateway runtime snapshot and WebChat `/operators/writing` endpoints.

The surface snapshot also exposes `operation_core_projection`, a read-only Operation Core view for Control Center. This projection is display-only (`ui_projection_used_for_authority=false`) and does not approve, execute, or replace HDS-BRAIN judgement.

## 2. Scope (in-scope user goals)

- draft text
- rewrite or proofread owner-provided text
- summarize local or owner-provided content
- translate text
- prepare outbound writing for later final review
- write bounded local files through existing file tools
- prepare Google/Gmail write operations through existing downstream tools

## 3. Non-Goals (out-of-scope user goals)

- autonomous publishing
- bypassing file sandbox roots
- bypassing Google or Gmail final-review
- direct raw file access
- replacing the LLM provider registry
- becoming a public document editor or SaaS workflow

## 4. Required Downstream Tools (existing tools)

Writing Operator reuses:

- LLM downstream command route for drafting/editing
- `file.search`, `file.write`, and `file.edit`
- `gmail.write` for draft/send paths
- `google.drive.write` for bounded document-like file creation/update
- `channel_send` for owner-visible responses

No new raw filesystem, network, or credential capability is introduced in Phase 11-S6.

## 5. Approval Levels per Operation (L1/L2/L3 ApprovalLevel + ApprovalRisk)

| Operation | ApprovalLevel | ApprovalRisk | Notes |
|---|---|---|---|
| local draft in memory | L1_observe | low | no durable side effect |
| summarize / proofread owner-provided text | L1_observe | low | no durable side effect |
| read owner-selected file through `file.search` / read path | L1_observe | low | sandbox applies |
| write or edit sandboxed local file | L2_operate | medium | existing file tool boundary applies |
| Gmail draft/send | L3_final_review | high | external write |
| Google Drive write/update | L3_final_review | high | external write |

## 6. Audit Trace Requirements (authority trace items)

Writing operations must record:

- `surface=writing`
- source type: prompt, selected file, or provided text
- downstream tool name
- LLM input/output digest where LLM is used
- file path hash or bounded path metadata for file writes
- external target summary for Gmail/Drive writes
- ApprovalLevel / ApprovalRisk / final-review result

## 7. Failure Modes (owner next action)

- missing LLM provider: configure provider or use stub
- file root unset: set `BLUE_TANUKI_FILE_ROOT`
- sandbox denial: choose a path under the configured root
- Gmail/Drive token missing: configure OAuth token
- L3 approval missing: approve through Approval Gate or cancel
- external API error: check provider state and audit before retry

## 8. Layer Boundary (Layer A vs Layer B)

Writing Operator is Layer A. Layer B plugins may add templates, style packs, import/export helpers, or format adapters, but may not publish externally, widen file roots, or bypass final-review.

## 9. Shared Substrate Usage

Writing Operator uses the shared substrate for:

- HDS-BRAIN decision
- Approval Gate mapping
- audit trace
- Operation Core projection
- Runtime Invariants
- downstream tool dispatch

## 10. Conformance Test Requirements (Phase 11-S6 target)

Phase 11-S6 must add tests for:

- Writing surface registration
- L1 in-memory draft path
- L2 sandboxed file write path
- L3 Gmail/Drive write path
- LLM digest audit trace
- final-review bypass denial
- capability envelope preservation

Implementation evidence:

- `packages/operator-writing/test/writing.test.ts`
- `packages/hds-brain/test/operator_surface.test.ts`
- `apps/gateway/test/plugin_loader.test.ts`
- `packages/channel-webchat/test/webchat.test.ts`

## 11. Cross-References

- [Shared Substrate](SHARED_SUBSTRATE.md)
- [Capability Envelope](../CAPABILITY_ENVELOPE.md)
- [Conformance](../CONFORMANCE.md)
- [Security](../../SECURITY.md)
- [Configuration](../../CONFIG.md)
- [Phase 11-S6 Writing Operator Implementation](../phase11-s6-writing-operator.md)
