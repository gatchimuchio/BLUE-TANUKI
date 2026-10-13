# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点全文と適用AGENTS.mdを毎作業・切替・再開時に再読する。現在のowner開発委任に従い、過去の停止・旧SHAから現在状態を巻き戻さない。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-FILE-SEARCH-WORKER。D02.02／D04.03のBLUE内部分を、既存HDS・Approval→永続開始意思→専用file.search child→実worker受領・終了確認→既存J結果検証へ接続する。対象はGatewayに登録された組込みfileSearchToolのみ。独立D4 Broker Permission、OS sandbox、外部業務作用は本バッチの到達状態に含めない。

親が固定built artifactをNodeの専用継承IPCで起動し、任意module／command／親loader／全envを渡さない。readyの実PIDをchild.pidと照合し、新worker ID・OS・起動時刻を既存消費ticketへ同期保存する。起動待ちと保存待ちの後、送信直前に内容・現在期限・停止条件を再検査する。childは同じticket・command digest・epoch、固定file.search能力、現在FILE_ROOTと既存秘密領域保護を独立に検査する。一worker一要求。親が応答の同一性と形状、実closeを確認して既存Executor結果producerへ戻す。

編集前local／remote mainは6f4c350a091ce745fa9c57abe3311a582330925e、clean。親が単一writer、subagentはread-only。local復元branch二世代とremote tag二世代は6f4c350a091ce745fa9c57abe3311a582330925e／41a51483dde09c9632f6d89764c7d190ef96d49cへCAS・期待SHA付きatomic pushで照合済み。旧D01.03 stashは保持する。backup ref移行はMIGRATION_COMPLETE。

## 安全・未接続

既存HDS standalone、Approval Gate、L3、能力envelope、output audit、監査、M非権限を維持する。digestやPIDを発行者認証とみなさず、親所有の専用IPCと固定childへ結合する。切断・unsupported・内容不一致・停止・期限・保存失敗ではchildを停止し、実終了を待つ。直接invoke／旧経路へのfallbackや同ticketの再使用を行わない。readyと検索開始、取消受付と実終了、adapter応答とJ検証成功を分ける。

D02全体の委任・目的版・実体版resolver、認証済みJ↔D4 Brokerと独立Permission AND、JとExecutor別DBのreceipt再送調停、外部受理照合、OS強制隔離・process群停止・5OS installed証拠はBUILD_GAP。Gateway停止は今回のworkerへ接続するが全作用の独立停止保証ではない。J checkpointと実行storeは別取引であり、全体ACIDを仮定しない。未完intentの照会から未消費や現在権限を復元しない。

C08.03実provider、実資格・外部業務作用、D4Pocket／ミニドラ別repo編集、公開・出荷判断は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部原典・ZIP・要求対応表・秘密・raw運転状態をPublic Gitへ置かない。他writer更新、重大安全逸脱、owner停止指示では該当変更を止め再同期する。

## 技術確認とGit

Windowsでtypecheck→build→変更consumerと重大境界の限定test、計画HTTP smoke、HDS standalone、変更文書docs:check、差分確認を実施する。実childのPID・世代・終了・再送拒否、起動と保存後の停止／期限、内容差替え・別worker、root外・同名adapter置換拒否を局所確認する。全suite／網羅QC／QA／耐久／全OS／実providerはNOT_RUN。

バッチ末に接続結果・初回失敗・残差を開発進捗へ記録し、限定commitをmainへpush、remote main・二世代tag・stash・dirtyを再照合する。次の作業では最新版三点全文・AGENTS・現物を再読する。次consumerは保存receiptからJへの非作用調停とD4独立Permissionであり、別repo変更案と許可を分離する。

接続したlocal部分はWIRED、D02.02／D03／D04全体はBUILD_GAP。最新typecheck→build、限定9 files／81 tests（2 workers固定）、built Gatewayの計画HTTP smoke、HDS standalone、docs:checkはPASS。全体QC／QAは未開始。初回失敗と修正、未接続は開発進捗へ保持する。
