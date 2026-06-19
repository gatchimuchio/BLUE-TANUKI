# GUI Product Spec

## 1. Product Role

BLUE-TANUKI GUI is the owner-facing AI operations control center.

It is not decoration and not a chatbot clone. It lets the human owner inspect and operate:

- runtime state
- HDS-BRAIN decisions
- Operation Core projections
- approval queue
- audit and replay evidence
- memory references
- skills / plugin review state
- channel readiness
- doctor / recovery next action
- settings readiness
- developer / release evidence

## 2. Core Principle

```txt
GUI renders state and collects explicit owner intent.
GUI does not own authority.
```

Sensitive actions remain HDS-BRAIN / Approval Gate / audit / recovery mapped.

## 3. Initial Screens

1. Home / Tanuki Dashboard
2. Tasks
3. Approvals
4. Activity / Audit
5. Memory
6. Skills
7. Channels
8. Doctor
9. Settings
10. Developer / Evidence

## 4. Supported Initial Implementation

Current implementation is a WebChat Control Center HTML shell served at `/` and `/app`.

The first GUI implementation adds:

- screen navigation
- owner operations dashboard
- Operation Core Plan viewer from `operator_surfaces.*.operation_core_projection`
- responsibility map
- task state lane
- memory / skills / channel / doctor / settings / evidence placeholders
- existing runtime / notification / approval / schedule / history / audit / authority API panels

Backend behavior is not expanded by this phase.

## 5. Safety Requirements

- UI state is not authority.
- LLM output is not authority.
- memory is not authority.
- channel metadata is not authority.
- human owner approval is required for sensitive actions.
- display projections must redact tokens, credentials, raw payloads, command content, and rendered output content.
- Operation Core projections remain `ui_projection_used_for_authority=false` and cannot approve, execute, or replace HDS-BRAIN judgement.
