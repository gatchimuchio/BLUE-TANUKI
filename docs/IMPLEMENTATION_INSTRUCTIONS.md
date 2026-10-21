# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-24-E03.03-TASK-M-RESTORE-POINT-J-REOBSERVATION`で、M restore後にbackup内のtask plan集合と現在のJ plan集合を相関するread-only restore point producerを、HDSのfresh J review gateへ接続した。同一task内の全plan集合・J binding・M receiptが現行状態と一致する場合だけ再審査へ進める。残差・欠落・不一致はholdを維持し、相関を観測できない旧backupは`unobserved`として通常の復旧操作に残す。再起動時も同一restore identityの有効なtask相関だけを保持する。別taskへ波及せず、projectionはdigest-only／non-authorityであり、承認・実行・自動resumeを生成しない。store間atomicityなし、E03.03/QEB-03全体`BUILD_GAP`を維持する。Gateway `recovery_surface` 19/19、`operation_plan_runtime` 40/40、QEB-24関連`execution_result_reconciliation` 5/5、Gateway/HDS typecheck・buildはPASS。広い`execution_result_reconciliation`全件はPASS扱いせず、Windows isolation provider未導入とJ commit残差拒否fixtureの失敗が別途未解消（原因未確定）。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-24記録にある。

## 次の接続

次のBUILD_BATCH開始時に、現行rev2.3のE03.03/QEB-03未接続要求と最新コードのproducer／consumerを照合し、次に実装する一つの縦断接続を選ぶ。QEB-24でつないだtask-scoped M restore pointとJ/M receipt gateを前提にできる場合はその次consumerを優先し、型・fixtureだけで完了扱いしない。全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
