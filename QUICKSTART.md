# BLUE-TANUKI v1.0 RC Quickstart

v1.0 RC の最短経路は **WebChat Control Center + HDS Approval/Audit** である。Telegram は first-party channel として追加できる。Slack / Discord / Teams / LINE は preview adapter であり、credentials がない場合は安全に skip / silent fallback する。
通常の `pnpm run doctor` は core release health を見る。preview channel credentials や core release bundle から除外された preview package の不足は release blocker ではない。preview readiness は `pnpm run doctor -- --preview`、全 optional surface の strict validation は `pnpm run doctor -- --strict` を使う。

v1.0 RC provides a guided first-run path, not a verified 5-minute beginner guarantee. 詳細な手順は [docs/FIRST_RUN_CHECKLIST.md](./docs/FIRST_RUN_CHECKLIST.md)、常駐運用の確認は [docs/PERMANENT_USE_CHECKLIST.md](./docs/PERMANENT_USE_CHECKLIST.md) を使う。
Support scope and remaining RC limitations are fixed in [docs/SUPPORT_BOUNDARY.md](./docs/SUPPORT_BOUNDARY.md) and [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md). Preview surfaces are not promoted by quickstart success.

## 1. OS別一発起動 entrypoint

展開した folder の root から OS に合う入口を実行する。

| OS | 実行するもの |
| --- | --- |
| Windows | packaged installer zip の `BlueTanukiSetup.cmd` |
| macOS | packaged installer archive の `BlueTanukiSetup.command` |
| Linux | packaged installer archive の `BlueTanukiSetup.sh` |

通常ユーザーは Windows/macOS/Linux すべてで source build を実行しない。
packaged installer artifact を展開し、展開先直下の setup だけを実行する。
installed launcher は `http://127.0.0.1:8787/app` を開く。通常ユーザーに
Node.js、Corepack、pnpm、Git、source build、手動 troubleshooting は要求しない。

launch を抑止して install のみ行う場合:

```bash
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.command
LAUNCH_AFTER_INSTALL=0 sh ./BlueTanukiSetup.sh
```

`INSTALL_WINDOWS.cmd` / `INSTALL_MACOS.command` / `INSTALL_LINUX.sh` / `INSTALL.sh`
は source-root helper である。`release/` 配下に matching packaged installer が
あれば検証して実行し、なければ GitHub Release asset の取得・検証を試す。
検証できない場合は wrong asset として fail fast し、source build へは落ちない。
開発者 source build は明示オプション限定:

```bash
sh ./INSTALL_MACOS.sh --build-from-source
sh ./INSTALL_LINUX.sh --build-from-source
```

```powershell
.\INSTALL_WINDOWS.cmd -BuildFromSource
```

## 2. Platform installer packages

Windows 一般ユーザー向けの経路は packaged installer zip のみである。Normal
Windows users should not run source builds. Download
`blue-tanuki-<version>-windows-x64-installer.zip`, extract it, and run
`BlueTanukiSetup.cmd`. source tree 内の
`install/windows/product/BlueTanukiSetup.cmd` は直接実行しない。

```text
1. blue-tanuki-*-windows-x64-installer.zip を取得
2. zip を展開
3. 展開先直下の BlueTanukiSetup.cmd を double-click
4. Start Menu から BLUE-TANUKI を起動
5. http://127.0.0.1:8787/app の Control Center で Conversation / WebChat を使う
```

`INSTALL_WINDOWS.cmd` は `release/windows/*windows-x64-installer.zip` があれば
それを検証して packaged setup を実行する。zip がなければ matching GitHub
Release の Windows installer asset と `.sha256` / `.manifest.json` を取得・検証する。
検証できない場合は「source zip ではなく Windows installer zip を使う」と
fail fast し、source build へは落ちない。

macOS 一般ユーザー向けの経路は packaged installer archive のみである。Normal
macOS users should not run source builds. Download
`blue-tanuki-<version>-macos-<arch>-installer.tar.gz`, extract it, and run
`BlueTanukiSetup.command`.

Linux 一般ユーザー向けの経路は packaged installer archive のみである。Normal
Linux users should not run source builds. Download
`blue-tanuki-<version>-linux-x64-installer.tar.gz`, extract it, and run
`BlueTanukiSetup.sh`.

開発側で package を作る:

```bash
pnpm build
pnpm package:windows
pnpm package:windows:verify
pnpm package:linux
pnpm package:linux:verify
pnpm package:macos
pnpm package:macos:verify
```

これらの package は bundled Node runtime を含む。ユーザーに Node.js、Corepack、
pnpm、Git、PowerShell/shell setup script、repository commands を要求しない。
現時点では unsigned installer package であり、signed MSI/EXE/DMG/DEB/RPM ではない。

詳細:

- [docs/WINDOWS_INSTALLER_GUIDE.md](./docs/WINDOWS_INSTALLER_GUIDE.md)
- [docs/WINDOWS_FIRST_RUN.md](./docs/WINDOWS_FIRST_RUN.md)
- [docs/WINDOWS_UNINSTALL.md](./docs/WINDOWS_UNINSTALL.md)

