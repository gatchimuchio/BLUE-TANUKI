# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の施工単位開始時に、owner指定の最新版QE三点正本（rev2.3）全文、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、active指示、現行HEAD・remote・dirty state、E01.01とCron／RuntimeScheduleの実consumerを読み直した。対象はWindows上のBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoには変更しない。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`。QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E01.01-CRON-EVENT-IDENTITY-CURSOR`。関連単位=E01.01のBLUE Cron／Gateway部分接続。開始HEAD／`origin/main`=`5370e5e54456af59314d203a114547413e3f225a`、clean。編集前のlocal recovery branch／remote backup tagは現世代`5370e5e`、直前世代`cf0458b`。remote二tagとlocal二branchのSHAを確認済み。

### 目的と到達状態

承認済みRuntimeScheduleの永続triggerからCron発火まで、同一schedule sourceのイベントに安定したevent IDと単調な予定時刻を与える。private Gateway event cursorにsource/event/payload digestとconsumer状態を保存し、同一eventの再配送を抑止し、より古いeventを拒否する。Cronの同一source内のconsumer呼出しは順序を保つ。未確定状態は成功扱いせず、自動再実行しない。

本施工はE01.01の限定接続であり、durable jobの完了、再起動後のpending outbox再配送、全channel共通inbox、E01.02の時差／catch-up、E03の所有権世代・回復を完了扱いしない。これらは実物に照らして次consumerとして残す。

### 対象と境界

- 対象：`apps/gateway/src/cron_channel.ts`、Gateway private event store、`apps/gateway/src/serve.ts`との接続、関連する限定試験、進捗・ロードマップ・変更記録。
- Cron eventのsourceはschedule origin／IDから導出し、event IDはsourceと予定発火時刻に結合する。payload digestが一致しない同一event IDは衝突として処理し、HDSへ二重配送しない。
- private DBにはraw content、target、credentialを保存しない。HDS-BRAIN、Approval、Executor、監査の既存責任を保ち、event identityは権限に使わない。
- 対象外：D4Pocket／ミニドラ変更、実provider／credential／外部業務送信、C08.03、別channelの全面dedup、restart後の未決イベント再実行、全体QE_QC／QE_QA、公開・出荷判断。

### 最小技術確認

event storeの再open後に重複・逆順・payload衝突を検査する。Cronのevent ID/source/sequenceと直列dispatchを対象testで確認する。影響したVitest、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`を実施し、実送信を行わない。

実行結果：`pnpm exec vitest run apps/gateway/test/cron_event_store.test.ts apps/gateway/test/cron_channel.test.ts apps/gateway/test/runtime_schedule.test.ts` PASS（3 files／19 tests）、`pnpm typecheck` PASS、`pnpm build` PASS（15 workspace projects）、`pnpm docs:check` PASS（初回にCHANGELOG移行hashの不一致を検出し、実hashを台帳へ反映後にPASS。移行負債77件）、`git diff --check` PASS。実provider・credential・外部送信なし。

### 停止・復旧・記録

DB破損・schema不整合・event衝突では fail-closed にする。handler開始後に結果が不明なeventは再送しない。処理済み、重複、逆順、衝突、結果不明を区別し、権限や仕事の完了へ昇格させない。完成した技術接続と残るBUILD_GAPを記録し、意味あるbuild batch終了時に限定commitを`main`へpush、remote HEADと復元refsを照合する。今回の変更は検証済みであり、最終diff確認後にpushする。

P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
