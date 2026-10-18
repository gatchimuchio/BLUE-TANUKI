# BLUE-TANUKI QE統合工程・公開ロードマップ

2026-10-19。owner指定の最新版である内部QE rev2.3三点正本を設計・要求・198施工単位（旧192＋Android/iOS各3）の根拠とする。今後もowner指定の最新版を正本とする。本書はPublicに出せる順序・状態の概要であり、内部原典を転載しない。

2026-10-19の`QEB-03-E03.03-MULTI-PLAN-RESTORE-RESIDUAL-HOLD`では、合成Gateway L3 restore経路でclean planを選択scopeに保ったまま、同じOperation Plan storeに残差collateral planを含め、復元後HDS projectionと永続holdが残差planだけを`held_residual`として保持することをfocused integration testで確認した。clean planにはRecovery holdが付かない。fixtureは実owner承認・Executor作用・実restoreではなく、Gateway process／HTTP／一時SQLite上の合成経路。E03.03=`BUILD_GAP`を維持する。次はclean planの通常HDS reviewと残差planの拒否を復元後状態から照合する。

2026-10-19の`QEB-03-E03.03-VERIFIED-PLAN-RESTORE-REFRESH`では、stub Gatewayの合成L3承認経路から、検証済みbackupのselected Operation Plan storeを復元し、Gateway/HDS runtime checkpointが復元後の状態を再読込することをfocused integration testで確認した。backup digest scopeはwhole-storeの効果範囲とともにL3 targetへ結合される。合成承認は実owner承認ではなく、残差を含む複数planの復元後hold分離も未確認。E03.03=`BUILD_GAP`を維持する。次は複数planのrestore observationから、残差planだけをholdするruntime consumerを確認する。

2026-10-19の`QEB-03-E03.03-RECOVERY-RESIDUAL-OPERATOR-DOM`では、合成checkpointの旧plan残差とfresh planの観測scopeをControl Center Recoveryの実browser DOMで別々に表示し、read-only／非権威／非実行境界とRuntime Snapshot上の旧hold継続を確認した。fresh planはinspection専用checkpointに合成追加したもので、runtime内の新規plan作成証拠ではない。実資格・provider・承認・Executor・外部作用は使っていない。E03.03=`BUILD_GAP`を維持する。次はOperation Plan単位のrestore review preflightとverified backup scopeの結合を現行正本・コードから照合する。

2026-10-19の`QEB-03-E03.03-RECOVERY-PLAN-RESIDUAL-ISOLATION`では、同じOperation Plan inventory内の旧`held_unverified` planとfresh planを別digest scopeで投影し、合成fixture内の旧plan revision残差を旧planだけへ限定できることを確認した。fresh planは`observed`のまま、hold・復旧権限・実行は変化しない。対象Gateway testとtypecheck/buildはPASS。全file実行では既存Cron復旧testが既定5秒を5.157秒超過したため、全件PASSとは扱わない。E03.03=`BUILD_GAP`を維持する。

2026-10-19の`QEB-03-E03.03-FRESH-PLAN-AFTER-RECOVERY-HOLD`では、起動時に`held_unverified`となったplanを保持したまま、新しいDeveloper requestから別Operation Planを作り、そのplanのfresh HDS reviewだけがL1承認待ちへ進むことを、合成Gateway processで確認した。固定JSON応答はloopback fixtureから1回だけ返し、外部LLM・資格・外部ネットワークを使わない。review requestにExecutor実行履歴はなく、旧holdと新旧planのSQLite保存を確認した。Gateway focused test 4/4、typecheck、15 workspace buildはPASS。実provider、承認、外部作用は未実施。E03.03=`BUILD_GAP`を維持し、次は両planが並ぶ状態のread-only Recovery inspectionを照合する。

