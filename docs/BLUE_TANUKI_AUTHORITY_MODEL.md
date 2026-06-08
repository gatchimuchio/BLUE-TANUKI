# BLUE-TANUKI Authority Model

## 1. Core Statement

HDS-BRAIN owns BLUE-TANUKI internal authority. Human owner retains final approval, recovery, release, and responsibility authority.

LLM agents, LLM backends, UI, channels, plugins, skills, memory, history, diagnostics, tools, and external services are downstream only.

## 2. Authority Layers

| Layer | Responsibility | Must not do |
|---|---|---|
| HDS-BRAIN | actor/process/boundary judgement, policy, Runtime Invariants, fail-safe suspend | call LLM, trust metadata, fall back to downstream authority |
| Approval Gate | approval mode, ApprovalLevel, final-review enforcement | let full access or reusable grants bypass L3 |
| Gateway | normalize inbound, connect downstream devices, expose read-only projections | use raw invalid input for execution, own authority |
| Executor / tools | execute command envelopes after HDS/approval | create or override authority |
| Control Center | display state and collect explicit owner intent | infer consent or approve by UI state |
| Human owner | final review, recovery, release GO | delegate final responsibility to LLM output |

## 3. Final-Review Boundary

L3 final-review remains required for privileged operations, including shell execution, file deletion, external sends, credential access, schedule mutations, settings writes, GitHub writes, Google writes, destructive browser automation, policy updates, detector updates, approval updates, and unknown/unclassified tool calls.

Full access may reduce friction for L1/L2. It cannot bypass L3.

## 4. Fail-Safe

Unknown, ambiguous, detector-conflict, missing capability, policy-version mismatch, invalid approval, failed Runtime Invariant, broken audit chain, or HDS self-health failure resolves to fail-closed behavior or `SUSPEND`.

Fail-safe suspension is not repaired by approval alone. Repair the failed precondition and retry through the normal authority path.

## 5. GUI Consequence

BLUE-TANUKI GUI may show:

- runtime status
- pending approvals
- action risks
- audit digests
- replay metadata
- recovery instructions
- conformance / release gates

BLUE-TANUKI GUI must not show or create:

- approval tokens except request-bound one-time UI handling
- credentials
- raw history payloads
- raw command content in replay views
- authority derived from UI state
- release readiness without evidence
