# Repository Health Inventory

この inventory は core release path のスリムダウン用 baseline である。機能追加ではなく、CORE / PREVIEW / ARCHIVE / DEAD の責務境界を明示する。

## Classification

| Area | Classification | Reason |
|---|---:|---|
| `packages/hds-brain` | CORE | HDS-BRAIN authority kernel, Approval Gate, audit, Runtime Invariants, self-health |
| `packages/protocol` | CORE | HDS / gateway / downstream command schema and manifest schema |
| `packages/blue-tanuki` | CORE | downstream executor, session store, built-in tools |
| `apps/gateway` | CORE | local owner runtime entry, WebChat/Telegram bridge, doctor/setup/audit CLI adapter |
| `packages/channel-webchat` | CORE | first-party local Control Center / WebChat surface |
| `packages/channel-telegram` | CORE | first-party starter external channel |
| `packages/channel-base` | CORE | shared downstream channel adapter substrate |
| `packages/channel-slack` | PREVIEW | first-party-preview channel; not core release blocker |
| `packages/channel-discord` | PREVIEW | first-party-preview channel; not core release blocker |
| `packages/channel-teams` | PREVIEW | first-party-preview channel; not core release blocker |
| `packages/channel-line` | PREVIEW | first-party-preview channel; not core release blocker |
| `packages/operator-daily` | CORE | first-party Layer A Daily Operator surface; plugin-loader discovered downstream package |
| `packages/operator-developer` | CORE | first-party Layer A Developer Operator surface; plugin-loader discovered downstream package |
| `packages/operator-writing` | CORE | first-party Layer A Writing Operator surface; plugin-loader discovered downstream package |
| `install/linux` | CORE | supported Linux guided install and launch surface |
| `install/macos` | CORE | supported macOS guided install and launch surface |
| `install/windows/product` | CORE | Windows product installer artifact surface; no owner GO/public GA claim implied |
| `install/windows/install.ps1` / `install/windows/uninstall.ps1` | PREVIEW | Windows source installer helpers; not core release claim |
| `install/installer` | PREVIEW | guided installer acceleration; not an authority path |
| `install/resident` | CORE | resident launch helper required by portable install launchers; not authority core |
| `docs/IMPLEMENTATION_INSTRUCTIONS.md` | CORE | active implementation source of truth |
| `docs/known-environment-failures.md` | CORE | validation failure classification |
| `docs/history/*` | ARCHIVE | historical phase evidence, not active release instruction |
| `docs/phase*.md` | ARCHIVE | historical phase reports unless referenced by release gates |
| `docs/ROADMAP.md` | ARCHIVE | high-level context only; active file is implementation instructions |
| root `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts` | CORE | workspace, validation, build/test graph |

## Scripts

| Script | Classification | Action |
|---|---:|---|
| `scripts/typecheck.mjs` | CORE | kept; wraps TypeScript project references |
| `scripts/check_docs.mjs` | CORE | kept; release docs consistency gate |
| `scripts/validate_packaging.ts` | CORE | kept; package/release path validation |
| `scripts/repo_health_gate.ts` | CORE | kept; regression gate for runtime import purity and preview/core release boundary |
| `scripts/create_release_bundle.ts` | CORE | kept; release bundle production |
| `scripts/verify_release_bundle.ts` | CORE | kept; release verification |
| `scripts/smoke_serve.ts` | CORE | kept; root workspace smoke entrypoint |
| `scripts/smoke_resume.ts` | CORE | kept; root workspace resume smoke entrypoint |
| `scripts/ga_promotion_gate.ts` | CORE | kept; GA claim boundary |
| `scripts/channel_promotion_gate.ts` | PREVIEW | kept for preview channel promotion evidence |
| `scripts/plugin_review_gate.ts` | PREVIEW | kept for Layer B review gate |
| `scripts/clean.mjs` | CORE | kept; native pnpm has no workspace dist/tsbuildinfo cleanup equivalent |
| `scripts/pnpm_exec.mjs` | DEAD | removed; native pnpm workspace/filter scripts replace it |

## Entrypoints

