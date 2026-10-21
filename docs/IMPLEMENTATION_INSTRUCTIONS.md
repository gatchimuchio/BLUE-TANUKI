# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セットである。独立作業の開始・切替・再開時は、三点セットの全文を読み直す。そのうえで現行版の仕様書・工程表・施工指示書、適用`AGENTS.md`、owner指示、HEAD・dirty stateを照合する。同一BUILD_BATCH内では関連要求と現物を再同期する。完了作業・旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) と [`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の解消時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。owner指定のrev2.3三点セットpinは維持する。復旧ref二世代の移行は`MIGRATION_COMPLETE`（2026-10-12）。開発順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断とする。全体実装が未完了の間は詳細品質試験へ先回りしない。型・起動・実consumerへの短時間疎通、および安全を守るために必要な確認は継続する。

`QEB-38-D05.02-PROCESS-CANCEL-CONSUMER`ではGateway停止・shutdownのAbortSignalをExecutorの汎用tool controllerへ伝播し、既存shell native providerへ渡す経路を接続した。取消後に返ったtool結果は破棄して`outcome unknown`で返す。native providerのworker開始・取消要求・終了観測・検証済みprocess tree empty、またはprovider状態不明をCompleteHistoryへ非権威metadataとして記録する。file.searchの既存worker PID開始・終了記録は再利用した。

D05.02は停止signal→Executor→toolの取消伝播、およびlocal shell workerの検証済み停止観測を部分的に`WIRED`とする。以下は`BUILD_GAP`のまま保持する：remote provider内部処理の停止確認、AbortSignalに従わない汎用toolの強制停止、CompleteHistoryが未設定・永続化不能な場合の回復後欠損記録、Gatewayのtask単位cancel callsite（今回調査した範囲では見つからず）。停止要求、local停止、provider側状態不明を同一結果として扱わない。`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。

検査済み：Executor dispatch focused suite 17 tests、Windows shell process-tree cancellation test 1件、core typecheck/build、Gateway typecheck。全workspace suite、実provider／credential、外部業務作用、5OS実機、QE_QC／QE_QAは未実施。これらを現行実装の完成証拠へ昇格しない。

## 直近再確認

`QEB-39-D05.03-AUDIT-FAILURE-EMERGENCY-STOP`は現HEADで既存実装により成立済みだったため、製品コードを重複変更せず閉じた。専用SQLite deny-only latchをHDS authority auditから独立して保存し、audit保存失敗時もexecutionを止め、回復後に元のevent ID・発生時刻で欠損eventを補記する。補記とpersistent auditの検証前はstopを解除できない。Gateway producerからrunning executionのabortとactive-state gateへ接続済み。`emergency_stop_control.test.ts` 4 testsとGateway typecheckが現HEADでPASS。これはD05.02のCompleteHistory証拠回復とは別経路であり、そのgapを閉じた扱いにしない。

## 次のBUILD_BATCH

`QEB-40-D05.02-COMPLETE-HISTORY-GAP-RECOVERY`。rev2.3 D05.02の未解決producer→consumerを再確認する。対象は取消・停止自体をCompleteHistoryの可用性へ依存させず、記録先が未設定または保存失敗した場合に、回復後の欠損事実・時点を実consumerで残せるかである。D05.03のHDS authority-audit recoveryと混同せず、既存のdurable state／hash-chain境界を先に調べ、機構を重複作成しない。現物で既に成立していれば限定確認のみで記録し、未成立箇所があればそこだけ接続する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、ownerの最終権限を維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。Gitはmainとremoteを照合し、意味あるBUILD_BATCH終端で限定commit/pushと復元ref／作業ツリーを確認する。
