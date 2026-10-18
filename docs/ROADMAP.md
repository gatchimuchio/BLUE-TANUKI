# BLUE-TANUKI QE統合工程・公開ロードマップ

2026-10-18。owner指定の最新版である内部QE rev2.3三点正本を設計・要求・198施工単位（旧192＋Android/iOS各3）の根拠とする。今後もowner指定の最新版を正本とする。本書はPublicに出せる順序・状態の概要であり、内部原典を転載しない。

## 現行のQE工程

| 工程 | 主な目的 | 状態 |
|---|---|---|
| QE_DESIGN | C/J/M、作用・記憶・外殻の全体設計 | 設計と現在コードの残差あり |
| QE_BUILD | 一気通貫の全体系を先行実装 | 上記の計画・結果・作用基盤に、受領済みfile.search観測の限定C射影、J表示前引用照合、意味更新案v2のtarget record/version照合、単一宛先Gmail作用と結果不明のJ配送、J計画revision/statusの既存Control Center表示、合成loopback receiptのdigest-only非権威観測を接続。Developer HTTPからの合成runtime照合をbuild済みGateway smokeで確認し、Gmail送信承認では明示的な内容確認とpending command digest結合をBLUE WebChatに追加。WebChat接続成立時の認証済みRuntime Snapshot再取得と、chat socket／Gateway状態の表示分離も実装。2026-10-18にCron scheduleの安定event identity、private cursor、同一source直列consumerを部分接続し、schedule変更を同一commandのL3 final-review評価へ結合、永続storeを検証してからCronへ有効化する境界を部分接続。起動時の保存済み結果／M receipt照合が未解決なら通常inbound／Cron起動を止める障壁も部分接続。同日、常駐serve／CLIに同一state rootのSQLite process-exclusive owner lease、永続boot generation／execution epoch、Executorの承認・dispatch・receipt fenceを追加し、別processの二重ownerを限定fixtureで拒否。J/M/Broker ledgerとJ OperationPlan bindingをdigest-onlyで照合するread-only `--recovery-inspect` CLIも部分接続した。未決Cron eventとjob resultの相関、修復・独立backup照合・restoreを含むrecovery、仕事別digest-only残差表示を超える回復操作UI、Windows ACL検査、実行中に渡した外部作用のfencing、network filesystem、approval lifecycleの再起動時照合、実provider receipt照会、D4Pocket画面接続、prior version、一般意味採用、全体系は未接続 |
| SYSTEM_SHAPED | 試験仕事が目的→結果→M→復帰まで通る | 全体成立未確認 |
| BUILD_COVERED | 全機能群の結合形状を確認 | 未成立 |
| QE_QC | 実物の全体検査・欠陥・原因・改善・再検査 | 未着手 |
| QE_QA | QC証拠から対象別・OS別・版別保証 | 未着手 |
| QE_RELEASE_REVIEW | ownerによる独立公開・出荷判断 | 未着手 |

2026-10-18にCronの未決dispatch状態を、event ID・sequence・delivery state・payload digest・時刻に限ったread-only通知として認証済みWebChatへ接続した。通知は外部結果の成功を断定せず、再送・解除・承認を行わない。再起動後の未決作用照合・復旧は未接続であり、E01.01／E03.02／QEB-03は`BUILD_GAP`。

