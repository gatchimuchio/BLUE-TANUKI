# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-23-E03.03-TASK-LINEAGE-BROKER-RESTORE-M-DEPENDENCY-REOBSERVATION`で、task-scoped Broker restore後の完全なread-only Recovery projectionを実consumerへ結び、選択taskのJ binding／M receipt／Broker correlationが正確に観測できる範囲を反映した。M残差は`residuals_present`、観測不足は`unobserved`／`unverified`へ閉じ、projection欠落時も従来どおり保留する。別taskは変更しない。観測は権限ではなく、選択済みbindingを失効して通常のfresh J reviewを要求する。QEB-22の追加的Broker receipt merge、store間atomicityなし、自動resumeなし、E03.03/QEB-03全体`BUILD_GAP`を維持する。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-23記録にある。

## 次の接続

次のBUILD_BATCHは、task-scoped M-state restore pointのproducerとJ binding／M receipt consumerの実接続を現行コードから確定し、正確に相関できる範囲だけを接続する。task identityを正確に結べない範囲は残差として隔離し、他taskを変更しない。cross-store atomicityや自動resumeを主張せず、全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
