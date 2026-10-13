# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点すべてと適用AGENTS.mdを毎作業・切替・再開時に再読する。過去の停止指示と規定同期は履歴であり、現行ownerの開発委任に従ってBLUE本体を接続する。

## 対象と到達状態

QE_STAGE: QE_BUILD。BUILD_BATCH: QEB-01-PLANS。単位D01.03、依存入力D01.02。既存Cが返す計画候補→HDSで旧版保持→Developerの明示step選択→既存HDS／Approval／Executor→内部command-step対応→実結果と依存入力→未実行部分の改訂を接続する。

前バッチの実command結果はplan_step_binding=unboundを維持し、HDSの内部対応記録から計画へ帰属させる。LLMのstateやresult_digestを実行事実へ昇格させない。改訂は期待revisionで更新し、変更と依存影響の旧pending commandを失効、無変更stepの対応と旧結果は保持する。

## 現物・作用範囲

編集前local／remote mainは54b369c9aa806516d74a80f35e930a6328f441af、dirtyなし。親を単一writerとし、subagentはread-only。旧D01.03 stashは復元せず保全する。

現在接続する対象resolverはfile.searchのdirectory targetとparameters.rootの一致。実パス・sandboxは既存toolが独立検査する。その他の能力は削除せずBUILD_GAPとして次のD02以後へ残す。Cの計画から自動作用を開始せず、現行Developer入口のplan:reviewで特定内容を選ぶ。これは個人identity認証や自動目的採否の完成ではない。

計画と内部対応、依存結果はBLUE_TANUKI_STATE_ROOT配下のprivate-stateへ、私有runtime SQLiteのCASで保存する。通常file操作はこのnamespaceと実path aliasを拒否する。実行前に現在のprepared内容・command内容・依存鮮度を再照合し、command全体と元発行IDを照合し、単回の開始意思を同期保存して深く固定してからExecutorへ渡す。再起動で旧承認を復活させず、開始意思がある未確定作用は結果不明として再実行しない。内部結果の準備有効期間は当該バッチの10分の有限profileであり、外界鮮度・保証値ではない。

## 安全・未接続・停止

既存HDS standalone、Approval Gate、L3、output audit、監査、M非権限、fail-closedを維持する。通常外部入力、偽装metadata、未知verb、壊れたplan controlはLLMへfallbackせず拒否する。plan:reviseは旧版を保持し、試行済みstepとその依存影響の変更・削除を拒否する。古いpending承認、内容差替え、結果不明を次の実行許可にしない。計画controlのSUSPENDはresume不可とし新しいreviewを要する。射影のplan/step IDはdigest handleに限定する。操作と回復先は[計画接続の操作](計画接続の操作.md)を参照する。

自動目的採否、汎用target resolver／Broker内容結合、外部postcondition照合、独立停止・取消、5OS・installed製品、長期帰還はBUILD_GAP。C08.03実provider、実credential・実外部業務作用、D4Pocket／ミニドラ別repo変更は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部QE/HDS原典、対応表、秘密・raw運転証拠をPublic Gitへ置かない。

他writer更新、重大安全逸脱、owner停止指示で該当変更を止め再同期する。tag移行はMIGRATION_COMPLETEで、旧ZIPの待機状態を転記しない。

## 技術確認とGit

Windowsでtypecheck→build→実consumerと重大境界の限定test、HDS standalone、serve/resume smoke、変更文書docs:check、差分確認を行う。全suite／網羅QC／QA／耐久／全OS／実providerは未実施とする。

今回の接続範囲はWIRED。最新typecheckとbuild、限定15 files／270 tests（2 workers固定）、HDS standalone、専用loopback計画HTTP smoke、隔離した既存serve/resume smoke、docs:checkと差分確認がPASS。観測範囲・初回失敗・BUILD_GAPは[開発進捗](開発進捗.md)へ保持する。次の作業は最新版三点全文・AGENTS・現物を再読し、未接続の作用境界へ再同期する。

編集前local backup branch二世代とremote backup tag二世代は54b369c9aa806516d74a80f35e930a6328f441af／66a21a84545666fbeb178ff003bc14b3fd5796f7へCAS・期待SHA付きatomic pushで照合済み。バッチ末は限定commit/push、remote main・tag・stash・dirtyを再照合する。