2026-10-18のQEB-03-E03.02-STARTUP-RECONCILIATION-BARRIERでは、Gatewayが起動時に既存Execution result outboxとM pendingを再照合し、未解決receiptが残る場合は通常inbound／Cron開始前に停止する経路を接続した。これはE03.02の部分実装であり、単一writer／boot generation／fencing、旧世代結果の分離、Cron eventとjob resultの相関、回復operator UIは未成立。E03.02／QEB-03は`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.02-OLD-GENERATION-RESULT-ARCHIVEでは、Gateway startup／実行後にcurrent execution epochと一致するreceiptだけをHDS J/Mへ配送する。旧世代receiptはJ結果consumerを呼ばず、private ExecutionIntentにstale-generation dispositionとarchive世代digestを記録してpendingから外す。snapshotにはdigest／dispositionだけを投影し、保管に失敗した場合はstartup readinessを拒否する。限定3-file／35-testと追加focused確認、typecheck、workspace build、docs gateが通った。E03.02／QEB-03はCron eventとjob resultの相関、未決結果のoperator recovery UI、旧processまたは既にadapterへ渡した作用の停止が未成立のため`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.03-READONLY-LEDGER-RECOVERY-INSPECTIONでは、通常startup／owner lease／HDS controller初期化に入らないGateway `--recovery-inspect` CLIを接続した。HDS J/Mのcanonical eventをread-onlyで再生し、verified prefix、破損suffix、projection差異、opaque update digestの残差を表示する。journal副ファイル検出時はDBを開かず、独立backupは未検査と明示し、repair／restore／resume／権限発行をしない。破損suffixに対する限定fixture、保存物不変、副ファイル時のopen抑止、J/M残差分類、空state rootでのJSON／text CLIを確認した。これは部分接続であり、verified prefixからの復旧、backup検査、operator UI、E03.03／QEB-03全体は未成立のため`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.03-EXECUTION-LEDGER-READONLY-INSPECTIONでは、同じCLIへBroker execution-intent ledgerのread-only検査を追加した。event hash chain、receipt projection、result outboxを照合し、破損suffixや整合しないprojectionからcurrent stateを出さず、健全時もopaque digestと状態だけを返す。J/M/Brokerの三台帳のいずれかが未検証ならreplay checkpointを表示しない。通常Executor write pathに変更はなく、E03.03は独立backup／restore point、仕事単位のplan binding照合、operator recovery UIが未接続のため`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.03-PLAN-BROKER-LEDGER-CORRELATIONでは、同じCLIへOperationPlan checkpointのread-only inspectionと、J binding／Broker execution-intent receiptのadmission digest相関を追加した。J checkpointの自己digest・schema・revision／step／result／command key／ticket uniquenessを確認し、Broker未検証・記録上限・不一致を区別する。未照合のJ/M result-memory linkは残差として保ち、checkpointを成立扱いしない。出力はopaque digestと固定enumに限定し、破損checkpoint全体を抑止しながら個別不整合のないbindingは保持する。合成2-file／11-test、`pnpm typecheck`、15 workspace build、未作成state rootでのJSON／text CLIを確認し、read前後のDB bytes不変とsidecar時open抑止を確認した。checkpointは認証済anchorやbackupではなく、restore・repair・resume・権限を生成しない。独立backup／restore、未決結果operator UI、E03.03／QEB-03全体は未成立で`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.03-PLAN-MEMORY-LEDGER-CORRELATIONでは、OperationPlanに記録されたJ result-memory commit／receiptをcanonical J/M ledger inspectionへupdate・event・content・revision・receipt digestでread-only照合した。期待linkの欠落、未検証、保留、不一致は残差のまま保持する。CLI／認証済みoperator projection／WebChatには固定enumとdigestだけを渡し、raw IDや本文を出さない。縦断fixture 30件、Gateway inspection 13件、WebChat 76件、typecheck、15 workspace build、docs gateを確認し、J/M/OperationPlan/Broker保存物がinspection前後で不変であることをfixtureで確認した。復旧操作や権限は生成しない。E03.03／QEB-03全体は未成立で`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.01-GATEWAY-OWNER-LEASE-EXECUTION-EPOCHでは、常駐serveとCLIが共有state rootのSQLite exclusive leaseを保持し、永続generation／UUID execution epochをExecutionIntentとExecutorの作用境界へ接続した。別Node processの同時owner拒否、再取得時の世代更新、lease喪失後の合成tool非dispatchを限定testで確認。Windows ACL、network filesystem、実行中に既に渡された作用の停止、旧世代receiptの分離は未確認で、E03.01／QEB-03全体は`BUILD_GAP`。