## 3. Source install

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm validate:repo-health
```

## 4. Guided source first-run

Recommended:

```bash
pnpm installer:run
```

For setup without starting the gateway:

```bash
pnpm installer:run -- --no-serve
```

The installer runs setup and doctor, writes a local env file, and then points to
the Control Center Settings page. It is a guided first-run path, not a signed
native installer, not an automatic updater, and not a verified 5-minute setup
guarantee.

Use `Verify LLM` in Settings before saving a non-stub provider, endpoint, model,
or API key.

## 5. Local setup

推奨:

```bash
pnpm run setup -- --yes
pnpm gateway:serve -- --env-file .blue-tanuki/blue-tanuki.env
```

手動 env の場合:

```bash
export WEBCHAT_TOKEN="replace-with-32chars-inbound-token"
export WEBCHAT_RESUME_TOKEN="replace-with-32chars-resume-token"
export LLM_BACKEND="stub"
pnpm gateway:serve
```

Open:

```text
http://127.0.0.1:8787/
```

## 6. First WebChat message

Control Center から短いメッセージを送る。HTTP で直接確認する場合:

```bash
curl -X POST http://127.0.0.1:8787/inbound \
  -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user":"local-user","content":"hello blue-tanuki"}'
```

## 7. Telegram

```bash
export TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
pnpm gateway:serve
```

Telegram inbound uses Bot API long polling. Outbound target is `chat_id`.

## 8. Daily Brief smoke

Daily Brief is a scheduled `channel_send` smoke by default. Gmail/GCal/Drive can be enabled as an optional read-only source after the basic smoke works.

```bash
export BLUE_TANUKI_DAILY_BRIEF_ENABLED=1
export BLUE_TANUKI_DAILY_BRIEF_CHANNEL=telegram
export BLUE_TANUKI_DAILY_BRIEF_TARGET="<telegram-chat-id>"
export BLUE_TANUKI_DAILY_BRIEF_TIME="07:00"
export BLUE_TANUKI_DAILY_BRIEF_CONTENT="Daily Brief: scheduled smoke from BLUE-TANUKI v1.0 RC"
pnpm gateway:serve
```

Test interval:

```bash
export BLUE_TANUKI_DAILY_BRIEF_INTERVAL_MS=60000
```

Optional read-only Google source:

```bash
export BLUE_TANUKI_DAILY_BRIEF_GOOGLE_ENABLED=1
export BLUE_TANUKI_DAILY_BRIEF_GOOGLE_SERVICES="gmail,calendar,drive"
export GOOGLE_ACCESS_TOKEN="<read-only-google-oauth-token>"
```

## 9. Boot-time scheduled-message smoke

```bash
export BLUE_TANUKI_SCHEDULES_JSON='[
  {
    "id": "minute-smoke",
    "channel": "webchat",
    "target": "local-user",
    "content": "scheduled smoke from BLUE-TANUKI",
    "interval_ms": 60000
  }
]'
pnpm gateway:serve
```

Boot-time schedules enter HDS-BRAIN as `cron.process` and share the same cron lane as approved runtime schedules.

## 10. Runtime schedules

Runtime schedule creation is enabled in v1.0 RC through `tool:schedule.*`. Listing is L1. Create/update/delete are L3 final-review operations and do not run until approved.

```text
tool:schedule.list
tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
tool:schedule.update id=<id> content="updated smoke"
tool:schedule.delete id=<id>
```

Pending, rejected, or timed-out schedule requests do not fire. Runtime snapshots expose ids, counts, timing metadata, and payload hashes, never schedule content.

## 11. Runtime snapshot

```bash
curl -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  http://127.0.0.1:8787/runtime/snapshot
```

The snapshot exposes HDS state, audit chain validity, memory count, pending approvals, safe scheduled-task metadata, and authority-path invariants.

## 12. Next documents

- [docs/INSTALLER_GUIDE.md](./docs/INSTALLER_GUIDE.md)
- [docs/WINDOWS_INSTALLER_GUIDE.md](./docs/WINDOWS_INSTALLER_GUIDE.md)
- [docs/WINDOWS_FIRST_RUN.md](./docs/WINDOWS_FIRST_RUN.md)
- [docs/WINDOWS_PACKAGING_AUDIT.md](./docs/WINDOWS_PACKAGING_AUDIT.md)
- [docs/WINDOWS_UNINSTALL.md](./docs/WINDOWS_UNINSTALL.md)
- [docs/FIRST_RUN_CHECKLIST.md](./docs/FIRST_RUN_CHECKLIST.md)
- [docs/PERMANENT_USE_CHECKLIST.md](./docs/PERMANENT_USE_CHECKLIST.md)
- [docs/SUPPORT_BOUNDARY.md](./docs/SUPPORT_BOUNDARY.md)
- [docs/KNOWN_LIMITATIONS.md](./docs/KNOWN_LIMITATIONS.md)
- [docs/CHANNEL_READINESS_MATRIX.md](./docs/CHANNEL_READINESS_MATRIX.md)
- [docs/CREDENTIAL_READINESS_MATRIX.md](./docs/CREDENTIAL_READINESS_MATRIX.md)
- [docs/preview-scope.md](./docs/preview-scope.md)
- [docs/UPDATE_ROLLBACK_RUNBOOK.md](./docs/UPDATE_ROLLBACK_RUNBOOK.md)
