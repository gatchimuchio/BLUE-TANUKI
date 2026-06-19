# Shared Operator Substrate

## 1. Purpose

This document defines the substrate shared by Writing Operator, Daily Operator, and Developer Operator.

The substrate is not a fourth surface. It is the common Layer A control path all first-party surfaces must use.

Operation Core はこの shared substrate の構造化 IR である。Writing / Daily / Developer / future surfaces は surface 固有の操作名を持ってよいが、通常 UI と planner は `OperationRequest` / `OperationPlan` / `OperationExecutionResult` へ投影できる形を保つ。

## 2. Scope (in-scope user goals)

The shared substrate supports:

- deterministic HDS-BRAIN authority decisions
- operation-level Approval Gate evaluation
- OperationRequest / OperationPlan projection
- hash-chain audit trace
- Runtime Invariants visibility
- downstream channel and tool execution

## 3. Non-Goals (out-of-scope user goals)

- direct LLM authority
- direct plugin authority
- raw filesystem, shell, network, credential, or external-write access
- raw command strings as the operation authority object
- surface-specific product UX
- replacing surface-specific conformance tests

## 4. Required Downstream Tools (existing tools)

The substrate connects surfaces to existing downstream tools only:

- LLM downstream route
- `file.*`
- `shell.*`
- `github.read` / `github.write`
- `gmail.*`
- `google.calendar.*`
- `google.drive.*`
- `cron.process`
- `schedule.*`
- `channel_send`
- `browser.*` preview tools

## 5. Approval Levels per Operation (L1/L2/L3 ApprovalLevel + ApprovalRisk)

The substrate does not invent a new approval model. It requires every surface operation to declare:

- operation id
- target scope
- ApprovalRisk
- ApprovalLevel
- final-review requirement where applicable

L3 final-review cannot be bypassed by full access, reusable grants, surface routing, plugin metadata, or channel metadata.

## 6. Audit Trace Requirements (authority trace items)

The shared audit trace must include:

- surface name
- operation id
- Operation Core plan or step id where available
- downstream tool command
- approval context
- authority trace
- result digest for write or external actions
- failure classification and owner next action

## 7. Failure Modes (owner next action)

The substrate must fail closed when:

- capability is missing
- approval is missing
- credential is missing
- sandbox root is missing
- external target is not allowlisted
- Runtime Invariants are unhealthy

Each failure must include a bounded owner next action.

## 8. Layer Boundary (Layer A vs Layer B)

The shared substrate is Layer A. Layer B can extend a first-party surface through plugin contracts, but cannot replace the substrate, inject authority, or widen a first-party capability without review.

## 9. Shared Substrate Usage

Writing, Daily, and Developer surfaces must route through:

- HDS-BRAIN authority path
- Approval Gate
- audit hash-chain
- Runtime Invariants
- downstream adapter/tool dispatch

They must not call an LLM or external service as authority.

Shell execution, browser automation, Composio execution, OS-specific launchers, and other process/API mechanisms are Execution Adapters. They are not the substrate itself and must carry `adapter_is_authority=false` / `adapter_result_used_for_authority=false` when represented through Operation Core.

## 10. Conformance Test Requirements (Phase 11-S6/S7/S8 target)

Implementation phases must test:

- HDS-BRAIN does not call LLM
- memory remains non-authority
- metadata cannot escalate authority
- L3 remains non-bypassable
- audit trace remains hash-chain compatible
- declared capabilities match used downstream tools

## 11. Cross-References

- [Operator Surfaces Index](INDEX.md)
- [Operation Core Architecture](../OPERATION_CORE_ARCHITECTURE.md)
- [Security Model](../../SECURITY.md)
- [Audit](../../AUDIT.md)
- [Capability Envelope](../CAPABILITY_ENVELOPE.md)
- [Conformance](../CONFORMANCE.md)
- [Strategy Frame](../STRATEGY_FRAME.md)
