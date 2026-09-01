# 🦝 BLUE-TANUKI

BLUE-TANUKI は、**LLM ではなく HDS-BRAIN に判断・権限を置く**、owner 運用の局所常駐 AI 制御面である。

LLM、ツール、cron、チャネル、plugin、memory、history、UI は下流装置として動く。HDS-BRAIN は actor、process、memory、approval、execution の可否を上流で構造的に決め、その判断経路を hash-chain audit へ記録する。HDS-BRAIN 自身は判断のために LLM を呼ばない。

現在版は **`1.0.0-rc.1` technical release candidate**。P13 は `PENDING_OWNER_GO` であり、GA と外部向け優位主張は `public_claim_allowed=false` のまま閉じている。支援範囲は [docs/SUPPORT_BOUNDARY.md](docs/SUPPORT_BOUNDARY.md)、残る制限は [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) を参照する。

## 日本語基底正本

このリポジトリは日本語を唯一の基底規定言語とする。多言語は、外部 API・構文・固定識別子・固有名・原文証拠など実務上やむを得ない箇所だけに局所化する。既存の英語資産は例外ではなく、監査可能な移行負債として扱う。

- [規定/README.md](規定/README.md) — 正本の読み順と成立状態
- [規定/00_日本語基底規定.md](規定/00_日本語基底規定.md) — 適用範囲、成立順序、例外、監査
- [規定/01_基底語彙.md](規定/01_基底語彙.md) — 日本語概念と既存識別子の接続
- [規定/02_資産分類と局所例外.md](規定/02_資産分類と局所例外.md) — 全資産分類と例外条件

```bash
pnpm validate:japanese-base
pnpm validate:japanese-base -- --strict
```

通常 gate は正本・例外・移行台帳の整合を確認する。strict gate は既存移行負債が残る間は失敗する。通常 gate の合格を全資産日本語化や GA readiness と読み替えない。

## 中核境界

1. **判断・権限は HDS-BRAIN にある。** LLM、tool、cron、channel は下流である。
2. **権限経路を black box にしない。** actor / process / memory / approval / execution / audit は構造化し検査可能にする。
3. **安全と堅牢性を先に置く。** owner-operated full access でも final-review operation は迂回できない。
4. **記憶と履歴は証拠であり権限ではない。** `used_for_authority=false` と `complete_history_used_for_authority=false` を保つ。
5. **不明は自動許可しない。** fail-closed / `SUSPEND` で再監査へ戻す。

## 通常利用者向けインストール

GitHub Release から対象 OS の single-file installer を取得する。

| OS | 実行物 |
|---|---|
| Windows | `BlueTanukiSetup-<version>-windows-x64.cmd` |
| macOS | `BlueTanukiSetup-<version>-macos-<arch>.command` |
| Linux | `BlueTanukiSetup-<version>-linux-x64.run` |

installer は埋込み payload を検証・展開して BLUE-TANUKI を導入し、resident app と `http://127.0.0.1:8787/app` を開く。通常利用者が Node.js、Corepack、pnpm、Git、source build を準備することは想定しない。

文書検証器が参照する固定区分名は、通常利用者=`normal user`、単一ファイル配布=`single-file`、補助・復旧用 archive=`payload/recovery` である。これらの英語ラベルは installer 契約との照合用であり、説明上の意味はこの日本語文から定める。

`INSTALL.sh`、`INSTALL_MACOS.command`、`INSTALL_LINUX.sh`、`INSTALL_WINDOWS.cmd` は source-root helper である。検証済み release artifact がなければ誤った asset の案内とともに停止し、暗黙の source build は行わない。Windows の `install/windows/product/BlueTanukiSetup.cmd` は packaged payload 内の entrypoint であり、source tree から直接実行しない。

install-only:

```bash
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.command
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.sh
```

詳細は [docs/INSTALLER_GUIDE.md](docs/INSTALLER_GUIDE.md)、[install/README.md](install/README.md)、[docs/RELEASE_HARDENING.md](docs/RELEASE_HARDENING.md) を参照する。現在の installer は bundled runtime を含む unsigned portable package であり、signed native installer ではない。

