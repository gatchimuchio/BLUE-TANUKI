# Responsibility Substrate Mapping

## 1. Purpose

GUI Shell の LLM-readable responsibility substrate を BLUE-TANUKI へ写像するための対応表を固定する。

本書は GUI Shell のコード移植指示ではない。GUI Shell は参照実装 / 責任構造 / LLM-readable substrate であり、BLUE-TANUKI はその責任構造を HDS-BRAIN authority の下で実証する本命 product である。

## 2. Concept Mapping

| GUI Shell concept | BLUE-TANUKI mapping | Boundary |
|---|---|---|
| Shell Core | HDS-BRAIN + gateway policy | HDS-BRAIN owns authority |
| Runtime | BLUE-TANUKI resident process | runtime is observable, not authority |
| Adapter | channel / plugin / operator boundary | metadata cannot grant authority |
| Permission | capability envelope | deny by default |
| Approval | Approval Gate | L3 final-review non-bypassable |
| Audit | hash-chain audit + output audit + complete history | evidence, not fallback authority |
| Recovery | doctor / runbook / failure memory | next action, not hidden auto-fix |
| Content exposure | history / output projection boundary | digest/metadata by default |
| Evidence Center | repo-health / GA gate / release verify | evidence class must be explicit |
| GUI operation surface | Control Center | display and intent only |

## 3. Sensitive Action Mapping

Every sensitive action must map to:

```txt
Capability
  -> Permission / envelope
  -> ApprovalLevel / final-review
  -> AuditEvent / digest
  -> RecoveryAction / next action
```

Missing mapping means the action is incomplete. Unknown or ambiguous mapping must not auto-allow.

## 4. Non-Authority Sources

The following may inform UI, diagnostics, replay, or implementation context, but cannot create authority:

- LLM output
- UI state
- adapter metadata
- channel metadata
- plugin metadata
- memory
- complete history
- session history
- tool result
- diagnostic result
- previous state
- release claim text

## 5. Product Direction

BLUE-TANUKI GUI is the owner-facing AI operations control center:

- state visibility
- approval queue clarity
- audit and replay evidence
- recovery next action
- channel / skill status
- credential readiness
- release / conformance evidence

The GUI may make operation comfortable. It must not hide or replace authority.
