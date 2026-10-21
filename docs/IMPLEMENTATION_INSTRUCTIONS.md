# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。rev2.3 pinとbackup ref移行=`MIGRATION_COMPLETE`。`QEB-33-E06.02-SEMANTIC-RESTORE-SEPARATE-FROM-EXTERNAL-EFFECT`では、owner L3後の意味候補訂正からMの`quarantined → restored → reassessed`まで進める実HDS経路を検査し、事前に完了済みとして保持した合成Gmail送信のJ `OperationPlan`状態が意味復元・再起動後も`verified`のまま残ることを接続確認した。外部送信状態はJのOperationPlan projection、意味状態はMの解釈履歴として別々に保持され、provider・credential・実送信は使っていない。focused test 1/1、workspace typecheck/buildはPASS。全workspace suite、QE_QC／QE_QAは未実施。製品全体は`BUILD_GAP`で、`SYSTEM_SHAPED`／`BUILD_COVERED`未成立。

## 次のBUILD_BATCH

`QEB-34-E06.03-GOAL-CHANGE-PROPOSAL-BOUNDED-REOPEN`として、反証による影響範囲から必要な対象だけを再開放し、目的変更が必要な場合も提案に留めて上位承認へ送る実consumerを接続する。対象・現consumer・停止条件は最新版三点セットのE06.03と現行コードから組み立てる。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
