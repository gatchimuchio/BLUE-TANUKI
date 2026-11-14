# BLUE-TANUKI Channel Promotion Gate

Phase 11-S11 defines the first-party promotion gate for external channels.

Channel count is not a quality metric. A channel can move from
`first-party-preview` to `first-party` only when owner-run evidence exists and
the compatibility matrix passes the machine gate.

## Current Decision

Current v1.0 RC first-party channels:

- WebChat
- Telegram

Current v1.0 RC preview channels:

- Slack
- Discord
- Microsoft Teams
- LINE

No Slack / Discord / Teams / LINE promotion is made in Phase 11-S11 because
this workspace does not have owner-provided live credentials and live smoke
targets. This is a deliberate support-boundary decision, not a missing local
test.

保留中の4チャネル実装と実行時依存関係は、利用者が設定したインストール済み環境から通常のプラグイン審査経路で読み込めるよう、デスクトップ製品の配置物とソース構築用一式へ含める。同梱によって提供水準を昇格させず、未設定チャネルを起動せず、認証情報も含めない。提供水準の昇格には、以下の証拠を引き続き要求する。

WhatsApp remains `reserved-third-party` and cannot be promoted by this gate.

## Machine Gate

Run:

```bash
pnpm validate:channels
```
The command checks:

- WebChat and Telegram remain `first-party` for `v1.0`.
- Slack / Discord / Teams / LINE remain `first-party-preview` for
  `v1.0-preview` unless explicit owner evidence exists.
- Any promoted Slack / Discord / Teams / LINE entry has a complete evidence
  record.
- WhatsApp remains `reserved-third-party`, `core_supported=false`, and
  `warranty=none`.

For a future promotion attempt, run the gate with an evidence file:

```bash
pnpm validate:channels -- --evidence docs/channel-promotion-evidence.json
```

`docs/channel-promotion-evidence.json` is intentionally not committed unless
it contains real owner-run evidence. It must not contain token values, raw live
target identifiers, bearer headers, request bodies, or channel message content.

## Required Evidence

Each promoted channel requires:

- owner approval for first-party status;
- `pnpm smoke:live` completed with at least one non-skip PASS for that channel;
- a SHA-256 digest of the live-smoke report, not raw secret or target material;
- recovery review for token revocation, permission failure, target error, and
  rate-limit/backoff behavior;
- setup docs, credential matrix, channel matrix, compatibility matrix, and
  permanent-use checklist review;
- conformance evidence for inbound/outbound behavior, metadata non-authority,
  typed delivery errors, and retry/backoff;
- no secret values exposed in the evidence.

Teams and LINE also require gateway-owned inbound listener closure before
first-party promotion. Injected transport conformance is not enough for v1.0
first-party support.

## Safety Boundary

Channel promotion does not change the HDS authority path.

Channel metadata, delivery results, live-smoke reports, and external service
responses remain downstream evidence only. They cannot classify risk, approve
requests, bypass final-review, widen capabilities, or create a new authority
path.

## Evidence Shape

Future evidence must follow this shape:

```json
{
  "schema_version": 1,
  "channels": {
    "slack": {
      "approved_for_first_party": true,
      "live_smoke": {
        "command": "pnpm smoke:live",
        "result": "pass",
        "non_skip": true,
        "completed_at": "2026-05-18T00:00:00.000Z",
        "report_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "secret_values_exposed": false
      },
      "recovery_review": {
        "token_revocation": true,
        "permission_failure": true,
        "target_error": true,
        "rate_limit_or_backoff": true,
        "next_action_documented": true
      },
      "docs_review": {
        "setup": true,
        "credentials": true,
        "channel_matrix": true,
        "compatibility_matrix": true,
        "permanent_use": true
      },
      "conformance": {
        "inbound_outbound": true,
        "metadata_non_authority": true,
        "typed_errors": true,
        "retry_backoff": true
      },
      "gateway_owned_inbound_listener": "not-required"
    }
  }
}
```
