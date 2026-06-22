# BLUE-TANUKI Operator Runbook

This runbook is the day-to-day operations reference for the BLUE-TANUKI
gateway. It covers boot, configuration, persistence, audit-chain inspection,
diagnostics, and the small number of recovery procedures an operator needs
to know cold.

The runbook assumes:

- Phase 6-S1 build (audit persistence, structured logger, provider-neutral LLM
  routing, tool capability envelope, action output rendering, workspace plugin
  loader, permission enforcement, `http.fetch` SSRF hardening,
  `file.search`/`file.write`/`file.edit` sandboxing,
  unauthenticated `github.read`, lightweight `browser.read`, final-review
  `shell.exec`, Unicode detector normalization with raw audit
  retention, WebChat resume token separation, Docker packaging,
  local validation, systemd packaging, one-time resume approval tokens, packaging
  validation, setup wizard/env-file loading, and `--audit-dump`).
- Single-process, single-host deployment. Multi-process writers are NOT
  supported for either the session store or the audit chain.

---

## 1. Process model

Two long-running surfaces and three CLI subcommands share one entry point
(`apps/gateway/src/main.ts`):

| Mode               | Invocation                        | Lifetime    |
| ------------------ | --------------------------------- | ----------- |
| `serve`            | `pnpm gateway:serve` / `--serve`  | long-running |
| `setup`            | `pnpm run setup` / `--setup`      | exits after writing local env |
| CLI one-shot       | `pnpm gateway -- "your text"`     | exits after one F→M→C decision |
| `doctor`           | `pnpm --filter @blue-tanuki/gateway run doctor` / `--doctor` | exits with code 0/1/2 |
| `audit-dump`       | `--audit-dump [--json]`           | exits with code 0/1/2 |

The build step (`pnpm build`) emits compiled JS to each package's `dist/`,
and the production scripts (`gateway`, `gateway:serve`, `doctor`) run the
compiled output. The `:dev` variants run via `tsx` for fast iteration.

Setup can generate a private local env file:

```bash
pnpm run setup -- --yes
pnpm gateway:serve:dev -- --env-file .blue-tanuki/blue-tanuki.env
```

`--env-file <path>` and `BLUE_TANUKI_ENV_FILE=<path>` are loaded before gateway
mode selection. Existing process env values win over file values.

When `BLUE_TANUKI_SETTINGS_TOKEN` is present, WebChat also serves the local
settings window at `/settings`. The JSON API uses the settings token only; it
does not accept the inbound or resume token. Saved changes update the env file
and require restart.

Portable installers live under `install/windows`, `install/macos`, and
`install/linux`. `pnpm release:bundle` creates an archive with those scripts
and the app source/dist, plus `.sha256` and `.manifest.json` integrity
sidecars. Run `pnpm release:verify` before distributing the archive. The
generated launcher uses the same env-file path as setup and supports
`start`, `doctor`, `setup`, `settings`, `env`, and `help`.

Portable uninstallers live beside the installers. Default uninstall removes
the app and launcher while preserving env/audit/session data. Use Windows
`-Purge` or macOS/Linux `PURGE=1` only when retained local data should also be
removed.

Portable upgrades should use Windows `-Force` or macOS/Linux `FORCE=1`. These
replace the app directory while preserving the existing env file. Use Windows
`-ResetConfig` or macOS/Linux `RESET_CONFIG=1` only for intentional token,
provider, and path regeneration.

When setup or the settings window overwrites an env file, the gateway writes a
timestamped `.bak` file next to it first and then atomically replaces the env
file. Keep those backups with the same care as the live env file because they
contain the same secrets.

Release bundle creation and verification exclude env backups and common local
key material. Treat any release verification failure for a secret-like path as
a stop-ship event and inspect the workspace before distributing an archive.

---

## 2. Required and optional environment

