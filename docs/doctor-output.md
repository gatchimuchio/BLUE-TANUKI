# `--doctor` Diagnostic

Status: Phase 8-S2b

Entry: `apps/gateway` -> `node ./dist/main.js --doctor [--json]`

Convenience:

```bash
pnpm run doctor
pnpm --filter @blue-tanuki/gateway run doctor
node apps/gateway/dist/main.js --doctor
```

`pnpm doctor` without `run` is reserved by pnpm itself.

## What It Is

`doctor` is a fast, hermetic, side-effect-light local probe. It answers:

```md
Can this owner start BLUE-TANUKI safely with the current environment?
If not, what should the owner do next?
```

Doctor never makes outbound network calls. Live Slack / Discord / LLM API checks remain in `pnpm smoke:live`.

## Exit Codes

| Code | Meaning | Operator action |
|---|---|---|
| `0` | All checks pass | Continue |
| `1` | One or more warnings | Read `next_action`; proceed only when warnings are intentionally accepted |
| `2` | One or more errors | Stop and fix before serve mode |

## JSON Contract

Each check includes remediation fields:

```json
{
  "id": "env:WEBCHAT_TOKEN",
  "level": "error",
  "status": "error",
  "label": "env WEBCHAT_TOKEN",
  "detail": "missing (required)",
  "cause": "missing (required)",
  "impact": "WebChat inbound and Control Center read APIs cannot be used safely.",
  "next_action": "Run pnpm run setup -- --yes or set WEBCHAT_TOKEN to a distinct random value, then restart.",
  "doc_ref": "docs/CREDENTIAL_READINESS_MATRIX.md",
  "safe_to_ignore": false
}
```

Stable fields:

- `ok: boolean`
- `exit_code: 0 | 1 | 2`
- `timestamp: string`
- `checks[].id`
- `checks[].level`: `ok | warn | error`
- `checks[].status`: `ok | warning | error`
- `checks[].label`
- `checks[].detail`
- `checks[].cause`
- `checks[].impact`
- `checks[].next_action`
- `checks[].doc_ref`
- `checks[].safe_to_ignore`

`level` is kept for backward compatibility. `status` is the owner-facing spelling.

## Text Output

Warnings and errors include the same remediation fields:

```text
blue-tanuki doctor - WARN (2026-05-12T00:00:00.000Z)

  OK    Node.js version              24.14.0 (>= 22.14.0)
  WARN  env SLACK_BOT_TOKEN          unset (optional)
        status: warning
        cause: SLACK_BOT_TOKEN is optional and currently unset (optional).
        impact: The related preview channel or live smoke path may be skipped; WebChat and HDS authority remain usable.
        next_action: Leave SLACK_BOT_TOKEN unset if unused, or set it and rerun pnpm smoke:live.
        doc_ref: docs/CREDENTIAL_READINESS_MATRIX.md
        safe_to_ignore: true

Summary: 18 ok, 2 warn, 0 error.
Exit code: 1
```

## Checks Performed

| Check id | What it inspects |
|---|---|
| `node_version` | Node.js version |
| `env:WEBCHAT_TOKEN` | WebChat inbound token presence and length only |
| `env:WEBCHAT_RESUME_TOKEN` | approval/resume token presence and length only |
| `env:BLUE_TANUKI_MAINTENANCE_TOKEN` | update/recovery maintenance token presence and length only |
| `webchat_token_separation` | inbound/resume/maintenance token separation |
| `webhook_token` | optional webhook token strength and separation |
| `settings_token` | optional settings token strength and separation |
| `env:SLACK_BOT_TOKEN` | optional Slack token presence |
| `env:SLACK_APP_TOKEN` | optional Slack Socket Mode token presence |
| `env:DISCORD_BOT_TOKEN` | optional Discord token presence |
| `env:ANTHROPIC_API_KEY` | optional Anthropic token presence |
| `llm_backend` | provider registry consistency |
| `llm_command_route` | HDS command route hint consistency |
| `cron_schedules` | boot-time schedule JSON parse and shape |
| `session_dir` | session directory writability |
| `audit_dir` | audit directory writability |
| `file_root` | file tool sandbox root |
| `shell_root` | shell exec root |
| `manifests` | bundled plugin manifest/package consistency |
| `compatibility_matrix` | channel scope and preview quarantine |
| `port` | WebChat bind address availability |

## Privacy

- Secret values are never logged.
- Tokens and API keys are reported by presence or length only.
- `next_action`, `cause`, and `impact` must never include secret values.
- Doctor does not import plugin code while checking manifests.

## What Doctor Does Not Check

- Live external API connectivity.
- Slack / Discord token validity.
- Telegram token validity.
- Audit chain integrity for long-running deployments. Use `--audit-verify`.
- HDS policy soundness beyond local configuration checks.

## Operator Use

For JSON automation:

```bash
node apps/gateway/dist/main.js --doctor --json |
  jq -e '.exit_code != 2 and ([.checks[] | select(.level=="error")] | length == 0)'
```

For owner operation, read every warning/error and follow `next_action`.
