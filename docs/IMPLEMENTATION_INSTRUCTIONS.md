# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点全文と適用AGENTS.mdを毎作業・切替・再開時に再読する。現在のowner開発委任に従い、過去の停止・旧SHAから現在状態を巻き戻さない。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-EXECUTION-INTENT。D02.02／D04.01／D04.02のBLUE内部分を、既存Approval→Executor→実adapter→保存receiptへ接続する。D02.01の内容固定とD01.03の計画・実結果を維持する。

HTTP・CLI・資料整理の既存consumerへ共通の私有SQLite実行storeを注入する。発行時にcommand IDと内容digest、proof digest、authority固有の起動epoch、wall期限を結合し、同一command IDの再発行を拒否する。process内のmonotonic期限を別に検査する。実行入口で単回消費・開始意思・開始eventを同じ同期取引で保存し、実adapter前に期限・epochを再検査する。保存に失敗した場合は下流を起動しない。実呼出しからの応答観測、未呼出し、結果不明を保存し、再照会は作用を起動しない。

編集前local／remote mainは41a51483dde09c9632f6d89764c7d190ef96d49c、clean。親が単一writer、subagentはread-only。local復元branch二世代とremote tag二世代は41a51483dde09c9632f6d89764c7d190ef96d49c／4e415a7fb63b6c6e795ab0eec53bf51d5d9581a3へCAS・期待SHA付きatomic pushで照合済み。旧D01.03 stashは保持する。backup ref移行はMIGRATION_COMPLETE。

## 安全・未接続

既存HDS standalone、Approval Gate、L3、能力envelope、output audit、監査、M非権限を維持し、旧L3分類は削除しない。期限は再送で延長せず、時計巻戻し、別authority、内容差替え、再発行、保存失敗から同じ承認を再実行しない。未完intentは再照会で結果不明とし、未消費へ戻さない。epochはauthorityごとに分離し、別CLI起動がserveの承認を失効させる共有epochを使わない。

このstoreはBLUEのExecutor所有のlocal実行記録であり、独立Broker Permissionでもprocess境界認証でもない。D02.01全体の委任・目的版・実体版resolver、D02.02の認証済みJ↔Broker入口、D03のD4登録・Permission AND、D04のworker世代・外部受理照合・Jとのreceipt再送調停はBUILD_GAP。J checkpointと実行storeは別取引であり、全体ACIDや目的成功を主張しない。issued記録の照会は現在権限の復元ではない。

C08.03実provider、実資格・外部業務作用、D4Pocket／ミニドラ別repo編集、5OS installed証拠、公開・出荷判断は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部原典・ZIP・要求対応表・秘密・raw運転状態をPublic Gitへ置かない。他writer更新、重大安全逸脱、owner停止指示では該当変更を止め再同期する。

## 技術確認とGit

Windowsでtypecheck→build→変更consumerと重大境界の限定test、既存計画HTTP smoke、変更文書docs:check、差分確認を実施する。期限・再発行・DB競合・consume後の中断・receipt保存失敗は未許可再作用を防ぐ局所確認とする。全suite／網羅QC／QA／耐久／全OS／実providerはNOT_RUN。

バッチ末に接続結果・初回失敗・残差を開発進捗へ記録し、限定commitをmainへpush、remote main・二世代tag・stash・dirtyを再照合する。次の作業では最新版三点全文・AGENTS・現物を再読する。

接続したlocal部分はWIRED、D02.02／D03／D04全体はBUILD_GAP。最新typecheckとbuild、限定14 files／103 tests（複数run・2 workers固定）、計画HTTP smokeと再起動後receipt／401確認、HDS standalone、docs:checkがPASS。初回接続欠陥と資料整理fixtureのEBUSY・修正・因果未確定は開発進捗へ保持する。全体QC／QAは未開始。
