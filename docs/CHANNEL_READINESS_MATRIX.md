# BLUE-TANUKI Channel Readiness Matrix

Channel count is not a quality metric. A channel is first-party only when setup,
credentials, smoke, error recovery, audit compatibility, and authority
non-escalation are all verified.

| Channel | Status | Setup difficulty | Credential | Live smoke | Skip path | Inbound | Outbound | Rate limit / backoff | Known failure modes | Next phase |
|---|---|---:|---|---|---|---|---|---|---|---|
| WebChat | first-party | low | `WEBCHAT_TOKEN`, `WEBCHAT_RESUME_TOKEN`, `BLUE_TANUKI_MAINTENANCE_TOKEN` | local smoke | n/a | yes | yes | local only | token missing, token reuse, port conflict | Control Center first-run status |
| Telegram | first-party | medium | `TELEGRAM_BOT_TOKEN` + exact `TELEGRAM_INBOUND_GRANTS_JSON` owner entries | credentialed path; inbound is deny-all without a matching user/chat/topic grant | silent fallback when token unset; inbound rejected when grants are empty | yes | yes | Bot API polling interval configurable | missing/mismatched inbound grant, bot not started, wrong chat_id, privacy mode, token revoked | credentialed owner live smoke remains separate |
| Slack | first-party-preview | medium | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | supported when credentials/target exist | yes | yes | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | missing app token, Socket Mode failure, channel permission, token revoked, rate limit | `validate:channels` promotion evidence |
| Discord | first-party-preview | medium | `DISCORD_BOT_TOKEN` | supported when credentials/target exist | yes | yes | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | gateway intent, channel permission, token revoked, rate limit | `validate:channels` promotion evidence |
| Microsoft Teams | first-party-preview | high | `MICROSOFT_GRAPH_ACCESS_TOKEN`; inbound: `TEAMS_AGENT_CLIENT_ID`, `TEAMS_AGENT_TENANT_ID`, secret-store `TEAMS_AGENT_CLIENT_SECRET`, exact `TEAMS_INBOUND_GRANTS_JSON` | synthetic served reply/outbox route and unauthenticated-route rejection; no valid JWT, owner tenant, or Graph API smoke | yes | Agents SDK JWT endpoint (loopback only), exact owner grant, Gateway durable digest-only inbox and payload-limited SQLite outbox | yes | durable retry only after explicit Graph 429 plus valid `Retry-After`; timeout/network/5xx remain outcome-unknown and are never auto-replayed | invalid JWT/audience/issuer, service URL mismatch, missing grant, duplicate/conflicting activity, Graph permission, tenant/app consent, target format, token revoked, rate limit, ambiguous delivery | F13.03 owner-run live acceptance after product implementation and OD-03 conditions |
| LINE | first-party-preview | high | outbound: `LINE_CHANNEL_ACCESS_TOKEN`; inbound: protected `LINE_CHANNEL_SECRET`, exact `LINE_CHANNEL_DESTINATION`, `LINE_INBOUND_GRANTS_JSON` | synthetic signed loopback route only; no provider callback or live API | deny-all without exact grants; ingress disabled unless secret and destination are paired | signed webhook HMAC, exact destination/source/user grant, Gateway digest-only replay inbox → `InboundRouter` | yes | adapter retry/backoff + typed recoverable/non-recoverable errors | invalid signature/destination/grant, duplicate or conflicting event, listener bind failure, Messaging API permission, target reachability, token revoked, rate limit | F14.02 reply/outbox consumer; F14.03 owner-run live acceptance after product implementation and OD-03 conditions |
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
non-authority. Teams and LINE require gateway-owned ingress and owner-run
credentialed acceptance before promotion. LINE's local synthetic webhook path
is connected, but no LINE provider callback or live API has been exercised.

### Teams / LINE Preview Boundary

Teams / LINE were added in Phase 9-S4 as first-party-preview target adapters.
They are downstream channel adapters only: service metadata, tenant/user ids,
LINE source ids, and delivery results are audit evidence, not authority.

Current boundary:

- Teams outbound uses Microsoft Graph chat/channel message consumers through `MICROSOFT_GRAPH_ACCESS_TOKEN`. The Gateway-owned SQLite outbox keeps reply text/target only while pending and clears it on terminal settlement. Only explicit 429 rejection with a valid `Retry-After` is retried durably; timeout, transport failure, 5xx, and restart during dispatch stay `outcome_unknown` without automatic replay.
- LINE outbound uses Messaging API push through `LINE_CHANNEL_ACCESS_TOKEN`.
- Teams now has a loopback-only Microsoft 365 Agents SDK JWT endpoint, exact tenant/conversation/user/team/channel admission, a Gateway-owned digest-only replay inbox, and a synthetic inbound→Gateway→native reply→durable outbox path. Synthetic route tests do not establish a valid JWT tenant route, HDS runtime, or Teams API operation. See [Teams inbound admission](TEAMS_INBOUND_ADMISSION.md).
- LINE inbound verifies the signature over the exact raw request bytes before parsing, checks the configured destination, and admits only exact destination/source type/source ID/user ID grants. A digest-only Gateway inbox suppresses duplicates and identity conflicts; interrupted dispatch stays `outcome_unknown`. Only complete text identities pass to `InboundRouter`; reply tokens and attachment content are excluded. Synthetic local tests do not establish a provider callback, HDS runtime, or LINE API operation. See [LINE inbound admission](LINE_INBOUND_ADMISSION.md).
- The LINE listener binds only to loopback. Public provider delivery requires a separately operated HTTPS reverse proxy; no public network exposure or live callback was configured.
- `pnpm smoke:live` skips safely when `TEAMS_LIVE_TARGET` / `LINE_LIVE_TARGET` or outbound credentials are absent.
- First-party promotion requires owner-run credentialed smoke, setup/recovery docs verification, and permanent-use failure review.

### Slack / Discord Preview Boundary

Slack / Discord reached release-polished preview in Phase 8-S5: adapter
conformance, retry/backoff, typed delivery errors, and credentialed live-smoke
paths are implemented.

First-party promotion still waits for:

- owner-run real token / test target `smoke:live`
- token revocation and permission failure recovery review
- permanent-use support decision
