# Phase 11-S12 - Plugin Review Gate Implementation

## Objective

Implement the Layer B Plugin Review Gate so plugin / skill / third-party adapter submissions can be statically reviewed before acceptance, while bundled workspace packages receive a basic non-submission check before plugin entry import.

## Implemented Surface

- `apps/gateway/src/plugin_review_gate.ts` implements `reviewPluginPackage()` and `assertPluginReviewAccepted()`.
- `scripts/plugin_review_gate.ts` exposes:

```bash
pnpm plugin:review -- --package <plugin-package-dir>
pnpm plugin:review -- --package packages/channel-slack --bundled
```

- `apps/gateway/src/plugin_loader.ts` runs bundled review before importing workspace plugin entries.
- `apps/gateway/test/plugin_review_gate.test.ts` covers accept/reject paths.

## Submission Requirements

Layer B submission mode requires `blue-tanuki.review.json` with:

- `schema_version: 1`
- `layer: "B"`
- `support_status`
- conformance evidence
- audit evidence
- safety evidence
- disable/revoke evidence
- failure modes with owner next action
- `external_dynamic_imports: false`
- `hot_reload: false`
- final-review capability declaration for privileged capabilities

## Reject Boundary

The gate rejects:

- missing or invalid package metadata
- invalid manifest schema
- manifest/package name, version, or entry drift
- entry or config schema paths escaping the package boundary
- wildcard capabilities
- unsupported capability prefixes
- `kind=core` Layer B submissions
- lifecycle install/package scripts
- runtime dynamic import
- forbidden WhatsApp-specific routes or final-review bypass claims
- missing review evidence for conformance, audit, safety, disable/revoke, failure modes, dynamic-import denial, hot-reload denial, or final-review capability declaration

## Safety Boundary

Plugin Review Gate is static review evidence only. It does not import or execute submission entry points.

Results include:

- `used_for_authority=false`
- `layer_b_review_used_for_authority=false`

Passing review does not approve operations, classify risk, substitute HDS-BRAIN, bypass Approval Gate, mutate Runtime Invariants, write audit decisions, or promote preview status.

## Operator Usability

Text output lists each check as PASS/FAIL and prints the review digest. JSON output is available through `--json` for local automation or future review tooling.

## Release Integration

Phase 11-S12 updates:

- `docs/PLUGIN_REVIEW_GATE.md`
- `docs/CONFORMANCE.md`
- `docs/CAPABILITY_ENVELOPE.md`
- `docs/SKILL_LOADER_CONTRACT.md`
- `docs/v1.0-release-candidate.md`
- `docs/v1.0-post-rc-closure-review.md`
- `apps/gateway/src/doctor.ts`
- `scripts/validate_packaging.ts`
- release bundle create/verify required paths

## Validation

Required validation includes:

- `pnpm test -- apps/gateway/test/plugin_review_gate.test.ts apps/gateway/test/plugin_loader.test.ts`
- `pnpm plugin:review -- --package packages/channel-slack --bundled`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm docs:check`
- `pnpm validate:packaging`
- `pnpm run doctor`
- `pnpm release:bundle -- --dry-run`
- `pnpm release:bundle`
- `pnpm release:verify`

## Next Phase

Active execution lane advances to Phase 11-S13 v1.0 GA Promotion Execution.
