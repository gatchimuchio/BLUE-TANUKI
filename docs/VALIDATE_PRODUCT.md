# validate:product

`pnpm validate:product` は製品完成判定用の実体検証ゲートである。`pnpm validate:ga` が文書・台帳・公開主張境界を照合するのに対し、`validate:product` は実際のsmoke、HDS-BRAIN挙動、approval境界、audit検証、evidence pack生成を実行して確認する。

このゲートはHDS-BRAINの外部観測者であり、authority経路やauditチェーンへ書き込まない。証跡は `.codex-tmp/validate-product-evidence/` 配下へ出力され、会話本文・payload本文・secret値は含めない方針でredactされる。

## CLI

```bash
pnpm validate:product
pnpm validate:product -- --phase P2
pnpm validate:product -- --phase P3
pnpm validate:product -- --phase P4
pnpm validate:product -- --phase P5
pnpm validate:product -- --phase P6
pnpm validate:product -- --phase P7
pnpm validate:product -- --phase P8
pnpm validate:product -- --phase P9
pnpm validate:product -- --phase P10
pnpm validate:product -- --phase P11
pnpm validate:product -- --phase P12
pnpm validate:product -- --phase P13
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
BLUE_TANUKI_VALIDATE_TIMEOUT_MS=600000
```

無指定時の既定値も 600000ms である。Windows installed smoke は installer setup / repair / launch / uninstall まで実行するため、120000ms では実機で不足する場合がある。

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
| `p3.package_windows_verify` | `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | `scripts/package_windows.ts` を実行してWindows installer zip、sha256、manifest、`README_INSTALL_WINDOWS.txt`を生成し、`scripts/verify_windows_package.ts` でmanifest、sha256、README、zip contents、secret exclusion、authority boundary metadataを検証する |
| `p3.windows_installed_smoke` | `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | `scripts/smoke_windows_installed.ts` をWindows上で実行し、source tree product setup誤起動時のfriendly guidance、root `INSTALL_WINDOWS.ps1` default dry-run がsource buildへ落ちず verified release download / fail-closed導線になること、`-BuildFromSource` explicit dry-runのみbuild/package導線を持つこと、root `INSTALL_WINDOWS.cmd` 別cwd dry-run、installer zip展開後の`BlueTanukiSetup.cmd` install、repair install設定保持、明示autostart/HKCU Run entryによるreboot persistence、port競合検出、常駐起動、GUI/WebChat first message、approval API token separation、audit tamper検出、resident kill、watchdog crash recovery、stop、doctor、restart、safe mode、Defender/SmartScreen向けSHA-256 guidance同梱、uninstallを検証する。marker一覧は `docs/WINDOWS_EVIDENCE_PACK.md` に固定する |

## P4 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p4.control_center_settings_api` | `LIVE_RUNTIME` / `INTERNAL_STATE` / `CONFIG` / `EXTERNAL_EVIDENCE` | WebChat Control Centerをloopback上で起動し、`/app` のSettings / Connectors / About / Backup-Restoreフォーム描画、`/settings/config` の専用settings token必須性、redacted snapshot、`/settings/llm/verify` の非mutating検証、LLM設定save、Composio allowlist / dry-run / live opt-in設定save、Composio non-authority境界、`/app/about` のWebChat token必須性・read-only性・version/license/claim boundary/public_claim_allowed=false/non-authority境界、`/recovery/snapshot` のWebChat token必須性・env backup inventory・recovery pack inventory・secret-bearing分類・backup/reset control availability・destructive repair未解放・non-authority境界をAPI経由で検証する |