2026-10-19の`QEB-03-E03.03-HOLD-TO-RECOVERY-LEDGER-INSPECTION`では、起動時holdからRecovery台帳inspectionまでの操作者経路を、合成stateの隔離Gateway processと実Control Center browser DOMで確認した。Recovery画面は全体`residuals_present`（document organization checkpoint store unavailable）と、同じplan digestの観測範囲内に依存残差なしを別々に示し、仕事単位の復旧可能性・復元・再開許可ではないと表示する。Evidence画面は同じplan digestのstep選択停止と、新しい依頼から新規計画を作る案内を表示する。Runtime Snapshotは`held_unverified`／scope relation `unknown`を維持し、raw IDやpayloadを露出しない。検査はread-onlyで、hold・権限を変えない。Gateway `recovery_mutation_entry.test.ts`は4/4 PASS。typecheck／15 workspace buildは製品コード変更時にPASS済み、docs:check／repo-health／diff checkもPASS。実restore、owner approval、外部作用は未実施。E03.03=`BUILD_GAP`を維持し、次は既存holdを保持したまま新しい依頼の新規planをHDS reviewへ届ける経路を合成processで確認する。

2026-10-19の`QEB-03-E03.03-CONTROL-CENTER-PLAN-HOLD-PROJECTION`では、起動時hold中の既存planがGatewayの非権威・payload非露出`operation_plan_status` projectionへ残り、実HTTPのControl Center pageがrendererと安全な次操作を提供することを合成processで確認した。既存接続に欠落はなく、focused recovery process test 4件とtypecheckはPASS。HTML配信とAPI projectionの証拠であり、browser DOM実行・実restore・owner approvalではない。E03.03=`BUILD_GAP`を維持する。次はread-only Recovery ledger inspectionへの案内経路を確認する。

2026-10-19の`QEB-03-E03.03-STARTUP-HOLD-DEVELOPER-REFUSAL-DELIVERY`では、起動時の`held_unverified` planに対するHDS拒否をDeveloperのWebChat WebSocketへ送り、拒否理由とControl Centerで復旧状態を読み取り確認する次の操作を表示した。状態確認後に続ける場合は新しい依頼から新規計画を作り、hold中のplan reviewは再試行しない案内を付けた。commandとexecutor履歴は生じず、拒否配送は合成履歴／実Gateway processのfixtureで`WIRED`。focused test 4件、typecheck、15 workspace build、serve smoke、docs／repo-health gateはPASS。ブラウザ描画・実restore・owner approvalは未実施。E03.03=`BUILD_GAP`を維持する。次はControl CenterのRecovery／Operation Plan投影で操作者がhold状態を読み取り確認する画面consumerを検証する。

2026-10-19の`QEB-03-E03.03-STARTUP-HOLD-DEVELOPER-PLAN-REVIEW`では、認証済みWebChat Developer Operator経由の`plan:review`が、起動時に`held_unverified`となった既存planをHDS内で拒否し、command／Executor実行を作らないことを合成Gateway processで確認した。この経路は`WIRED`、E03.03全体は`BUILD_GAP`。実canonical restore、実owner approval、実作用は未実施。次は安全な拒否結果をDeveloper UIへ届ける出力経路を接続する。

2026-10-19の`QEB-03-E03.03-COMPLETE-HISTORY-STARTUP-HOLD-PROCESS-RESTART`では、file-backed Complete Historyの合成restore失敗記録から、Gateway起動時に既存Operation Planをholdする実process経路を確認した。holdはSQLiteへdigest限定で保存され、履歴記録を空にして別processを再起動した後も維持された。これは起動時の保留とprocess再起動のfixture証拠であり、実restore／owner approval／job再開ではない。E03.03=`BUILD_GAP`を維持する。

2026-10-19の`QEB-03-E03.03-JM-RESTORE-HOLD-CLOSED-STORE-RESTART`では、J/M receiptとRecovery startup evidenceを含むOperationPlan holdの回帰testを追加した。J state DBとJ/M memory DBを閉じて開き直し、同一checkpoint・receiptからholdを再構成し、旧selection拒否とfresh HDS review後だけのhold解除を確認した。既存のserve startup→evidence converter→HDS constructor→永続hold接続にコード欠落は見つからなかった。Gateway result reconciliation test file 33件、typecheck、15 workspace build、serve smokeはPASS。OS process restartや実restoreではなくfixtureによる再open検証であり、E03.03=`BUILD_GAP`を維持する。

2026-10-19のQEB-03-E03.03-RESTORE-SCOPE-RELATION-OPERATOR-PROJECTIONでは、HDS recovery holdのrequested／collateral／unknown関係をGatewayの固定投影経由でControl Centerへ表示した。指定計画と同一selected store内の巻き添え計画をdigest限定で区別し、欠落時は関係未確認とする。投影は非権威で、hold解除・実行・plan単位復元を示さない。101 focused tests、typecheck、build、HDS standalone、serve smoke、docs check、repo-healthはPASS。実restore、実approval、実restartは未実施。E03.03=BUILD_GAP、C08.03 provider保留、P13=PENDING_OWNER_GOを維持する。