| Variable                    | Required for | Purpose                                               | Default            |
| --------------------------- | ------------ | ----------------------------------------------------- | ------------------ |
| `WEBCHAT_TOKEN`             | `serve`      | Bearer token for `/inbound` and `/ws-ticket`          | none (hard error)  |
| `WEBCHAT_RESUME_TOKEN`      | `serve`      | Separate Bearer token for `/resume`; must differ from `WEBCHAT_TOKEN` | none (hard error)  |
| `BLUE_TANUKI_MAINTENANCE_TOKEN` | `serve` | Separate Bearer token for `/update/*` and `/recovery/*`; must differ from WebChat tokens | none (hard error) |
| `WEBCHAT_PORT`              | `serve`      | HTTP/WS listen port                                   | `8787`             |
| `WEBCHAT_HOST`              | `serve`      | HTTP/WS bind host                                     | `127.0.0.1`        |
| `LLM_BACKEND`               | all modes    | Default LLM provider: `stub`, `anthropic`, `openai`, `openai-compatible`, or `openrouter` | `stub` |
| `LLM_DEFAULT_BACKEND`       | optional     | Fallback default provider name when `LLM_BACKEND` is unset | none |
| `LLM_ENDPOINT`              | optional     | Generic OpenAI-compatible endpoint                    | none               |
| `LLM_MODEL`                 | optional     | Generic default model name                            | none               |
| `LLM_API_KEY`               | optional     | Generic bearer token for OpenAI-compatible providers  | none               |
| `LLM_HEADERS_JSON`          | optional     | Extra OpenAI-compatible HTTP headers as a JSON object  | none               |
| `LLM_PROVIDERS_JSON`        | optional     | Additional named provider catalog                     | none               |
| `ANTHROPIC_API_KEY`         | `anthropic`  | API key when `LLM_BACKEND=anthropic`                  | none               |
| `ANTHROPIC_MODEL`           | optional     | Override default Anthropic model name                 | `claude-opus-4-7`  |
| `ANTHROPIC_ENDPOINT`        | optional     | Override Anthropic messages endpoint                  | Anthropic API      |
| `OPENAI_API_KEY`            | `openai`     | API key when `LLM_BACKEND=openai`                     | none               |
| `OPENAI_MODEL`              | `openai`     | Model when `LLM_BACKEND=openai`                       | none               |
| `OPENAI_ENDPOINT`           | optional     | Override OpenAI-compatible endpoint for `openai`      | OpenAI API         |
| `OPENAI_COMPAT_ENDPOINT`    | `openai-compatible` | Chat-completions-compatible endpoint           | none               |
| `OPENAI_COMPAT_MODEL`       | `openai-compatible` | Model for the compatible endpoint              | none               |
| `OPENAI_COMPAT_API_KEY`     | optional     | Bearer token for compatible endpoint                  | none               |
| `OPENAI_COMPAT_HEADERS_JSON` | optional    | Extra compatible-provider headers as a JSON object    | none               |
| `OPENROUTER_API_KEY`        | `openrouter` | API key when `LLM_BACKEND=openrouter`                 | none               |
| `OPENROUTER_MODEL`          | `openrouter` | Model when `LLM_BACKEND=openrouter`                   | none               |
| `OPENROUTER_SITE_URL`       | optional     | Optional OpenRouter `HTTP-Referer` metadata           | none               |
| `OPENROUTER_APP_TITLE`      | optional     | Optional OpenRouter `X-Title` metadata                | none               |
| `COMPOSIO_API_KEY`          | optional     | Optional Composio connector key                       | none               |
| `COMPOSIO_ALLOWED_TOOLKITS` | optional     | Comma/space-separated Composio toolkit allowlist      | none               |
| `COMPOSIO_ALLOWED_ACTIONS`  | live connector | Comma/space-separated toolkit/action allowlist      | none               |
| `COMPOSIO_REVOKED_ACTIONS`  | optional     | Comma/space-separated toolkit/action denylist         | none               |
| `COMPOSIO_USER_ID`          | live connector | Composio user/account scope id                       | none               |
| `COMPOSIO_DRY_RUN`          | optional     | Composio connector dry-run mode                       | `true`             |
| `COMPOSIO_LIVE_EXECUTION`   | optional     | Explicit live connector opt-in                        | `false`            |
| `SLACK_BOT_TOKEN`           | optional     | Slack inbound/outbound (silent stub if unset)         | none               |
| `SLACK_APP_TOKEN`           | optional     | Slack Socket Mode app token                           | none               |
| `SLACK_LIVE_TARGET`         | live smoke   | Slack channel/DM id for `pnpm smoke:live`             | none               |
| `DISCORD_BOT_TOKEN`         | optional     | Discord inbound/outbound (silent stub if unset)       | none               |
| `DISCORD_LIVE_TARGET`       | live smoke   | Discord channel id for `pnpm smoke:live`              | none               |
| `MICROSOFT_GRAPH_ACCESS_TOKEN` | optional  | Teams outbound through Microsoft Graph (silent stub if unset) | none       |
| `TEAMS_LIVE_TARGET`         | live smoke   | Teams target for `pnpm smoke:live` (`channel/...`, `reply/...`, or `chat/...`) | none |
| `LINE_CHANNEL_ACCESS_TOKEN` | optional     | LINE Messaging API push (silent stub if unset)        | none               |
| `LINE_LIVE_TARGET`          | live smoke   | LINE user/group/room id for `pnpm smoke:live`         | none               |
| `BLUE_TANUKI_SESSION_DIR`   | optional     | Enables on-disk SessionStore at this directory        | none → in-memory   |
| `BLUE_TANUKI_SESSION_CAP`   | optional     | Max retained messages per session                     | `100`              |
| `BLUE_TANUKI_AUDIT_DIR`     | optional     | Enables on-disk AuditLog at `<dir>/audit.jsonl`       | none → in-memory   |
| `BLUE_TANUKI_LOG_LEVEL`     | optional     | `debug` / `info` / `warn` / `error`                   | `info`             |
| `BLUE_TANUKI_LOG_FORMAT`    | optional     | `text` (default) or `json` (one-object-per-line)      | `text`             |
| `BLUE_TANUKI_HTTP_ALLOWLIST` | optional    | Comma/space-separated domains allowed for `http.fetch` | unset              |
| `BLUE_TANUKI_FILE_ROOT`     | file tools   | Sandbox root for file search/write/edit              | none (hard error)  |
| `BLUE_TANUKI_SHELL_ROOT`    | `shell.exec` | Working-directory root for shell command execution   | none (hard error)  |
| `BLUE_TANUKI_LLM_BACKEND_HINT` | optional  | Backend hint attached by HDS-BRAIN to approved LLM commands | registry default |
| `BLUE_TANUKI_LLM_MODEL`     | optional     | Per-command model override attached by HDS-BRAIN      | provider default   |
| `BLUE_TANUKI_LLM_TEMPERATURE` | optional   | Per-command temperature override (`0..2`)             | provider default   |
| `BLUE_TANUKI_LLM_MAX_TOKENS` | optional    | Per-command max token constraint                      | `1024`             |
| `BLUE_TANUKI_LLM_TIMEOUT_MS` | optional    | Per-command timeout constraint                        | `30000`            |
| `BLUE_TANUKI_LIVE_REQUIRED` | live smoke   | `=1` fails `smoke:live` if every live check is skipped | unset              |
| `BLUE_TANUKI_LIVE_TIMEOUT_MS` | live smoke | Timeout for Slack/Discord/Teams/LINE live start/send checks | `30000`       |
| `BLUE_TANUKI_LIVE_LLM_TIMEOUT_MS` | live smoke | Timeout for the configured live LLM call          | `BLUE_TANUKI_LIVE_TIMEOUT_MS` |
| `BLUE_TANUKI_SERVE`         | optional     | `=1` is equivalent to passing `--serve`               | unset              |