## P5 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p5.llm_resilience_health` | `INTERNAL_STATE` / `FIXTURE` | LLM registryのretry、明示fallback、typed provider error分類、health snapshot、LLM API key secret-ref round trip、LLM output/provider metadata/health metadata/secret metadataのnon-authority境界をfixtureで検証する。owner資格情報を使うlive LLM smokeはP13前の外部証跡として別途必要 |
| `p5.llm_fetch_abort_timeout` | `LIVE_RUNTIME` / `INTERNAL_STATE` | 応答しないloopback OpenAI-compatible endpointに対して `timeout_ms=50` を渡し、provider fetchが `kind=timeout` でabortされ、request/socketが残留せず、settings verify経路もsafe/non-mutating failureとしてtimeoutすることを検証する |
| `p5.windows_dpapi_secret_roundtrip` | `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | Windows上で `COMPOSIO_API_KEY` をDPAPI CurrentUser refとして保存し、envに平文が残らず、secret fileが作成され、復号値が一致し、secret file改竄と `BLUE_TANUKI_POWERSHELL` 不正pathがfail-closedすることを検証する。Windows以外ではplatform skip |

## P6 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p6.approval_authority_controls` | `INTERNAL_STATE` / `LIVE_RUNTIME` / `FIXTURE` | Approval Gateのallow / ask / deny / remembered grant / revoke / L3 final-review non-bypassを動的評価し、WebChat approval APIをloopback上で起動してresume-token必須性、grant revoke、approval historyのnon-authority flag、owner emergency stop activate/clear、emergency stop中のdownstream execution block fixtureを検証する |

## P7 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p7.evidence_pack_redaction` | `LIVE_RUNTIME` / `INTERNAL_STATE` / `EXTERNAL_EVIDENCE` / `FIXTURE` | Gateway evidence pack exporterをfixture audit / complete-historyで実行し、manifest、human-readable report、hash-chain検証結果、retention、secret redaction、raw payload非露出、`used_for_authority=false` を検証する |

## P8 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p8.composio_safety_closure` | `INTERNAL_STATE` / `FIXTURE` | Composio live availabilityがAPI key / user id / dry-run false / live opt-in / toolkit allowlist / action allowlistの全条件でのみ開くこと、dry-runが外部requestを呼ばないこと、revoked actionが外部request前にblockされること、HDS routeが`composio.execute`をL3 final-review askに止めること、承認済みfixture commandがExecutor経由でComposio v3.1 execute endpointへ到達すること、pre/post authority eventとexecutor feedbackがaudit hash-chainで検証できること、API keyがfeedback/evidenceに露出しないことを確認する。実Composio資格情報でのlive smokeはP13前の外部証跡として別途必要 |

## P9 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p9.channel_operator_extension_boundary` | `CONFIG` / `INTERNAL_STATE` / `FIXTURE` | CLAIM・package metadata・operator manifest・release bundle・Windows package・preview/core scope文書の三点一致を確認し、`pnpm validate:channels` でWebChat/Telegram first-party、Slack/Discord/Teams/LINE first-party-preview、WhatsApp reserved-third-partyを検査する。Writing / Daily / Developer Operatorはbundled `plugin:review` とplugin-loader surface読込でLayer A / downstream / non-authority / L3 final-review境界を確認する。Plugin Review Gate / Plugin HIG / Skill Loader Contractはv1.0 contract-stable Layer B境界を宣言していることを確認する。owner-run channel promotion smokeや第三者plugin live実行は主張しない |

## P10 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p10.recovery_backup_restore` | `CONFIG` / `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | WebChat recovery control pathをloopback上で起動し、`/recovery/snapshot` のcontrol availabilityとnon-authority境界、`/recovery/backup` のtoken gateとsecret非露出、破壊後の`/recovery/restore`によるenv/session復元、`/recovery/reset-provider`によるstub復帰、`/recovery/reset-connector`によるComposio dry-run/live disabled復帰、`/recovery/factory-reset`によるsession/memory/schedule/log削除とaudit/recovery root保持を実ファイルで検証する |

## P11 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p11.update_release_rollback` | `CONFIG` / `LIVE_RUNTIME` / `EXTERNAL_EVIDENCE` | WebChat update control pathをloopback上で起動し、`/update/snapshot` のtoken gate、manual update mode、release bundle sha256 sidecar / manifest verification、unsigned/no-secret/no-dynamic-import境界、automatic updater未出荷、runtime auto-apply未解放、non-authority境界を検証する。`/update/verify` はsecret非露出で候補bundleを検証し、`/update/prepare` は明示confirmationなしでfail-closed、confirmationありでP10 recovery backupとrollback planを生成し、rollback planがmanual app restore必須・non-authority・secret非露出であることを実ファイルで確認する。release notes `docs/release-notes/1.0.0-rc.1.md` の存在とpre-GO境界も検査する |

