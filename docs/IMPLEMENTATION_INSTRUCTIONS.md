# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。rev2.3 pinとbackup ref移行=`MIGRATION_COMPLETE`。`QEB-31-E05.03-VERSION-CANDIDATE-TO-DEVELOPMENT-PRINCIPAL`で、request-boundのFailureLearning候補をruntime FailureMemoryから分離したDevelopmentHandoffStoreへ渡し、認証済みno-storeのDeveloper surface／Control Center inboxで表示する実producer→consumerを接続した。候補は未評価の開発検討資料であり、実行・承認・コード／P版昇格はしない。関連focused tests 190/190、workspace typecheck/build、`docs:check`はPASS。全workspace suite、QE_QC／QE_QAは未実施。製品全体は`BUILD_GAP`で、`SYSTEM_SHAPED`／`BUILD_COVERED`未成立。

## 次のBUILD_BATCH

`QEB-32-E06.01-RELATION-TRACED-RETURN`として、結果から影響relationを辿る帰還対象集合を作り、採用・非採用候補と目的へ戻す実producer→consumerを現物から特定する。無影響と判断した範囲にも保持理由を残す。E06.01の要求、次consumer、変更対象、停止条件は作業開始時に現行三点セットと最新コードから再構成する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