Empty-string values are treated as unset for the `BLUE_TANUKI_*` directory
variables. This lets smoke scripts wipe a parent process's setting without
touching disk.

---

## 2.1 Plugin Loader And Permissions

Boot discovers workspace packages through `pnpm-workspace.yaml`, reads each
package root's `blue-tanuki.plugin.json`, and imports only workspace-local
manifest entries. External npm package plugin discovery, hot reload, and
runtime permission mutation are not supported.

Permission failures are boot failures. A package must declare every capability
it needs before the gateway registers or configures it:

| Surface | Required manifest permissions |
| ------- | ----------------------------- |
| Built-in tools | `tool:*`, `fs:read`, `fs:write`, `network:http`, `network:github.com`, `network:googleapis.com`, and declared credential capabilities as required by each tool |
| WebChat | `network:listen`, `secrets:WEBCHAT_TOKEN`, `secrets:WEBCHAT_RESUME_TOKEN` |
| Telegram | `network:api.telegram.org`, `secrets:TELEGRAM_BOT_TOKEN` |
| Slack | `network:slack.com`, `secrets:SLACK_BOT_TOKEN`, `secrets:SLACK_APP_TOKEN` |
| Discord | `network:discord.com`, `secrets:DISCORD_BOT_TOKEN` |
| Teams | `network:graph.microsoft.com`, `secrets:MICROSOFT_GRAPH_ACCESS_TOKEN` |
| LINE | `network:api.line.me`, `secrets:LINE_CHANNEL_ACCESS_TOKEN` |
| Non-stub LLM providers | `network:llm-provider` plus accessed API-key/header env secrets |
| Session file store | `fs:read:session_dir`, `fs:write:session_dir`, `fs:append:session_dir` |
| Audit file store | `fs:append:audit_dir` |

`doctor` validates the consistency of all of the above. Run it before every
deploy.

