# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-21-E03.03-TASK-LINEAGE-SCOPED-RESTORE`で、L3 scopeをHDS-J task identityへ束縛し、同一lineageのplan／waitをJ storeから選択復元するconsumerを接続した。現在のlineage外recordは維持し、兄弟planのselected bindingを失効、`intent_committed`を`outcome_unknown`へ閉じる。復元後は全対象をholdし、fresh J review前に現在のJ/M/Broker依存を再観測する。残差・未確認・再観測失敗ではholdを解除しない。task単位のJ-store復元であり、自動resume／store間atomicity／仕事全体の復旧可能性は成立しない。E03.03/QEB-03全体は`BUILD_GAP`。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-21記録にある。

## 次の接続

次のBUILD_BATCHでは、E03.03の親目的に残る同一taskのJ/M/Broker/Cron依存と復元点の接続を、実在するproducer／consumerから一つ選んで前進させる。task identityを正確に結べない範囲は残差として隔離し、他taskを変更しない。cross-store atomicityや自動resumeを主張せず、全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
