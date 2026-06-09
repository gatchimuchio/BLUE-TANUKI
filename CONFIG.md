# BLUE-TANUKI v1.0 RC Configuration

このファイルは env reference である。初回手順は [docs/FIRST_RUN_CHECKLIST.md](./docs/FIRST_RUN_CHECKLIST.md)、credential の readiness は [docs/CREDENTIAL_READINESS_MATRIX.md](./docs/CREDENTIAL_READINESS_MATRIX.md)、常駐運用の確認は [docs/PERMANENT_USE_CHECKLIST.md](./docs/PERMANENT_USE_CHECKLIST.md) を参照する。

## Setup command

```bash
pnpm run setup -- --yes
```

`pnpm run setup` は local env file を生成し、既存 file を上書きする場合は `.bak` backup を残す。secret 値は公開しない。

## HDS-BRAIN standalone smoke

HDS-BRAIN 単体境界は env なしで確認できる。

```bash
pnpm hds:standalone
pnpm hds:standalone -- "tool:file.search root=. query=needle max_results=5"
```

この smoke は gateway / executor / channel / Control Center / LLM backend / external API を起動しない。HDS-BRAIN が `InboundRequest` を受け取り、command envelope、approval classification、audit verification、runtime invariants、health baseline を返せることだけを確認する。

## Required for serve

```bash
WEBCHAT_TOKEN=...
WEBCHAT_RESUME_TOKEN=...
```

Tokens must differ.

## Optional LLM

```bash
LLM_BACKEND=stub
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

`openrouter` is an optional convenience model adapter, not authority and not a
required dependency:

```bash
LLM_BACKEND=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openrouter/model-name
OPENROUTER_SITE_URL=https://example.com
OPENROUTER_APP_TITLE=BLUE-TANUKI
```

Native/direct providers remain canonical. Missing OpenRouter must not break
`stub`, `openai`, `anthropic`, `openai-compatible`, local endpoints, or
`LLM_PROVIDERS_JSON`.

## Telegram

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_POLL_INTERVAL_MS=1500
TELEGRAM_POLL_TIMEOUT_SEC=25
```

## Slack / Discord / Teams / LINE preview channels

Slack, Discord, Teams, and LINE are preview adapters. Missing credentials keep the adapters in silent fail-closed mode. Credentialed live smoke uses a test target and reports typed delivery errors.
First-party promotion is gated by `pnpm validate:channels` and requires owner-run live-smoke evidence. Do not store token values or raw target identifiers in promotion evidence.

```bash
SLACK_BOT_TOKEN=...
SLACK_APP_TOKEN=...
SLACK_LIVE_TARGET=C0123456789

DISCORD_BOT_TOKEN=...
DISCORD_LIVE_TARGET=123456789012345678

MICROSOFT_GRAPH_ACCESS_TOKEN=...
TEAMS_LIVE_TARGET=channel/<urlencoded-team-id>/<urlencoded-channel-id>

LINE_CHANNEL_ACCESS_TOKEN=...
LINE_LIVE_TARGET=<line-user-or-group-or-room-id>

BLUE_TANUKI_LIVE_TIMEOUT_MS=30000
```

Teams target forms are `channel/<team_id>/<channel_id>`, `reply/<team_id>/<channel_id>/<message_id>`, or `chat/<chat_id>` with URL-encoded ids. LINE targets are LINE userId, groupId, or roomId values reachable by the bot. Teams and LINE inbound webhook/subscription listeners are not release-complete yet; injected transports cover adapter conformance and future listener work.

Delivery failures include `error_kind` (`recoverable` / `non_recoverable`), `error_code`, optional `retry_after_ms`, and `next_action`. `recoverable` normally means provider rate limit or transient transport failure; `non_recoverable` means token, target, permission, or app configuration must be fixed before retry.

## Daily Brief smoke

