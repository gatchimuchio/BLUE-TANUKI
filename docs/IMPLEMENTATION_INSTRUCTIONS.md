# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-24-E03.03-TASK-M-RESTORE-POINT-J-REOBSERVATION`でtask-scoped M restore point producerをHDS fresh J review gateへ接続し、同一taskのbackup plan集合・現在のJ binding・M receiptが揃う範囲だけを再審査へ通した。`QEB-25-E03.03-TASK-M-RESTORE-POINT-OPERATOR-PROJECTION`では、Recovery snapshotのM task restore pointをControl Centerのread-only表示へ接続した。raw IDやpayloadを出さず、不正projectionは表示を抑止し、権限や自動resumeを作らない。`QEB-26-E04.01-FAILURE-SYMPTOM-CAUSE-SEPARATION`では、FailureMemory抽出器が観測failure categoryをcause candidateとして重複記録するのをやめ、症状digestと`root_cause_unconfirmed`を保ったまま、原因候補は明示的なdigest-only C reviewに分離した。FailureMemory focused 14/14、HDS failure-review consumer 1/1、HDS typecheck/buildはPASS。全suiteは未実施。E03.03/QEB-03および製品全体は`BUILD_GAP`、QE_QC／QE_QA未開始。

`QEB-27-E04.02-J-INDEPENDENT-OBSERVATION-ADOPTION`では、chain検証済みComplete HistoryからFailureMemory署名が参照するrecordだけをfailure category／scopeとdigestへ限定射影し、HDS-JのFailureReview consumerに接続した。参照集合全件と分類が一致し、Cのscope提案も`same_scope`の場合だけscope reviewをobservation-boundとし、counterexample／resume conditionは事実・許可ではなく将来の観測対象として保持する。原因は未採用、実行・再試行権限なし。HDS focused 92/92、Gateway focused 6/6、protocol/HDS/Gateway typecheckとHDS/Gateway buildはPASS。E04.02の全品質保証、製品全体の`BUILD_COVERED`、QE_QC／QE_QAは未開始。

`QEB-28-E04.03-CONDITION-CHANGE-REOBSERVATION`では、同じ完全一致action／targetに対し、新しいHDS `ASSERT`のgoal／actor／channel fingerprint差をFailureMemory gateで検出する。activeなblock／require-approval署名は旧記録のまま保持し、通常のfresh Approval Gateへ渡す。`probe_policy=never`のblockは解除せず、異なるaction／targetへ適用を広げない。fingerprint差は外部条件の解消証明や実行権限ではない。FailureMemory focused 17/17、Gateway operation-result focused 7/7、HDS／Gateway typecheck/buildはPASS。全suite、実provider／credential／外部作用、E04.03の対象別QC／QA、製品全体の`BUILD_COVERED`とQE_QC／QE_QAは未実施。

## 次の接続

次の`BUILD_BATCH`は`QEB-29-E05.01-RETENTION-DERIVATION-APPLICATION-LINEAGE`とし、FailureMemory保持・C導出・J採否・M反映の系譜producer／consumerを現物から確定して接続する。現在のE04.03は、同一action／target下の新しいHDS ASSERTとgoal／actor／channel fingerprint差を条件変化候補として検出し、fresh Approval Gateへ渡すまで接続した。差分だけでは外部条件の解消を証明しない。旧失敗署名とnever-probe blockを維持し、旧承認の再利用をしない。開始時に現行三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
