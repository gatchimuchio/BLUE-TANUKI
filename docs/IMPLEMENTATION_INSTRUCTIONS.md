# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-19-E03.03-BROKER-RESTORE-TASK-LINEAGE-ISOLATION`で、Broker復元holdとfresh dependency re-observationをJが保持する同一task lineageへ拡張した。同一仕事の兄弟planは全て未観測なら隔離され、全planの現行依存をread-only再観測した後も新しいJレビューごとに個別解除する。再起動時に残るplan単位Broker holdも同じtask lineageへ広げる。仕事単位の独立restore point、store間atomicity、guarded recovery／resumeは未接続で、E03.03/QEB-03全体は引き続き`BUILD_GAP`。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-19記録にある。

## 次の接続

次のBUILD_BATCHでは、現行producer／consumerを再照合し、E03.03に残る仕事identityと独立restore pointをcanonical backupへ結ぶ次の実consumerを一つ選ぶ。計画相関やstore復元成功を仕事の復旧・再開可能性へ昇格させない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログの「次」は現行指示として使わない。全体実装形状の成立前にQE_QC／QE_QAを開始しない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
