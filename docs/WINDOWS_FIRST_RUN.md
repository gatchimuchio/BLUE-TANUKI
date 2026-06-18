# Windows First Run

This first-run path is for the unsigned Windows installer package, not source
development.

Normal Windows users should not run source builds. Download
`blue-tanuki-<version>-windows-x64-installer.zip`, extract it, and run
`BlueTanukiSetup.cmd`.

## Before Install

The Windows package is unsigned. Before running `BlueTanukiSetup.cmd` from the
extracted installer folder, verify the
zip digest against the release `.sha256` sidecar:

```powershell
Get-FileHash -Algorithm SHA256 .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip
Get-Content .\blue-tanuki-1.0.0-rc.1-windows-x64-installer.zip.sha256
```

If SmartScreen warns, continue only after the SHA-256 digest matches the
sidecar. A mismatch means the package must not be run.

## First Launch

1. Install with `BlueTanukiSetup.cmd` from the extracted installer folder.
2. Start `BLUE-TANUKI` from the Start Menu.
3. The launcher starts the local resident gateway.
4. The browser opens `http://127.0.0.1:8787/app`.

The Control Center must expose:

- Home / Tanuki Dashboard,
- Conversation / WebChat,
- Approvals,
- Activity / Audit,
- Doctor / Health,
- Settings,
- Logs / Developer Evidence.

## Stub Mode

The generated env file defaults to stub LLM mode. This means the first
conversation can run without external API credentials.

Use the `Conversation / WebChat` panel:

1. Paste the WebChat token from `%APPDATA%\BlueTanuki\blue-tanuki.env`.
2. Click `Connect`.
3. Send a short message.
4. Confirm a `channel_send` response or a clear backend error.

The token is browser session UI state only. It is not authority and is not a
permission grant.

## Doctor / Health

The `Doctor` screen shows live runtime health from the existing runtime snapshot
surface. The Start Menu `BLUE-TANUKI Doctor` shortcut runs the full Doctor and
writes:

```text
%APPDATA%\BlueTanuki\logs\doctor.json
```

Doctor output is diagnostic evidence. It does not grant authority, approve
actions, or certify GA release readiness.

## Settings

Settings are stored in:

```text
%APPDATA%\BlueTanuki\blue-tanuki.env
```

Use Settings to verify non-stub LLM provider configuration before saving. API
keys must not appear in logs, audit, runtime snapshot, or Control Center
projections. When saved through Settings on Windows, LLM API keys are stored as
DPAPI CurrentUser secret references and the env file keeps only the reference.

Optional adapters can also be configured here:

- OpenRouter as a model provider (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`).
- Composio as an external tool connector (`COMPOSIO_API_KEY`,
  `COMPOSIO_ALLOWED_TOOLKITS`, `COMPOSIO_DRY_RUN=true`).

These are convenience adapters. Native/direct providers and native/local tools
remain canonical. Missing OpenRouter or Composio settings are non-fatal for
stub-mode first-run.

## Stop / Restart

Use Start Menu shortcuts:

- `BLUE-TANUKI Stop`
- `BLUE-TANUKI Safe Mode`
- `BLUE-TANUKI`

The launcher stores runtime logs under:

```text
%APPDATA%\BlueTanuki\logs
```

If first launch reports `port_conflict=<host>:<port>`, another local process is
using the configured WebChat port. Stop that process or change `WEBCHAT_PORT` in
`%APPDATA%\BlueTanuki\blue-tanuki.env`, then start BLUE-TANUKI again.

Use `BLUE-TANUKI Safe Mode` for recovery. It starts the local Control Center
with stub LLM mode and disables external provider keys, connector keys,
channel tokens, daily brief, and schedules for that launch.
