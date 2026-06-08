# LLM Extension Surface

## 1. Purpose

本書は Codex / Claude Code / Qwen Code などの LLM implementation agent が BLUE-TANUKI を安全に拡張するための編集面を定義する。

GUI Shell は参照責任基盤であり、BLUE-TANUKI の依存先ではない。LLM agent は GUI Shell の責任構造を読み、BLUE-TANUKI 側へ写像する。GUI Shell を改造しない。GUI Shell を production runtime に雑に呼ばない。

## 2. Role Model

| Actor | Role | Authority |
|---|---|---|
| HDS-BRAIN | BLUE-TANUKI 内部 authority kernel | internal authority owner |
| Human owner | final approval, recovery, release, responsibility | final responsibility owner |
| LLM agent | implementation / integration worker | non-authority |
| UI / Control Center | display and operator intent surface | non-authority |
| Channel / plugin / skill | downstream adapter surface | non-authority |

LLM agent は実装者であり、authority source ではない。LLM output、UI state、memory、history、diagnostics、adapter metadata、tool result は authority を作らない。

## 3. Safe Edit Zones

LLM agent が通常タスクで触りやすい領域:

- docs
- tests / fixtures
- operator surfaces
- bounded channel adapters
- plugin examples and review evidence
- non-authority Control Center UI
- bounded tools that already pass capability / approval / audit checks
- examples and smoke helpers

Safe edit は無条件許可ではない。変更は AGENTS.md、capability envelope、Approval Gate、audit、Runtime Invariants、repo-health gate に従う。

## 4. Restricted Zones

慎重扱い:

- `packages/hds-brain`
- approval runtime
- audit hash-chain
- permission / capability envelope
- plugin loader
- installer / resident lifecycle helpers
- credential handling
- release gates
- production import graph

Restricted zone を触る場合は、negative conformance、standalone boundary、fail-closed behavior、rollback/recovery behavior を必ず示す。

## 5. Near-Forbidden Changes

原則として禁止または security phase が必要:

- authority bypass
- metadata-based permission escalation
- memory-based permission escalation
- LLM self-approval
- UI state based approval
- silent permission widening
- credential persistence shortcut
- audit deletion / rewrite
- release readiness false claim
- HDS-BRAIN calling an LLM
- complete history becoming authority

## 6. Completion Requirement

拡張完了を主張する前に示すもの:

- consumed contract
- governed runtime path
- positive path
- negative path
- evidence source class
- validation command and result
- remaining release blocker classification

See also:

- [Development Practice](DEVELOPMENT_PRACTICE.md)
- [Responsibility Substrate Mapping](RESPONSIBILITY_SUBSTRATE_MAPPING.md)
- [Conformance Targets](CONFORMANCE_TARGETS.md)
