# BLUE-TANUKI Guided Installer

This directory provides a guided first-run wrapper for the portable source bundle.

It is not a signed native installer and it is not an automatic updater. It coordinates the existing safe setup path:

1. Node.js / package-manager preflight
2. optional `pnpm install --frozen-lockfile`
3. optional `pnpm build`
4. env generation with WebChat / resume / settings tokens
5. doctor verification
6. optional Control Center startup

After startup, use Settings `Verify LLM` before saving non-stub provider,
endpoint, model, or API key changes.

## Usage

From the repository root:

```bash
pnpm installer:run
```

For a setup-only run that does not start the gateway:

```bash
pnpm installer:run -- --no-serve
```

For local OpenAI-compatible providers:

```bash
pnpm installer:run -- --provider openai-compatible --endpoint http://localhost:11434/v1 --model llama-local --no-serve
```

The generated env file defaults to:

```txt
.blue-tanuki/blue-tanuki.env
```

If an existing env file is overwritten with `--force`, setup creates a `.bak` file first.

## Boundaries

- No 5-minute setup guarantee is claimed.
- On Windows, settings-saved LLM API keys are stored as DPAPI CurrentUser secret references.
- On other platforms, API key values remain env-file material until a later keychain phase.
- API key values are not printed by the installer.
- LLM providers remain downstream devices under HDS-BRAIN authority.
- The guided installer does not modify Approval Gate, audit, runtime invariants, or Layer A / Layer B authority boundaries.
- Starting the Control Center is process launch only; it does not create a second authority path.
