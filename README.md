# 🦝 BLUE-TANUKI

A local-resident AI control plane where **authority lives in HDS-BRAIN, not the LLM**.

BLUE-TANUKI treats LLMs, tools, cron, and channels as *downstream devices*. The HDS-BRAIN core decides actor, process, memory, approval, and execution upstream — and it never calls an LLM to do it. Every authority decision is structured, inspectable, and written to a hash-chain audit.

This is **v0.1**: an owner-operated local control plane with a WebChat Control Center, a deterministic memory trace, an approval gate with a final-review boundary, and Telegram / Slack / Discord channels.

---

## TL;DR

1. **HDS-BRAIN owns authority.** LLMs, tools, cron, and channels are downstream devices. / 権限は HDS-BRAIN に。LLM・ツール・cron・チャネルは下流。
2. **No black box in the HDS authority path.** Actor / process / memory / approval / execution / audit are structured and inspectable. / 権限経路にブラックボックスなし。すべて構造化・検査可能。
3. **Safety first, UX second.** Full access is allowed for owner-operated local work, but final-review operations remain gated. / 安全性が第一、UX は第二。最終レビュー操作はゲートのまま。

---

## Quick Start

### 1. Install and build

```
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### 2. Set the inbound tokens

```
export WEBCHAT_TOKEN="replace-with-32chars-inbound-token"
export WEBCHAT_RESUME_TOKEN="replace-with-32chars-resume-token"
export LLM_BACKEND="stub"
```

### 3. Serve

```
pnpm gateway:serve
```

Open:

```
http://127.0.0.1:8787/
```

That's it. The WebChat Control Center, runtime snapshot, approval gate, and audit chain all run locally through the gateway.

See [QUICKSTART.md](QUICKSTART.md).

---

## v0.1 Completed Surface

* **WebChat Control Center** at `/` and `/app`
* **Runtime snapshot** at `/runtime/snapshot`
* **HDS** Process / Memory / Authority closure
* **Deterministic `MemoryTrace`** with `used_for_authority=false`
* **Approval Gate** with final-review boundary
* **Hash-chain audit logs**
* **Telegram** Bot API channel
* **Slack / Discord** adapters with silent fallback when credentials are absent
* **Daily Brief** scheduled-message smoke via internal cron

## v0.1 Explicit Boundaries

* **WhatsApp** is not completion-quality in v0.1; use later experimental integration.
* **Gmail / Google Calendar / Drive** are not read by v0.1 Daily Brief.
* **Voice / Mobile / rich Canvas** are deferred to v0.2+.
* **Public third-party Skill registry** is intentionally excluded.

---

## Channels

### Telegram

```
export TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
pnpm gateway:serve
```

### Slack / Discord

Slack and Discord adapters fall back silently when credentials are absent, so the gateway boots without them. Provide the channel tokens to activate.

---

## Daily Brief Smoke

```
export BLUE_TANUKI_DAILY_BRIEF_ENABLED=1
export BLUE_TANUKI_DAILY_BRIEF_CHANNEL=telegram
export BLUE_TANUKI_DAILY_BRIEF_TARGET="<telegram-chat-id>"
export BLUE_TANUKI_DAILY_BRIEF_TIME="07:00"
export BLUE_TANUKI_DAILY_BRIEF_CONTENT="Daily Brief: scheduled smoke from BLUE-TANUKI v0.1"
pnpm gateway:serve
```

v0.1 Daily Brief is a scheduled `channel_send` smoke. A real Gmail / GCal / Drive-backed brief is v0.2+.

---

## Runtime Snapshot

```
curl -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  http://127.0.0.1:8787/runtime/snapshot
```

Expected invariants:

```
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

---

## How It Works

HDS-BRAIN sits upstream of every executor. Inbound traffic never reaches an LLM or a tool until the authority core has decided it should.

```
Inbound channels / cron / webhook-like sources
        |
        v
     HDS-BRAIN  <-- upstream authority (never calls an LLM)
        |  ActorRef
        |  HDSProcessDefinition
        |  Frame
        |  deterministic MemoryTrace
        |  Model / Policy
        |  Commit
        |  process authority enforcement
        |  process execution-policy enforcement
        |  Approval Gate (final-review boundary)
        v
     Executor   <-- downstream devices
        |  LLM / tools / channel_send
        v
   ExecutorFeedback
        |
        v
   hash-chain audit
```

The authority core never consumes downstream session history to make decisions. Memory is recorded with `used_for_authority=false`, and external metadata can never escalate authority.

---

## Package Map

| Package | Role |
| --- | --- |
| `@blue-tanuki/protocol` | HDS-BRAIN ↔ Executor protocol |
| `@blue-tanuki/hds-brain` | Upstream authority core |
| `@blue-tanuki/core` | Executor, LLM backend, tools, sessions |
| `@blue-tanuki/channel-base` | Channel interfaces / router / dispatcher |
| `@blue-tanuki/channel-webchat` | Local Control Center + HTTP/WS channel |
| `@blue-tanuki/channel-telegram` | Telegram Bot API channel |
| `@blue-tanuki/channel-slack` | Slack channel adapter |
| `@blue-tanuki/channel-discord` | Discord channel adapter |
| `@blue-tanuki/gateway` | Runtime wiring |

---

## Documents

* [CLAIM.md](CLAIM.md) — product claim and non-claim boundary
* [SECURITY.md](SECURITY.md) — authority and memory security model
* [AUDIT.md](AUDIT.md) — hash-chain audit and runtime snapshot
* [CONFIG.md](CONFIG.md) — environment variables
* [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — operational fixes

---

## Release Boundary

Release archives are source bundles, not standalone binaries. They intentionally exclude `node_modules`, local `.env` files, audit/session data, and secret-like backups.

---

## License

MIT. See [LICENSE](LICENSE).
