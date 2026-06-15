# Composio Connector

Composio is an optional external tool/API connector.

It is not a model provider, not authority, not an approval source, and not a
required runtime dependency.

## Layer

```text
Composio = external tool/API connector layer
BLUE-TANUKI = HDS-BRAIN, capability envelope, Approval Gate, audit, recovery
```

Composio groups external service tools through toolkits and tools. BLUE-TANUKI
uses that concept only behind an explicit allowlist and dry-run boundary.

References:

- <https://docs.composio.dev/docs/tools-and-toolkits>
- <https://docs.composio.dev/docs/authentication>

## Current Scope

Current implementation is a dry-run-default connector with explicit live opt-in:

- `composio.search`
- `composio.execute`

`COMPOSIO_DRY_RUN` defaults to `true`. In that mode `composio.execute` returns
dry-run evidence and sends no external request.

Live execution opens only when all live preconditions are true:

- `COMPOSIO_DRY_RUN=false`
- `COMPOSIO_LIVE_EXECUTION=true`
- `COMPOSIO_USER_ID` is set
- `COMPOSIO_ALLOWED_TOOLKITS` includes the requested toolkit
- `COMPOSIO_ALLOWED_ACTIONS` includes the requested toolkit/action pair
- `COMPOSIO_REVOKED_ACTIONS` does not match the requested action
- HDS-BRAIN routes the command through capability checks and Approval Gate L3
  final review
- Executor receives a human final-review approval proof before execution

Live execution uses the Composio v3.1 tool execution API and a bounded timeout.
The gateway records pre/post authority events plus executor feedback in the HDS
hash-chain audit.

## Configuration

```bash
COMPOSIO_API_KEY=...
COMPOSIO_USER_ID=...
COMPOSIO_ALLOWED_TOOLKITS=github,gmail,calendar,drive,slack
COMPOSIO_ALLOWED_ACTIONS=github:GITHUB_CREATE_AN_ISSUE
COMPOSIO_REVOKED_ACTIONS=
COMPOSIO_DRY_RUN=true
COMPOSIO_LIVE_EXECUTION=false
```

The allowlist is required. If `COMPOSIO_API_KEY` is present but
`COMPOSIO_ALLOWED_TOOLKITS` is empty, the connector fails closed.

The Windows installer stores these settings in:

```text
%APPDATA%\BlueTanuki\blue-tanuki.env
```

Do not store Composio keys in the install directory.

## Tool Use

Search metadata:

```text
tool:composio.search toolkit=github query=issues
```

Dry-run execution:

```text
tool:composio.execute toolkit=github tool=issues.create payload="{\"title\":\"hello\"}"
```

`composio.execute` requires:

- `tool:composio.execute`
- `network:composio.dev`
- `secrets:COMPOSIO_API_KEY`
- `external:send`

Those capabilities make the operation high-risk and L3 final-review gated.

For live execution, keep the same tool command but set the live env values above
only after owner review. Missing key/user id/allowlist, dry-run mode, live opt-in
absence, revoked action, Approval Gate rejection, executor approval proof
absence, timeout, or Composio API failure all fail closed before claiming a
confirmed mutation.

## Authority Boundary

- Composio tool discovery is not authority.
- Composio metadata is not authority.
- Connected account status is not authority.
- Tool schema is not permission.
- Tool result is not approval.
- Dry-run output is not permission.
- External write/send/delete/create/update actions require Approval Gate.

The connector returns `used_for_authority=false` and
`metadata_used_for_authority=false` in its safe projections.

## Native-First Policy

Native/direct tool/API connectors remain canonical.

Composio is a convenience adapter for aggregated API access. Missing Composio
must not break local tools, native GitHub tools, native Google tools, first-party
channels, or future direct OAuth/API connectors.

## Verification

Tests cover:

- missing key fails safely,
- explicit toolkit allowlist is enforced,
- search metadata cannot grant permission,
- dry-run prevents real external execution,
- live execution requires dry-run off, live opt-in, user id, toolkit/action
  allowlists, and non-revoked action,
- write/send/delete-like actions remain approval-gated,
- approved fixture commands reach the Composio v3.1 execution endpoint,
- pre/post authority events and executor feedback close the audit path,
- secrets do not appear in connector output.
