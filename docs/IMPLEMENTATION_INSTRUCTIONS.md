# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、直前active指示、現物HEAD／差分、E03.03と既存J/M recovery consumerを再読した。対象はBLUE-TANUKIだけ。D4Pocket／ミニドラrepo、実provider／資格、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-PLAN-MEMORY-LEDGER-CORRELATION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`eb3a52a232cc62556af75b726fb494b157d5f59a`、clean。編集前に現世代=`eb3a52a232cc62556af75b726fb494b157d5f59a`、前世代=`e9c1df7ecdcd0ed4a3dd854414f6da9ccb87592f`のlocal復旧branch二世代とremote backup tag二世代を条件付きで回転し、local／remote SHA一致を確認した。backup-ref状態=`MIGRATION_COMPLETE`。旧local tag cacheは事前観測でremoteと不一致だったため、remote SHAのCAS更新後にremoteを正本として合わせた。

### 目的

J OperationPlan checkpointに保存された結果MemoryCommit／Receiptと、canonical J/M ledger inspectionの実値をupdate・event・content・revision・receipt digestでread-only照合する。現在の「リンクがあるので未照合」という残差を、実consumerの一致・保留・不一致・未検証へ分類し、Gateway CLI・保護済みRecovery operator projection・BLUE WebChatまでdigest-only状態をつなぐ。

### 対象と境界

- 対象：`packages/hds-brain/src/operation_result_memory.ts`の既存純粋検証器を公開read-only利用可能にするbarrel export、`apps/gateway/src/operation_plan_recovery_inspection.ts`、`apps/gateway/src/recovery_inspection.ts`、`apps/gateway/src/cli_router.ts`、Gateway focused tests、`packages/channel-webchat/src/control_center_script.ts`とfocused test、本進捗、公開ROADMAP、本指示。
- 相関対象はJ checkpoint内result-memory linkと既存J/M canonical ledger row。raw update ID／event ID／record／plan／command／result本文を新たに外へ出さず、sha256 digest・整数・固定enumだけをCLI/operatorへ投影する。
- Memory、plan checkpoint、UI projectionは参照／証拠であり、権限・承認・risk判定・実行・再送・repair・restore・resumeを生成しない。すべて`used_for_authority=false`、`may_execute=false`を維持する。盤面のM/J/Broker残差や独立backup未検査の既存扱いを弱めない。
- 実state／live serve、実credential/provider、外部業務作用、D4Pocket／ミニドラ、5OS実機、QE_QC／QE_QA、P13 owner GOは対象外。E03.03／QEB-03=`BUILD_GAP`、C08.03 provider試験保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### 成立条件

1. 合成の実結果→J OperationPlan result-memory commit／receipt→J/M ledgerをread-only相関し、一致をdigest-only固定状態で返す。保留・破損・不一致・台帳未検証は一致へ昇格しない。
2. operator projectionで新enumとupdate digestを再allowlistし、WebChatのrecovery表示に状態が現れる。raw sentinel、本文、ID、DB pathを出さず、無効なboundaryでは行を抑止する。
3. Inspection前後でJ/M/OperationPlan/Broker保存物が変わらないことをfixtureで確認する。型検査、Gateway/WebChatの接続対象focused test、workspace build、必要なdocs gate、`git diff --check`を実行する。
4. E03.03とQEB-03は`BUILD_GAP`のまま、次consumerと残差を記録する。batch末に限定commitをmainへpushし、HEAD、remote main、backup tag二世代、local復旧branch二世代、clean stateを再照合する。他writer更新やref不一致時は上書きしない。

### 技術確認・Git閉包

Gateway `execution_result_reconciliation.test.ts` 30/30、OperationPlan／recovery inspection 2 files／13 tests、WebChat `webchat.test.ts` 76/76を確認した。`pnpm typecheck`、`pnpm build`（15 workspace projects）、`pnpm docs:check`、`git diff --check`はすべてPASS。縦断fixtureでは一致・content mismatch・期待link欠落を確認し、J/M/OperationPlan/Brokerの保存物不変を検査した。実state、live serve、provider／資格、外部業務作用、別repo、実機、QE_QC／QE_QAは未実施。

BUILD_BATCH状態=`完了`。実装commit=`7af70b50aa81470ce096d2b153ed71135933874b`（mainへpush済み）。QE_BUILDは継続し、次consumerは次回の三点正本／現物再同期で選定する。E03.03／QEB-03は`BUILD_GAP`、C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
