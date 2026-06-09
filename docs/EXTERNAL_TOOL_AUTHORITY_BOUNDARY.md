# External Tool Authority Boundary

This document applies to native connectors and convenience adapters.

## Layer Separation

```text
OpenRouter = model provider backend
Composio = external tool/API connector
BLUE-TANUKI = HDS-BRAIN, Approval Gate, audit, GUI, runtime, packaging
```

Do not place OpenRouter and Composio in the same authority layer.

## Native-First Integration Policy

BLUE-TANUKI must not depend exclusively on convenience aggregation services.

Native/direct configuration is canonical:

- OpenAI-compatible direct endpoint,
- OpenAI,
- Anthropic,
- Gemini or other native providers when added,
- local/custom endpoint where feasible,
- direct API key or OAuth connector where feasible,
- direct GitHub/Gmail/Slack/Drive/etc. connectors may exist independently of
  Composio.

Convenience adapters are optional:

- OpenRouter for aggregated model access,
- Composio for aggregated tool/API access.

Rules:

- Missing OpenRouter must not break native providers.
- Missing Composio must not break native/local tools.
- Convenience adapter metadata must not grant authority.
- Convenience adapter availability must not alter approval policy.
- Direct and convenience paths must both pass through capability, approval,
  audit, and recovery boundaries.

## Non-Authority Inputs

The following are reference/evidence only:

- LLM output,
- OpenRouter response metadata,
- Composio toolkit metadata,
- Composio connected account status,
- tool schema,
- tool result,
- GUI state,
- memory/history/session data,
- external service metadata.

None of these can approve actions, widen permissions, infer consent, bypass
final review, or rewrite policy.

## Approval Rule

External send/write/delete/create/update actions are L3 final-review operations
or must be represented by capabilities that force L3 final review.

Dry-run is allowed as evidence, not as permission.