LLM providers are downstream references, not the agent's control plane.
HDS-BRAIN decides whether a command may run; the executor resolves the command's
optional `backend_hint` against the configured LLM registry. `stub` is always
registered for offline development. `anthropic` registers when configured with
`ANTHROPIC_API_KEY`; `openai-compatible` registers when an endpoint and model
are configured. The `openai` alias uses the same compatible adapter with the
standard OpenAI chat-completions endpoint unless overridden.
`openrouter` registers when `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are
configured, or fails closed if selected without them.

OpenRouter is an optional convenience model adapter. It does not replace native
OpenAI, Anthropic, OpenAI-compatible, local, or `LLM_PROVIDERS_JSON` routes.
Composio is an optional convenience external tool adapter. It does not replace
native/local tools. Live execution stays closed unless dry-run is disabled,
`COMPOSIO_LIVE_EXECUTION=true`, `COMPOSIO_USER_ID`, toolkit/action allowlists,
and HDS L3 final review all pass.

For multiple arbitrary LLM APIs, set `LLM_PROVIDERS_JSON` to an array (or
`{"providers":[...]}`) of named OpenAI-compatible providers:

```json
[
  {
    "name": "local-fast",
    "type": "openai-compatible",
    "endpoint": "http://localhost:11434/v1",
    "model": "llama-local",
    "api_key_env": "LOCAL_LLM_API_KEY",
    "aliases": ["fast"]
  }
]
```

Then set `LLM_BACKEND=local-fast` or let HDS-BRAIN emit
`backend_hint: "fast"` for an approved command. Provider names and aliases are
routes only; they do not grant authority to the LLM.

`BLUE_TANUKI_LLM_BACKEND_HINT` is the operational way to attach a route hint to
every ASSERTed `llm_call`. It is intentionally separate from `LLM_BACKEND`:
`LLM_BACKEND` configures the registry default, while
`BLUE_TANUKI_LLM_BACKEND_HINT` becomes part of the upstream command emitted by
HDS-BRAIN. `doctor` verifies that the hint resolves to a configured provider
before serve starts.

---

## 3. Persistence boundaries

There are two independent persistence surfaces. They must NOT be conflated.

### 3.1 Session store

- Purpose: per-`session_id` rolling history for LLM context.
- Authority: BLUE-TANUKI/core (executor). HDS-BRAIN does not read it.
- Format: one JSON file per session under `${BLUE_TANUKI_SESSION_DIR}/`.
- Lifecycle: append-on-success only; failed LLM calls do not pollute history.
- Multi-process: NOT safe. Single writer per directory.

### 3.2 Audit chain

- Purpose: tamper-evident record of every HDS-BRAIN F→M→C decision plus
  every human RESUME verdict.
- Authority: HDS-BRAIN. The executor does not write here.
- Format: a single JSONL file `${BLUE_TANUKI_AUDIT_DIR}/audit.jsonl` with
  hash-chain linkage (`prev_hash` → `entry_hash`).
- Lifecycle: append-only. Re-loaded and re-verified on every gateway boot.
- Multi-process: NOT safe. Single writer per file.

The two are intentionally decoupled. Operational logs (stdout) are a third,
separate surface — they are NOT a substitute for the audit chain, and the
audit chain is NOT a substitute for them.

### 3.3 Tool permission envelope

Tool execution is gated per command. Each tool declares
`required_capabilities`; an ASSERTed `tool_call` must carry matching
`constraints.allowed_capabilities`.

Built-in tool capabilities:

| Tool          | Required capabilities                 |
| ------------- | ------------------------------------- |
| `echo`        | `tool:echo`                           |
| `file.search` | `tool:file.search`, `fs:read`         |
| `file.write` | `tool:file.write`, `fs:write`         |
| `file.edit`  | `tool:file.edit`, `fs:read`, `fs:write` |
| `http.fetch`  | `tool:http.fetch`, `network:http`     |
| `web.search` | `tool:web.search`, `network:http`     |
| `github.read` | `tool:github.read`, `network:github.com` |
| `github.write` | `tool:github.write`, `network:github.com`, `secrets:GITHUB_TOKEN`, `github:issue.write`, `github:pr.write`, `github:comment.write` |
| `gmail.read` | `tool:gmail.read`, `network:googleapis.com`, `secrets:GMAIL_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:gmail.read` |
| `google.calendar.read` | `tool:google.calendar.read`, `network:googleapis.com`, `secrets:GOOGLE_CALENDAR_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:calendar.read` |
| `google.drive.read` | `tool:google.drive.read`, `network:googleapis.com`, `secrets:GOOGLE_DRIVE_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:drive.read` |
| `gmail.write` | `tool:gmail.write`, `network:googleapis.com`, `secrets:GMAIL_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:gmail.write`, `external:send`, `email:send` |
| `google.calendar.write` | `tool:google.calendar.write`, `network:googleapis.com`, `secrets:GOOGLE_CALENDAR_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:calendar.write` |
| `google.drive.write` | `tool:google.drive.write`, `network:googleapis.com`, `secrets:GOOGLE_DRIVE_ACCESS_TOKEN`, `secrets:GOOGLE_ACCESS_TOKEN`, `google:drive.write` |
| `browser.read` | `tool:browser.read`, `network:http` |
| `shell.exec` | `tool:shell.exec`, `shell:exec` |

If a capability is missing, the executor returns failed feedback before the
tool is invoked. This is separate from `allowed_tools`: `allowed_tools` says
which tool name may run; `allowed_capabilities` says which side-effect classes
that tool may use.

`http.fetch` additionally enforces an SSRF boundary. It resolves DNS before
connecting, denies local/private/link-local/metadata/reserved targets, pins the
connection to the validated IP, and validates every redirect target. Redirects
are capped at 3 hops. If `BLUE_TANUKI_HTTP_ALLOWLIST` is set, the hostname must
match one of the comma/space-separated domains or its subdomains.

`file.search`, `file.write`, and `file.edit` additionally require
`BLUE_TANUKI_FILE_ROOT`. Requested paths resolve inside that sandbox and are
re-checked with `fs.realpath`; paths outside the sandbox and symlink escapes are
rejected. Secret-like paths such as `.env`, `.git`, `.ssh`, private key
filenames, and key/certificate files are not read or written.

`github.read` is read-only and unauthenticated. It is fixed to
`api.github.com` and supports public repo, issue, and pull request metadata.

`github.write` is authenticated, fixed to `api.github.com`, restricted by
`BLUE_TANUKI_GITHUB_REPOS`, and always L3 final-review. It supports initial
issue/PR/comment write operations only. Token values are never returned in tool
output.

Google read tools are authenticated, read-only, fixed to Google API hosts, and
mapped as credential access when OAuth token capabilities are present. Google
write tools are fixed to Google API hosts and always L3 final-review. Missing
Google tokens fail before a request is sent.

`browser.read` is a lightweight no-JavaScript page reader. It is not the future
headless Chromium automation backend; it fetches public pages through
`http.fetch` guards and returns bounded title/text/link extraction.

`shell.exec` runs a cwd-bounded non-shell spawn (`cmd` plus `args[]`) under
`BLUE_TANUKI_SHELL_ROOT`. It is a final-review operation because it carries
`shell:exec`; full access and reusable grants cannot bypass owner confirmation.
The root constrains cwd resolution only. It is not OS isolation and does not
prevent the spawned process from reading cwd-external paths such as
`/etc/passwd` unless a separate OS sandbox enforces that boundary.

Detector input is normalized immediately before scoring. HDS-BRAIN keeps raw
request content in the audit trace while scoring against NFKC-normalized content
with zero-width and bidi control characters removed. `DecisionLog.input`
contains `raw_content`, `normalized_content`, `changed`, and detected control
character metadata for post-incident analysis.

### 3.4 Explicit action routing

HDS-BRAIN can route explicit bounded tool requests to `tool_call` commands.
The supported text forms are:

```text
tool:file.search root=. query=needle max_results=5
tool:file.write path=notes/today.md content="hello" mode=create
tool:file.edit path=notes/today.md search=hello replace=hi expected_replacements=1
tool:http.fetch url=https://example.com method=HEAD
tool:web.search query="blue tanuki" max_results=5
tool:github.read resource=issues owner=gatchimuchio repo=blue-tanuki max_results=5
tool:github.write operation=issue.create owner=gatchimuchio repo=blue-tanuki title="Bug report" body="details"
tool:gmail.read query="newer_than:1d" max_results=5
tool:google.calendar.read calendar_id=primary days=1 max_results=5
tool:google.drive.read query="trashed=false" max_results=5
tool:gmail.write operation=draft.create to=owner@example.com subject="Draft" body_text="hello"
tool:google.calendar.write operation=event.create calendar_id=primary summary="Standup" start=2026-05-12T09:00:00Z end=2026-05-12T09:15:00Z
tool:google.drive.write operation=file.create name=notes.txt content="hello"
tool:browser.read url=https://example.com max_chars=4000
tool:shell.exec {"cmd":"git","args":["status","-sb"],"cwd":"."}
/tool echo text="hello"
tool:http.fetch {"url":"https://example.com","method":"GET"}
```

Structured channels may also send metadata:

```json
{
  "blue_tanuki.tool_call": {
    "tool_name": "file.search",
    "arguments": {
      "root": ".",
      "query": "needle"
    }
  }
}
```

Unknown explicit `tool:*` requests become `noop`; they are not passed to an LLM.

### 3.5 Command output delivery

Gateway renders user-visible command output consistently:

| Command result | Delivery |
| -------------- | -------- |
| `llm_call` success | assistant content |
| `tool_call` success | `[tool:<name>]` plus stable JSON |
| `noop` success | `[noop] <reason>` |
| failed non-channel command | `[failed:<type>] <error>` |
| `channel_send` | no echo, to avoid recursive sends |

Serve mode sends rendered output back to the originating channel. CLI mode logs
non-LLM rendered output as `command.output`.

---

## 4. Boot procedure

1. `pnpm install`
2. `pnpm build`
3. `WEBCHAT_TOKEN=<...> WEBCHAT_RESUME_TOKEN=<...> pnpm run doctor` — must show `Exit code: 0` or `1`.
   Exit code `2` means at least one **error** check failed; do NOT proceed.
4. `WEBCHAT_TOKEN=<...> WEBCHAT_RESUME_TOKEN=<...> [BLUE_TANUKI_AUDIT_DIR=<...>] pnpm gateway:serve`
5. From another shell, `curl http://127.0.0.1:8787/healthz` should return 200.

