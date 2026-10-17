# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の小単位開始時にowner指定の最新版QE三点全文（rev2.3）、適用AGENTS.md、作業標準、QE再同期規約、active指示、最新HEAD／remote／dirty state、D09.03要求とWebChat接続・runtime snapshot consumerを読み直した。Windows上のBLUE-TANUKIだけを対象とし、D4Pocket／ミニドラには変更を加えない。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`。QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-02-D09.03-BLUE-WEBCHAT-RECONNECT-SNAPSHOT。関連単位=D09.03（BLUE側部分施工）。開始HEAD／origin/main=`cf0458b6f9680439fd32adedfce210b2e663a32a`、clean。編集前local recovery branch／remote backup tagは`cf0458b`／`24c550e`の二世代。実装commit=`b8619bfa57e7454a2dee5532fffe7f14b1144585`をorigin/mainへpush済み。

### 今回の目的と境界

WebChatのWebSocket接続・切断をGateway serviceの起動・停止と誤認させず、現在世代の接続成立後に認証済みRuntime Snapshotを再取得するBLUE側consumerを接続する。保存済みの独立Runtime tokenがない場合は通信せず、snapshot状態をunknownとする。再取得要求は`cache: no-store`を指定し、受信時刻を表示する。古いWebSocket世代のeventと古いsnapshot要求結果は画面を上書きしない。

対象=D09.03 BLUE WebChat接続状態／Runtime Snapshot再同期の部分施工。対象外=D4Pocket変更（別途限定委任が必要）、サービスstop/cancel/restart API、実provider／資格／外部作用、C08.03、全体QE_QC／QE_QA、公開・出荷判断。D09.03全体はD4 consumerと実サービスライフサイクルが未接続のため`BUILD_GAP`のままとする。

### 必須境界

- Disconnect／画面閉鎖はWebChat側socketを閉じるだけであり、Gateway service停止やjob cancellationを推定・発行しない。
- reconnect snapshotには専用Runtime tokenを使う。WebChat tokenへ代替せず、tokenがない場合はHTTP requestを送らない。
- 新しいsnapshotが取れない間はGateway statusをunknownと表示し、古い値を現在状態に見せない。GET応答と要求はcacheしない。
- D4Pocket／ミニドラrepo、実credential、外部業務作用は対象外。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

## 検証・閉包

- `pnpm exec vitest run packages/channel-webchat/test/webchat.test.ts`: PASS、1 file／76 tests。Control Center shellと埋込JavaScript構文を確認。
- `pnpm typecheck`: PASS。
- `pnpm build`: PASS、15 workspace projects。
- `git diff --check`: PASS。
- `pnpm docs:check`: PASS。通常日本語gate・license PASS、日本語基底の移行負債77件を維持。
- Gateway processとControl Centerを実際に使うWebSocket reconnect E2E、D4 consumer、service stop/cancel、外部provider／資格／送信、全体QE_QC／QE_QAは未実施。
- 工程表QEB-02のshell系実装に属する部分施工として記録する。前記録のD09.02をQEB-03とした文書ラベルは、工程表に合わせQEB-02へ訂正した。実装状態とD09.02の`BUILD_GAP`は変更しない。

実装経路はWebChat接続成立→socket世代照合→既存Runtime tokenによるno-store snapshot取得→受信時刻とGateway状態の表示へ接続した。UI切断からGateway停止・job取消へのconsumerは追加していない。BLUE WebChat内の限定接続であり、D09.03全体は`BUILD_GAP`。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
