# Known Environment Failures

This file separates runtime or validation environment failures from product
regressions. Do not use it to hide real test failures.

## `pnpm` is not on `PATH`

### Symptom

`pnpm install` or a pnpm-based validation command fails because `pnpm` cannot be
found.

### Classification

Environment setup failure, not an application regression.

### Recovery

```bash
node --version
corepack --version || true
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

If `pnpm` is still unavailable, report validation as environment-limited. Do not
rewrite application code to work around a missing package manager.

## Root smoke checks

`pnpm smoke:serve` and `pnpm smoke:resume` are no longer classified as known
environment failures. The prior root dependency issue was fixed by declaring
the root `ws` / `@types/ws` dev dependencies and updating `pnpm-lock.yaml`.

When a task explicitly targets smoke tests, root workspace resolution, or a
release gate, run these checks and treat failures as actionable until proven
environment-specific:

```bash
pnpm smoke:serve
pnpm smoke:resume
```

If either smoke check fails:

- confirm `pnpm install --frozen-lockfile` passed
- confirm root `node_modules/ws` exists after install
- inspect child gateway logs before changing product code
- report platform-specific failures separately from host environment failures

## Doctor preview credentials

Missing Slack / Discord / Teams / LINE credentials are not a core release
environment failure. In default mode, `pnpm run doctor` reports them as WARN and
can still exit 0 when core health is otherwise good.

Use these modes deliberately:

```bash
pnpm run doctor
pnpm run doctor -- --preview
pnpm run doctor -- --strict
```

`--preview` treats preview channel credentials as required for readiness.
`--strict` treats optional external surfaces as required for full validation.

## Release bundle extraction

`pnpm release:verify` now extracts the generated source bundle and runs install,
build, core doctor, and `validate:repo-health` inside the extracted tree.
Failures from those extracted commands are product regressions unless the exact
error is a host tool failure such as missing `corepack`, missing `tar`/zip
support, or network outage while installing dependencies.

Missing Slack / Discord / Teams / LINE packages inside the extracted bundle are
intentional preview limitations, not environment failures. Core doctor and
`validate:repo-health` must pass with those packages absent.

## Report Format

For any environment-limited validation, report:

- command
- result
- classification
- likely cause
- whether it appears pre-existing or introduced by the current change
- files modified
- recommended next action
