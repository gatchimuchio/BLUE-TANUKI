# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、作業標準要領、active指示、関係するE03.02／E01.01／D04.02要求と現物を再読した。開始HEAD／`origin/main`=`fdbd2738d6f51f9df5702f994aaff007c56fbd7e`、開始worktree clean。三点原典はowner指定rev2.3 ZIPの新規展開から読み、旧版の状態を現行へ転記しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-CRON-RECEIPT-OBSERVATION-CORRELATION`。関係単位=E03.02「未決作用・M pendingの回復」、E01.01「永続jobと重複event」、D04.02「実行receiptと受理後照合」。対象はBLUE-TANUKIのCron向けread-only resident notification。D4Pocket／ミニドラ、実provider／credential、実外部業務作用、公開・出荷判断は対象外。

既存HDSの`operation_plans` projectionは、完全一致したplan request IDごとに保存済み結果の相関と、未解決bindingへの`local_inspection`外部receipt観測（`matched`／`not_found`／`mismatch`／`ambiguous`／`not_recorded`）を非権威情報として持つ。Gateway notificationは現在、Cron cursorの結果・M相関は表示するがreceipt観測を表示せず、restartで中断したCron approval通知には結果相関自体がない。Cron event IDと一意なplan request IDの一致を使い、cursor通知と中断approval通知の双方へreceipt観測のsource/statusだけを投影する。外部照会は通知生成時に起動しない。

### 安全境界

- `operation-plan-projection.v1`、`used_for_authority=false`、`raw_payload_exposed=false`を必須確認し、planが一意にevent IDへ一致しない場合は不明／曖昧状態を保持する。
- 表示するのは固定source=`local_inspection`と検査済みstatusのみ。raw receipt、候補本文、credential、plan/commandの本文・識別子、receipt/evidence digestは通知へ加えない。
- `matched`も外部作用成功・目的達成・Cron event解消・M確定を意味しない。`outcome_unknown`、未決cursor、L3 no-replay判断、fresh approval要件を変更しない。
- 変更はGateway projection／resident notification／WebChat read-only表示に限定し、HDS・Broker・Executor・Cron cursor・承認・作用・memoryの判断や状態を変更しない。
- C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### 到達・確認

- Cron event IDで保存済みOperationPlanとの結果・receipt観測を通知へ接続する。projection欠落、複数plan、未知status、step相関の異常を曖昧／利用不可として表示し、証拠を成功へ昇格させない。
- focused testsはGateway resident notificationとWebChat通知描画に限定する。`pnpm typecheck`、必要な`pnpm build`、文書変更に対する`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`をバッチ境界で実施する。
- live provider／credential、外部業務作用、全suite、全OS実機、QE_QC／QE_QAは実施しない。

編集前に復旧状態=`MIGRATION_COMPLETE`を確認した。local復旧branch二世代・local tag二世代・remote backup tag二世代は現世代=`fdbd2738d6f51f9df5702f994aaff007c56fbd7e`、前世代=`4f85463e1924db1afb812a195f238ed2cd68a7e4`で一致。実装と関連公開文書を限定commitして`main`へpushし、remote HEAD・二世代refs・worktreeを照合する。

残るBUILD_GAPは外部receipt照合結果に基づくHDS／owner判断とCron lifecycleの統合、worker世代別の結果帰属の全consumer、durable job全体である。receipt観測表示から自動再送・自動no-replay・成功判断を追加しない。