198小単位（旧192＋Android/iOS各3）は実装索引であり、個別のQC/QAを198回行うための工程ではない。毎作業および各小単位の開始・切替・再開時に最新版の三点セットすべてと適用AGENTS.mdを読み直し、実際の仕事を先へつなぐBUILD_BATCHで施工・限定技術確認・Git保全を行う。

2026-10-18のQEB-03-E03.03-OPERATOR-RECOVERY-INSPECTIONでは、既存Recovery面にmaintenance-token保護のread-only `GET /recovery/inspection`を追加し、J/M/Broker/OperationPlan診断の固定状態・残差件数をallowlistで表示した。続くQEB-03-E03.03-OPERATOR-RESIDUAL-ISOLATIONでは、plan／step／commandとupdateの参照をSHA-256 digest、固定enum、最大200件のoperator projectionへ限定した。raw IDや内容を出さず、invalid boundaryでは明細を抑止する。両接続とも権限・実行・復旧actionを行わず、再生checkpointをbackupと誤認させず、外部backup restore pointは`not_examined`のまま示す。仕事別復旧操作、独立backupの確認・restore、E03.03／QEB-03全体は`BUILD_GAP`。

2026-10-18のQEB-03-E03.03-RESTORE-PREFLIGHT-ATOMICITYでは、既存local recovery restoreを変更する前に選択manifestの全item／target／archiveを検査する経路を追加した。後段archiveのdigest不一致とdirectory内symlinkをfixtureで拒否し、target不変更とpre-restore pack未作成を確認した。これはrestore対象の検査を先行する部分実装であり、J/M/Broker ledgerの復旧、独立backupの検証、実stateへのrestore、restore可能性の証明ではない。E03.03／QEB-03は`BUILD_GAP`を維持する。

## 公開可能なBUILD_BATCHの順序案

1. QEB-00：QE規律、現行正本、Git復元、安全と公開制限の同期。
2. QEB-01：既存コードを使った目的、計算C、判断J、記憶M、複数step作用、結果照合の接続。
3. QEB-02：D4Pocket汎用外殻とBLUEの認証済みAdapter／Broker接続、操作者導線と旧新切替。
4. QEB-03：長期運転、結果帰還、再計画、復旧、学習の接続。
5. QEB-04：OpenClaw/Museの観測された能力群を安全に実装。
6. QEB-05：ミニドラを交換計算Cとして接続。
7. QEB-05M：Android（G09）とiOS（G10）をそれぞれ独立したnative製品入口として一気通貫で結合する。Device Link、端末の資格・OS権限、仕事の承認・観測・取消・切断復帰、更新・削除まで対象とし、詳細QCはBUILD_COVERED後へ置く。
8. QEB-06：全能力のBUILD_GAPを照合してBUILD_COVEREDを判定。

この順序は完成の証拠や無制限な作業許可ではない。D4Pocket・ミニドラの別repo、実資格と業務作用は別の委任が必要。BUILD_COVERED後にQE_QCで実物を検査し原因を修正、QE_QAで対象別の保証を判定する。

## 5OSの製品完成スコープ

最終対応対象はWindows／Linux native／macOS／Android／iOS。Desktop三系統に加え、AndroidとiOSのnative製品入口を別々に実装し、両OSの実機QC／QAを独立して行う。F16の「モバイル入力媒体」はAndroid/iOSの製品完成を代替しない。詳細は[QE対応OS正本](PLATFORM_TARGETS_QE.md)。旧v1.0 RCのMobile非搭載は別の歴史的制限である。

## D4Pocket方式へのバックアップ移行

local二世代branch（refs/heads/codex/backup-main、refs/heads/codex/backup-main-prev）／remote二世代tag（refs/tags/codex/backup-main、refs/tags/codex/backup-main-prev）への移行状態は**MIGRATION_COMPLETE（2026-10-12）**。二tagのSHAを照合後、旧remote backup branch二本を競合検出付きで整理した。完了時SHAと手順は[復元ref移行記録](BACKUP_REF_MIGRATION.md)を参照する。新AGIの製品QE_BUILD再開とは独立した規定修正である。

