# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定の最新版QE三点正本（rev2.3）全文、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、active指示、現行HEAD・remote・dirty state、E01.01／E03.02とCron event cursor→Gateway owner通知consumerを読み直した。対象はWindows上のBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E01.01-CRON-UNRESOLVED-OPERATOR-VISIBILITY`。関連単位=E01.01永続event cursor／E03.02未決結果回復のowner観測部分。開始HEAD／`origin/main`=`3926b448799469e645c712ca63dfa800b910a8e5`、clean。backup ref移行=`MIGRATION_COMPLETE`。編集前のlocal recovery branch／remote backup tagは現世代`3926b44`、直前世代`e45c40b`でSHA一致を確認済み。

### 目的と到達状態

永続Cron event cursorにsettled resultがないeventの識別子・状態・payload digestを、既存HDS Authority Traceと照合可能なread-only owner notificationへ接続する。表示はevent ID／sequence／digest／delivery stateに限定し、raw schedule content・target・credentialを含めない。`dispatching`／`outcome_unknown`を再送・成功扱い・解決・権限へ変換しない。

### 対象と境界

- 対象：`apps/gateway/src/cron_event_store.ts`、`apps/gateway/src/resident_notifications.ts`、`apps/gateway/src/serve.ts`、`packages/channel-webchat/src/webchat_types.ts`、関係する限定testとQE記録。
- event storeは永続cursorの整合性を検査し、未settled eventのsource digest・event ID・sequence・payload digest・delivery state・更新時刻だけを返す。
- Gatewayはcursorのread-only projectionをHDS Authority Traceの`request_id=event_id`と照合し、owner向け通知にする。通知は`display_only`であり、HDS/J/Approval/Brokerの判断、再実行、cursor変更を行わない。
- 未決eventの再実行・解決操作、E01.02 timezone／DST／clock jump／catch-up、E03世代・fencing、durable job全体は未完了のままとし、E01.01／E03.02／QEB-03全体の工程状態は`BUILD_GAP`を維持する。
- 対象外：D4Pocket／ミニドラ変更、provider／credential／外部業務送信、C08.03、全体QE_QC／QE_QA、公開・出荷判断。

### 安全・最小技術確認

event payloadとschedule contentが通知・snapshotへ出ないこと、event IDをrequest IDにした照合、`dispatching`／`outcome_unknown`の表示、handler-returned eventの通知対象外、cursor不整合時のfail-closed、認証済みWebChat notification APIを確認した。限定Vitestは3 files／82 tests PASS、`pnpm typecheck` PASS、`pnpm build` PASS（15 workspace projects）、`pnpm docs:check` PASS、日本語基底の移行負債77件を維持、`git diff --check` PASS。実credential／外部送信は未使用。

### 停止・復旧・記録

未決eventは再送せず、sourceを自動解除しない。通知は「結果未確定」を示し、operatorがevent IDでAuthority Traceを照合して重複送信を避ける。表示できないstore不整合を正常状態に丸めない。BUILD_BATCH終了時は限定commitを`main`へpushし、remote HEAD、二世代復元refs、作業ツリーを再照合する。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
