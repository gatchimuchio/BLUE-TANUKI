# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。現行pinはrev2.3、backup ref移行=`MIGRATION_COMPLETE`。`QEB-24-E03.03-TASK-M-RESTORE-POINT-J-REOBSERVATION`でtask-scoped M restore point producerをHDS fresh J review gateへ接続し、同一taskのbackup plan集合・現在のJ binding・M receiptが揃う範囲だけを再審査へ通した。`QEB-25-E03.03-TASK-M-RESTORE-POINT-OPERATOR-PROJECTION`では、Recovery snapshotのM task restore pointをControl Centerのread-only表示へ接続した。raw IDやpayloadを出さず、不正projectionは表示を抑止し、権限や自動resumeを作らない。`QEB-26-E04.01-FAILURE-SYMPTOM-CAUSE-SEPARATION`では、FailureMemory抽出器が観測failure categoryをcause candidateとして重複記録するのをやめ、症状digestと`root_cause_unconfirmed`を保ったまま、原因候補は明示的なdigest-only C reviewに分離した。FailureMemory focused 14/14、HDS failure-review consumer 1/1、HDS typecheck/buildはPASS。全suiteは未実施。E03.03/QEB-03および製品全体は`BUILD_GAP`、QE_QC／QE_QA未開始。

## 次の接続

次の`BUILD_BATCH`は`QEB-27-E04.02-J-INDEPENDENT-OBSERVATION-ADOPTION`とし、現行rev2.3のE04.02要求とFailureReviewの実consumerを接続する。Cのdigest-only仮説は候補に留まり、現在の`assessFailureReviewCandidate`は`held_for_independent_observation`／`not_adopted`を返す。独立観測をJが範囲・反例・再開条件へ結ぶ実consumerを特定し、C出力だけで原因を採用したり再試行権限を発行したりしない。型・fixtureだけで完了扱いせず、全体実装形状の成立前にQE_QC／QE_QAを開始しない。開始時は現行三点セット・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期し、旧ログは依存・系譜・矛盾の解決時だけ参照する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
