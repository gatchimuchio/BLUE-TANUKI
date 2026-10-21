# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。owner指定rev2.3三点セットのpinを維持する。backup refsは`MIGRATION_COMPLETE`（2026-10-12）で、local recovery branchesとremote tagsの二世代SHAが照合済み。`QEB-36-E07.02-SHARED-TARGET-SERIALIZATION`では、Executorのadapter dispatch前に同一target resource lockを取得する。file.write／file.edit／file.deleteはsandbox内の実体pathから非公開digestを作り、同一Node.js process内の複数Executor間で直列化する。gmail.writeは承認済みtarget identity digestで直列化する。lock待ちはexecution timeoutに含め、timeout後も実adapter promiseの終了までlockを保持する。各adapterの既存target-version再照合は維持し、期待版が変われば後続作用を拒否する。

QE_BUILDの現行経路ではファイルtarget mutationとGmail writeの該当target dispatchを`WIRED`とする。lockはprocess-localであり別processとの排他を証明しない。任意shell commandや未接続adapterの共有target識別は`BUILD_GAP`として保持する。E07親要求全体と製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。C08.03実provider保留、D4Pocket／ミニドラ別repo変更なし、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

確認済み：Executor target-lock fixture 1 test、Gmail target-version suite 10 tests、file target-versionの選択確認3 tests、core package typecheck、`git diff --check`はPASS。全workspace suite、workspace build、provider／credential、外部業務作用、5OS実機、QE_QC／QE_QAは未実施。

## 次のBUILD_BATCH

`QEB-37-E07.03-PARENT-CANCELLATION-CONVERGENCE`として、E07.01子computeからE07.03の実worker lifecycle consumerを追い、親取消後の遅延結果を非権威証拠として保持し、未完了childを停止・観測する。現行rev2.3三点セットとE07.03、最新HEAD・差分を開始時に再同期する。E07.02で残る任意shell／未接続adapterのresource coverageは、後続の実target接続時に具体化する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
