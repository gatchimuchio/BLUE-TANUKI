# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、仕様・工程・施工指示は今回に必要な節だけ読む。新版指定・工程対象切替・依存や矛盾の解消時のみ三点全文を再読する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

`QEB-12-E03.03-OPERATION-PLAN-SCOPED-RECOVERY` は完了し、詳細をIMPLEMENTATION_HISTORY.mdへ移した。選択Operation Plan復元からHDS対象plan再評価までのconsumerは`WIRED`。E03.03／QEB-03全体は`BUILD_GAP`。現行ピンrev2.3、backup ref移行状態=`MIGRATION_COMPLETE`。

## 次の接続

次のBUILD_BATCHはE03.03の常駐launcherが、復元後の仕事単位状態・残差をどのproducerから受け取り、どの既存consumerへ戻すかを現行コードから特定する。新しいバッチ開始時にQE_CURRENT_AUTHORITYのE03.03関連節と実callsiteを確認して範囲を固定する。旧ログに残る過去の「次」は現行指示として使わない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