2026-10-19の`QEB-03-E03.03-JM-RESTORE-QUIESCE-REOPEN-HDS-HOLD`では、J/M selected-store restoreのL3後にGatewayをmaintenance holdへ入れ、既存仕事を排出してHDS J/M接続を閉じる実経路を接続した。完全で安定した履歴、command／backup／restored-state digest、選択store、verified ledger／残差0が一致した後だけ再openする。既存OperationPlanは復元前にdigest限定の`held_unverified`へ永続化し、cleanなJ/M store integrityでも解除しない。41 focused tests、typecheck、15 workspace build、HDS standalone、serve smokeを確認した。実restore／owner approval／restart、cross-store atomicity、job単位restore pointは未成立で、E03.03=`BUILD_GAP`を維持する。

2026-10-19の`QEB-03-E03.03-JM-RESTORE-PLAN-DEPENDENCY-REVIEW`では、J/M restore後の各既存計画について、保存済みJ control lifecycle、M receipt、result recordが同じcommitへ対応するかread-onlyで照合し、条件を満たした場合だけfresh HDS review時に該当holdを解除する経路を接続した。未確定binding、古いrestore観測、別理由のholdは解除せず、新しいstep bindingを必要とする。J/M結果がない未実行計画は依存なしと確認してreviewへ戻す。71 focused tests、typecheck、15 workspace build、HDS standalone、serve smokeを確認した。実restore／実restart、cross-store atomicity、job単位restore pointは未成立で、E03.03=`BUILD_GAP`を維持する。

2026-10-19の`QEB-03-E03.03-RECOVERY-JOB-SCOPE-CONSUMER-AUDIT`では、Operation Planの`plan_id`がstep／commandを通じてBroker、M、Cron handoffとbackup dependency inventoryを結ぶ現行のplan範囲identityであることを確認した。汎用`task_id/run_id`はoptional contractに留まり、各機能のtask/event IDは相互のjob identityではない。Recoveryのexact-scope applicabilityはread-only表示で、L3 restore要求はbackup ID／store keyだけを束縛し、selected canonical SQLite store全体を復元する。snapshot間atomicityもない。後続のBUILD_BATCHで既存plan digestをcanonical `operation_plans` restoreのL3要求・実行直前照合へ結んだ。さらにpost-action evidenceまでscope digestを渡し、HDS holdにrequested／collateral関係をdigest限定で残す。これはselected-store復元のscope bindingであり、job単位DB復元を意味しない。E03.03=`BUILD_GAP`、C08.03 provider保留、P13=`PENDING_OWNER_GO`を維持する。

2026-10-19の`QEB-03-E03.03-INPROCESS-RESTORE-PLAN-DEPENDENCY-EVIDENCE`では、同一serve process内の成功restoreを完全history・expected command・opaque backup digest・再読込checkpointへ照合し、既存read-only dependency inspectionをHDSの計画別holdへ接続した。残差／未観測／未確認は各planを選択停止し、history・store・checkpointの不一致時はgateを維持する。clean evidenceも通常HDS reviewに留まり、実行・Approval・resumeを生成しない。3 files／26 focused tests、typecheck、15 workspace build、HDS standalone、serve smokeを確認した。実restoreや実restart、独立restore point、store間atomicityは未実証でありE03.03／QEB-03=`BUILD_GAP`を維持する。

2026-10-19の`QEB-03-E03.03-PLAN-RESIDUAL-ISOLATION-CONSUMER-AUDIT`では、計画別残差／未観測依存を実行や復旧再開のために読むruntime consumerがまだないことを確認した。Recovery post-action observationはRecovery snapshot／Control Centerのread-only表示にとどまり、startupの保存結果／M receipt調停やOperationPlanの承認resumeはこの投影を消費しない。HDSの計画step再確認・選択との接続は、残差を再開可否へ反映する契約が未成立のため`BUILD_GAP`。E03.03／QEB-03の状態、非権威診断、owner GOの独立境界を維持する。

