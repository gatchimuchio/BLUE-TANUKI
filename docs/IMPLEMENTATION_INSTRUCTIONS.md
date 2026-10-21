# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は現行pin、適用AGENTS、owner指示、このactive指示、HEAD・差分を確認し、三点セットの全文を読み直す。同一作業内の連続する小単位では関係する節を再確認する。完了済み作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md) 等のログに保持し、依存・系譜・矛盾の確認時だけ該当箇所を参照する。

## 現行状態

`QEB-13-E03.03-WAIT-RECOVERY-HOLD-ROUTING`、`QEB-14-E03.03-BROKER-RESULT-RECOVERY-HOLD`、`QEB-15-E03.03-J-PLAN-RESIDUAL-ISOLATION`、`QEB-16-E03.03-J-PLAN-SCHEMA-RESIDUAL-ISOLATION`は完了し、詳細をIMPLEMENTATION_HISTORY.mdへ移した。復元holdはwait／遅延C候補／Broker保存結果の返却・plan再利用を止める。Jの意味不整合または個別schema-invalidなplanは実行viewから隔離し、raw recordを保持してclean sibling planの判断・保存を続け、識別可能な対象だけをplan-scoped restoreできる。Recoveryは不正planのrecord digestと取得可能なplan ID digestだけを表示する。plan IDを安全に得られないrecordは表示のみでrestore対象にできない。checkpoint全体digest不一致と共有state schema破損は全体fail-closed。E03.03／QEB-03全体のjob単位復旧は未成立で`BUILD_GAP`。`operation_plan_runtime.test.ts`の関連2ケース、Recovery 3 suite 48/48、WebChat Recovery consumer 1件、workspace typecheck/build、HDS standaloneはPASS。既存runtime suiteはWindows localで既定5秒timeoutが2件残り、timeout変更で隠していない。現行ピンrev2.3、backup ref移行状態=`MIGRATION_COMPLETE`。

## 次の接続

次のBUILD_BATCHでは、固定済みrev2.3のE03.03に基づき、最新HEADのRecovery／J／M／Broker callsiteから未接続の次consumerを一つ選び、仕事単位の隔離復旧を前進させる。開始時に三点セット全文・適用AGENTS.md・owner指示・active指示・HEAD／差分を再同期して具体範囲を確定する。旧ログに残る過去の「次」は現行指示として使わない。全体実装形状の成立前にQE_QC／QE_QAを開始しない。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closed、`cross_store_atomic=false`を維持する。provider実試験、実credential、外部作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は対象外。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。
