# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。owner指定rev2.3三点セットのpinとbackup ref移行は維持。`QEB-35-E07.01-PARENT-GOAL-DELEGATION`では、開発者の内部plan:computeだけに固定4 role（division／independent comparison／audit／redundancy）を発行し、親task・criteria・termination digestへ束縛した。ExecutorはC計算経路で子要求を最大2件ずつ処理し、各子を固有task digest・個別token/time上限・共有parent budget digestへ予約する。budget reservation能力がないC実装はprovider呼出し前に拒否する。子にtool・再委任・実行・権限能力はなく、出力は候補として親計算へ渡す。親のplan候補は既存HDS inspectionと採否経路に留まる。これを当該consumer経路の`WIRED`とするが、E07親全体と製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

HDS `goal_governance.test.ts` 15 tests、Executor `executor_compute.test.ts` 8 tests、workspace `pnpm typecheck`／`pnpm build`はPASS。実provider／credential、全workspace suite、外部業務作用、5OS実機、QE_QC／QE_QAは未実施。製品全体は`BUILD_GAP`のまま。C08.03実provider保留、D4Pocket／ミニドラ別repo変更なし、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
## 次のBUILD_BATCH

`QEB-36-E07.02-SHARED-TARGET-SERIALIZATION`として、同じ実体への作用をresource lockと期待版で直列確定するconsumerを現行Broker／operation-plan経路から調査・接続する。既存target identityとversion preconditionを再利用し、未接続をschemaだけで閉じない。対象・consumer・停止条件は次batch開始時に現行rev2.3三点セットとE07.02から再同期する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