続く`QEB-03-E03.03-PLAN-RESTORE-HDS-SELECTION-GUARD`では、起動時のRecovery observationをHDSの既存plan-step reviewへdigest限定で接続した。復元済みplanの残差・未観測・欠落依存・checkpoint競合はHDS内で該当planのstep選択を止め、scopeが未確認なら起動時の既存planをholdする。復元後に完全backup inventoryに存在しないと確認できた後発planはholdしない。clean observationはApproval、Broker、resume、外部作用を許可しない。Control Centerへ固定理由を表示し、合成検証は通過したが実restore／実再起動は未実施。独立restore point、job復帰、Recovery後の実結果照合は未接続のためE03.03／QEB-03=`BUILD_GAP`を維持する。

## 現行のQE工程

| 工程 | 主な目的 | 状態 |
|---|---|---|
| QE_DESIGN | C/J/M、作用・記憶・外殻の全体設計 | 設計と現在コードの残差あり |
| QE_BUILD | 一気通貫の全体系を先行実装 | 上記の計画・結果・作用基盤に、受領済みfile.search観測の限定C射影、J表示前引用照合、意味更新案v2のtarget record/version照合、単一宛先Gmail作用と結果不明のJ配送、J計画revision/statusの既存Control Center表示、合成loopback receiptのdigest-only非権威観測を接続。Developer HTTPからの合成runtime照合をbuild済みGateway smokeで確認し、Gmail送信承認では明示的な内容確認とpending command digest結合をBLUE WebChatに追加。WebChat接続成立時の認証済みRuntime Snapshot再取得と、chat socket／Gateway状態の表示分離も実装。2026-10-18にCron scheduleの安定event identity、private cursor、同一source直列consumerを部分接続し、schedule変更を同一commandのL3 final-review評価へ結合、永続storeを検証してからCronへ有効化する境界を部分接続。起動時の保存済み結果／M receipt照合が未解決なら通常inbound／Cron起動を止める障壁も部分接続。同日、常駐serve／CLIに同一state rootのSQLite process-exclusive owner lease、永続boot generation／execution epoch、Executorの承認・dispatch・receipt fenceを追加し、別processの二重ownerを限定fixtureで拒否。J/M/Broker ledgerとJ OperationPlan bindingをdigest-onlyで照合するread-only `--recovery-inspect` CLIも部分接続した。未決Cron eventとjob resultのread-only相関表示は部分接続、Recovery restore/reset要求のHDS L3 owner review経路と結果投影、およびoperation／result digestに結び付くRecovery後のread-only設定再観測も接続済み。canonical archiveの適用・独立restore point・job identity、相関に基づくevent解消／復旧、Windows ACL検査、実行中に渡した外部作用のfencing、network filesystem、approval lifecycleの再起動時照合、実provider receipt照会、D4Pocket画面接続、prior version、一般意味採用、全体系は未接続 |
| SYSTEM_SHAPED | 試験仕事が目的→結果→M→復帰まで通る | 全体成立未確認 |
| BUILD_COVERED | 全機能群の結合形状を確認 | 未成立 |
| QE_QC | 実物の全体検査・欠陥・原因・改善・再検査 | 未着手 |
| QE_QA | QC証拠から対象別・OS別・版別保証 | 未着手 |
| QE_RELEASE_REVIEW | ownerによる独立公開・出荷判断 | 未着手 |

2026-10-18のQEB-03-E03.03-CRON-READONLY-RECOVERY-INSPECTIONでは、Cronのinbox／outbox／approval-handoff台帳をruntime store初期化なしのread-only検査として`--recovery-inspect`、Recovery Operator、Control Centerへ接続した。検査は最大10,000行単位で検証済み／不整合／孤立／未決／省略件数だけを示し、行識別子・payload・command／request参照を返さない。Cron状態が欠損・未確認・未決の場合は統合replay checkpointをverifiedにしない。復旧・repair・resumeや独立restore pointには接続せず、E03.03は`BUILD_GAP`を維持する。

2026-10-18の`QEB-03-E03.03-PER-STORE-SNAPSHOT-STATUS-PROJECTION`では、read-only Recovery Backup inspectionからcanonical snapshotの5台帳statusを固定順・固定enumに限ってControl Centerへ接続した。Control Centerは各statusと集約件数・coverageの整合を再検査し、不整合・invalid boundaryでは台帳別statusを表示しない。投影は非権威で復元操作を行わず、store間atomicityやrestore pointを証明しない。E03.03／QEB-03は`BUILD_GAP`を維持する。