## 開発環境から起動

```bash
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

最小の WebChat 設定:

```bash
export WEBCHAT_TOKEN="replace-with-32chars-inbound-token"
export WEBCHAT_RESUME_TOKEN="replace-with-32chars-resume-token"
export LLM_BACKEND="stub"
pnpm gateway:serve
```

`http://127.0.0.1:8787/` を開く。設定、first-run、恒久利用は [QUICKSTART.md](QUICKSTART.md)、[docs/FIRST_RUN_CHECKLIST.md](docs/FIRST_RUN_CHECKLIST.md)、[docs/PERMANENT_USE_CHECKLIST.md](docs/PERMANENT_USE_CHECKLIST.md) を参照する。

## RC surface

- WebChat Control Center (`/`, `/app`)
- Home、Conversation、Tasks、Approvals、Activity/Audit、Memory、Skills、Channels、Doctor、Settings、Developer/Evidence の owner 操作面
- runtime snapshot (`/runtime/snapshot`)
- standalone HDS-BRAIN authority core
- L1 / L2 / L3 `ApprovalLevel` と non-bypassable final-review を持つ Approval Gate
- hash-chain audit、output audit、complete history、Runtime Invariants evidence
- Writing / Daily / Developer Operator
- WebChat / Telegram first-party channel
- Slack / Discord / Teams / LINE `first-party-preview`
- capability / approval / preview / audit 境界下の GitHub / Google / browser tool
- optional OpenRouter provider と optional Composio connector
- Windows / macOS / Linux portable installer と update / rollback 文書

## 明示的境界

- WhatsApp は `reserved-third-party`、`core_supported=false` で first-party core ではない。
- preview adapter / tool は owner-run evidence なしに first-party へ昇格しない。
- Voice / Mobile / rich Canvas は現在の GA bar 外である。
- public third-party Skill registry は意図的に含めない。
- OpenRouter と Composio は optional downstream adapter であり、権限源ではない。
- `pnpm validate:ga` と owner GO が許可するまで GA 公開文言を有効化しない。

## Runtime Invariants

```json
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "complete_history_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

snapshot:

```bash
curl -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  http://127.0.0.1:8787/runtime/snapshot
```

## 実行関係

```text
Inbound channel / cron / webhook-like source
        |
        v
     HDS-BRAIN  <- 上流判断・権限。LLM を呼ばない
        |  actor / process / frame / policy / commit
        |  Approval Gate / final review
        v
     Executor   <- 下流装置
        |  LLM / tool / channel_send
        v
   ExecutorFeedback
        |
        v
   hash-chain audit
