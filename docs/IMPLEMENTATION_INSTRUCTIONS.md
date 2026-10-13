# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点全文と適用AGENTS.mdを毎作業・切替・再開時に再読する。現在のowner開発委任に従い、過去の停止・旧SHAから現在状態を巻き戻さない。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-RESULT-RECONCILIATION。D04.02／D04.03のBLUE内部分として、固定file.search workerの実結果を同じExecutor取引で保存し、再起動後の既存J bindingへ非作用配送して依存stepへ戻す。通常HTTPの保存結果とJのCAS採用、配送確認をつなぐ。対象は既存組込みfile.searchの計画stepのみ。

承認後、実行前にExecutorが発行したticket・全内容digest・proof digest・epoch・期限をJ checkpointへ結合する。Jの計画digestとExecutorの内容digestは別契約として検査する。実operation_core_resultと容量・形状を制限した実検索出力は私有outboxに保存し、元JSONのキー順・result ID・観測時刻を保持する。receiptとoutbox、eventはExecutorの同じSQLite取引で保存する。

再起動時は旧承認・inflightを復元せず、開始意思を持つ元bindingとadmissionを照合する専用consumerで既存result_equalsを通す。結果と配送digestをJの同じCASへ保存し、その後だけoutboxをackする。J保存後・ack前の中断は同結果の再配送で回復し、異内容を拒否する。依存の鮮度は元観測時刻＋10分のまま。全pendingの上限内一回走査とし、未採用は保持する。

編集前local／remote mainは72167f81155a24d6b8a3921ee0fe2380340769fb、clean。親が単一writer、subagentはread-only。local復元branch二世代とremote tag二世代は72167f81155a24d6b8a3921ee0fe2380340769fb／6f4c350a091ce745fa9c57abe3311a582330925eへCAS・期待SHA付きatomic pushで照合済み。旧D01.03 stashは保持。backup ref移行はMIGRATION_COMPLETE。

## 安全・未接続

通常onFeedbackのinflight保護、HDS standalone、Approval Gate、L3、能力envelope、output audit、監査、M非権限を維持する。保存結果は権限でもCや記憶更新の候補でもない。欠落・issued・未完のreceiptを未作用へ変換せず、同ticketを復活させない。raw検索本文・ticket・epoch・資格をsnapshot／Complete Historyへ出さない。保存・照合失敗はpending／結果不明を保持する。

一配送の上限は256 KiB、保存上限は1000件・8 MiB。満杯では削除や成功への変換をせず保存故障として扱う。長期の保持・容量解消、ack故障後の常時配送、OS別秘密保護は後続接続／QC対象として残す。POSIX私有dir／DB modeを限定するがWindows ACL保証を主張しない。

認証済みJ↔D4 Brokerと独立Permission AND、委任・目的版・実体版の全結合、外部受理照合、OS強制隔離・process群停止・5OS installed証拠はBUILD_GAP。JとExecutorのDBは別取引であり、全体ACIDや製品完遂を主張しない。実provider・実資格・外部業務作用、D4Pocket／ミニドラ別repo編集、公開・出荷判断は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。内部原典・ZIP・要求対応表・秘密・raw運転状態をPublic Gitへ置かない。他writer更新・重大安全逸脱・owner停止では再同期する。

## 技術確認とGit

Windowsでtypecheck→build、実保存・再起動・依存・ack窓・異内容・鮮度・未呼出し・保存故障の限定testと関連する既存安全testを実施する。built GatewayのHTTP smokeは専用一時DBのJ保存故障を使い、実worker結果保存後の再起動・非作用採用と新規作用数を観測する。製品に故障hookは追加しない。HDS standalone、変更文書docs:check、差分確認も行う。全suite／網羅QC／QA／耐久／全OS／実providerはNOT_RUN。

バッチ末に接続結果と残差を開発進捗へ記録し、限定commitをmainへpush、remote main・二世代tag・stash・dirtyを再照合する。次作業も三点全文・AGENTS・現物を再読する。次consumerは独立D4 Permission、保留配送の継続的な再照合、結果のM帰還であり、別repoの提案・許可を分離する。

localの計画file.search結果調停はWIRED。最新typecheck→build、限定10 files／88 tests（2 workers固定）、built Gatewayの保存故障・再起動HTTP smoke、HDS standalone、docs:checkはPASS。D03／D04全体はBUILD_GAP。全体QC／QAは未開始。初回smokeの試験側HTTP status誤りと修正は開発進捗に保持する。