2026-10-18の`QEB-03-E03.03-OPERATOR-PER-STORE-STATUS-READABILITY`では、検証済みstatusをControl Centerの5つの固定行へ日本語ラベルで表示する。invalid／未確認時は全行を「未確認」、canonical snapshotが含まれない場合は「このbackupに未収録」とし、backup時の台帳不存在と区別する。statusはarchive検査結果であり、generic Restoreはcanonical stateを適用しない。E03.03／QEB-03は`BUILD_GAP`。

2026-10-18の`QEB-03-E03.03-RECOVERY-L3-MUTATION-BOUNDARY`時点では、HDS L3最終審査の接続がないRecovery Restore／reset HTTP操作を403でfail-closedにし、Control Centerでも実行不可と表示した。HDSの最終審査operation listにはRecovery変更を追加し、full-access grantでもL3を迂回しない状態まで接続した。後続の`RECOVERY-HDS-L3-MUTATION-PATH`でowner承認・監査・実行経路を接続済み。canonical archive適用など残る未接続範囲があるためE03.03／QEB-03は`BUILD_GAP`。

2026-10-18の`QEB-03-E03.03-RECOVERY-HDS-L3-MUTATION-PATH`では、Recovery restore／provider reset／connector reset／factory resetをoperation catalogとHDS tool processへ接続し、固定tool名でhigh-risk／L3／askとなる経路を追加した。認証済みowner resumeと単回tokenの後にだけExecutorが作用し、再利用grantやrequest bodyのactor申告では承認を代替できない。restore対象backup IDを要求時点で固定し、Approval queueとControl Centerへ表示する。合成Gateway processで、承認待ち中のstate不変、owner resume後の一時env reset、token再利用拒否を確認した。canonical SQLite snapshotはgeneric Restoreから適用されず、仕事identity・独立restore point・実state復旧は未接続。E03.03／QEB-03は`BUILD_GAP`。