If this is the first boot pointed at a `BLUE_TANUKI_AUDIT_DIR`, the directory
will be created (`mkdir -p`) and the audit file will appear after the first
inbound request that produces a decision.

If this is a subsequent boot pointed at a directory that already has an
`audit.jsonl`, the chain will be loaded and verified before the gateway
accepts requests. A broken chain causes boot to throw; see §6.

---

## 4.1 Docker Compose Boot

The repository includes a single-host Docker packaging path:

```bash
WEBCHAT_TOKEN=<...> WEBCHAT_RESUME_TOKEN=<...> docker compose up --build
```

The compose service maps `${WEBCHAT_PORT:-8787}` to the same container port,
sets `WEBCHAT_HOST=0.0.0.0`, and stores audit/session data in the named
`blue_tanuki_data` volume under `/data`.

The image does not contain secrets. Pass `WEBCHAT_TOKEN`,
`WEBCHAT_RESUME_TOKEN`, and any provider/channel tokens through the deployment
environment. The runtime process runs as the non-root `blue-tanuki` user and
the container healthcheck probes `/healthz`.

---

## 4.2 Local Validation

GitHub Actions workflows are intentionally absent. Do not add
`.github/workflows/*.yml` as a quality gate.

For release or deployment work, run the local validation commands explicitly
from the target workspace or target OS. The normal local set installs with the
checked-in lockfile, then runs typecheck, build, tests, docs check,
repo/package/release gates, scoped smoke checks, `doctor`, release bundle
generation, and release verification.