```

下流 session history を authority decision に使わない。external metadata は権限を昇格できない。

## Package map

| Package | 責任 |
|---|---|
| `@blue-tanuki/protocol` | HDS-BRAIN と Executor の protocol |
| `@blue-tanuki/hds-brain` | standalone 上流判断・権限 core |
| `@blue-tanuki/core` | Executor、LLM backend、tool、session |
| `@blue-tanuki/channel-base` | channel interface / router / dispatcher |
| `@blue-tanuki/channel-webchat` | local Control Center と HTTP/WS channel |
| `@blue-tanuki/channel-telegram` | Telegram Bot API channel |
| `@blue-tanuki/channel-slack` | preview Slack adapter |
| `@blue-tanuki/channel-discord` | preview Discord adapter |
| `@blue-tanuki/gateway` | runtime wiring |

## 文書

- [CLAIM.md](CLAIM.md) — product claim / non-claim 境界
- [SECURITY.md](SECURITY.md) — authority と memory の security model
- [AUDIT.md](AUDIT.md) — hash-chain audit と runtime snapshot
- [CONFIG.md](CONFIG.md) — environment variables
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — 運用上の復旧
- [docs/INDEX.md](docs/INDEX.md) — 文書索引
- [docs/SUPPORT_BOUNDARY.md](docs/SUPPORT_BOUNDARY.md) — support / preview / reserved / not-shipped
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — RC 制限と evidence gap
- [docs/CHANNEL_READINESS_MATRIX.md](docs/CHANNEL_READINESS_MATRIX.md) — channel 状態
- [docs/CHANNEL_PROMOTION_GATE.md](docs/CHANNEL_PROMOTION_GATE.md) — preview 昇格 gate
- [docs/CREDENTIAL_READINESS_MATRIX.md](docs/CREDENTIAL_READINESS_MATRIX.md) — credential 要件と safe skip
- [docs/PLUGIN_REVIEW_GATE.md](docs/PLUGIN_REVIEW_GATE.md) — Layer B review gate
- [docs/UPDATE_ROLLBACK_RUNBOOK.md](docs/UPDATE_ROLLBACK_RUNBOOK.md) — update / rollback / recovery
- [docs/RELEASE_HARDENING.md](docs/RELEASE_HARDENING.md) — workflow 不在、signing、manual update gate
- [docs/WINDOWS_INSTALLER_GUIDE.md](docs/WINDOWS_INSTALLER_GUIDE.md) — Windows installer
- [docs/WINDOWS_FIRST_RUN.md](docs/WINDOWS_FIRST_RUN.md) — installed Windows first-run
- [docs/WINDOWS_EVIDENCE_PACK.md](docs/WINDOWS_EVIDENCE_PACK.md) — Windows evidence markers
- [docs/WINDOWS_PACKAGING_AUDIT.md](docs/WINDOWS_PACKAGING_AUDIT.md) — packaging evidence
- [docs/WINDOWS_UNINSTALL.md](docs/WINDOWS_UNINSTALL.md) — uninstall / data preservation
- [docs/v1.0-release-candidate.md](docs/v1.0-release-candidate.md) — RC 境界
- [docs/v1.0-post-rc-closure-review.md](docs/v1.0-post-rc-closure-review.md) — post-RC 状態
- [docs/v1.0-ga-promotion-review.md](docs/v1.0-ga-promotion-review.md) — GA pre-GO review
- [docs/P13_OWNER_GO_READINESS.md](docs/P13_OWNER_GO_READINESS.md) — owner-GO 境界
- [docs/v1.0-security-and-permanent-use-review.md](docs/v1.0-security-and-permanent-use-review.md) — security / permanent-use review
- [docs/DEVELOPMENT_PRACTICE.md](docs/DEVELOPMENT_PRACTICE.md) — evidence discipline
- [docs/LLM_EXTENSION_SURFACE.md](docs/LLM_EXTENSION_SURFACE.md) — LLM-safe extension
- [docs/RESPONSIBILITY_SUBSTRATE_MAPPING.md](docs/RESPONSIBILITY_SUBSTRATE_MAPPING.md) — responsibility mapping
- [docs/BLUE_TANUKI_AUTHORITY_MODEL.md](docs/BLUE_TANUKI_AUTHORITY_MODEL.md) — authority model
- [docs/CONFORMANCE_TARGETS.md](docs/CONFORMANCE_TARGETS.md) — negative conformance targets
- [docs/GUI_PRODUCT_SPEC.md](docs/GUI_PRODUCT_SPEC.md)、[docs/GUI_SCREEN_MAP.md](docs/GUI_SCREEN_MAP.md)、[docs/GUI_STATE_MODEL.md](docs/GUI_STATE_MODEL.md)、[docs/GUI_APPROVAL_UX.md](docs/GUI_APPROVAL_UX.md)、[docs/GUI_AUDIT_UX.md](docs/GUI_AUDIT_UX.md) — Control Center 仕様

既存の非日本語 active docs は現在 `規定/移行台帳.json` の移行負債であり、英語であることを理由に現行日本語正本より優先しない。

## Release boundary

source release archive は standalone binary ではない。OS 別 single-file installer は bundled runtime payload を持つ unsigned portable installer であり、signed MSI/EXE/DMG/DEB/RPM ではない。`pnpm validate:release-hardening` は GitHub Actions workflow の不在、local validation command、`manual_update_only` を確認し、signing credential と notarization/GPG evidence がない `--require-signing` を fail-closed する。release artifact は `.env`、audit/session data、secret-like backup を含めない。

## ライセンス

MIT。法的原文は [LICENSE](LICENSE) を参照する。
