# BLUE-TANUKI Credential Readiness Matrix

Secret values must never be printed in docs, logs, doctor output, runtime snapshots, or audit summaries. Length/status/digest-only reporting is acceptable where already implemented.

| Credential / env | Required for | Secret class | Setup source | Current doctor check | Safe missing behavior | Failure message / symptom | Rotation notes |
|---|---|---|---|---|---|---|---|
| `WEBCHAT_TOKEN` | WebChat inbound, `/ws-ticket`, read-only Control Center APIs | bearer secret | `pnpm setup` or manual env | required, length-only | no | `WEBCHAT_TOKEN is required for serve mode` | rotate with restart; must differ from resume token |
| `WEBCHAT_RESUME_TOKEN` | `/resume`, `/approval` | bearer secret | `pnpm setup` or manual env | required, separation check | no | `WEBCHAT_RESUME_TOKEN must differ from WEBCHAT_TOKEN` | rotate with restart; do not reuse inbound token |
| `BLUE_TANUKI_SETTINGS_TOKEN` | `/settings` JSON API | bearer secret | setup/settings env | optional | settings API disabled or inaccessible | 401/403 on settings API | rotate with restart; settings writes create env backup |
| `LLM_BACKEND` | executor provider selection | config | setup/manual | provider consistency check | yes, `stub` default | provider unavailable or unresolved backend hint | route only; does not grant authority |
| `ANTHROPIC_API_KEY` | Anthropic backend | API key | provider dashboard/manual env | required only when backend/hint needs it | yes if backend unused | provider not registered / live smoke skip | rotate at provider, restart gateway |
| `OPENAI_API_KEY` | OpenAI backend | API key | provider dashboard/manual env | required only when backend/hint needs it | yes if backend unused | provider not registered / live smoke skip | rotate at provider, restart gateway |
| `OPENAI_COMPAT_API_KEY` / `LLM_API_KEY` | OpenAI-compatible backend | API key | provider/manual env | required depending provider config | yes if backend unused | provider not registered | rotate at provider, restart gateway |
| `OPENROUTER_API_KEY` | OpenRouter backend | API key | OpenRouter/manual env/settings | required only when `LLM_BACKEND=openrouter` | yes if backend unused | `openrouter but OPENROUTER_API_KEY is unset` | rotate at OpenRouter, restart gateway |
| `OPENROUTER_MODEL` | OpenRouter backend | provider model id, not secret | manual env/settings | required only when `LLM_BACKEND=openrouter` | yes if backend unused | `openrouter but no model is set` | changing model changes downstream route only |
| `COMPOSIO_API_KEY` | Composio connector | API key | Composio/manual env/settings | optional token presence | yes, connector disabled/fails closed | `COMPOSIO_API_KEY is required for Composio connector; external_call_performed=false` | rotate at Composio, restart gateway |
| `COMPOSIO_ALLOWED_TOOLKITS` | Composio connector | toolkit allowlist, not secret | manual env/settings | connector consistency check | yes, connector fails closed | `COMPOSIO_ALLOWED_TOOLKITS must explicitly allow a toolkit` | list only intended toolkits; live still requires action allowlist and L3 approval |
| `COMPOSIO_ALLOWED_ACTIONS` | Composio live connector | action allowlist, not secret | manual env/settings | product gate fixture | yes, live connector fails closed | `COMPOSIO_ALLOWED_ACTIONS must explicitly allow a toolkit action before Composio live execution` | list only intended toolkit actions; changing list changes external write reach |
| `COMPOSIO_REVOKED_ACTIONS` | Composio live connector | action denylist, not secret | manual env/settings | product gate fixture | yes, matching action fails closed | `Composio action revoked: ...; external_call_performed=false` | use to disable a previously allowed action without widening other actions |
| `COMPOSIO_USER_ID` | Composio live connector | user/account scope id | Composio/manual env/settings | product gate fixture | yes, live connector fails closed | `COMPOSIO_USER_ID is required for Composio live execution; mutation_sent=false` | rotate/change when Composio user/account mapping changes |
| `COMPOSIO_DRY_RUN` | Composio connector | config | setup/manual env/settings | connector consistency check | defaults to `true` | external request is not sent | set `false` only with `COMPOSIO_LIVE_EXECUTION=true`, user id, and explicit toolkit/action allowlists |
| `COMPOSIO_LIVE_EXECUTION` | Composio live connector | config | setup/manual env/settings | product gate fixture | defaults to `false` | live execution remains blocked | set `true` only after reviewing HDS approval and action allowlist scope |
| `TELEGRAM_BOT_TOKEN` | Telegram channel | bot token | BotFather/manual env | optional token presence | yes, Telegram disabled/fallback | Telegram does not register/respond | revoke/regenerate in BotFather; restart |
| `SLACK_BOT_TOKEN` | Slack release-polished preview adapter | bot token | Slack app config | optional token presence | yes, Slack silent fallback | typed `slack_not_configured`, `invalid_auth`, `token_revoked`, or delivery error / live smoke skip | rotate Slack bot token, restart |
| `SLACK_APP_TOKEN` | Slack Socket Mode | app token | Slack app config | optional token presence | yes, Slack silent fallback | typed `slack_not_configured` or Socket Mode start failure | rotate Slack app token, restart |
| `DISCORD_BOT_TOKEN` | Discord release-polished preview adapter | bot token | Discord developer portal | optional token presence | yes, Discord silent fallback | typed `discord_not_configured`, token/permission error, or live smoke skip | rotate in developer portal, restart |
| `MICROSOFT_GRAPH_ACCESS_TOKEN` | Microsoft Teams preview adapter | OAuth access token | Microsoft Entra / delegated Graph OAuth | optional token presence | yes, Teams silent fallback | typed `teams_not_configured`, Graph auth/permission/target error, or live smoke skip | rotate through OAuth/app consent path, restart |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE preview adapter | channel access token | LINE Developers console | optional token presence | yes, LINE silent fallback | typed `line_not_configured`, Messaging API auth/permission/target error, or live smoke skip | rotate in LINE Developers, restart |
| `GITHUB_TOKEN` | `github.write` external write tool | API token | GitHub token settings/manual env | optional token presence | yes, `github.write` fails closed | `GITHUB_TOKEN is required for github.write; mutation_sent=false` | rotate in GitHub, restart gateway |
| `BLUE_TANUKI_GITHUB_REPOS` | `github.write` repository allowlist | repo list, not secret | manual env | optional presence | yes, `github.write` fails closed | allowlist missing/denied before mutation | list `owner/repo`; changing allowlist changes write reach |
| `GOOGLE_ACCESS_TOKEN` | Google read/write tools and optional Daily Brief Google source | OAuth access token | Google OAuth/manual env | Google Daily Brief source check when enabled | yes, Google tools fail closed | `GOOGLE_ACCESS_TOKEN is required ... request_sent=false; mutation_sent=false` | rotate in Google account/OAuth client, restart gateway |
| `GMAIL_ACCESS_TOKEN` | `gmail.read`, `gmail.write`, and Gmail Daily Brief source | OAuth access token | Google OAuth/manual env | Google Daily Brief source check when Gmail source enabled | yes, Gmail tools fail closed | `GMAIL_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN is required for gmail.write; request_sent=false; mutation_sent=false` | prefer least-privilege Gmail scopes; rotate/restart |
| `GOOGLE_CALENDAR_ACCESS_TOKEN` | `google.calendar.read` / `google.calendar.write` and Calendar Daily Brief source | OAuth access token | Google OAuth/manual env | Google Daily Brief source check when Calendar source enabled | yes, Calendar tools fail closed | `GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN is required for google.calendar.write; request_sent=false; mutation_sent=false` | prefer least-privilege Calendar scopes; rotate/restart |
| `GOOGLE_DRIVE_ACCESS_TOKEN` | `google.drive.read` / `google.drive.write` and Drive Daily Brief source | OAuth access token | Google OAuth/manual env | Google Daily Brief source check when Drive source enabled | yes, Drive tools fail closed | `GOOGLE_DRIVE_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN is required for google.drive.write; request_sent=false; mutation_sent=false` | prefer least-privilege Drive scopes; rotate/restart |
| `WEBHOOK_TOKEN` | optional `/webhook` ingress | bearer secret | manual env | optional/separation check where configured | yes, webhook disabled | `/webhook` unauthorized/disabled | rotate with restart; must differ from WebChat/settings tokens |
| `BLUE_TANUKI_FILE_ROOT` | file search/write/edit tools | local path, not secret | setup/manual env | root/path check | file tools fail closed | file tool root required/denied | changing root changes tool reach; restart |
| `BLUE_TANUKI_SHELL_ROOT` | `shell.exec` | local path, not secret | manual env | root/path check | shell tool fails closed | shell root required/denied | final-review still required |
| `BLUE_TANUKI_AUDIT_DIR` | persisted audit | local path | setup/manual env | writability check | in-memory audit if unset in some modes | audit persistence missing/unwritable | backup before moving |
| `BLUE_TANUKI_SESSION_DIR` | persisted sessions | local path | setup/manual env | writability check | in-memory sessions if unset | session persistence missing/unwritable | backup before moving |
| `BLUE_TANUKI_MEMORY_DIR` | HDS long-term memory component | local path | setup/manual env | directory check if configured | memory persistence disabled/fails closed | memory unavailable | memory is not authority |
| `BLUE_TANUKI_FAILURE_MEMORY_FILE` / `BLUE_TANUKI_FAILURE_MEMORY_DIR` | HDS failure-memory control asset | local path | manual env | loaded by gateway / verifier when configured | in-memory failure memory if unset | repeated-failure control history not persisted | failure memory is deterministic control, not LLM authority |
| `BLUE_TANUKI_APPROVALS_FILE` | reusable approval grants | local path | setup/manual env | path parent check if configured | in-memory grants | grants not persisted | grants never bypass L3 |
| `BLUE_TANUKI_SCHEDULES_DIR` | runtime schedule store | local path | default/manual env | schedule config release gate | default `.blue-tanuki/schedules` | schedule store unwritable | backup with local runtime data |
| `SLACK_LIVE_TARGET` | live smoke | target id | manual env | not doctor-owned | live smoke skip | Slack live check skipped | use test channel |
| `DISCORD_LIVE_TARGET` | live smoke | target id | manual env | not doctor-owned | live smoke skip | Discord live check skipped | use test channel |
| `TEAMS_LIVE_TARGET` | live smoke | target id | manual env | not doctor-owned | live smoke skip | Teams live check skipped | use `channel/<team_id>/<channel_id>`, `reply/<team_id>/<channel_id>/<message_id>`, or `chat/<chat_id>` test target |
| `LINE_LIVE_TARGET` | live smoke | target id | manual env | not doctor-owned | live smoke skip | LINE live check skipped | use a reachable userId, groupId, or roomId test target |

## Promotion Evidence Rule

Channel first-party promotion evidence must be redacted. It may record command
name, PASS/SKIP/FAIL status, timestamp, and report digest, but it must not
record token values, bearer headers, raw live target identifiers, message
content, or provider request bodies. Run `pnpm validate:channels` to verify the
compatibility matrix against the promotion gate.

## Rotation Rule

Credential rotation is a configuration change, not an authority change. Rotating a token must not alter HDS-BRAIN, Approval Gate, Runtime Invariants, or hash-chain compatibility.