Quality judgment comes from local command output and owner-run evidence packs,
not from GitHub runner status.

---

## 4.3 systemd Boot

The repository includes a single-host systemd template under `deploy/systemd/`.

Expected layout:

```text
/opt/blue-tanuki
/etc/blue-tanuki/blue-tanuki.env
/var/lib/blue-tanuki/audit
/var/lib/blue-tanuki/sessions
```

Install outline:

```bash
sudo useradd --system --home-dir /opt/blue-tanuki --shell /usr/sbin/nologin blue-tanuki
sudo mkdir -p /opt/blue-tanuki /etc/blue-tanuki /var/lib/blue-tanuki/audit /var/lib/blue-tanuki/sessions
sudo chown -R blue-tanuki:blue-tanuki /opt/blue-tanuki /var/lib/blue-tanuki
sudo cp deploy/systemd/blue-tanuki.service /etc/systemd/system/blue-tanuki.service
sudo cp deploy/systemd/blue-tanuki.env.example /etc/blue-tanuki/blue-tanuki.env
sudo chmod 600 /etc/blue-tanuki/blue-tanuki.env
sudoedit /etc/blue-tanuki/blue-tanuki.env
sudo systemctl daemon-reload
sudo systemctl enable --now blue-tanuki.service
```

The unit runs `node apps/gateway/dist/main.js --serve` from `/opt/blue-tanuki`.
Secrets remain in the environment file. `ExecStartPre` runs `--doctor` and
blocks start only for error exit code 2; warning exit code 1 remains allowed.

---

## 5. Diagnostics

### 5.1 `doctor`

```
WEBCHAT_TOKEN=<...> WEBCHAT_RESUME_TOKEN=<...> pnpm run doctor
```

Exit codes:

- `0` — all checks pass.
- `1` — one or more **warns** (e.g. optional connector tokens unset).
  Safe to proceed.
- `2` — one or more **errors** (missing required env, port unbindable,
  session/audit dir unwritable, Node.js too old, etc.). DO NOT proceed.

