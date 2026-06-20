# BLUE-TANUKI Channel Readiness Matrix

Channel count is not a quality metric. A channel is first-party only when setup,
credentials, smoke, error recovery, audit compatibility, and authority
non-escalation are all verified.

| Channel | Status | Setup difficulty | Credential | Live smoke | Skip path | Inbound | Outbound | Rate limit / backoff | Known failure modes | Next phase |
|---|---|---:|---|---|---|---|---|---|---|---|
| WebChat | first-party | low | `WEBCHAT_TOKEN`, `WEBCHAT_RESUME_TOKEN`, `BLUE_TANUKI_MAINTENANCE_TOKEN` | local smoke | n/a | yes | yes | local only | token missing, token reuse, port conflict | Control Center first-run status |
| Telegram | first-party | medium | `TELEGRAM_BOT_TOKEN` | credentialed path | silent fallback when unset | yes | yes | Bot API polling interval configurable | bot not started, wrong chat_id, privacy mode, token revoked | stronger live smoke docs |
| Slack | first-party-preview | medium | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | supported when credentials/target exist | yes | yes | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | missing app token, Socket Mode failure, channel permission, token revoked, rate limit | `validate:channels` promotion evidence |
| Discord | first-party-preview | medium | `DISCORD_BOT_TOKEN` | supported when credentials/target exist | yes | yes | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | gateway intent, channel permission, token revoked, rate limit | `validate:channels` promotion evidence |
| Microsoft Teams | first-party-preview | high | `MICROSOFT_GRAPH_ACCESS_TOKEN` | supported when credentials/target exist | yes | injected transport / no gateway webhook listener yet | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | Graph permission, tenant/app consent, target format, token revoked, rate limit | inbound listener closure + `validate:channels` evidence |
| LINE | first-party-preview | high | `LINE_CHANNEL_ACCESS_TOKEN` | supported when credentials/target exist | yes | injected transport / no gateway webhook listener yet | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | Messaging API permission, target reachability, token revoked, rate limit | inbound listener closure + `validate:channels` evidence |
| WhatsApp | reserved-third-party | high | third-party adapter-specific | not first-party | n/a | no core support | no core support | not warranted | ToS/stability/operation responsibility cannot be guaranteed by core | generic adapter interface only |

## Release Meaning

- `first-party`: BLUE-TANUKI core owns docs, smoke, conformance, failure mode, and compatibility matrix.
- `first-party-preview`: adapter exists, but release-quality permanent-use closure is not complete.
- `first-party target`: accepted future first-party direction, not current implementation.
- `reserved-third-party`: BLUE-TANUKI core intentionally does not implement or warrant the channel.

## Authority Rule

No channel metadata can escalate authority. Channel user IDs, roles, group
metadata, thread metadata, webhook metadata, and adapter-specific metadata are
downstream context only.

## Preview Channel Boundaries

### Phase 11-S11 Promotion Gate

First-party promotion is guarded by [CHANNEL_PROMOTION_GATE.md](CHANNEL_PROMOTION_GATE.md)
and `pnpm validate:channels`.

The current compatibility matrix intentionally keeps Slack, Discord, Teams, and
LINE as `first-party-preview` because owner-run credentialed live smoke evidence
is absent in this workspace. A future promotion must provide redacted evidence
for live smoke, recovery review, docs review, conformance, and metadata
non-authority. Teams and LINE also require gateway-owned inbound listener
closure before they can become first-party.

### Teams / LINE Preview Boundary

Teams / LINE were added in Phase 9-S4 as first-party-preview target adapters.
They are downstream channel adapters only: service metadata, tenant/user ids,
LINE source ids, and delivery results are audit evidence, not authority.

Current boundary:

- Teams outbound uses Microsoft Graph chatMessage send through `MICROSOFT_GRAPH_ACCESS_TOKEN`.
- LINE outbound uses Messaging API push through `LINE_CHANNEL_ACCESS_TOKEN`.
- Inbound normalization is covered through injected transports; gateway-owned webhook/subscription listeners are not release-complete yet.
- `pnpm smoke:live` skips safely when `TEAMS_LIVE_TARGET` / `LINE_LIVE_TARGET` or credentials are absent.
- First-party promotion requires owner-run credentialed smoke, setup/recovery docs verification, and permanent-use failure review.

### Slack / Discord Preview Boundary

Slack / Discord reached release-polished preview in Phase 8-S5: adapter
conformance, retry/backoff, typed delivery errors, and credentialed live-smoke
paths are implemented.

First-party promotion still waits for:

- owner-run real token / test target `smoke:live`
- token revocation and permission failure recovery review
- permanent-use support decision
