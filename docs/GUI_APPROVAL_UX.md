# GUI Approval UX

## 1. Purpose

Approval UX is the owner-facing final-review surface.

It must answer:

- what action is requested
- why it is needed
- target / scope
- risk
- ApprovalLevel
- final-review status
- expiration
- audit visibility
- recovery / reversibility hints when available

## 2. Allowed Actions

The initial GUI may submit only:

- approve
- reject
- block

These actions go through the existing `/approval/:id` path using:

- `WEBCHAT_RESUME_TOKEN`
- request-bound one-time approval token

## 3. Non-Goals

The GUI must not:

- approve from inbound token alone
- approve without one-time token
- expose approval token outside the request-bound UI action
- allow reusable grants to bypass L3
- treat full access as L3 approval
- edit authority trace fields
- infer approval from checked UI state

## 4. Display Requirements

Approval rows should show:

- command id
- request id
- operation
- risk
- ApprovalLevel
- final-review badge
- expiration
- reason
- redacted authority trace

Raw command content is not required for the initial view and must not appear in replay projections.