Doctor probes the audit dir for write access only. It does NOT verify
chain integrity. That is what `--audit-dump` is for.

### 5.2 `--audit-dump`

Read-only. Never appends, mutates, or rotates the file.

```
BLUE_TANUKI_AUDIT_DIR=<dir> pnpm --filter @blue-tanuki/gateway exec \
  tsx src/main.ts --audit-dump [--json]
```

Exit codes:

- `0` — chain valid (or no file yet, status `EMPTY`).
- `1` — chain broken or unparseable (`status=BROKEN`).
- `2` — `BLUE_TANUKI_AUDIT_DIR` unset (`status=SETUP-ERROR`).

The text view summarises one entry per line (`[NNNN] DECISION hashprefix… request_id=…`).
The JSON view (`--json`) emits the full structured chain — use this for
offline analysis. Reserved JSON top-level keys are `ts`, `level`,
`scope`, `msg`; user fields can never overwrite them.

### 5.3 Logs

The gateway logs to stdout/stderr. Operational lines look like
`[scope] msg key=value …`. Set `BLUE_TANUKI_LOG_FORMAT=json` for structured
output suitable for log aggregators. Set `BLUE_TANUKI_LOG_LEVEL=debug` to
see verbose decision-axis breakdowns.

### 5.4 Live-fire smoke

`pnpm smoke:live` is opt-in because it can call third-party APIs and post
test messages. With no live credentials it exits successfully with SKIP lines.

Configured checks:

- LLM: set `LLM_BACKEND` to a non-`stub` provider and configure its required
  env vars. This can be `anthropic`, `openai`, or `openai-compatible`.
- Slack Socket Mode: set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and
  `SLACK_LIVE_TARGET` to a channel/DM id the bot can post to.
- Discord Gateway: set `DISCORD_BOT_TOKEN` and `DISCORD_LIVE_TARGET` to a
  text channel id the bot can post to.
- Teams Graph send: set `MICROSOFT_GRAPH_ACCESS_TOKEN` and
  `TEAMS_LIVE_TARGET` to a test Teams `channel/...`, `reply/...`, or `chat/...`
  target the signed-in user can post to.
- LINE Messaging API push: set `LINE_CHANNEL_ACCESS_TOKEN` and
  `LINE_LIVE_TARGET` to a reachable test userId, groupId, or roomId.

For deploy gates that require at least one real API check, set
`BLUE_TANUKI_LIVE_REQUIRED=1`.

---

## 6. Failure modes and recovery

### 6.1 Audit chain fails to verify on boot

Symptom: gateway boot throws with
`AuditLog: chain verification failed on load from <path>`.

This means the on-disk JSONL file is no longer self-consistent. Common causes:

1. Manual edit of `audit.jsonl`.
2. Truncation by an external tool or a partial write during a hard kill.
3. Concurrent writer (the file was written by two gateway processes).

Recovery:

1. **Stop the gateway** if it is still running.
2. Run `--audit-dump --json` to see how far the chain got and at which
   index it broke. This is read-only and safe.
3. Decide whether the corrupted segment is acceptable to lose. Options:
   - Quarantine: `mv audit.jsonl audit-broken-$(date +%s).jsonl`. Boot
     starts a fresh chain at GENESIS.
   - Truncate at a known-good index: copy lines `[0..N]` to a new file,
     verify with `--audit-dump`, then atomically replace.
4. Re-boot the gateway. Confirm `--audit-dump` reports `status=ok`.

The chain is tamper-evident, NOT tamper-recoverable. There is no undo.
Quarantine is always a valid response.

### 6.2 SessionStore write failure

Symptom: log lines like `[executor] error: ENOSPC: no space left on device`.

Sessions are appended on success only, so a write failure surfaces as a
failed `executor.execute()`. The audit chain is unaffected because audit
writes go to a separate file under `BLUE_TANUKI_AUDIT_DIR`.

Recovery: free disk space, restart the gateway. Lost session history is
not recoverable; the next user message will start with empty context for
that `session_id`.

### 6.3 Port already in use

Symptom: gateway fails to bind, `EADDRINUSE`.

Recovery: identify the offender (`lsof -i :8787`), free the port or set
`WEBCHAT_PORT` to something else. Doctor's port-bind probe will catch
this before serve does.

### 6.4 SUSPEND backlog growing

Symptom: `listSuspended()` size keeps growing; no human is reviewing.

This is a policy/staffing issue, not a fault. Suspended requests sit in
HDS-BRAIN's in-memory map; they do NOT persist across restarts. A gateway
restart drops the entire suspend backlog.

