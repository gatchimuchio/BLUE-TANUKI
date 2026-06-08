# BLUE-TANUKI v1.0 RC Claim Boundary

GA promotion note: `pnpm validate:ga` currently treats the repository as
pre-GO ready only. `public_claim_allowed=false` until explicit owner GO is
recorded.

## Claim

BLUE-TANUKI v1.0 RC is a local, owner-operated resident control plane built around **HDS-BRAIN**.

The core claim is not "more channels than OpenClaw."

The core claim is:

```text
No black box in BLUE-TANUKI's HDS authority path.
```

Development-method note: BLUE-TANUKI may use GUI Shell as a reference LLM-readable responsibility substrate for implementation strategy and GUI design. This is not a claim that GUI Shell is a production dependency, an authority source, or a BLUE-TANUKI runtime component.

Meaning:

- actor is resolved as structured data
- process is resolved as structured data
- process authority policy is enforced before command emission
- execution policy is enforced before executor handoff
- approval operation/scope/risk/final-review status is resolved as structured data
- memory hits are traced and explicitly not used for authority escalation
- decisions, approvals, command lifecycle, and executor feedback are recorded in a hash-chain audit log

## Non-claim

BLUE-TANUKI does not claim that the following are internally transparent:

- OS kernel
- network providers
- Telegram / Slack / Discord / Teams / LINE platforms
- LLM providers
- browser engines
- external APIs
- user-provided tools
- GUI Shell

The transparency claim is limited to BLUE-TANUKI's own authority path.

## v1.0 RC Completed Quality

- WebChat Control Center
- HDS Process / Memory / Authority closure
- Approval Gate with final-review boundary
- hash-chain audit
- runtime snapshot
- Telegram channel
- Slack / Discord preview adapters with silent fallback
- Teams / LINE preview adapters with silent fallback
- Daily Brief and generic scheduled-message smoke with optional read-only Google source
- GitHub and Google downstream write tools with L3 final-review
- Distribution readiness gate, update/rollback runbook, and release bundle verification
- v1.0 security and permanent-use review closure

## v1.0 RC Explicit Preview / Deferred

- WhatsApp: reserved-third-party only. BLUE-TANUKI does not ship first-party WhatsApp core support, Baileys/WAHA/WhatsApp Web automation, Business API support, or Twilio WhatsApp support.
- Gmail / Google Calendar / Drive: bounded downstream tools; writes are L3 final-review.
- Teams / LINE: preview channel adapters; first-party promotion waits for owner credentialed live smoke and permanent-use recovery review
- Slack / Discord: release-polished preview adapters; first-party promotion waits for owner credentialed live smoke and permanent-use recovery review
- Browser automation: disabled-by-default preview.
- Signed native installer and automatic updater: not shipped.
- Voice / Mobile: interface/design only, real product quality v0.2+
- Rich Canvas / A2UI: v0.2+
- third-party Skill registry: intentionally excluded
