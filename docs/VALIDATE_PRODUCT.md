# validate:product

`pnpm validate:product` は製品完成判定用の実体検証ゲートである。`pnpm validate:ga` が文書・台帳・公開主張境界を照合するのに対し、`validate:product` は実際のsmoke、HDS-BRAIN挙動、approval境界、audit検証、evidence pack生成を実行して確認する。

このゲートはHDS-BRAINの外部観測者であり、authority経路やauditチェーンへ書き込まない。証跡は `.codex-tmp/validate-product-evidence/` 配下へ出力され、会話本文・payload本文・secret値は含めない方針でredactされる。

## CLI

```bash
pnpm validate:product
pnpm validate:product -- --phase P2
pnpm validate:product -- --phase P3
pnpm validate:product -- --evidence .codex-tmp/vp-accept
pnpm validate:product -- --list
```

無指定時は登録済みrequired checkを対象にする。`--phase P2` のように指定した場合は、そのphaseまでに到達済みのcheckを対象にする。実行platform外のcheckは `skipped` として報告し、FAILにはしない。

出力サマリ:

```txt
[product] PASS|FAIL phase=P2 required=N passed=N failed=N skipped=M
```

追加ENV:

```bash
BLUE_TANUKI_VALIDATE_TIMEOUT_MS=120000
```

## PASS / FAIL / skipped

| status | 意味 |
|---|---|
| `pass` | checkが実動作または機械判定で成功した |
| `fail` | required checkが失敗した。ゲート全体はexit 1 |
| `skipped` | platform外または未到達phaseのため判定対象外。ゲート全体の失敗にはしない |

## P2 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p2.test_suite` | `FIXTURE` / `INTERNAL_STATE` | Linux基準面で `pnpm test` を子プロセス実行し、既存の自動テスト一式がPASSすることを確認する。この結果だけでlive runtimeの健全性は主張しない |
| `p2.smoke_serve` | `LIVE_RUNTIME` | `scripts/smoke_serve.ts` を子プロセス実行し、gateway起動、WebChat往復、audit persistence、audit-dump検証がPASSすることを確認する |
| `p2.smoke_resume` | `LIVE_RUNTIME` | `scripts/smoke_resume.ts` を子プロセス実行し、SUSPEND→human RESUME→実行結果echoがPASSすることを確認する |
| `p2.hds_standalone` | `LIVE_RUNTIME` | `examples/hds-brain-standalone.ts` のstdoutをJSON parseし、runtime invariants `all_ok` と `audit_chain_valid` を確認する |
| `p2.suspend_dynamic` | `LIVE_RUNTIME` / `INTERNAL_STATE` | fail-safe 6条件をin-memoryで注入し、SUSPEND発火とhuman resume不可を確認する |
| `p2.approval_bypass_dynamic` | `LIVE_RUNTIME` / `INTERNAL_STATE` | `full_access` でもfinal-review operationがallowにならないこと、外部metadataでcapabilityが昇格しないことを確認する |
| `p2.audit_chain_verify` | `LIVE_RUNTIME` / `INTERNAL_STATE` | `smoke_serve` のaudit-dump成功を確認し、さらに既存 `runAuditVerify` 経路で永続audit hash-chainを機械検証する |

## P3 Checks

P3 checks are registered as Windows-target checks. Linux runs report them as `skipped`; the `windows-latest` CI job runs them through `pnpm validate:product -- --phase P3`.
The `windows-product` CI job uploads `.codex-tmp/validate-product-windows`
as the `validate-product-windows-evidence` artifact on both success and
failure, so a passing Windows product gate leaves an evidence pack rather than
only console output.

| ID | evidence source | 内容 |
|---|---|---|
| `p3.package_windows_verify` | `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | `scripts/package_windows.ts` を実行してWindows installer zipを生成し、`scripts/verify_windows_package.ts` でmanifest、sha256、zip contents、secret exclusion、authority boundary metadataを検証する |
| `p3.windows_installed_smoke` | `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | `scripts/smoke_windows_installed.ts` をWindows上で実行し、install→repair install設定保持→port競合検出→常駐起動→GUI/WebChat first message→resident kill→watchdog crash recovery→stop→doctor→restart→safe mode→stop→uninstallを検証する |

## Incremental Registration

| 追加Phase | 検査項目 |
|---|---|
| P2 | ゲート骨格＋Linux系: test一式 / smoke:serve / smoke:resume / hds:standalone / SUSPEND実発火（動的） / approval bypass不能（動的） / audit chain verify / evidence pack生成 |
| P3 | package:windows verify / smoke:windows-installed（win環境） / install→常駐→stop/restart/logs→uninstall往復 |
| P4 | Control Center操作スモーク（API経由） |
| P5 | live LLM smoke（owner資格情報、opt-in→P13でrequired化） / 鍵保護検査 |
| P6 | approval allow・ask・deny・revoke・emergency stopの動的検証 |
| P7 | evidence pack内容検査＋secret redaction検査 |
| P8 | composio dry-run整合（live解放後はlive監査整合） |
| P10 | backup→破壊→restore往復 |
| P11 | release bundle verify＋update失敗rollback |

## Evidence Pack

`--evidence <dir>` を指定しない場合、`.codex-tmp/validate-product-evidence/<UTC ISO timestamp>/` に出力する。

内容:

| file | 内容 |
|---|---|
| `checks.json` | check id、status、duration、summary、ログ抜粋、details |
| `logs/*.log` | 各checkのredacted raw log |
| `environment.json` | node、pnpm、git rev、platform、env key一覧。env値は記録しない |
| `manifest.json` | evidence fileのsha256一覧。self-hash不可能性のためmanifest自身は対象外 |

`validate:product` は証跡を生成するだけで、製品完成claimを解禁しない。P13のowner GOまでは `public_claim_allowed=false` を維持する。
