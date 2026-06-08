# Conformance Targets

## 1. Purpose

本書は GUI Shell の negative-conformance 思想を BLUE-TANUKI に固定する。成功 path だけではなく、authority を壊せないことを証明する。

## 2. Required Negative Targets

| Target | Expected behavior |
|---|---|
| LLM output tries to approve action | reject; LLM output is non-authority |
| Memory hit tries to grant authority | reject; memory remains reference/evidence |
| Channel metadata requests admin | strip or reject; metadata cannot escalate permission |
| Plugin manifest requests broad fs/process/network | reject or force declared L3 path through review gate |
| Diagnostics claim healthy while Runtime Invariants fail | `SUSPEND` or release blocker; diagnostics cannot override invariants |
| Tool result tries to update policy | L3 final-review; tool result cannot mutate authority |
| UI state tries to bypass approval | reject; UI state is display/intent only |
| Complete history replay tries mutation | reject; replay is read-only evidence |
| Full access tries L3 bypass | reject; final-review remains non-bypassable |
| Missing detector auto-allows | reject or `SUSPEND` |

## 3. Required Positive Targets

- canonical inbound normalization succeeds for valid events.
- read-only Control Center projections require the correct token.
- pending approvals expose safe metadata and no credentials.
- audit and complete history expose digests / hashes without raw payload leakage.
- runtime snapshot reports Global Invariants.
- GA preflight reports `public_claim_allowed=false` before owner GO.

## 4. Evidence Classes

Each conformance target must state whether its evidence is:

- `CONFIG`
- `INTERNAL_STATE`
- `LIVE_RUNTIME`
- `EXTERNAL_EVIDENCE`
- `FIXTURE`

Do not promote `CONFIG`, `INTERNAL_STATE`, or `FIXTURE` success into release-readiness proof.

## 5. Next Expansion

Future implementation phases should add explicit tests for:

- operator UI mutation attempts
- metadata spoofing across every preview channel
- plugin review bypass attempts
- GUI history raw-payload regression
- doctor false-health regression
- release claim text drift