| Entrypoint | Classification | Responsibility |
|---|---:|---|
| `apps/gateway/src/main.ts` | CORE | thin process entry only |
| `apps/gateway/src/runtime.ts` | CORE | production CLI one-shot runtime wiring |
| `apps/gateway/src/serve.ts` | CORE | long-running WebChat/channel runtime |
| `apps/gateway/src/cli_router.ts` | CORE | diagnostic/setup/audit command router |
| `apps/gateway/src/doctor.ts` | CORE | configuration and local runtime diagnostics |
| `apps/gateway/src/setup.ts` | CORE | guided setup adapter |
| `apps/gateway/src/audit_dump.ts` / `audit_verify.ts` | CORE | audit inspection tools, not production runtime imports |
| `apps/gateway/src/smoke_live.ts` | PREVIEW | credential-dependent live smoke path |

## Workspace Graph

- tsconfig references include CORE and PREVIEW packages so typecheck covers the full repository.
- core release path is CORE-first; PREVIEW package type/test coverage may remain in validation without becoming release scope.
- `apps/gateway` hard dependencies are core-only. Preview adapters are discovered through plugin manifests in the full workspace and skipped when absent from the extracted core release bundle. Operator packages are first-party Layer A core release packages, but still load through plugin manifests and permission checks rather than hard Gateway imports.
- core release bundle allowlist is declared by `PRODUCT_SCOPE_CORE_RELEASE_PATHS` in `packages/protocol/src/product_scope_contract.ts`; preview channel packages, the guided installer dev package, Windows source installer helpers, and credential-dependent live smoke are excluded from that allowlist. macOS/Linux portable installer entrypoints, Windows product installer artifacts, and resident helpers are included as release install surfaces, not as HDS authority code.

## Health Phase Decisions

- native Linux / WSL baseline uses Corepack pnpm 9.12.0.
- Windows-native fallback wrappers are not added.
- production runtime entry no longer imports doctor/audit/setup modules directly; those are command-gated dynamic imports from `cli_router.ts`, and the eager `main -> cli_router` graph does not load serve/runtime/doctor/setup/audit tools.
- `serve.ts` no longer imports audit dump formatting or operator package runtime constants; operator packages remain plugin-loaded downstream surfaces and are skipped when absent from core release extraction.
- raw inbound objects must pass strict boundary validation and canonicalization before HDS-BRAIN receives an authority frame. Invalid gateway inbound values are replaced with a safe fallback request and only boundary failure metadata is recorded.
- gateway now supplies self-health probes for required runtime directories, configured memory file appendability, audit appendability, process telemetry, audit chain validity, and Runtime Invariants. The serve-time probe is repair-capable and may create configured runtime directories; read-only mode is available for non-mutating checks. Runtime evidence uses PASS / WARN / FAIL / UNKNOWN and remains `used_for_authority=false`. Persistent audit and memory-only audit are distinguished.
- core doctor treats missing preview credentials as WARN with `exit_code=0`; `doctor --preview` and `doctor --strict` fail missing credentials for their selected validation scope.
- `repo_health_gate` uses the TypeScript AST for import / export / literal dynamic import detection, ignores comments and plain strings, and fails non-literal dynamic imports in the production CLI graph.
- `release:verify` extracts the bundle and verifies install/build/doctor/`validate:repo-health` inside the extracted core release tree.
- extracted core release doctor treats absent Slack / Discord / Teams / LINE packages, guided installer helper sources, resident helper sources, and non-Linux platform helper scripts as intentional preview limitations because the source bundle includes only the core release allowlist plus docs and Linux install scripts.

## Gate Limits

`pnpm validate:repo-health` is a static source regression gate. It does not execute runtime branches, prove external package side effects, or replace build/test/release verification. It specifically protects the known health regressions: custom pnpm wrapper revival, eager production import graph drift, hard preview gateway dependencies, missing preview documentation, and preview paths entering the core release allowlist.

## Failure Classification

| Classification | Meaning | Release blocker |
|---|---|---:|
| environment | host/tooling problem such as missing pnpm, broken Corepack, network outage, or unavailable external credentials | no, unless the required validation environment cannot be restored |
| credential | optional live-smoke credential or live target absent | no for core release; yes only for an owner-declared credentialed promotion gate |
| product regression | validation, docs, authority, package graph, release bundle, doctor, or local gate failure caused by repository behavior | yes |
| intentional preview limitation | preview package/credential/surface absent from core release by design | no |

## Phase 2 Added Docs

- `docs/production-import-graph.md`
- `docs/preview-scope.md`
