# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-22-E03.03-TASK-LINEAGE-SCOPED-BROKER-MERGE`で、検証済みbackupから同一task identityの不足Broker receiptとarchive event rowsだけを現行Broker event chainへ追加するconsumerを接続した。現行receiptと無関係taskの履歴を保ち、異なる同一ticket／command衝突と選択lineage内の同epoch未完了処理は拒否する。旧epochの`intent_committed`／`invocation_attempted`は`outcome_unknown`として追加し、復元後に自動実行しない。L3 targetはbackup・store・task digestへ束縛し、不正scopeをwhole-store restoreへ曖昧化しない。復元後は選択taskの全planをholdし、fresh J review前にJ/M/Broker依存を再観測する。task-scoped Broker restoreは追加的receipt mergeであり、store間atomicity／自動resume／仕事全体の復旧可能性は成立しない。E03.03/QEB-03全体は`BUILD_GAP`。詳細は`IMPLEMENTATION_HISTORY.md`のQEB-22記録にある。

## 次の接続

次のBUILD_BATCHは、同一taskのM-state依存と復元点の実consumerを現行コードから選び、J binding／M receiptとの相関が正確な範囲だけを接続する。task identityを正確に結べない範囲は残差として隔離し、他taskを変更しない。cross-store atomicityや自動resumeを主張せず、全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は最新三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
