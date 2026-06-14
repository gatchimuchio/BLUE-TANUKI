# Plugin Review Gate

## 1. Purpose

Plugin Review Gate defines the Layer B acceptance boundary for plugins, skills, and third-party adapters.

It prevents third-party extension code from becoming practical authority through undeclared capability, hidden side effects, metadata escalation, or audit gaps.

## 2. Submission Package Requirements

A submission must include:

- plugin or skill manifest
- declared capabilities
- entry point and package metadata
- conformance tests
- audit trace description
- failure modes with owner next action
- explicit preview / first-party-preview / first-party target status

Submissions without a manifest or conformance tests are rejected.

## 3. Manifest Review Criteria

The manifest must declare:

- stable name and version
- plugin / skill / adapter kind
- entry point
- capability list
- credential names, if any
- network hosts, if any
- filesystem/process requirements, if any
- support status

Manifest drift from package metadata is a review failure.

## 4. Capability Review Criteria

Capabilities are deny-by-default.

Review must reject:

- undeclared network access
- undeclared filesystem access
- undeclared process access
- undeclared credential access
- wildcard capabilities without explicit phase approval
- capability use that exceeds the stated support status

Declared capability is not authority. It only describes the maximum downstream action shape that still must pass HDS-BRAIN, Approval Gate, and audit.

## 5. Audit Compatibility Review

A plugin must preserve audit compatibility:

- request id is traceable
- operation is traceable
- declared capability is traceable
- ApprovalLevel and ApprovalRisk are traceable where applicable
- external writes record safe result digests
- failures include typed status and owner next action

If audit trace cannot explain what happened, whether anything changed, and what the owner should do next, the plugin is rejected.

## 6. HDS Authority Non-Bypass Review

Review must prove the plugin cannot:

- call an LLM from the authority path
- inject authority into HDS-BRAIN
- bypass Approval Gate
- treat channel, plugin, skill, tool, memory, or external metadata as authority
- resume, approve, or execute privileged operations on its own
- widen Layer A capability through Layer B metadata

Authority bypass attempts are hard reject.

## 7. Rejection Criteria

Reject any submission that includes:

- agent-driven authority path
- undeclared capability use
- hidden side effects
- audit-invisible mutation
- final-review bypass
- external metadata authority escalation
- emotion functionality
- 5-minute setup guarantee claims
- public third-party Skill registry assumptions
- WhatsApp unofficial routes: Baileys, WAHA, WhatsApp Web automation
- first-party WhatsApp Business API or Twilio WhatsApp claims

## 8. Promotion Criteria (preview -> first-party-preview / first-party)

Preview may be accepted only when it is quarantined, documented, and fail-closed.

First-party-preview requires:

- conformance tests
- typed failure modes
- credential skip path and credential path
- audit compatibility
- no authority escalation

First-party requires:

- owner-run live smoke where relevant
- permanent-use recovery review
- compatibility matrix update
- docs and setup closure
- no unresolved preview-only safety boundary

## 9. Disable / Revoke Path

Every accepted plugin must have a disable/revoke path:

- disable without deleting audit history
- revoke capability without widening other plugins
- fail closed after disable
- report owner next action through doctor or equivalent review output

Runtime disable is allowed only if it does not create hot authority mutation. Hot-reload remains out of scope unless a future security phase changes the policy.

## 10. Implemented Gate

Phase 11-S12 implements the static Plugin Review Gate in `apps/gateway/src/plugin_review_gate.ts` and exposes it through:

```bash
pnpm plugin:review -- --package <plugin-package-dir>
pnpm plugin:review -- --package packages/channel-slack --bundled
```

Default mode is Layer B submission review. `--bundled` is for repository-bundled packages and performs the basic manifest/package/capability/rejected-scope checks before workspace plugin loading. The gate never imports the plugin entry point during review.

Layer B submissions must include `blue-tanuki.review.json` with:

- `schema_version: 1`
- `layer: "B"`
- `support_status: "preview" | "first-party-preview" | "first-party"`
- conformance evidence
- audit evidence
- safety evidence
- disable/revoke evidence
- failure modes with owner next action
- `external_dynamic_imports: false`
- `hot_reload: false`
- explicit final-review capability declaration when privileged capabilities are requested

The implementation rejects wildcard capabilities, package/manifest drift, lifecycle install scripts, core-kind Layer B submissions, forbidden WhatsApp-specific routes, final-review bypass claims, and no external npm dynamic import is allowed at runtime.

Plugin Review Gate result is review evidence only. Results carry `used_for_authority=false` and `layer_b_review_used_for_authority=false`; they do not approve, execute, classify risk, substitute HDS-BRAIN, bypass Approval Gate, or promote preview support status.

## 11. v1.0 Layer B Stability Boundary

API stability: contract-stable for v1.0 RC.

The v1.0 Layer B scope is deliberately limited to:

- static manifest review;
- bundled package review before workspace plugin loading;
- Layer B submission review through `blue-tanuki.review.json`;
- skill loader contract enforcement;
- capability declaration checks;
- no external npm dynamic import at runtime;
- no hot reload;
- disable / revoke evidence requirements;
- explicit preview / first-party-preview / first-party support status review.

The v1.0 boundary is not a public marketplace promise. It does not claim a public third-party Skill registry, automatic plugin installation, automatic promotion, hot runtime replacement, or review results as authority. HDS-BRAIN, Approval Gate, audit, final-review, and Runtime Invariants remain Layer A authority/control boundaries.

Changing this contract after v1.0 RC requires a dedicated phase because it can alter extension supply-chain, permission, and audit expectations.

## 12. Cross-References

- [Plugin HIG](PLUGIN_HIG.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)
- [Adapter Contract](ADAPTER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [Strategy Frame](STRATEGY_FRAME.md)
- [AGENTS.md](../AGENTS.md)
