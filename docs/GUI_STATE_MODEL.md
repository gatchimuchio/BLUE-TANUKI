# GUI State Model

## 1. State Classes

| Class | Source | Use |
|---|---|---|
| RuntimeState | `/runtime/snapshot` | gateway readiness, invariants, schedules, first-run next action |
| ApprovalState | `/approval` | pending approvals, risk, ApprovalLevel, final-review status |
| AuditState | `/audit/dump` | audit chain validity and digest metadata |
| AuthorityTraceState | `/authority/trace` | request/command authority events |
| NotificationState | `/notifications` | display-only operator alerts |
| HistoryReplayState | `/history/replay` | digest/metadata replay entries |
| LocalUiState | sessionStorage, localStorage, active tab, token input fields, mascot preference fields | display convenience only |
| AotanuMascotState | RuntimeState projection in Control Center UI | display-only mascot animation state |

## 2. Local UI State Rule

Local UI state may remember selected screen and token input values in browser session storage. It may remember display-only mascot preferences in browser local storage.

Local UI state must not:

- approve an operation
- infer consent
- persist credentials as product state
- rewrite policy
- update audit/history
- affect HDS-BRAIN judgement

## 2.1 Aotanu Mascot State Rule

`AotanuMascotState` is a Control Center display projection only.

States:

- `idle`
- `walk`
- `working`
- `happy`
- `error`

Mapping is performed in the WebChat Control Center UI from read-only runtime snapshot fields. The mascot may show readiness, pending work, success, or action-required state, but it must not approve, reject, resume, execute, rewrite policy, or influence HDS-BRAIN judgement.

The mascot is mounted as a root-level floating dock. Its ON/OFF, built-in character, size, and corner placement preferences affect only Control Center rendering.

## 3. Task States

The GUI recognizes these task statuses:

- `pending`
- `running`
- `waiting_approval`
- `blocked`
- `failed`
- `completed`
- `suspended`

The initial UI shows the lane model and existing runtime schedule state. A future task API must preserve the same non-authority UI rule.

## 4. Redaction

The GUI must redact or avoid projecting:

- bearer tokens
- approval tokens except current one-time approval submission handling
- credentials
- raw command content
- raw history payload
- raw tool result
- rendered LLM output content in replay views
