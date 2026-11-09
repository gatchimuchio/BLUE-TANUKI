# Plugin Manifest Specification

Status: Phase 5-S2 (workspace loader + enforcement)
Schema: `@blue-tanuki/protocol` → `PluginManifestSchema`
Filename: `blue-tanuki.plugin.json` (one per package, at the package root)

## Purpose

Each blue-tanuki package carries a manifest that declares:

- What kind of extension it is (`core` / `channel` / `llm` / `tool` / `detector`)
- Its entry module
- Named exports relevant for runtime wiring
- Runtime permissions it expects (network, secrets, filesystem)

The manifest is the single source of truth that the workspace loader, security
audits, and the `doctor` command read to reason about package shape and surface
area.

## Current Phase 5-S2 scope

What this phase ships:

- The schema (this document + `PluginManifestSchema` zod object).
- A manifest in every existing package, with values consistent with that package's `package.json`.
- Read/validate utilities (`readManifest`, `validateManifest`, `manifestPathFor`, `MANIFEST_FILENAME`).
- Tests that lock down both the schema and the bundled manifests.
- Gateway workspace discovery through `pnpm-workspace.yaml`.
- Workspace-only dynamic import of manifest `entry` modules.
- Manifest-driven registration for built-in tools and channel classes.
- Boot-time permission enforcement for declared tool/channel/LLM/session/audit
  capability use.

What this phase explicitly does **not** ship:

- External npm package plugin discovery.
- Hot reload or runtime permission mutation.
- Detector plugin loading.
- A generic third-party config schema flow.

The loader and permission enforcement are intentionally shipped together so no
half-checked security boundary is live.

## Schema

```jsonc
{
  "name":          "string (required, must match package.json name)",
  "version":       "string (required, should match package.json version)",
  "kind":          "core | channel | llm | tool | detector (required)",
  "entry":         "string (required, path to entry module from package root)",
  "exports":       "{ [key: string]: string } (default: {})",
  "config_schema": "string (optional, path to a config schema file)",
  "permissions":   "string[] (default: [])",
  "description":   "string (optional)"
}
```

### `kind`

| Value      | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `core`     | Library or runtime piece. Not user-pluggable today.       |
| `channel`  | Inbound and/or outbound channel adapter.                  |
| `llm`      | LLM backend implementation.                                |
| `tool`     | Executor tool registered into `ToolRegistry`.             |
| `detector` | HDS-BRAIN axis detector.                                  |

`core` exists so that every package can ship a manifest, including ones that are not extension points themselves. This keeps the validation rule simple: every package has a manifest, every manifest matches the schema.

### `exports`

Free-form `{ key: string }` map. The future loader will consult `exports[kind]` first (e.g. `exports.channel` for a `kind: "channel"` plugin) and fall back to `exports.default`. The string is treated as a named export from the entry module; a value of `"*"` means "the namespace object itself".

### `permissions`

Declaration of expected runtime side effects. The format is `<scope>:<target>`. The schema accepts any non-empty string so new scopes can be introduced without revving the spec; the conventions below are documented expectations rather than validated patterns.

| Scope                    | Meaning                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `network:<host>`         | Outbound HTTP/WS to `<host>`.                              |
| `network:listen`         | Opens a listening socket.                                  |
| `secrets:<env_var>`      | Reads `<env_var>` from `process.env`.                      |
| `fs:read:<rel_path>`     | Reads under `<rel_path>` (relative to a configured root).  |
| `fs:append:<rel_path>`   | Appends under `<rel_path>`.                                 |
| `fs:write:<rel_path>`    | Writes (read-modify-write or rename) under `<rel_path>`.    |
| `tool:<name>`            | Executor tool capability used by `allowed_capabilities`.    |
| `network:http`           | Generic HTTP client capability for gated tools.             |
| `network:github.com`     | GitHub API capability fixed to `api.github.com`.            |
| `network:googleapis.com` | Google API capability fixed to Google read hosts.           |
| `network:graph.microsoft.com` | Microsoft Graph capability for Teams preview send.     |
| `network:api.line.me`    | LINE Messaging API capability for LINE preview send.        |
| `github:issue.write`     | GitHub issue create/update capability.                      |
| `github:pr.write`        | GitHub pull request create capability.                      |
| `github:comment.write`   | GitHub issue/PR comment create capability.                  |
| `github:code.write`      | Reviewed new-file commit to an existing non-default branch. |
| `google:gmail.read`      | Gmail read-only summary capability.                         |
| `google:calendar.read`   | Google Calendar read-only summary capability.               |
| `google:drive.read`      | Google Drive read-only metadata/search capability.          |
| `google:gmail.write`     | Gmail draft/send capability.                                |
| `google:calendar.write`  | Google Calendar event write capability.                     |
| `google:drive.write`     | Google Drive file create/update capability.                 |
| `external:send`          | Sends content to an external party.                         |
| `email:send`             | Email send capability.                                      |
| `shell:exec`             | Runs a bounded non-shell child process after Approval Gate. |
| `channel:send`           | Sends through an outbound channel.                          |

`<rel_path>` is allowed to be a logical name (e.g. `audit_dir`, `session_dir`) rather than a literal path; the host configuration resolves it.

`network:*` is reserved for future use. Production manifests must enumerate the hosts they touch.

### Runtime command capabilities

S6 added enforcement at the executor boundary. A tool declares
`required_capabilities`; a `tool_call` command must include every required
entry in `constraints.allowed_capabilities`. Missing entries fail before the
tool is invoked. Phase 5-S2 adds boot-time package-level enforcement:
registered tools must also be backed by package manifest permissions.
`permissions` is the package-level envelope; `allowed_capabilities` is the
per-command envelope produced by the upstream control layer.

## Validation rules locked in by tests

- `name`, `version`, `entry` are non-empty.
- `kind` is one of the five enum values.
- `permissions` array entries are non-empty strings.
- A manifest's `name` and `version` match the sibling `package.json`.
- A manifest's `entry` is `./dist/index.js` for every existing package.

These rules live in `packages/protocol/test/manifest.test.ts` and are also
checked by the gateway doctor path.

## Boundary with HDS-BRAIN audit

Manifests are documentation and runtime configuration. They are **not** part of HDS-BRAIN's hash-chained audit log and **must not** be appended to the same files. See `docs/persistence-boundary.md`.

## Future work

1. Detector plugin loading into `DetectorRegistry`.
2. Manifest-driven config validation via `config_schema`.
3. Optional stricter host-level network policy beyond the current capability
   names.
4. External package plugin discovery, only after a stronger trust model exists.
