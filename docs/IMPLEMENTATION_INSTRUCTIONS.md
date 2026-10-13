# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点全文と適用AGENTS.mdを毎作業・切替・再開時に再読する。現在のowner開発委任に従い、過去の停止・旧SHAから現在状態を巻き戻さない。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-APPROVAL-CONTENT。D02.01のうち、実commandがApprovalへ入った時点の内容→既存採否・pending→Executor直前照合→固定内容のadapter呼出しを接続する。D01.03の内部plan対応と実結果経路を維持する。

既存の制限JSON・JCS境界を使い、command ID、payload、constraints、HDSの目的・commitを同じ内容digestへ固定する。GatewayのHTTP、CLI、資料整理の既存三consumerは、受付時に元commandを深く固定し、同じdigestをproof発行へ渡す。HTTP pendingは同じ内容とdigestを保持してresumeへ渡す。Executorは独立した固定copyを使い、private WeakMapでauthority instanceとproof・内容digestを保持し、実行入口で単回消費する。digest自体は権限・発行者認証ではない。

編集前local／remote mainは4e415a7fb63b6c6e795ab0eec53bf51d5d9581a3、clean。親が単一writer、subagentはread-only。local復元branch二世代とremote tag二世代は4e415a7fb63b6c6e795ab0eec53bf51d5d9581a3／54b369c9aa806516d74a80f35e930a6328f441afへCAS・期待SHA付きatomic pushで照合済み。旧D01.03 stashは保持する。

backup ref移行はMIGRATION_COMPLETEであり、旧ZIPの移行待ちを現在状態へ転記しない。

## 安全・未接続

既存HDS standalone、Approval Gate、L3、能力envelope、output audit、監査、M非権限を維持し、旧L3分類は削除しない。コピーしたobject、JSON、別authority、承認後の内容差替え、同じ承認の再利用は実adapter前に拒否する。getter等の非JSON値、数値・Unicode・深さ・容量の境界違反は固定した理由で拒否し、raw内容をerrorへ出さない。

今回のconsumer接続はApproval受付からの内容固定に限定する。D02.01全体はBUILD_GAPであり、正規の委任・目的版・issuer/audience・host/process epoch・実体版のresolverとの結合は未接続。D02.02のprocess境界認証、wall/monotonic期限、永続ticket消費・receipt、独立Broker Permissionは次consumer。process内の単回proofを永続作用ticketの成立と呼ばない。D02.03の旧L3置換は未実施。外部作用の結果不明・独立停止・秘密・OS隔離はD04以後へ保持する。

C08.03実provider、実資格・外部業務作用、D4Pocket／ミニドラ別repo編集、5OS installed証拠、公開・出荷判断は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部原典・ZIP・要求対応表・秘密・raw運転状態をPublic Gitへ置かない。他writer更新、重大安全逸脱、owner停止指示では該当変更を止め再同期する。

## 技術確認とGit

Windowsでtypecheck→build→変更consumerと重大境界の限定test、既存計画HTTP smokeとserve/resume smoke、変更文書docs:check、差分確認を実施する。全suite／網羅QC／QA／耐久／全OS／実providerはNOT_RUN。HDS権限中核は今回変更しないが、既存standaloneを維持する。

バッチ末に接続結果・初回失敗・残差を開発進捗へ記録し、限定commitをmainへpush、remote main・二世代tag・stash・dirtyを再照合する。次の小単位では最新版三点全文・AGENTS・現物を再読する。

接続部分はWIRED、D02.01全体はBUILD_GAP。最新typecheckとbuild、限定13 files／158 tests（2 workers固定）、計画HTTP smoke、temperature=0.7の隔離serve/resume smoke、HDS standaloneがPASS。初回回帰・未接続・後段QCは開発進捗へ保持する。
