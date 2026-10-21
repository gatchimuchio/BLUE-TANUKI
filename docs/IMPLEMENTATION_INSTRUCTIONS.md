# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-18-E03.03-BROKER-RESTORE-PLAN-DEPENDENCY-REOBSERVATION`で、Broker全体復元後のJ/M/Broker計画別相関をread-only観測へ接続した。影響・未観測計画のholdを保存し、現行依存を再観測した新しいJレビューだけがholdを解除できる。E03.03/QEB-03全体のjob単位復旧は引き続き`BUILD_GAP`。以前のBUILD_BATCH詳細は`IMPLEMENTATION_HISTORY.md`と`開発進捗.md`を必要時のみ参照する。証拠と境界は同ファイルのQEB-18記録にある。

## 次の接続

次のBUILD_BATCHでは、固定済みrev2.3のE03.03に残るjob単位の復旧identity／restore point／隔離経路から、現行producerとconsumerで一つの縦断接続を選ぶ。計画相関やstore復元成功を仕事の復旧・再開可能性へ昇格させない。開始時に三点セット全文・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期して対象を確定し、旧ログの「次」は現行指示として使わない。全体実装形状の成立前にQE_QC／QE_QAを開始しない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