## 既存の局所実装と現行接続

2026-10-17に意味更新案のv2 `target_reference`を既存MemoryCitationReferenceと同じ(record ID, immutable entry hash)で表し、同一commandの現在M射影との完全一致をHDSが照合するようにした。v1履歴は解析可能なまま残す。`prior_version_ref`は未型付け・未検証であり、意味関係の評価、記憶採用、M反映、権限には使わない。

2026-10-17のQEB-01-APPROVAL-POLICY-CONSUMERで、ExecutorはHDS-BRAINのcommand分類を直接消費し、proofのoperation／risk／final-review状態を発行時とdispatch直前に照合する。HDSがL3と分類する場合はhuman final-review由来を要求する。D02.02の部分接続であり、独立Broker PermissionとD08.01全体は未成立。

2026-10-17のQEB-01-D08.01-LOCAL-EXTERNAL-RESULT-PATHで、OperationPlanのGmail `message.send`を単一宛先へ限定し、承認ticket同一性をGmail adapterへ渡す。tool-adapter結果を耐久outboxからJへ返し、結果不明を保持する。合成C／L3 proof、loopbackの非冪等検査server、応答破棄、3回の再起動、read-only receipt照合で二重作用0件を確認した。2026-10-18のQEB-01-D08.01-D09.01-RECEIPT-OBSERVATION-INGESTIONでは、loopback照合応答をcommand key／Executor command／request payload digestで照合して、非権威のdigest-only観測をJの永続plan stateと既存Control Centerへ接続した。一致しても結果不明は解除しない。続くQEB-01-D08.01-D09.01-LOOPBACK-INSPECTION-ADAPTERでは、固定loopback endpointに限定したread-only GET producerを縦断fixtureへ接続し、redirectと過大応答を拒否した。QEB-01-D08.01-D09.01-OWNER-TRIGGERED-LOOPBACK-RECONCILIATIONでは、Control Centerの明示操作とDeveloper HTTPから合成loopback照合を起動し、照会前認可を接続した。QEB-02-D08.01-D09.01-GATEWAY-HTTP-RECEIPT-RECONCILIATION-SMOKEでは、build済みGateway processを通し、matchedのdigest-only projectionとendpoint未設定時の通信なしを確認した。期限切れ券は同じGateway境界試験で明示的に期限を進め拒否・GETなし・結果不明維持を確認する。D08.01／D09.01全体は実provider照会・D4Pocket画面・全体結合が未成立のため`BUILD_GAP`を維持する。

C01～C08.02、D01.01～D01.02などは現行Gitに局所成果を持つが、AGI全体の完成、D4Pocket実接続の証明ではない。QEB-01-RESULTSで実結果を既存監査・履歴へ、QEB-01-PLANSで旧plan保持、内部command-step対応、明示step選択、検証済み依存結果、未実行部分の再審査を接続した。QEB-01-APPROVAL-CONTENTはApproval受付からExecutorまで内容を固定する。QEB-01-EXECUTION-INTENTはlocal期限、私有SQLiteの単回消費・開始意思・receipt、再起動後の認証付きdigest照会を接続する。QEB-01-FILE-SEARCH-WORKERは組込みfile.searchを固定childの専用IPCへ通し、実worker世代・終了と既存Jの結果検証を接続する。QEB-01-RESULT-RECONCILIATIONは保存実結果を再起動Jへ非作用配送する。QEB-01-RESULT-MEMORYはその検証済み観測を私有Mへ保存し、同receipt・元recordを照合して依存stepへ戻る。QEB-01-RESULT-REFLECTIONは現行計画の受領済みfile.search観測をdigestと件数等の有限射影にし、Cの解釈候補・不確実性をJが表示前に引用照合する。QEB-01-C07-PROPOSAL-REFERENCE-REVIEWは意味更新案の支持／反証record ID・版を現在のM射影へ限定照合する。QEB-01-C07-SCOPE-PLAN-DIGEST-REVIEWは両scope referenceを現在のapplication_scope_idへ、scope digestを同一J MemorySearchPlanのplan_idへ照合し、結果を非権威auditへ記録する。これは同一計画への結合であり、意味的支持／反証、探索完全性、scopeの意味適合、target/prior version、採用は未検証のまま保持する。plan:reflect由来のproposalは通常の意味更新履歴へ保存しない。候補は未採用で、一般C引用・学習は未接続。対象resolverはfile.searchのdirectoryと、単一宛先gmail.write／message.sendに限定される。receipt観測はloopback fixture経路から永続J checkpoint・既存Control Centerへの限定接続であり、実サービスreceiptを取得するproduct adapterは未接続。自動目的採否、独立D4 Broker Permission・汎用内容結合、他の外部作用の照合、外部postcondition照合、OS強制隔離・全作用の独立停止はBUILD_GAP。操作は[計画接続の操作](計画接続の操作.md)、[承認内容の固定](承認内容の固定.md)、[実行意思と再照会](実行意思と再照会.md)を参照する。C08.03実LLM/providerは保留。

