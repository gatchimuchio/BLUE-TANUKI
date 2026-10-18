# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、現行ownerの継続指示、直前active指示、E03.02／E03要求、実HEAD・差分、Cron→Gateway→HDS OperationPlan→Broker結果consumerを再読した。前バッチE04.02は`cb9806464247365ff7a54033e4f12cf92c050fb8`で閉鎖済み。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラrepo、実provider・credential、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-CRON-RESULT-CORRELATION-INSPECTION`。関連単位=E03.02「未決作用・M pendingの回復」およびE01.01「永続event／job状態」のCron部分。開始HEAD／`origin/main`=`cb9806464247365ff7a54033e4f12cf92c050fb8`、開始時clean。編集前のlocal復旧branch二世代／remote backup tag二世代を期待SHA付きで回転し一致確認済み。backup-ref state=`MIGRATION_COMPLETE`。

### 目的と対象

永続Cron event cursorに残る未決event IDを、同じIDをrequest IDとして保持するHDS OperationPlanの実行binding・保存済みresult deliveryへ、完全一致のread-only照合で結び付ける。結果はresident notificationで固定enumの`result_correlation_status`だけ表示し、Control Centerはその状態をescape済み文字列として描画する。

対象：`apps/gateway/src/resident_notifications.ts`、`apps/gateway/src/serve.ts`、`packages/channel-webchat/src/webchat_types.ts`、`packages/channel-webchat/src/control_center_script.ts`、関連focused tests、公開ROADMAPと開発進捗。

照合状態は「planなし」「bindingなし」「複数・不整合」「実行／結果未解決」「terminal bindingだが保存deliveryなし」「delivery digestを持つterminal binding」に区別する。これらはJ/Mの採否、業務作用の成功、完全なjob完了、現在の実行権限を証明しない。UIへraw plan／command／step／payload、target、result本文、追加digestを公開しない。

### 境界・完了条件

- event IDとHDS plan/bindingのrequest IDを完全一致させ、曖昧・欠落・未知状態は保留カテゴリにする。
- HDS plan projectionから固定状態だけを導出し、既存の認証済みread-only通知へ実接続する。HDS/Broker/M/Cursorの状態変更、event settle、retry/replay、承認、権限、外部作用を追加しない。
- focused consumer test、型検査、必要なbuild、`pnpm docs:check`、`git diff --check`を行う。全suite、live/provider、credential、外部送信、QE_QC／QE_QAは行わない。
- E03.02／E01.01の復旧操作・未決作用解消・durable job lifecycle全体は未成立のまま`BUILD_GAP`を保持し、次consumerを記録する。

### Git閉鎖

意味あるBUILD_BATCHとして限定commitし`main`へfast-forward pushする。push後にlocal／remote main、clean tree、local復旧branch二世代、remote backup tag二世代を実SHAで確認する。復元参照は編集前現世代=`cb9806464247365ff7a54033e4f12cf92c050fb8`、前世代=`58ec78e59b0ddde93e65d0497bb31a2bf21a4a8`。remoteが進行・競合した場合は上書きせず同期し直す。C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
