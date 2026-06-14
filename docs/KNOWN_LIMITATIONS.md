# BLUE-TANUKI v1.0 RC Known Limitations

This document records known RC limitations and residual evidence gaps. It is a
support and release-claim boundary, not a defect waiver and not authority:
`used_for_authority=false`.

## Claim / Release Limitations

- The workspace remains `1.0.0-rc.1`, not GA.
- `public_claim_allowed=false` until explicit owner GO.
- Public complete-superiority claims remain blocked until P13.
- `pnpm validate:ga` can report pre-GO readiness, but that is not owner GO.

## Platform Evidence Limitations

- Linux validation is the primary local evidence in this environment.
- Windows実機E2E evidence remains required before GA.
- Windows installed-app smoke is registered in `validate:product`, but is
  skipped on non-Windows platforms.
- Windows実機GUI manual update / rollback evidence remains a P13 or owner-run
  evidence item.

## Credentialed External Surface Limitations

- Owner credentialed live smoke for Slack / Discord / Teams / LINE remains
  required before any first-party promotion.
- Missing external credentials are a valid skip path, not proof of live
  platform delivery.
- GitHub, Google, OpenRouter, and Composio behavior depends on owner-provided
  credentials and external providers. Their metadata is never authority.

## Update / Rollback Limitations

- P11 adds release sidecar verification, pre-update recovery backup, and
  rollback-plan evidence.
- Actual manual replacement after prepared update is operator-run and has not
  been auto-executed by the runtime.
- Automatic updater is not shipped.
- Runtime app-file replacement / runtime auto-apply update is not shipped.
- Future migration schema support is not implemented beyond the current
  observed manifest/data schema boundary.
- Signed native installer and signing pipeline are not shipped.

## Preview / Reserved Limitations

- Slack / Discord / Teams / LINE remain `first-party-preview`.
- Browser automation remains disabled-by-default preview.
- WhatsApp remains `reserved-third-party` with no first-party core support and
  no warranty.
- Voice, mobile, rich Canvas, A2UI, and public third-party Skill registry are
  outside the current RC.

## Support Boundary

See [SUPPORT_BOUNDARY.md](SUPPORT_BOUNDARY.md) for the authoritative P12
support boundary. If this document and support wording elsewhere conflict,
apply the stricter interpretation that preserves HDS-BRAIN authority, preview
quarantine, auditability, recovery, release-gate integrity, and operator
safety.
