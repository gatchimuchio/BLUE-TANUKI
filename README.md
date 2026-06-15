# 🦝 BLUE-TANUKI

A local-resident AI control plane where **authority lives in HDS-BRAIN, not the LLM**.

BLUE-TANUKI treats LLMs, tools, cron, and channels as *downstream devices*. The HDS-BRAIN core decides actor, process, memory, approval, and execution upstream — and it never calls an LLM to do it. Every authority decision is structured, inspectable, and written to a hash-chain audit.

Current state: **1.0.0-rc.1 technical release candidate**. GA and public complete-superiority claims remain blocked until the GA Bar passes and the owner gives explicit GO.

P12 fixes the RC support boundary: see [docs/SUPPORT_BOUNDARY.md](docs/SUPPORT_BOUNDARY.md) and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) before treating any surface as supported or release-claimable.

Development strategy: GUI Shell is a reference LLM-readable responsibility substrate, not a dependency to modify. BLUE-TANUKI is the target resident control plane extended under that responsibility method: LLM implementation agents may build bounded changes, but HDS-BRAIN and the human owner remain the authority boundaries.

---

## TL;DR

1. **HDS-BRAIN owns authority.** LLMs, tools, cron, and channels are downstream devices. / 権限は HDS-BRAIN に。LLM・ツール・cron・チャネルは下流。
2. **No black box in the HDS authority path.** Actor / process / memory / approval / execution / audit are structured and inspectable. / 権限経路にブラックボックスなし。すべて構造化・検査可能。
3. **Safety first, UX second.** Full access is allowed for owner-operated local work, but final-review operations remain gated. / 安全性が第一、UX は第二。最終レビュー操作はゲートのまま。

---

## Quick Start

### Windows users

Do not run `install/windows/product/BlueTanukiSetup.cmd` directly from a source
tree. That script is the payload entrypoint inside the packaged installer zip.

Path A: prebuilt installer zip

1. Get `blue-tanuki-*-windows-x64-installer.zip` from the GitHub Release or
   `release/windows/`.
2. Extract the zip.
3. Run `BlueTanukiSetup.cmd` from the extracted installer folder.

Path B: source zip

1. Extract the source zip.
2. Run `INSTALL_WINDOWS.cmd` from the repository root.

`INSTALL_WINDOWS.cmd` uses an existing `release/windows/*windows-x64-installer.zip`
when present. If no installer zip exists, it enables Corepack, prepares
`pnpm@9.12.0`, installs dependencies, builds, packages, verifies, extracts the
generated installer zip, and runs `BlueTanukiSetup.cmd`.

### Build a Windows installer package

For developers preparing the Windows artifact:

```
pnpm build
pnpm package:windows
pnpm package:windows:verify
```

This produces an unsigned Windows installer package and sidecars under
`release/windows/`, including `README_INSTALL_WINDOWS.txt`. The installed app
uses a bundled Windows Node runtime, creates Start Menu shortcuts, opens the
Control Center, and preserves user data under `%APPDATA%\BlueTanuki`.

See [docs/WINDOWS_INSTALLER_GUIDE.md](docs/WINDOWS_INSTALLER_GUIDE.md).

### Source/dev run

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

## Release Candidate Surface

* **WebChat Control Center** at `/` and `/app`
* **Owner-operation GUI screens** for Home, Conversation / WebChat, Tasks, Approvals, Activity / Audit, Memory, Skills, Channels, Doctor, Settings, and Developer / Evidence
* **Runtime snapshot** at `/runtime/snapshot`
* **HDS-BRAIN** standalone authority core
* **Approval Gate** with L1/L2/L3 `ApprovalLevel` and non-bypassable final-review boundary
* **Hash-chain audit**, output audit, complete history, and Runtime Invariants evidence
* **Writing / Daily / Developer Operator** first-party surfaces
* **WebChat / Telegram** first-party channels
* **Slack / Discord / Teams / LINE** first-party-preview adapters gated by owner evidence
* **Daily Brief** scheduled-message smoke via internal cron
* **GitHub / Google / browser automation** downstream tools behind capability, approval, preview, and audit boundaries
* **OpenRouter** optional LLM provider adapter, separate from native/direct providers
* **Composio** optional live-gated external tool connector behind dry-run default, allowlist, capability, approval, and audit boundaries
* **Unsigned Windows installer package**, portable installer / resident app / update-rollback documentation, and validation gates

## Explicit Boundaries

