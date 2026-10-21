# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-24-E03.03-TASK-M-RESTORE-POINT-J-REOBSERVATION`でtask-scoped M restore point producerをHDS fresh J review gateへ接続し、同一taskのbackup plan集合・現在のJ binding・M receiptが揃う範囲だけを再審査へ通した。`QEB-25-E03.03-TASK-M-RESTORE-POINT-OPERATOR-PROJECTION`では、既存Recovery snapshotに届いていたM task restore pointをControl Centerのread-only表示へ接続した。backup digestとtask digestは短縮表示、plan数と固定された依存statusを示し、raw IDやpayloadを出さない。不正なprojectionは表示を抑止し、復元・承認・実行権限を作らず、保留解除はHDSの現行判定へ委ねる。WebChat focused 2/2、typecheck、buildはPASS。WebChat全suiteは未実施。QEB-24のM residual／欠落／不一致hold、store間atomicityなし、自動resumeなし、E03.03/QEB-03全体`BUILD_GAP`を維持する。QEB-24の広い`execution_result_reconciliation`にはWindows isolation provider未導入とJ commit residual rejection fixtureの失敗（原因未確定）が残る。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-24/25記録にある。

## 次の接続

次のBUILD_BATCH開始時に、現行rev2.3のE03.03/QEB-03未接続要求と最新コードのproducer／consumerを再照合し、UI表示の次に実際の仕事を前進させる接続を一つ選ぶ。QEB-24のtask-scoped M restore gateとQEB-25のoperator projectionは完了状態として利用し、必要な下流consumerが残る場合だけ続ける。型・fixture・表示だけで完了扱いしない。全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
