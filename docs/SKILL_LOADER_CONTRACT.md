# Skill Loader Contract

## 1. Purpose

Skill Loader Contract defines how Layer B skills are discovered, declared, permissioned, loaded, disabled, and kept downstream-only.

Skills may provide tools, templates, prompts, adapters, or helper workflows. Skills do not create authority.

## 2. Skill Discovery Path

Skills are discovered only from approved workspace package roots or explicitly configured repository-local skill paths.

The loader must not dynamically import arbitrary external npm packages at runtime. External dynamic import is rejected unless a future security phase explicitly changes this policy.

Layer B skill submissions must pass Plugin Review Gate before acceptance:

```bash
pnpm plugin:review -- --package <skill-package-dir>
```

The submitted package must include `blue-tanuki.review.json`, declare `external_dynamic_imports: false`, and declare `hot_reload: false`. Review is static and must not import or execute the skill entry point.

## 3. Skill Manifest Schema

A skill manifest must include:

- name
- version
- kind
- entry point
- description
- capability declarations
- optional credential names
- optional network hosts
- optional filesystem/process scopes
- support status

Missing manifests fail closed.

## 4. Capability Declaration Requirements

Every skill capability must be explicit:

- network hosts
- filesystem roots or prefixes
- process execution requirements
- credential names
- memory read/write/reference needs
- notification or external send needs

Capabilities are reviewed against [Capability Envelope](CAPABILITY_ENVELOPE.md). Undeclared access is denied.

## 5. Sandbox Boundary

Skills execute inside the repository-defined sandbox boundary:

- no implicit filesystem reach
- no implicit network reach
- no implicit shell/process reach
- no implicit credential reach
- no persistent profile or credential reuse
- no channel metadata authority

Sandbox failures must include owner next action.

## 6. Load-Time Permission Enforcement

Permission enforcement happens at load time before the skill can run.

The loader must:

- parse manifest
- validate schema
- compare declared capabilities with allowed envelope
- apply Plugin Review Gate evidence for Layer B submissions
- reject unsupported capability classes
- record review result for doctor/reporting
- fail closed on invalid state

## 7. Runtime Authority Non-Bypass Guarantee

At runtime, a skill must not:

- inject commands into HDS-BRAIN authority
- approve requests
- resume suspended requests
- widen actor/process authority
- treat plugin/skill metadata as authority
- bypass L3 final-review
- bypass audit

Skill output is downstream evidence or content only.

## 8. Skill Disable / Revoke

The loader must support:

- disabling a skill
- revoking a skill capability
- reporting disabled/revoked state
- preserving audit history
- fail-closed behavior after disable

Disable/revoke must not silently remove evidence.

## 9. No Hot-Reload Policy

Skills are boot-time loaded only.

No hot reload is allowed in v1.0 GA because runtime replacement of executable extension code is authority-adjacent and hard to audit.

Changing this policy requires a standalone security phase.

## 10. v1.0 Skill Loader Stability Boundary

This Skill Loader Contract is contract-stable for v1.0 RC.

The stable v1.0 scope is discovery from approved workspace package roots or explicitly configured repository-local skill paths, static manifest parsing, capability comparison against the capability envelope, Plugin Review Gate evidence for Layer B submissions, boot-time loading only, disable / revoke reporting, and fail-closed behavior.

The contract does not include a public third-party Skill registry, automatic network installation, runtime hot reload, external npm dynamic import, or any path where skill output, skill metadata, or review metadata can become authority. Skills remain downstream devices; HDS-BRAIN, Approval Gate, audit, and final-review remain the authority/control boundaries.

Changing this boundary after v1.0 RC requires a dedicated phase because it can alter supply-chain, permission, and runtime replacement guarantees.

## 11. Cross-References

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Plugin HIG](PLUGIN_HIG.md)
- [Adapter Contract](ADAPTER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [Strategy Frame](STRATEGY_FRAME.md)
