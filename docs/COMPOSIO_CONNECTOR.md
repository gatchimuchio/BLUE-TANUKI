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

Current implementation is a dry-run connector substrate:

- `composio.search`
- `composio.execute`

Live Composio execution is intentionally not enabled in this phase.

`COMPOSIO_DRY_RUN` defaults to `true`. If set to `false`, the connector still
fails closed because live execution is not implemented yet.

## Configuration

```bash
COMPOSIO_API_KEY=...
COMPOSIO_ALLOWED_TOOLKITS=github,gmail,calendar,drive,slack
COMPOSIO_DRY_RUN=true
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
- write/send/delete-like actions remain approval-gated,
- secrets do not appear in connector output.
