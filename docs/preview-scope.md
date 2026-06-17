# Preview Scope

この文書は core release path から外す実体を明示する。削除ではなく隔離を優先し、workspace typecheck/test は維持する。

## Core Release Include

- `apps/gateway`
- `packages/hds-brain`
- `packages/protocol`
- `packages/blue-tanuki`
- `packages/channel-base`
- `packages/channel-webchat`
- `packages/channel-telegram`
- `packages/operator-writing`
- `packages/operator-daily`
- `packages/operator-developer`
- `install/linux`
- `install/macos`
- `install/resident`
- core validation scripts and active docs

## Preview / Archive Exclude

- `packages/channel-slack`
- `packages/channel-discord`
- `packages/channel-teams`
- `packages/channel-line`
- `install/installer`
- `install/windows`
- `apps/gateway/src/smoke_live.ts`
- historical `docs/phase*.md` and `docs/history/*`

Preview items remain downstream-only. Missing preview credentials are WARN in core doctor and do not fail core health. `doctor --preview` validates preview channel readiness; `doctor --strict` validates all optional surfaces strictly.

Writing / Daily / Developer Operator packages are Layer A first-party core release packages. They remain plugin-loader discovered downstream surfaces rather than hard Gateway dependencies, so package presence, manifest review, and permission enforcement are visible before the surface is loaded.

`apps/gateway` does not carry hard workspace dependencies on preview channel packages. In the full workspace those packages are discovered through plugin manifests; in the extracted core release bundle preview channels are absent and skipped. Core doctor treats that absence as an intentional preview limitation, not as a product regression.

## Regression Gate

`pnpm validate:repo-health` blocks custom pnpm wrapper revival, forbidden eager production import graph edges, non-literal dynamic imports in the production CLI graph, undocumented preview scope, hard preview gateway dependencies, and preview paths in the core release allowlist. Import graph checks use the TypeScript AST, so comments and plain string content do not count as imports.

`pnpm release:verify` extracts the generated source bundle and runs `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, `corepack pnpm run doctor`, and `corepack pnpm validate:repo-health` inside the extracted tree.
