# BLUE-TANUKI P13 Owner GO Readiness

P13 is the product release decision boundary. Current state is
`PENDING_OWNER_GO`, not GA.

This document is evidence and operator guidance only: `used_for_authority=false`.
It cannot approve commands, classify risk, promote preview surfaces, replace
HDS-BRAIN, infer consent, activate public claims, or bypass final review.

## Current Machine State

Expected pre-GO machine state:

```txt
status=pre_go_ready
owner_go=pending
public_claim_allowed=false
package_version=1.0.0-rc.1
```

Actual `1.0.0` promotion remains blocked until owner GO evidence exists and the
workspace is intentionally promoted.

## P13 Criteria

| Criterion | Current state | Evidence path |
|---|---|---|
| Linux local validation full PASS | required before GO | owner/Codex local validation report |
| `validate:product` full PASS | local Linux PASS with Windows-only checks skipped on Linux | `pnpm validate:product -- --phase P13` |
| Windows実機E2E PASS + evidence pack | still required before GO | owner-run Windows evidence pack |
| D1-D8 decision record | present | `docs/product-owner-decisions.md` |
| preview exclusion / first-party scope | preserved | `docs/SUPPORT_BOUNDARY.md`, `docs/KNOWN_LIMITATIONS.md`, compatibility matrix |
| release bundle + sha256 + manifest | generated and verified by release validation | `pnpm release:bundle`, `pnpm release:verify` |
| owner decision record | absent / pending | `docs/ga-owner-decision.json` |
| version decision | RC remains active | `package.json`, D2 |
| release notes | RC notes present | `docs/release-notes/1.0.0-rc.1.md` |

## GO Blockers

P13 cannot be reported as GA complete until all of the following are true:

- owner records explicit GO;
- `docs/ga-owner-decision.json` exists and passes schema validation;
- package version is intentionally promoted according to D2;
- `pnpm validate:ga -- --require-owner-go` passes;
- Windows実機E2E evidence pack is reviewed;
- owner credentialed live smoke / redaction evidence is reviewed for any
  external surfaces being claimed;
- release bundle is regenerated after final claim/version changes and verified;
- README / QUICKSTART / CLAIM public wording is updated only after GO.

## Fail-Closed Rule

If owner GO evidence is absent, ambiguous, malformed, or inconsistent with the
workspace version, the correct state is:

```txt
PENDING_OWNER_GO
public_claim_allowed=false
```

Do not infer GO from passed tests, generated bundles, docs presence, remote
runner status, operator convenience, or LLM output.