* **WhatsApp** remains `reserved-third-party` and is not first-party core.
* Preview adapters and tools are not promoted to first-party without owner-run evidence.
* **Voice / Mobile / rich Canvas** are outside the current GA bar.
* **Public third-party Skill registry** is intentionally excluded.
* External GA/public superiority claims remain blocked until `pnpm validate:ga` and owner GO allow them.
* OpenRouter and Composio are optional convenience adapters, not mandatory infrastructure or authority sources.
* Support scope and known limitations are fixed in [docs/SUPPORT_BOUNDARY.md](docs/SUPPORT_BOUNDARY.md) and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

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
export BLUE_TANUKI_DAILY_BRIEF_CONTENT="Daily Brief: scheduled smoke from BLUE-TANUKI"
pnpm gateway:serve
```

Daily Brief is a scheduled `channel_send` smoke. Google read/write integrations remain bounded downstream tools with credential readiness, Approval Gate, and audit requirements.

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
  "complete_history_used_for_authority": false,
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
* [docs/INDEX.md](docs/INDEX.md) — full documentation index
* [docs/FIRST_RUN_CHECKLIST.md](docs/FIRST_RUN_CHECKLIST.md) — first successful local operation
* [docs/PERMANENT_USE_CHECKLIST.md](docs/PERMANENT_USE_CHECKLIST.md) — permanent owner operation
* [docs/SUPPORT_BOUNDARY.md](docs/SUPPORT_BOUNDARY.md) — supported, preview, reserved, and not-shipped boundary
* [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — RC limitations and remaining evidence gaps
* [docs/CHANNEL_READINESS_MATRIX.md](docs/CHANNEL_READINESS_MATRIX.md) — channel status and evidence
* [docs/CHANNEL_PROMOTION_GATE.md](docs/CHANNEL_PROMOTION_GATE.md) — preview-to-first-party promotion gate
* [docs/CREDENTIAL_READINESS_MATRIX.md](docs/CREDENTIAL_READINESS_MATRIX.md) — credential requirements and safe skips
* [docs/PLUGIN_REVIEW_GATE.md](docs/PLUGIN_REVIEW_GATE.md) — Layer B review gate
* [docs/UPDATE_ROLLBACK_RUNBOOK.md](docs/UPDATE_ROLLBACK_RUNBOOK.md) — update, rollback, and recovery path
* [docs/WINDOWS_INSTALLER_GUIDE.md](docs/WINDOWS_INSTALLER_GUIDE.md) — unsigned Windows installer package
* [docs/WINDOWS_FIRST_RUN.md](docs/WINDOWS_FIRST_RUN.md) — installed Windows first run
* [docs/WINDOWS_EVIDENCE_PACK.md](docs/WINDOWS_EVIDENCE_PACK.md) — Windows installed-app evidence markers
* [docs/WINDOWS_PACKAGING_AUDIT.md](docs/WINDOWS_PACKAGING_AUDIT.md) — Windows packaging evidence
* [docs/WINDOWS_UNINSTALL.md](docs/WINDOWS_UNINSTALL.md) — Windows uninstall and data preservation
* [docs/v1.0-release-candidate.md](docs/v1.0-release-candidate.md) — release-candidate boundary
* [docs/v1.0-post-rc-closure-review.md](docs/v1.0-post-rc-closure-review.md) — post-RC closure status
* [docs/v1.0-ga-promotion-review.md](docs/v1.0-ga-promotion-review.md) — GA promotion pre-GO review
* [docs/P13_OWNER_GO_READINESS.md](docs/P13_OWNER_GO_READINESS.md) — P13 owner-GO release boundary
* [docs/v1.0-security-and-permanent-use-review.md](docs/v1.0-security-and-permanent-use-review.md) — security and permanent-use review
* [docs/DEVELOPMENT_PRACTICE.md](docs/DEVELOPMENT_PRACTICE.md) — development practice and evidence discipline
* [docs/LLM_EXTENSION_SURFACE.md](docs/LLM_EXTENSION_SURFACE.md) — LLM-safe extension surface
* [docs/RESPONSIBILITY_SUBSTRATE_MAPPING.md](docs/RESPONSIBILITY_SUBSTRATE_MAPPING.md) — GUI Shell responsibility mapping
* [docs/BLUE_TANUKI_AUTHORITY_MODEL.md](docs/BLUE_TANUKI_AUTHORITY_MODEL.md) — authority model
* [docs/CONFORMANCE_TARGETS.md](docs/CONFORMANCE_TARGETS.md) — negative conformance targets
* [docs/GUI_PRODUCT_SPEC.md](docs/GUI_PRODUCT_SPEC.md) — Control Center product role
* [docs/GUI_SCREEN_MAP.md](docs/GUI_SCREEN_MAP.md) — GUI screen inventory
* [docs/GUI_STATE_MODEL.md](docs/GUI_STATE_MODEL.md) — GUI state and redaction model
* [docs/GUI_APPROVAL_UX.md](docs/GUI_APPROVAL_UX.md) — approval UX boundary
* [docs/GUI_AUDIT_UX.md](docs/GUI_AUDIT_UX.md) — audit UX boundary

---

## Release Boundary

Release archives are source bundles, not standalone binaries. The Windows installer package is a separate unsigned zip-delivered installer package with a bundled Windows Node runtime. It is not a signed MSI/EXE yet. Release artifacts intentionally exclude local `.env` files, audit/session data, and secret-like backups.

---

## License

MIT. See [LICENSE](LICENSE).
