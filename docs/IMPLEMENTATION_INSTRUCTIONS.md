# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。owner指定rev2.3三点セットのpinを維持する。backup refsは`MIGRATION_COMPLETE`（2026-10-12）で、local recovery branchesとremote tagsの二世代SHAが照合済み。`QEB-37-E07.03-PARENT-CANCELLATION-CONVERGENCE`では、Executorが各child computeへ個別AbortControllerを渡し、親signalを受けたら実行中の全childへ取消を伝え、後続child batchと親Computeを開始しない。取消後に返った子出力は親候補へ入れず、出力本文や本文digestを保存せず、結果有無・文字数・resource-use digestだけを非権威記録へ残す。Gatewayは既存CompleteHistoryのhash-chainへchild lifecycleを`audit_history`として追加する。1秒後にも未settleなら`residual_worker_observed`、後着時は`late_result_discarded`を記録する。

QE_BUILDの現行経路では、親signal→Executor child compute cancellation→CompleteHistory lifecycle記録を`WIRED`とする。ComputeBackendがsignalを無視した場合の強制kill、provider側処理の停止確認、CompleteHistoryがfile未設定時の再起動後保持は未成立で`BUILD_GAP`。遅延結果は権威・実行可能性・親候補に使わない。E07親要求全体と製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。C08.03実provider保留、D4Pocket／ミニドラ別repo変更なし、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

確認済み：`executor_compute.test.ts` 9 tests、core package typecheck／build、Gateway package typecheck、`git diff --check`はPASS。実provider／credential、外部業務作用、5OS実機、全workspace suite、QE_QC／QE_QAは未実施。全体実装形状の前に詳細QC／QAへ進まない。

## 次のBUILD_BATCH

`QEB-38-D05.02-PROCESS-CANCEL-CONSUMER`として、Gatewayの停止・取消起点から既存child/process workerまでの実consumerを追い、停止要求、local settlement、provider側の不明状態を分けて接続する。実際のkill/stop機構がないComputeBackendやremote providerを停止済みと偽らず、利用可能な既存consumerがなければ具体的`BUILD_GAP`を残す。新しいwrapper/shimや独立stop authorityは作らない。作業開始時に現行pin、三点セット、適用AGENTS、active task、最新HEAD・差分を再同期する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
