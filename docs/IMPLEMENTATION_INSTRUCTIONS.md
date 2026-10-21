# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

`QEB-13-E03.03-WAIT-RECOVERY-HOLD-ROUTING`、`QEB-14-E03.03-BROKER-RESULT-RECOVERY-HOLD`、`QEB-15-E03.03-J-PLAN-RESIDUAL-ISOLATION`は完了し、詳細をIMPLEMENTATION_HISTORY.mdへ移した。復元holdはwait／遅延C候補／Broker保存結果の返却・plan再利用を止める。Jの意味的不整合planは実行viewから隔離し、raw recordを保全したままclean sibling planの判断・保存を続けられる。plan-scoped restoreは選択scopeだけを置換する。checkpoint全体digest不一致とplan項目のschema-invalidは全体fail-closedで、job全体の独立復旧は未成立。E03.03／QEB-03全体は`BUILD_GAP`。現行ピンrev2.3、backup ref移行状態=`MIGRATION_COMPLETE`。

## 次の接続

次のBUILD_BATCHでは、checkpoint全体digestは一致するが一つのplan itemだけがschema-invalidな場合に、他planを使い続けられる次consumerをRecovery／J経路へ接続する。raw residualを保持し、該当planの表示・plan-scoped restoreだけを可能にし、digest不一致・共有state破損は全体fail-closedに保つ。新しいバッチ開始時は固定済みrev2.3のE03.03関連節、適用AGENTS.md、HEAD／差分を再同期して範囲を確定する。旧ログに残る過去の「次」は現行指示として使わない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
