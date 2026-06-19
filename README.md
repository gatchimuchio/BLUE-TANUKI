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

Choose the single-file installer for your OS from the Release assets:

| OS | Run this |
| --- | --- |
| Windows | `BlueTanukiSetup-<version>-windows-x64.cmd` |
| macOS | `BlueTanukiSetup-<version>-macos-<arch>.command` |
| Linux | `BlueTanukiSetup-<version>-linux-x64.run` |

Normal users on Windows, macOS, and Linux should not run source builds and
should not manually extract a nested payload archive. Download the single-file
installer package for your OS and run it. The installer verifies its embedded
payload, extracts it internally, installs BLUE-TANUKI, launches the resident
app, and opens `http://127.0.0.1:8787/app`. It does not require user-installed
Node.js, Corepack, pnpm, Git, or source-build troubleshooting.

`INSTALL.sh`, `INSTALL_MACOS.command`, and `INSTALL_LINUX.sh` are source-root
helpers only. They use a verified local packaged installer under `release/` or
download the matching GitHub Release asset. If no verified installer is
available, they fail fast with wrong-asset guidance. Developer source build is
explicit only with `--build-from-source`.

### Windows users

Do not run `install/windows/product/BlueTanukiSetup.cmd` directly from a source
tree. That script is the payload entrypoint inside the packaged installer zip.

Path A: single-file installer package

1. Get `BlueTanukiSetup-<version>-windows-x64.cmd` from the GitHub Release.
2. Double-click it.
3. BLUE-TANUKI installs, starts, and opens the Control Center.

Normal Windows users should not run source builds. Download
`BlueTanukiSetup-<version>-windows-x64.cmd` and run it. The older
`blue-tanuki-<version>-windows-x64-installer.zip` artifact remains available as
the payload/recovery package, but normal users should not need to extract it
manually. The installed launcher opens:

```text
http://127.0.0.1:8787/app
```

`INSTALL_WINDOWS.cmd` uses an existing `release/windows/*windows-x64-installer.zip`
when present. If no installer zip exists in a source tree/source zip, it
attempts to download and verify the matching GitHub Release installer asset. If
that cannot be verified, it fails fast with wrong-asset guidance instead of
building from source. Developer source build is explicit only:

```powershell
.\INSTALL_WINDOWS.cmd -BuildFromSource
```

### macOS users

1. Get `BlueTanukiSetup-<version>-macos-<arch>.command` from the GitHub Release.
2. Run it.
3. BLUE-TANUKI installs, starts, and opens the Control Center.
4. Later, launch BLUE-TANUKI from `~/Applications/BlueTanuki.command` or
   `~/.local/bin/blue-tanuki`.

Normal macOS users should not run source builds. Download
`BlueTanukiSetup-<version>-macos-<arch>.command` and run it. The
`blue-tanuki-<version>-macos-<arch>-installer.tar.gz` artifact is the
payload/recovery package.

For install-only behavior:

```
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.command
```

### Linux users

1. Get `BlueTanukiSetup-<version>-linux-x64.run` from the GitHub Release.
2. Run it with `sh ./BlueTanukiSetup-<version>-linux-x64.run` or mark it
   executable and run it.
3. BLUE-TANUKI installs, starts, and opens the Control Center.
4. Later, launch BLUE-TANUKI from the desktop launcher where supported or
   `~/.local/bin/blue-tanuki`.

Normal Linux users should not run source builds. Download
`BlueTanukiSetup-<version>-linux-x64.run` and run it. The
`blue-tanuki-<version>-linux-x64-installer.tar.gz` artifact is the
payload/recovery package.

For install-only behavior:

```
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.sh
```

### Build installer packages

For developers preparing release artifacts:

```
pnpm build
pnpm package:windows
pnpm package:windows:verify
pnpm package:linux
pnpm package:linux:verify
pnpm package:macos
pnpm package:macos:verify
pnpm package:installers
pnpm package:installers:verify
pnpm validate:release-hardening
```

This produces unsigned payload/recovery archives plus single-file normal user
installers and sidecars under `release/windows/`, `release/linux/`, and
`release/macos/`. Each single-file installer includes a bundled Node runtime
through its verified payload, opens the Control Center, and preserves user data
under the platform user data location. These are not signed native installer
packages yet.

See [docs/WINDOWS_INSTALLER_GUIDE.md](docs/WINDOWS_INSTALLER_GUIDE.md).
See [docs/RELEASE_HARDENING.md](docs/RELEASE_HARDENING.md) for the CI action,
signing-prerequisite, and manual-update hardening gate.

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
* [docs/RELEASE_HARDENING.md](docs/RELEASE_HARDENING.md) — CI action, signing, and updater release gate
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

Release archives are source bundles, not standalone binaries. The OS-specific single-file installers are unsigned portable installer packages with bundled runtime payloads. They are not signed MSI/EXE/DMG/DEB/RPM artifacts yet. `pnpm validate:release-hardening` blocks stale CI action majors, records `manual_update_only`, and fails closed under `--require-signing` until signing credentials and notarization/GPG evidence exist. Release artifacts intentionally exclude local `.env` files, audit/session data, and secret-like backups.

---

## License

MIT. See [LICENSE](LICENSE).
