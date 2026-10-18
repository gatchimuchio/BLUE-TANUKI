# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用AGENTS.md、作業標準要領、現行ownerの継続開発指示、前batch指示、E03.02／E01.01要求、現物HEAD・差分・Cron／Gateway／HDSの実接続を読み直した。前batch `QEB-03-E03.02-CRON-RESULT-CORRELATION-INSPECTION` は `e57633ca34240db6410af9332808d4fd914205f0` で閉鎖済み。今回の開始HEAD／`origin/main` は同SHA、開始時worktree clean。編集前の復旧refはlocal branch二世代とremote tag二世代を期待SHA付きで回転し、local／remoteの一致を確認した。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-CRON-NO-REPLAY-OWNER-RESOLUTION`。関係単位=E03.02「未決作用・M pendingの回復」、E01.01「永続jobと重複event」。BLUE-TANUKI内だけを対象にし、D4Pocket／ミニドラ、実provider／credential、実外部業務作用、公開・出荷判断を対象外とする。

### 目的と接続先

未決Cron eventの処理結果を成功へ読み替えたり自動再送したりせず、ownerが正確なevent IDとpayload digestを確認してL3最終レビューで「このeventは再実行しない」と明示した場合に限り、次のsource eventを処理可能にする。HDS-BRAINのhash-chain auditがこの判断の正本を持ち、Cron cursorはHDSの検証済み判断を参照する。イベントが現在処理中、ID/digestがcurrent cursorと異なる、監査が無効・未確認、またはfresh L3承認がない場合はfail-closedで遮断する。

対象候補は `packages/protocol/src/operation_catalog.ts`、`packages/hds-brain/src/approval_policy.ts`・`controller.ts`・監査record型／tool許可policy、`apps/gateway/src/cron_event_store.ts`・`cron_channel.ts`・`serve.ts`、resident notification／WebChat projection、Daily operator projectionと関連focused tests。実callsiteに合わせ最小化する。

### 安全境界・成立条件

- 専用operation `schedule.resolve_event` は `FINAL_REVIEW_OPERATION_LIST` の唯一の正本へ追加し、`full_access`・reusable grantでもL3を迂回できない。引数は `event_id`、`payload_digest`、固定値 `acknowledge_no_replay` のみ。入力の不足・余剰・改変、stale cursor、二重ack、in-flight eventを拒否する。
- Tool adapter自身はcursorを書き換えない。executorが成功した後、HDSが同じcommandへのL3評価と明示承認済みlifecycleを照合して監査recordへno-replay判断を追記する。Cron cursorは起動後も検証済みHDS audit recordとの完全一致を要求する。audit不在・不正・append失敗時は後続eventを通さない。
- owner判断後も元eventは `outcome_unknown` のまま表示し、外部作用成功・失敗、M commit、再送完了とは扱わない。表示はevent ID・payload digest・固定状態に限定し、raw payload／target／command／秘密を出さない。
- `handler_returned`、worker停止、外部成功、取消完了、結果確定を混同しない。Cron event再送・旧実作用の再実行・M更新・Approval Gate迂回・別authority pathを追加しない。
- 検証はevent cursor／active event／HDS L3記録／resident noticeをつなぐ合成fixtureと関連focused tests、型検査、workspace build、docs gate、diff checkまで。live/provider、credential、実外部作用、全suite、QE_QC／QE_QAは実施しない。

復旧参照は `MIGRATION_COMPLETE`（2026-10-12）を維持する。編集前・バッチ開始時のlocal recovery branch二世代とremote backup tag二世代は、今回の開始HEAD `e57633ca34240db6410af9332808d4fd914205f0` と直前世代の組で照合済み。バッチ途中では回転しない。閉鎖時に実SHAを再照合し、local二branch／remote二tag／mainが意図した世代で一致したことを記録する。

未接続の完全なdurable job lifecycle、旧worker／旧approval世代の全回復、実外部結果の照合、D4Pocket UI接続は`BUILD_GAP`として残す。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。実装commit=`9522971b73d86a4b2222de6f44a8014fde1fd38e`を`main`へpush済み。local／remote mainは同SHA、復旧branch二世代とbackup tag二世代は現世代=`e57633ca34240db6410af9332808d4fd914205f0`、前世代=`cb9806464247365ff7a54033e4f12cf92c050fb8`で一致。次consumerはdurable job lifecycleと実外部結果のread-only照合を維持した上で、明示権限がある場合のreconciliation経路を設計・接続する。