```bash
BLUE_TANUKI_DAILY_BRIEF_ENABLED=1
BLUE_TANUKI_DAILY_BRIEF_CHANNEL=telegram
BLUE_TANUKI_DAILY_BRIEF_TARGET=<chat-id-or-channel-target>
BLUE_TANUKI_DAILY_BRIEF_TIME=07:00
BLUE_TANUKI_DAILY_BRIEF_CONTENT="Daily Brief: scheduled smoke"
```

For smoke testing:

```bash
BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS=60000
```

Optional read-only Google source:

```bash
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED=1
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES=gmail,calendar,drive
GOOGLE_ACCESS_TOKEN=<read-only-google-oauth-token>
```

If the generic token is not used, set service-specific tokens:

```bash
GMAIL_ACCESS_TOKEN=<gmail-read-token>
GOOGLE_CALENDAR_ACCESS_TOKEN=<calendar-read-token>
GOOGLE_DRIVE_ACCESS_TOKEN=<drive-read-token>
```

Daily Brief still enters HDS-BRAIN through the same trusted cron lane. Runtime snapshots expose timing metadata and payload hashes, not brief content.

## Generic scheduled messages

```bash
BLUE_TANUKI_SCHEDULES_JSON='[
  {
    "id": "ops-smoke",
    "channel": "webchat",
    "target": "local-user",
    "content": "scheduled smoke",
    "time": "07:00"
  }
]'
```

Fields:

