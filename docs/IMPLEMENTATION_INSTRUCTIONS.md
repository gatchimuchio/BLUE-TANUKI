# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

`QEB-13-E03.03-WAIT-RECOVERY-HOLD-ROUTING` と `QEB-14-E03.03-BROKER-RESULT-RECOVERY-HOLD` は完了し、詳細をIMPLEMENTATION_HISTORY.mdへ移した。復元holdは常駐wait／遅延C候補を止め、Brokerの保存結果は観測済みcanonical restore holdのもとでJ/Mへ照合できる。結果返却とplanの再利用はhold中に止まり、Jのfresh review後にのみ解放される。E03.03／QEB-03全体は`BUILD_GAP`。現行ピンrev2.3、backup ref移行状態=`MIGRATION_COMPLETE`。

## 次の接続

次のBUILD_BATCHではE03.03の回復可能な仕事と破損依存仕事を分離し、無関係な仕事が継続できるための未接続consumerを現行Recovery／J／M／Broker経路から特定する。新しいバッチ開始時に固定済みrev2.3のE03.03関連節、適用AGENTS.md、HEAD／差分を再同期して範囲を確定する。旧ログに残る過去の「次」は現行指示として使わない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
