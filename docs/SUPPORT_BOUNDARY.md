# BLUE-TANUKI P12 Support Boundary

This document fixes the v1.0 RC support boundary. It is evidence and operator
guidance only: `used_for_authority=false`. It cannot approve commands, classify
risk, promote preview surfaces, replace HDS-BRAIN, infer consent, or bypass
final review.

## Release State

BLUE-TANUKI is currently `1.0.0-rc.1`.

- `public_claim_allowed=false` until explicit owner GO.
- GA/public complete-superiority claims are not active.
- HDS-BRAIN remains authority.
- LLMs, tools, channels, UI, update flows, plugins, skills, memory, history,
  scheduler, and external APIs remain downstream devices.

## Supported First-Party RC Surface

The supported first-party RC surface is the scope that BLUE-TANUKI owns,
documents, and validates with repository gates:

- HDS-BRAIN authority path, Approval Gate, final-review boundary, Runtime
  Invariants evidence, hash-chain audit, output audit, and complete history
  substrate.
- WebChat Control Center, local gateway HTTP/WS routes, runtime snapshot,
  approval/recovery/update/evidence/settings/About surfaces, and token-gated
  operator controls.
- Telegram as first-party channel.
- Writing / Daily / Developer Operator as first-party Layer A downstream
  operator surfaces.
- GitHub and Google downstream tools when configured by the owner, with
  capability, credential, audit, and L3 final-review boundaries.
- OpenRouter and Composio as optional downstream adapters. They are not
  mandatory infrastructure and are not authority sources.
- Source release bundle, `.sha256` sidecar, `.manifest.json` sidecar,
  unsigned Windows installer package, portable launcher paths, update/rollback
  runbook, and recovery controls.

## Preview / No-Support Boundary

Preview means the adapter or tool exists, but BLUE-TANUKI does not claim full
first-party permanent-use support for the current RC.

- Slack / Discord / Teams / LINE remain `first-party-preview`.
- Browser automation remains disabled-by-default preview.
- Channel promotion requires `pnpm validate:channels`, owner-run credentialed
  live smoke, and recovery evidence.
- Preview status cannot be promoted by README text, Control Center state,
  plugin review, channel metadata, or external service metadata.
- Preview failures do not weaken HDS-BRAIN authority, Approval Gate, audit,
  Runtime Invariants, or final review.

## Reserved / Not Shipped

The following are outside the first-party RC support boundary:

- WhatsApp first-party core support, WhatsApp Web automation, WhatsApp Business
  API support, Twilio WhatsApp support, and WhatsApp-specific hidden hooks.
- Signed native installer.
- Automatic updater.
- Runtime app-file replacement or runtime auto-apply update.
- Public third-party Skill registry.
- Voice, mobile companion app, rich Canvas, and A2UI production surfaces.
- Commercial SaaS operation model.

## Support Escalation Rule

When a support question crosses this boundary, classify it before acting:

| Class | Meaning | Action |
|---|---|---|
| first-party RC | within the supported surface above | troubleshoot with doctor, validate gates, runbooks, and audit evidence |
| preview | implemented but not first-party permanent-use support | keep quarantined; require owner evidence before promotion |
| reserved-third-party | intentionally outside first-party core | do not claim support; use adapter contract only if future owner scope allows |
| not shipped | not implemented in RC | do not document as available; track as future scope only |

No support-path evidence creates authority. All support evidence remains
`used_for_authority=false`.