- `id`: stable task id. Must match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`.
- `channel`: outbound channel name, such as `webchat` or `telegram`.
- `target`: outbound target for that channel.
- `content`: message body. It is never included in runtime snapshots.
- `time`: optional local `HH:MM`; defaults to `07:00`.
- `interval_ms`: optional positive integer for smoke tests.
- `enabled`: optional boolean; `false` keeps the task visible but not running.

Generic schedules are boot-time config. They share the same cron lane as approved runtime schedules.

## Runtime schedules

Runtime schedules are created, updated, and deleted through `tool:schedule.*` commands. Mutating operations are L3 final-review operations, so full access and reusable grants do not bypass owner confirmation.

```bash
BLUE_TANUKI_SCHEDULES_DIR=.blue-tanuki/schedules
BLUE_TANUKI_SCHEDULE_APPROVAL_TIMEOUT_MS=86400000
```

Commands:

```text
tool:schedule.list
tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
tool:schedule.update id=<id> content="updated smoke"
tool:schedule.delete id=<id>
```

Notes:

- `schedule.list` is L1 and exposes safe metadata only.
- `schedule.create`, `schedule.update`, and `schedule.delete` are L3.
- Pending, rejected, or timed-out schedule requests do not fire.
- Runtime snapshots expose schedule ids, counts, timing metadata, and payload hashes, but never schedule `content`.

## Webhook ingress

```bash
WEBHOOK_TOKEN=...
```

When set, `POST /webhook` accepts JSON with `content`, `text`, or `event`.
The webhook token must differ from the WebChat inbound, resume, and settings tokens.
Webhook metadata is normalized and cannot carry authority.

## File tools

```bash
BLUE_TANUKI_FILE_ROOT=/path/to/workspace
```

`file.search`, `file.write`, and `file.edit` only operate under this root.
Secret-like paths and symlink escapes are denied.

Request examples:

```text
tool:file.search root=. query=needle max_results=5
tool:file.write path=notes/today.md content="hello" mode=create
tool:file.edit path=notes/today.md search=hello replace=hi expected_replacements=1
```

## Web search

```bash
BLUE_TANUKI_WEB_SEARCH_ENDPOINT=https://search.example.com/search?q={query}&count={max_results}
BLUE_TANUKI_HTTP_ALLOWLIST=search.example.com
```

`web.search` is disabled unless the endpoint is configured. The endpoint can use
`{query}` and `{max_results}` placeholders, or BLUE-TANUKI will append `q` and
`count` query parameters. Requests inherit `http.fetch` SSRF protections.

## GitHub tools

`github.read` is read-only, unauthenticated, and fixed to `api.github.com`.
It supports public repo metadata, issue metadata, issue lists, pull request
metadata, and pull request lists.

```text
tool:github.read resource=repo owner=gatchimuchio repo=blue-tanuki
tool:github.read resource=issues owner=gatchimuchio repo=blue-tanuki state=open max_results=5
tool:github.read resource=pr owner=gatchimuchio repo=blue-tanuki number=1
```

`github.write` is authenticated, downstream-only, fixed to `api.github.com`,
restricted to allowlisted repositories, and always L3 final-review.

```bash
GITHUB_TOKEN=github-token-with-issue-pr-scope
BLUE_TANUKI_GITHUB_REPOS=gatchimuchio/blue-tanuki
```

`BLUE_TANUKI_GITHUB_REPOS` is a comma/space separated list of `owner/repo`
entries. If either `GITHUB_TOKEN` or the allowlist is missing, `github.write`
fails before sending a mutation.

```text
tool:github.write operation=issue.create owner=gatchimuchio repo=blue-tanuki title="Bug report" body="details"
tool:github.write operation=issue.comment.create owner=gatchimuchio repo=blue-tanuki number=1 body="follow-up"
tool:github.write operation=issue.update owner=gatchimuchio repo=blue-tanuki number=1 title="Updated title"
tool:github.write operation=pr.create owner=gatchimuchio repo=blue-tanuki title="Change" head=feature base=main draft=true
tool:github.write operation=pr.comment.create owner=gatchimuchio repo=blue-tanuki number=1 body="review note"
```

## Composio connector

Composio is an optional convenience external tool/API adapter. It does not
replace native/local tools and is not authority.

```bash
COMPOSIO_API_KEY=...
COMPOSIO_ALLOWED_TOOLKITS=github,gmail,calendar,drive,slack
COMPOSIO_DRY_RUN=true
```

`COMPOSIO_DRY_RUN` defaults to `true`. Live execution is not implemented in the
current phase; `composio.execute` returns dry-run evidence or fails closed.

```text
tool:composio.search toolkit=github query=issues
tool:composio.execute toolkit=github tool=issues.create payload="{\"title\":\"hello\"}"
```

Composio metadata, connected-account status, tool schemas, and tool results do
not grant authority. External write/send/delete/create/update actions must pass
through capability envelope, Approval Gate, and audit.

## Google tools and Daily Brief source

Google read integrations:

- `gmail.read` returns Gmail message metadata summaries.
- `google.calendar.read` returns event metadata summaries.
- `google.drive.read` returns Drive file metadata/search summaries.

Google write integrations:

- `gmail.write` creates Gmail drafts, sends Gmail messages, or sends an existing draft.
- `google.calendar.write` creates, updates, or deletes Calendar events with `sendUpdates=none`.
- `google.drive.write` creates or updates bounded text/media files.

All requests are fixed to Google API hosts and require OAuth access tokens. `GOOGLE_ACCESS_TOKEN` can be used for all services, or service-specific tokens can narrow operator configuration:

```bash
GOOGLE_ACCESS_TOKEN=<google-oauth-token>
GMAIL_ACCESS_TOKEN=<gmail-read-token>
GOOGLE_CALENDAR_ACCESS_TOKEN=<calendar-read-token>
GOOGLE_DRIVE_ACCESS_TOKEN=<drive-read-token>
```

Tool examples:

```text
tool:gmail.read query="newer_than:1d" max_results=5
tool:google.calendar.read calendar_id=primary days=1 max_results=5
tool:google.drive.read query="trashed=false" max_results=5
```

Write examples:

```text
tool:gmail.write operation=draft.create to=owner@example.com subject="Draft" body_text="hello"
tool:gmail.write operation=message.send to=owner@example.com subject="Notice" body_text="hello"
tool:gmail.write operation=draft.send draft_id=<draft-id>
tool:google.calendar.write operation=event.create calendar_id=primary summary="Standup" start=2026-05-12T09:00:00Z end=2026-05-12T09:15:00Z
tool:google.calendar.write operation=event.update calendar_id=primary event_id=<event-id> summary="Updated"
tool:google.calendar.write operation=event.delete calendar_id=primary event_id=<event-id>
tool:google.drive.write operation=file.create name=notes.txt content="hello" mime_type=text/plain
tool:google.drive.write operation=file.update file_id=<file-id> content="updated"
```

Daily Brief Google source:

```bash
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED=1
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES=gmail,calendar,drive
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_MAX_RESULTS=5
BLUE_TANUKI_DAILY_BRIEF_GMAIL_QUERY="newer_than:1d"
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_CALENDAR_ID=primary
BLUE_TANUKI_DAILY_BRIEF_GOOGLE_CALENDAR_DAYS=1
BLUE_TANUKI_DAILY_BRIEF_DRIVE_QUERY="trashed=false"
```

Calendar attendee invites, Drive delete/share, autonomous cross-service actions, and unbounded file writes are not available here. Missing tokens fail closed before a request is sent. Doctor checks the Google Daily Brief source only when `BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED` is set.

## Browser read tool

`browser.read` is a lightweight page reader, not a full headless Chromium
automation backend. It fetches public pages through the same SSRF guard as
`http.fetch`, then returns bounded title, text, and links.

```text
tool:browser.read url=https://example.com max_chars=4000
```

## Browser automation preview

Browser automation is a disabled-by-default preview. It must be explicitly
enabled by the operator:

```bash
BLUE_TANUKI_BROWSER_AUTOMATION_PREVIEW=1
```

Preview tools:

```text
tool:browser.snapshot url=https://example.com max_chars=4000
tool:browser.automation action=smoke
tool:browser.automation action=navigate url=https://example.com
```

Policy:

- `browser.snapshot` is read-only and maps to L2 because it performs networked headless page access.
- `browser.automation` maps to L3 final-review.
- Credentials, cookies, storage state, custom headers, uploads, and downloads are not supported in the preview.
- Network targets must pass the same public-address and `BLUE_TANUKI_HTTP_ALLOWLIST` checks used by `http.fetch`.
- The smoke path returns `skipped` when the preview env flag is absent.

## Shell exec tool

```bash
BLUE_TANUKI_SHELL_ROOT=/path/to/workspace
```

`shell.exec` runs a non-shell command (`cmd` + `args[]`) with its working
directory fixed under this root. It is always a final-review operation.

```text
tool:shell.exec {"cmd":"git","args":["status","-sb"],"cwd":"."}
```

## Persistence

```bash
BLUE_TANUKI_AUDIT_DIR=.blue-tanuki/audit
BLUE_TANUKI_MEMORY_DIR=.blue-tanuki/memory
BLUE_TANUKI_SESSION_DIR=.blue-tanuki/sessions
BLUE_TANUKI_APPROVALS_FILE=.blue-tanuki/approvals/grants.json
BLUE_TANUKI_COMPLETE_HISTORY_FILE=.blue-tanuki/history/complete-history.jsonl
BLUE_TANUKI_COMPLETE_HISTORY_MAX_ENTRIES=10000
```

Complete history persistence is optional. If `BLUE_TANUKI_COMPLETE_HISTORY_FILE` is unset, Gateway keeps the replay chain in memory for the current serve process. The Control Center history API remains read-only and returns digests/metadata only.

## Approval

```bash
BLUE_TANUKI_APPROVAL_MODE=full_access
# Alternatives: ask_every_time, remember_this_decision
```

`full_access` remains final-review guarded.

The canonical final-review operation source is `FINAL_REVIEW_OPERATION_LIST` in
`packages/hds-brain/src/approval_policy.ts`. Gateway, UI, channels, plugins,
operators, schedules, and executor surfaces display or route that HDS-BRAIN
classification; they do not own a separate final-review policy list.
