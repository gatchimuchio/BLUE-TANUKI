# Plugin HIG

## 1. Purpose

Plugin HIG defines the human and LLM readability standard for Layer B extension code.

Plugin code must be understandable enough that Codex, reviewers, and the owner can audit capability, boundary, side effect, and failure behavior without guessing.

## 2. Claude-Readable Code Principle

Plugin code must be Claude-readable:

- small modules
- explicit names
- visible input/output types
- no hidden control flow
- no unexplained dynamic import or runtime code generation
- no clever compression that hides behavior

Readable code is a safety requirement, not style preference.

## 3. Boundary Clarity Requirements

Every plugin must make clear:

- what it reads
- what it writes
- what network host it contacts
- what credential it uses
- what downstream operation it invokes
- what it never does

Boundary comments are required around authority-adjacent code.

## 4. Type Visibility Requirements

Types must expose:

- request shape
- response shape
- error shape
- capability declarations
- audit metadata shape
- owner next action fields

Opaque `any` or untyped dynamic blobs are rejected unless isolated at an external API edge and normalized immediately.

## 5. No Hidden Side Effects

Plugins must not:

- mutate files outside declared paths
- send network requests outside declared hosts
- spawn processes without declared process capability
- read credentials without declared credential capability
- persist state without documented storage
- perform retries that hide final mutation status

Side effects must be explicit and audit-compatible.

## 6. Authority Boundary Comments

Authority-adjacent sections must state:

- this code is downstream only
- this code does not approve operations
- this code does not alter HDS-BRAIN policy
- this code does not treat metadata as authority
- this code returns evidence or result only

Comments must clarify real boundaries, not restate obvious lines.

## 7. Error Return Owner Next Action

Errors must include:

- recoverable / non-recoverable classification
- whether mutation was sent
- whether retry is safe
- what the owner should fix
- which doc or config key applies

Silent failure and vague "failed" errors are rejected.

## 8. Conformance Test Inclusion

Every plugin must include tests for:

- declared capability use
- undeclared capability rejection
- typed recoverable and non-recoverable errors
- audit trace compatibility
- authority non-bypass
- credential redaction

## 9. Naming Conventions

Names must be explicit:

- package names identify the plugin domain
- operation names identify side effect class
- capability names match `docs/CAPABILITY_ENVELOPE.md`
- audit fields use stable snake_case or existing repository conventions
- error fields use `next_action`, `error_kind`, and `mutation_status` where applicable

Do not use marketing names for privileged operations.

## 10. v1.0 HIG Stability Boundary

This HIG is contract-stable for v1.0 RC.

For v1.0, "stable" means reviewers, Codex, and the owner can rely on the readability, type visibility, side-effect declaration, authority-boundary comment, owner-next-action, and conformance expectations in this document when applying Plugin Review Gate. It does not mean plugin behavior is authority, that preview support status is promoted, or that third-party code is trusted after review.

Any post-v1 expansion that weakens these requirements, adds hot reload, allows external dynamic import, accepts opaque capability blobs, or treats plugin metadata as authority requires a dedicated security phase.

## 11. Cross-References

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [LLM Development Guide](LLM_DEVELOPMENT_GUIDE.md)