Recovery: review and resume (`/resume` endpoint with `WEBCHAT_RESUME_TOKEN`,
the request-bound `approval_token`, and `verdict=approve|reject|block`).
If a backlog is genuinely abandoned, restart is acceptable — every suspend
that was lost has an audit entry on disk explaining what happened.

### 6.5 Slack/Discord/Teams/LINE channel not delivering

Symptom: preview channel logs a missing-token warning such as `[teams] WARN MICROSOFT_GRAPH_ACCESS_TOKEN unset - running in silent mode`.

This is the fail-closed silent mode. Outbound dispatch returns `delivered:
false` with typed delivery fields:

- `error_kind=recoverable`: rate limit or transient transport failure; retry
  after `retry_after_ms` when present.
- `error_kind=non_recoverable`: token, target, app permission, channel
  membership, or channel type must be fixed before retry.

Recovery: set the required token(s), verify the live target is a safe test
channel/chat/user/group, restart, then run live smoke. Doctor reports optional
token presence so deployment scripts can check this without booting.

---

## 7. Audit-chain operations

### 7.1 Routine inspection

```
BLUE_TANUKI_AUDIT_DIR=<dir> pnpm --filter @blue-tanuki/gateway exec \
  tsx src/main.ts --audit-dump
```

Read this regularly as part of normal operations to confirm decisions are
flowing and the chain is intact. The text view is human-friendly; redirect
JSON output to a file for offline analysis.

### 7.2 Rotation

There is no in-process rotation. If the audit file grows large enough to
matter:

1. Stop the gateway.
2. `mv audit.jsonl audit-$(date +%Y%m%d).jsonl`
3. Start the gateway. A fresh chain begins at GENESIS.

Each rotated file remains a self-verifiable chain via `--audit-dump`.

### 7.3 Off-host archival

The audit file is plain JSONL with no secrets in field names (only what
you put in `request.content`). Standard tools (`rsync`, S3 sync) work.

---

## 8. Deploy checklist

For live deploys, run `pnpm smoke:live` with
`BLUE_TANUKI_LIVE_REQUIRED=1` after the offline smoke scripts. For local
development it is acceptable for every live check to report SKIP.

- [ ] `pnpm install`
- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` — all green
- [ ] `pnpm smoke:serve` / `pnpm smoke:resume` when validating runtime, root smoke behavior, release, or operator setup
- [ ] `pnpm smoke:live` — green for every configured real provider, or SKIP is
      explicitly accepted for this deployment
- [ ] `pnpm validate:packaging` — green if packaging files are in use
- [ ] `pnpm release:bundle` and `pnpm release:verify` pass before distributing
      a portable archive
- [ ] If using portable installers, post-install `doctor` passes or exits with
      warnings only
- [ ] If upgrading a portable install, preserve env config unless a reset is
      intentional
- [ ] If changing settings or resetting config, confirm the generated `.bak`
      env backup exists before deleting any old configuration
- [ ] `pnpm release:verify` passes with no secret-like backup/path findings
- [ ] If removing a portable install, choose default uninstall for data
      retention or purge mode for full local data removal
- [ ] `pnpm --filter @blue-tanuki/gateway run doctor` with target env — exit code 0 or 1
- [ ] `BLUE_TANUKI_AUDIT_DIR` is on a persistent volume (not `/tmp`)
- [ ] `BLUE_TANUKI_AUDIT_DIR` writable by the gateway user
- [ ] `WEBCHAT_TOKEN` is unique to this deployment and stored in a secret
      manager
- [ ] `WEBCHAT_RESUME_TOKEN` is unique, stored in a secret manager, and differs
      from `WEBCHAT_TOKEN`
- [ ] If using Docker, `docker compose config` succeeds with the target env
- [ ] If using Docker, the `/data` volume policy matches audit/session
      retention requirements
- [ ] If using systemd, `/etc/blue-tanuki/blue-tanuki.env` is chmod 600 and
      contains distinct WebChat tokens
- [ ] If using systemd, `/var/lib/blue-tanuki` is writable by the
      `blue-tanuki` user
- [ ] If `LLM_BACKEND=anthropic`, `ANTHROPIC_API_KEY` present
- [ ] Channel tokens (Slack/Discord/Teams/LINE) set or explicitly omitted

---

## 9. What this runbook does NOT cover

- Plugin manifest authoring and loader specifics — see `docs/plugin-manifest.md`.
- Architecture and the upstream-containment property — see `docs/architecture.md`.
- HDS policy tuning — see the policy section of `docs/architecture.md`.
- Phase-by-phase rollout history — see the per-phase notes
  under `docs/history/`.
