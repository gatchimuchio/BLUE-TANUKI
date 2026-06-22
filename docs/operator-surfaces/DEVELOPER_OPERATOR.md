# Developer Operator

Phase 11-S8 implements this surface in `packages/operator-developer/` and exposes its state through the Gateway runtime snapshot and WebChat `/operators/developer` endpoints.

The surface snapshot also exposes `operation_core_projection`, a read-only Operation Core view for Control Center. Shell execution is projected as `adapter=shell`, `adapter_is_authority=false`, and `command_generated_by_adapter_only=true`.

## 1. Purpose

Developer Operator is the first-party surface for code-reading, code-editing support, local file work, guarded shell execution, GitHub operations, and browser preview work under HDS-BRAIN authority.

It is a Layer A surface and does not create a developer-mode authority bypass.

## 2. Scope (in-scope user goals)

- inspect local code and docs through configured file tools
- write or edit sandboxed local files
- prepare shell commands for final review
- inspect GitHub repositories, issues, and pull requests
- create GitHub issues/PRs/comments through final-review
- use browser preview tools within their disabled-by-default boundary

Developer Operator may prepare process-backed work, but shell execution is represented as a ShellAdapter step under Operation Core. The raw command is not the operation authority object.

## 3. Non-Goals (out-of-scope user goals)

- unrestricted shell
- unrestricted filesystem access
- hidden git or GitHub mutations
- browser automation promotion to first-party
- credential reuse through browser profiles
- replacing Codex or human code review

## 4. Required Downstream Tools (existing tools)

Developer Operator reuses:

- `file.search`, `file.write`, `file.edit`
- `shell.exec`
- `github.read`
- `github.write`
- `browser.snapshot`
- `browser.automation`
- `channel_send`

No new raw filesystem, process, GitHub, or browser capability is introduced in Phase 11-S8.

## 5. Approval Levels per Operation (L1/L2/L3 ApprovalLevel + ApprovalRisk)

| Operation | ApprovalLevel | ApprovalRisk | Notes |
|---|---|---|---|
| local file read/search in sandbox | L1_observe | low | bounded by `BLUE_TANUKI_FILE_ROOT` |
| github.read | L1_observe | low | read-only |
| browser.snapshot | L2_operate | medium | preview and public-address guards apply |
| local file write/edit in sandbox | L2_operate | medium | existing file tool boundary applies |
| shell.exec | L3_final_review | high | ShellAdapter only; final-review always required |
| github.write | L3_final_review | high | external write |
| browser.automation mutation/credential action | L3_final_review | high | preview remains disabled-by-default |

## 6. Audit Trace Requirements (authority trace items)

Developer operations must record:

- `surface=developer`
- file path hash or bounded path metadata
- shell command digest and sandbox root
- Operation Core adapter metadata where available (`adapter_is_authority=false`)
- GitHub owner/repo/resource summary
- browser URL origin and action class
- ApprovalLevel / ApprovalRisk / final-review result
- mutation result digest for writes

## 7. Failure Modes (owner next action)

- file root unset: set `BLUE_TANUKI_FILE_ROOT`
- path outside sandbox: choose an allowed path
- shell root unset: set `BLUE_TANUKI_SHELL_ROOT`
- shell final-review missing: approve or cancel
- GitHub token missing: set `GITHUB_TOKEN`
- GitHub repo denied: update `BLUE_TANUKI_GITHUB_REPOS`
- browser preview disabled: set preview env only when intended
- browser guard denial: use an allowed public address and no credentialed profile

## 8. Layer Boundary (Layer A vs Layer B)

Developer Operator is Layer A. Layer B plugins may add language helpers, templates, repo analyzers, or local validation parsers, but cannot widen file roots, run shell, mutate GitHub, or automate browser actions outside the existing Approval Gate and capability envelope.

## 9. Shared Substrate Usage

Developer Operator uses the shared substrate for:

- file/process/external write approval mapping
- capability declaration enforcement
- audit-safe mutation summaries
- browser preview quarantine
- Operation Core projection
- Runtime Invariants preservation

## 10. Conformance Test Requirements (Phase 11-S8 target)

Phase 11-S8 adds tests for:

- Developer surface registration
- L1 file/GitHub read paths
- L2 file write path
- L3 shell and GitHub write paths
- browser preview disabled-by-default
- audit trace completeness
- final-review bypass denial
- capability envelope preservation

## 11. Cross-References

- [Shared Substrate](SHARED_SUBSTRATE.md)
- [Capability Envelope](../CAPABILITY_ENVELOPE.md)
- [Conformance](../CONFORMANCE.md)
- [GitHub write phase](../phase8-s4-github-write.md)
- [Phase 11-S8 Developer Operator Implementation](../phase11-s8-developer-operator.md)
- [Security](../../SECURITY.md)
