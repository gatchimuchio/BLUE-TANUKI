# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

D05.02は部分的に`WIRED`。QEB-38／40で取消signal・遅延結果破棄・native shell worker観測・lifecycle evidence回復を接続し、QEB-41でowner-facing task単位取消をControl Center／WebChatからExecutorへつないだ。作業ログは`IMPLEMENTATION_HISTORY.md`と`開発進捗.md`に保持し、ここでは実装を続けるための現在地だけを記す。D05.02全体、`SYSTEM_SHAPED`、`BUILD_COVERED`は未成立。

残る`BUILD_GAP`は、task cancel要求・Executor settlementの監査記録がCompleteHistory保存不能時に回復するconsumer。remote provider内部の停止は確認手段がない限り`unknown`を保つ。AbortSignalに従わないgeneric toolは取消受付後もactiveになり得るため、settlement前に停止済みと表示しない。任意tool processの強制killを実装済みと報告しない。

## 次のBUILD_BATCH

`QEB-42-D05.02-CANCEL-EVIDENCE-RECOVERY`。task単位の取消受付とExecutor settlementを、既存`GatewayExecutionIntentStore`のprivate hash-chain evidence回復経路へ接続し、CompleteHistoryへ永続投影できた場合だけackする。QEB-40のlifecycle evidence機構を再利用し、本文・tool結果を保存しない。

作業開始時に固定された現行三点セットの全文を読み直す。適用AGENTS.md、HEAD／dirty state、取消記録と既存recovery consumerも再確認する。取消自体はaudit保存失敗で取り消さず、未ack証拠はprivate ledgerへ保持する。CompleteHistoryのmemory-only projectionは永続ackとみなさない。取消要求・Executor settlement・local worker観測・external processing stopは別状態とし、対象task本文、tool結果、秘密を保存しない。未承認の外部作用、実provider／credential、D4Pocket／ミニドラ別repo変更、公開・出荷判断を含めない。

最低限の確認は、CompleteHistory未設定・append失敗からのtask cancellation evidence recoveryと重複防止の限定試験、変更型・buildに絞る。全workspace suite、全異常注入、性能・耐久、OS別QAは全体実装形状成立後へ置く。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref移行状態は`MIGRATION_COMPLETE`（`BACKUP_REF_MIGRATION.md`）の現行記録を参照する。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
