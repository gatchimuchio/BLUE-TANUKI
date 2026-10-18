# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定の最新版QE三点正本（rev2.3）全文、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、active指示、現行HEAD・remote・dirty state、E01.01／E01.02とRuntimeSchedule→Cron→Gateway実consumerを読み直した。対象はWindows上のBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E01.01-DURABLE-SCHEDULE-ACTIVATION`。関連単位=E01.01の永続trigger・承認済みRuntimeScheduleからCronへの接続。現単位の局所境界は`WIRED`、E01.01/QEB-03全体は`BUILD_GAP`。開始HEAD／`origin/main`=`e45c40bd00bf467058d1e6ad41745921617a4c6f`、clean。backup ref移行=`MIGRATION_COMPLETE`。編集前のlocal recovery branch／remote backup tagは現世代`e45c40b`、直前世代`5370e5e`。remote二tagとlocal二branchを実値照合済み。

### 目的と到達状態

HDSの同一schedule commandに対するL3最終レビューから、永続RuntimeSchedule、再起動時の読戻し、Cron task登録までを安全に接続する。scheduleのcreate/update/deleteはoperation・command ID・risk・L3 final-review条件が一致する新しい承認評価だけ受け入れる。承認後はschedule全体をatomic replaceで永続化し、保存失敗時はmemory／Cronを有効化しない。保存成功後にのみ現在状態とCron consumerを更新する。永続レコードは型・状態・同一性・payload digestを厳密照合し、不明状態をactiveへ補完しない。

### 対象と境界

- 対象：`apps/gateway/src/runtime_schedule.ts`、`apps/gateway/test/runtime_schedule.test.ts`、active指示・進捗・公開ロードマップ。
- schedule発火は外部作用の承認ではない。Cronからの実作用・所有者向け承認導線は独立した次接続として追跡する。
- 未決Cron eventの再起動後reconciliation、E01.02のtimezone／DST／clock jump／catch-up、E01.03待機、E03世代・復旧、durable job全体は未完了のまま残す。
- 対象外：D4Pocket／ミニドラ変更、provider／credential／外部業務送信、C08.03、全体QE_QC／QE_QA、公開・出荷判断。

### 安全・最小技術確認

不正・不一致なapproval評価、壊れた永続レコード、payload hash不一致、保存失敗ではCron起動を許可しない。作成・更新・削除の保存後再open、保存失敗時に旧scheduleが有効のままで新内容が登録されないことを対象testで確認する。`runtime_schedule.test.ts`／`cron_event_store.test.ts`／`cron_channel.test.ts`は3 files／23 tests PASS、`pnpm typecheck` PASS、`pnpm build` PASS。`pnpm docs:check`は初回に本指示の必須状態語`BUILD_GAP`と`MIGRATION_COMPLETE`の欠落でFAILした後、補記して再実行しPASS。`git diff --check` PASS。実credential／外部送信なし。

### 停止・復旧・記録

schedule DBの不整合はfail-closedとし、破損をactiveへ読み替えない。更新を永続化できない場合は旧scheduleを維持する。Cron eventのdispatch後に結果不明なeventは自動再送しない。承認評価のpayload digestは内容整合確認であり、再起動時のapproval lifecycle照合や承認証明ではない。BUILD_BATCH終了時は限定commitを`main`へpushし、remote HEAD、二世代復元refs、作業ツリーを再照合する。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