2026-10-18の`QEB-03-E03.03-RECOVERY-POST-ACTION-REOBSERVATION`では、HDS complete-historyのexecution／final-outputをcommand ID・operation digest・result digestで照合し、現在のenv fileとGateway processの固定状態を読み取り再観測する。履歴欠落、chain不整合、digest不一致、restore範囲、工場リセット全体は未確認として表示し、secret値・pathを投影せず、承認や実行へ使わない。provider／connectorの設定状態が確認できても、Recovery／E03.03全体は未成立で`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.02-CRON-NO-REPLAY-OWNER-RESOLUTIONでは、未決Cron eventの正確なevent ID／payload digestに結び付いたL3の「再実行しない」判断をDaily操作として接続した。HDSの永続hash-chain監査で同一command／requestのL3要求と人間承認を検証し、Cron cursorは同じeventの判断が再起動後も検証できた場合に限り次eventを許可する。処理中、stale／重複、監査検証不能はfail-closed。元の結果は`outcome_unknown`のまま保持し、再送・結果成功の推定・M更新はしない。durable job lifecycleと実外部結果の照合を含むE03.02／E01.01全体は`BUILD_GAP`。

2026-10-18のQEB-03-E03.02-CRON-FAILURE-OUTCOME-PROPAGATIONでは、共有InboundRouterが捕捉していたhandler例外をCron channelに限ってschedulerへ返し、永続event cursorへ`outcome_unknown`として記録する経路を接続した。後続source eventはownerの明示したno-replay判断までblockedのまま。その他channelの例外封じ込めは維持し、`handler_returned`を外部作用成功とは扱わない。pending approvalを含むdurable job lifecycle、実外部receipt照合は引き続き`BUILD_GAP`。

2026-10-18のQEB-03-E04.01-CONDITIONED-FAILURE-GATEでは、Gateway command failureからHDS-BRAIN failure memory、次の実行前gateまでを接続した。署名にはgoal・action／target・actor/channel・症状のdigestを分離して保持し、原因分類は候補、原因と予測差は未確認として記録する。異なるtarget／goalや旧request IDで誤照合しないfixtureを追加。raw error・goal・argumentsは新規failure signatureへ保存しない。既存failure-memory-v2は読み込み互換を保つが、条件patternを持たない旧command signatureは新gateで適用しない。予測差を供給するproducerとJの原因・反対仮説採否は未接続のため、E04.01／QEB-03は`BUILD_GAP`。

2026-10-18のQEB-03-E04.02-FAILURE-CAUSE-REVIEWでは、明示したDeveloper要求から保存済みfailure signatureのカテゴリ・allowlist unknown・パターンdigestだけをGatewayが射影し、HDS-issued C computeと署名／projection結合済みJ reviewへ接続した。Cの候補本文は形状・結合確認後に未検証候補としてDeveloperへ表示し、HDS auditには内容でなく各候補のdigestを記録する。Cのscope判断は提案として残し、Jは常に独立観測まで保留する。raw failure patternを渡さず、fallback provider authorization、memory更新、failure gate変更、retry、OperationPlan保持、外部作用へ接続しない。protocol／HDS／Gateway／Compute focused tests、workspace typecheck/buildを確認した。意味に基づく原因確定・独立観測の取得／採否・Memory反映・条件変化後の限定再試行は未接続で、E04.02／QEB-03は`BUILD_GAP`を維持する。

2026-10-18にCronの未決dispatch状態を、event ID・sequence・delivery state・payload digest・時刻に限ったread-only通知として認証済みWebChatへ接続した。通知は外部結果の成功を断定せず、再送・解除・承認を行わない。再起動後の未決作用照合・復旧は未接続であり、E01.01／E03.02／QEB-03は`BUILD_GAP`。

2026-10-18のQEB-03-E03.02-CRON-RESULT-CORRELATION-INSPECTIONでは、未決Cron eventのrequest IDをHDS OperationPlan projectionのrequest IDへ完全一致で照合し、result delivery digestとJ/M receipt状態を固定enumだけで認証済みresident notificationへ表示する。planなし、bindingなし、曖昧、実行未解決、保存result欠落を区別する。表示は非権威・read-onlyで、cursor・HDS・Mを変更せず、eventを解消せず、再送・権限・外部作用・外部成功判定を行わない。E03.02／E01.01のdurable job lifecycle、未決作用の照合に基づく解消・回復は`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.02-STARTUP-RECONCILIATION-BARRIERでは、Gatewayが起動時に既存Execution result outboxとM pendingを再照合し、未解決receiptが残る場合は通常inbound／Cron開始前に停止する経路を接続した。これはE03.02の部分実装であり、単一writer／boot generation／fencing、旧世代結果の分離、result相関に基づくCron event解消、回復operator UIは未成立。read-onlyのresult相関表示を加えたが、E03.02／QEB-03は`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.02-OLD-GENERATION-RESULT-ARCHIVEでは、Gateway startup／実行後にcurrent execution epochと一致するreceiptだけをHDS J/Mへ配送する。旧世代receiptはJ結果consumerを呼ばず、private ExecutionIntentにstale-generation dispositionとarchive世代digestを記録してpendingから外す。snapshotにはdigest／dispositionだけを投影し、保管に失敗した場合はstartup readinessを拒否する。限定3-file／35-testと追加focused確認、typecheck、workspace build、docs gateが通った。未決Cron eventとjob resultのread-only相関表示までは接続したが、その証拠に基づくevent lifecycle reconciliation、未決結果のoperator recovery UI、旧processまたは既にadapterへ渡した作用の停止は未成立のためE03.02／QEB-03=`BUILD_GAP`を維持する。

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

2026-10-18の`QEB-03-E03.03-INBOUND-REQUEST-RECOVERY-SCOPE`では、Operation Planの`operation-request:<InboundRequest.id>`と検証済み文書整理checkpointの同じInboundRequest.idを、checkpoint保存キーと共通のchannel／actor digestも含むdomain-separated `request_scope_digest`でread-only復旧検査へ結んだ。Gateway/operator report、CLI、Control Centerへdigestのみを表示し、identity不一致や破損行は未リンクで残す。これはrequest範囲の診断相関で、task/job復旧権限やrestore pointではない。独立restore pointとguarded selective recoveryが未接続のためE03.03は`BUILD_GAP`。

2026-10-18の`QEB-03-E03.03-REQUEST-SCOPE-RESIDUAL-SEPARATION`では、Operation Plan dependency scopeと検証済み文書整理checkpointを`request_scope_digest`単位でoperator projection・CLI・Control Centerへ集約した。両台帳一致、片側のみ、相手範囲未解決を分け、残差と未完了checkpointをscope内で数える。相手台帳に未リンク行や省略があれば片側のみと断定せず、不完全inventoryの未リンク件数はunknownとして返す。壊れたcheckpointにscopeを付けず、Control Centerは受信集約を独立再計算して不一致を拒否する。Gateway/WebChat 94 focused tests、typecheck、15 workspace build、分離root CLI smoke、Control Center script構文、docs/repo-health gatesを確認した。read-only診断でありjob identity、restore point、復旧操作・権限は生成しない。独立restore point、store間atomicity、guarded selective recoveryが未接続のためE03.03=`BUILD_GAP`を維持する。

2026-10-18の`QEB-03-E03.03-SNAPSHOT-CAPTURE-CHANGE-DETECTION`では、canonical state 5台帳の独立snapshot取得前後にread-only `PRAGMA data_version`とBigInt精度のsource file identityを照合する。取得途中のcommitまたはsource差異があれば、保存したarchiveを全て除去し、存在する台帳を`snapshot_failed`へ閉じる。合成競合試験と分離root `--recovery-inspect` smokeを確認した。これは途中変更検知でありstore間atomicity、restore point、復旧可能性を証明しない。`cross_store_atomic=false`、E03.03=`BUILD_GAP`を維持する。

## 旧RCのP13と日本語基底J系列

旧v1.0 RCのP1–P12とP13は独立した出荷履歴・境界。version=1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。必要な実機、GA、release bundle、strict日本語基底とowner GOの条件は維持し、旧RCの局所PASSを新AGI構成の品質へ転用しない。

J0は日本語基底規定成立として完了。J1（活正文書）、J2（UI/installer）、J3（コード散文）、J4（strict closure）は未承認・未着手。J0通常gateの成功をJ4の証明にしない。

## 正本

AGENTS.mdがQE方法と保護、docs/作業標準要領.mdが運用、docs/IMPLEMENTATION_INSTRUCTIONS.mdが限定task、docs/開発進捗.mdが観測済み履歴、docs/STRATEGY_FRAME.mdが競合と外殻の戦略、docs/PRODUCT_ROADMAP.mdが旧v1 RCのrelease境界を扱う。現在のowner開発委任と内部正本の再照合に基づきQE_BUILDを継続する。

2026-10-18のQEB-03-E03.03-OPERATOR-PLAN-DEPENDENCY-SCOPE-READABILITYで、現行のread-only Recovery Inspectionに含まれるOperation Plan依存scopeをControl Centerへ固定日本語で表示した。verified boundaryでは短縮digest・状態・依存分類と件数を示し、不正・未検証時は全scopeを抑止する。これは現行台帳の診断表示であり、job identity、backup restore point、recoverability、実復元・再開を成立させない。E03.03／QEB-03は引き続き`BUILD_GAP`。

2026-10-18のQEB-03-E03.03-BACKUP-PLAN-SCOPE-RESIDUAL-INSPECTIONで、検査済みcanonical snapshot内のOperation Plan J台帳を既存のread-only recovery inspectorへ接続した。plan/request scope digestと固定残差状態・件数だけをControl Centerへ表示し、archive digestを検査後も再照合する。これはbackup内Jの診断で、他台帳との相関、atomic restore point、task/job identity、復元・再開許可は成立させない。E03.03／QEB-03=`BUILD_GAP`を維持する。

2026-10-18のQEB-03-E03.03-ARCHIVED-PLAN-DEPENDENCY-CORRELATIONで、検証済みbackupのJ-control／M／Broker／Operation Plan／Cron archiveを既存read-only相関へ接続し、Control Centerに計画digest別の残差・未観測依存を表示した。未検証ledgerは相関に使わず、独立取得したstore snapshot間のatomicity、restore point、job identity、復元・repair・resume許可は成立させない。Gateway／WebChat focused tests 3 files／100 tests、typecheck、15 workspace build、docs／repo-health gateを確認した。E03.03／QEB-03=`BUILD_GAP`を維持する。