## P12 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p12.docs_support_claims` | `CONFIG` / `EXTERNAL_EVIDENCE` | `docs/SUPPORT_BOUNDARY.md` と `docs/KNOWN_LIMITATIONS.md` が存在し、README / QUICKSTART / CLAIM / RC docs / release notes / docs indexから参照されることを確認する。`public_claim_allowed=false`、`used_for_authority=false`、HDS-BRAIN authority、first-party support surface、preview/no-support boundary、reserved/not-shipped boundary、Slack / Discord / Teams / LINE preview、WhatsApp reserved-third-party、signed installer未出荷、automatic updater未出荷、Windows実機証跡・credentialed live smoke・manual update replacement・future migration schema等の残差が文書化され、compatibility matrixのchannel statusと矛盾しないことを検査する |

## P13 Checks

| ID | evidence source | 内容 |
|---|---|---|
| `p13.owner_go_release_boundary` | `CONFIG` / `EXTERNAL_EVIDENCE` | `validate:ga` のpre-GO結果が `status=pre_go_ready` / `owner_go=pending` / `public_claim_allowed=false` / `package_version=1.0.0-rc.1` を保ち、`require-owner-go` modeがowner decisionなしでfail-closedすることを確認する。D1-D7 decision ledger、P13 readiness doc、GA promotion review、release notesがowner GO、Windows実機E2E、release bundle verification、`docs/ga-owner-decision.json`、public claim boundaryを矛盾なく記録していることを検査する。このcheckはGA解禁ではなく、GOなしにreleaseしない境界の検査である |

## Incremental Registration

| 追加Phase | 検査項目 |
|---|---|
| P2 | ゲート骨格＋Linux系: test一式 / smoke:serve / smoke:resume / hds:standalone / SUSPEND実発火（動的） / approval bypass不能（動的） / audit chain verify / evidence pack生成 |
| P3 | package:windows verify / smoke:windows-installed（win環境） / install→常駐→stop/restart/logs→uninstall往復 |
| P4 | Control Center操作スモーク（API経由） |
| P5 | LLM resilience health fixture / LLM secret-ref fixture / 実HTTP abort timeout / settings verify timeout / Windows DPAPI connector secret roundtrip / live LLM smoke（owner資格情報、opt-in→P13でrequired化） |
| P6 | approval allow・ask・deny・remembered grant・revoke・emergency stop・L3 final-review non-bypassの動的検証 |
| P7 | Control Center evidence export / evidence pack内容検査 / human-readable report / retention / secret redaction検査 |
| P8 | Composio dry-run no-call / live opt-in / toolkit+action allowlist / action revoke / L3 final-review non-bypass / fixture live execution / pre-post audit |
| P9 | channel claim matrix / operator first-party package-manifest-release整合 / bundled plugin review / plugin-loader surface / Layer B contract-stable宣言 |
| P10 | Control Center/WebChat経由のbackup→破壊→restore往復、provider reset、connector reset、audit保持factory reset |
| P11 | release sidecar verify＋pre-update backup＋rollback plan＋release notes |
| P12 | support boundary＋known limitations＋release claim alignment |
| P13 | owner GO release boundary＋pre-GO fail-closed verification |

## Evidence Pack

`--evidence <dir>` を指定しない場合、`.codex-tmp/validate-product-evidence/<Windows-safe UTC timestamp>/` に出力する。
timestamp は `2026-06-15T13.40.21.589Z` のように、Windows path で使えない `:` を含まない。

内容:

| file | 内容 |
|---|---|
| `checks.json` | check id、status、duration、summary、ログ抜粋、details |
| `logs/*.log` | 各checkのredacted raw log |
| `environment.json` | node、pnpm、git rev、platform、env key一覧。env値は記録しない |
| `p7-runtime-evidence-root/evidence-*/summary.json` | P7 exporterが生成するdigest-only evidence summary |
| `p7-runtime-evidence-root/evidence-*/report.txt` | P7 exporterが生成するhuman-readable report |
| `manifest.json` | evidence fileのsha256一覧。self-hash不可能性のためmanifest自身は対象外 |

`validate:product` は証跡を生成するだけで、製品完成claimを解禁しない。P13のowner GOまでは `public_claim_allowed=false` を維持する。
