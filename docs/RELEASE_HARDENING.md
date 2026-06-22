# Release Hardening Gate

BLUE-TANUKI の通常ユーザー導線は、OS 別の single-file installer を受け取り、
実行するとインストール、resident 起動、Control Center 表示まで進む形に固定する。
この gate はその配布面を硬化するための静的検査であり、HDS-BRAIN の authority
path ではない。

## 現在の境界

- 現在の RC は signed native installer ではない。
- 現在の RC は automatic updater を持たない。
- GitHub Actions workflows are intentionally absent.
- runtime_auto_apply_available=false。
- 更新は manual_update_only。
- installer / updater / release metadata は authority として使わない。

## GitHub Actions boundary

GitHub Actions / CI workflow はこのリポジトリの品質判定経路ではない。
`.github/workflows` 配下に YAML workflow が存在する場合、
`pnpm validate:release-hardening` と `pnpm validate:packaging` は fail する。

push / pull_request / schedule / workflow_dispatch による自動テストは使わない。
品質判定は owner が明示的に走らせる local release validation と実機 evidence を正とする。

## Local release validation

local release validation の入口は package scripts に残す。
`pnpm validate:release-hardening` は少なくとも次の script 名が `package.json` に残っていることを確認する。

```text
typecheck
build
test
docs:check
validate:repo-health
validate:packaging
validate:release-hardening
validate:channels
validate:ga
validate:product
plugin:review
doctor
smoke:serve
smoke:resume
smoke:live
smoke:windows-installed
smoke:linux-installed
smoke:macos-installed
release:bundle
release:verify
```

これらは GitHub runner ではなく、owner / Codex が必要なタイミングでローカル実機または対象OS上で実行する。

## Signing prerequisites

署名済み native installer は将来の owner-scoped release phase で扱う。通常の
`pnpm validate:release-hardening` は未署名状態を明示して通すが、署名必須
release として扱う場合は次を実行する。

```bash
pnpm validate:release-hardening -- --require-signing
```

この mode は必要な資格情報がなければ fail-closed する。必要な環境変数は以下。
これらは artifacts、release bundle、installer payload、docs の出力物に含めては
ならない。

```text
BLUE_TANUKI_WINDOWS_SIGNING_CERT_PFX
BLUE_TANUKI_WINDOWS_SIGNING_CERT_PASSWORD
APPLE_DEVELOPER_ID_APPLICATION
APPLE_DEVELOPER_ID_INSTALLER
APPLE_NOTARIZATION_APPLE_ID
APPLE_NOTARIZATION_TEAM_ID
APPLE_NOTARIZATION_PASSWORD
BLUE_TANUKI_LINUX_GPG_PRIVATE_KEY
BLUE_TANUKI_LINUX_GPG_KEY_ID
```

資格情報がない状態の expected status は `blocked_missing_credentials`。資格情報が
全てある状態でも、この gate が証明するのは static configuration の充足だけであり、
実際の signtool / codesign / notarization / GPG signing 成功は別の
EXTERNAL_EVIDENCE が必要。

## Automatic updater boundary

BLUE-TANUKI はこの RC で automatic updater を実装しない。Control Center の
update surface は候補 bundle の検証と rollback evidence 作成までで、app files の
置換、background download、runtime auto-apply は行わない。

将来の updater は次の条件なしに有効化しない。

- HDS-BRAIN authority path を変更しない。
- update metadata が authority にならない。
- owner final review を迂回しない。
- pre-update backup / rollback plan / audit evidence を残す。
- 失敗時は SUSPEND または明示された repair path に止まる。

## Evidence source

この gate の evidence source は `CONFIG`。
GitHub Actions workflow 不在、docs、package scripts、installer manifest boundary、
update surface boundary を読むだけで、live installed product の動作成功や署名の
成立は証明しない。実機検証、extracted bundle verification、credentialed live smoke は
別の `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` として実行・報告する。

Expected normal output:

```text
release_hardening=pass_pre_signing_blocked
github_actions_workflows_present=false
local_release_validation_commands_present=true
signed_native_installer_status=blocked_missing_credentials
automatic_updater_status=manual_update_only
runtime_auto_apply_available=false
```
