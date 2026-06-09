# OpenRouter Backend

OpenRouter is an optional model provider adapter.

It is not BLUE-TANUKI authority, not an approval source, and not required for
first-run. The default first-run provider remains `stub`.

## Layer

```text
OpenRouter = LLM model supply layer
BLUE-TANUKI = HDS-BRAIN, Approval Gate, audit, GUI, runtime, Windows product path
```

OpenRouter uses an OpenAI-compatible chat-completions endpoint. BLUE-TANUKI
therefore registers `openrouter` through the existing compatible backend path
instead of adding a separate authority path.

Reference:

- <https://openrouter.ai/docs>

## Configuration

```bash
LLM_BACKEND=openrouter
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openrouter/model-name
OPENROUTER_SITE_URL=https://example.com
OPENROUTER_APP_TITLE=BLUE-TANUKI
```

`OPENROUTER_SITE_URL` and `OPENROUTER_APP_TITLE` are optional request headers.
`OPENROUTER_ENDPOINT` may override the default endpoint for testing.

The Windows installer stores these settings in:

```text
%APPDATA%\BlueTanuki\blue-tanuki.env
```

Do not store OpenRouter keys in the install directory.

## Native-First Policy

Native/direct model configuration remains canonical:

- `stub`
- `openai`
- `anthropic`
- `openai-compatible`
- named providers in `LLM_PROVIDERS_JSON`
- local/custom OpenAI-compatible endpoints

OpenRouter is a convenience adapter for aggregated model access. Missing
OpenRouter settings must not break `stub`, OpenAI, Anthropic, local, or other
direct providers.

## Authority Boundary

- OpenRouter model output is not authority.
- `backend_hint=openrouter` is routing metadata only.
- Provider choice cannot alter approval policy.
- HDS-BRAIN still decides whether an `llm_call` may execute.
- Output audit treats OpenRouter output as downstream LLM output.

## Verification

Use Settings `Verify LLM` before saving non-stub changes.

Tests cover:

- `stub` remains the default.
- `openrouter` is selectable when key and model are present.
- selected `openrouter` without key fails safely.
- provider routing hints do not change authority policy.