2026-10-18のQEB-02-D09.02-BLUE-APPROVAL-CONTENT-REVIEWでは、BLUE WebChatにresume認証付きの明示的Gmail送信内容previewを追加した。previewはcurrent pending commandとproduction payload serializerに結び、approve時にpreview開示記録と同一command digestを一回券消費前とGateway実行直前に確認する。本文は明示preview以外の一覧・snapshot・履歴へ出さず、承認履歴へはdigestのみを投影する。D4 consumerは別途権限が必要で未接続のため、D09.02全体は`BUILD_GAP`を維持する。実送信・credentialは使用していない。

2026-10-18のQEB-02-D09.03-BLUE-WEBCHAT-RECONNECT-SNAPSHOTでは、WebChat接続状態をGateway process状態と区別し、接続成立時にRuntime tokenがある場合だけno-storeの認証済みsnapshotを再取得するBLUE側consumerを追加した。閉じた古いWebSocket eventは無視する。Control Center/Gatewayの実processを使ったreconnect E2E、service stop/cancel、D4Pocket画面接続は未確認・未接続。D09.03全体は`BUILD_GAP`。

2026-10-18のQEB-03-E01.01-CRON-EVENT-IDENTITY-CURSORでは、承認済みRuntimeScheduleのCron発火にsource／予定時刻由来の安定event IDを付け、Gateway private SQLite inbox/outbox cursorへdigestとconsumer状態を保存する。重複・逆順・payload衝突を識別し、未確定consumerを自動再実行せず、同一sourceの呼出しを直列化した。これはE01.01のBLUE Cron部分接続であり、durable job状態、再起動後の未決outbox復旧、全channel共通inbox、catch-up、E01.01全体の成立は未確認のまま`BUILD_GAP`。

## 旧RCのP13と日本語基底J系列

旧v1.0 RCのP1–P12とP13は独立した出荷履歴・境界。version=1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。必要な実機、GA、release bundle、strict日本語基底とowner GOの条件は維持し、旧RCの局所PASSを新AGI構成の品質へ転用しない。

J0は日本語基底規定成立として完了。J1（活正文書）、J2（UI/installer）、J3（コード散文）、J4（strict closure）は未承認・未着手。J0通常gateの成功をJ4の証明にしない。

## 正本

AGENTS.mdがQE方法と保護、docs/作業標準要領.mdが運用、docs/IMPLEMENTATION_INSTRUCTIONS.mdが限定task、docs/開発進捗.mdが観測済み履歴、docs/STRATEGY_FRAME.mdが競合と外殻の戦略、docs/PRODUCT_ROADMAP.mdが旧v1 RCのrelease境界を扱う。現在のowner開発委任と内部正本の再照合に基づきQE_BUILDを継続する。
