# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0、工程表SHA-256=7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77、Codex施工指示SHA-256=D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8）、適用AGENTS.md、作業標準要領、現物、active対象要求を今回も再読した。今回開始HEAD／origin/main=ccb6342d26efe3f720b746086d1e71282d8aa327、worktree clean。編集前local復旧branchとlocal／remote backup tagは現世代=ccb6342d26efe3f720b746086d1e71282d8aa327、前世代=340f96b04717d54d7f4ed4c81da11526d09798a8で一致。復旧ref移行状態=MIGRATION_COMPLETE。ownerの開発続行指示を維持し、C08.03実provider試験保留、別repo変更・実業務作用・公開行為・出荷判断は対象外とする。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-PER-STORE-SNAPSHOT-STATUS-PROJECTION`。関係単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`ccb6342d26efe3f720b746086d1e71282d8aa327`、worktree clean。編集前local recovery branch二世代とremote backup tag二世代を現世代=`ccb6342d26efe3f720b746086d1e71282d8aa327`、前世代=`340f96b04717d54d7f4edc81da11526d09798a8`へ回転し、local／remoteの各SHAを照合した。

目的は、既存のread-only Recovery Backup検査が集約件数だけでなく、検証済みcanonical snapshot manifestから5台帳の個別statusをControl Centerへ接続すること。投影は固定`store_key`と固定status enumだけとし、raw ID、行内容、path、archive digestは出さない。manifest／archive検査が不成立ならmanifest由来の行を表示せず、個別statusと集約件数が一致しなければControl Center boundaryをinvalidにする。

対象は`RecoveryBackupInspection`、既存`inspectBackup` consumerとControl Centerの受信検証・表示、合成manifestの通常／欠損／未確認／改ざん境界確認。対象外はarchive適用、実state restore、job identity・recoverability・restore point判定、store間atomicity、権限変更、C08.03 live/provider、別repo、実業務作用、公開・出荷判断。`canonical_state_cross_store_atomic=false`、`used_for_authority=false`、`may_execute=false`を維持する。

最小確認は、5台帳の固定status表示、manifest coverage件数との整合、未知・重複・欠落statusの拒否、invalid backupからの個別情報抑止、合成testでのsource/archive非変更。変更したrecovery surface／WebChat tests、`pnpm typecheck`→`pnpm build`、Recovery operator疎通、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実施する。全suite、実state復旧、credential/live/provider、5OS実機、QE_QC／QE_QAは対象外。

## 今回の実績

既存のread-only Recovery Backup inspectionがcanonical snapshot manifestの5台帳statusを固定順・固定enumだけで返し、Control Centerは受信status・集約件数・coverageの相互整合を再検査するよう接続した。`not_found`／invalid inspectionでは台帳別statusを空にし、Control Centerもverified boundary以外のstatus行を表示しない。raw ID、行内容、path、archive digestは投影しない。`cross_store_atomic=false`、`used_for_authority=false`、`may_execute=false`は維持した。

| 限定確認 | 結果 |
|---|---|
| Gateway recovery surface／WebChat focused tests | PASS、2 files／90 tests。5台帳verified／not-present／partial status、固定順・enum検証、集約件数不一致時の`invalid_report`化とstatus行抑止を確認。 |
| `pnpm typecheck`→`pnpm build` | 両方PASS。Gateway／WebChatを含むworkspace build完了。 |
| `pnpm docs:check` | PASS。日本語基底の既存移行負債76件。 |
| `pnpm validate:repo-health`／`git diff --check` | 両方PASS。 |
| 全suite、実state restore、credential/live/provider、5OS実機、QE_QC／QE_QA | 未実施。 |

Recovery Backup inspectionのread-only per-store投影を接続した部分実装であり、独立restore point、実state復元、store間atomicity、復旧可能性は証明しない。E03.03／QEB-03=`BUILD_GAP`、C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。別repo、実業務作用、公開・出荷判断は行っていない。

## 前回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-SNAPSHOT-CAPTURE-CHANGE-DETECTION`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。開始HEAD／`origin/main`=`340f96b04717d54d7f4ed4c81da11526d09798a8`、worktree clean。編集前local recovery branch二世代とremote backup tag二世代を現世代=`340f96b04717d54d7f4ed4c81da11526d09798a8`、前世代=`be85af9f76fe45023954609587a2d49d6fa6a8f4`へ回転し、期待SHA・remote実値を照合した。

目的は、canonical recovery snapshotを5台帳から個別取得する途中でsource DBにcommitがあった場合、異なる時点の混在を成功済みsnapshotとして保存しないこと。各sourceの`PRAGMA data_version`を同一観測connection上で取得前後比較し、いずれかが取得期間中に変わったら保存済みarchiveを除去して全captureを`snapshot_failed`へ閉じる。変化を検出しない場合も`cross_store_atomic=false`は維持し、store間transaction atomicityや復旧可能性は主張しない。

対象は`canonical_state_backup.ts`のread-only source change observation、既存manifest／backup inspectionへの接続、合成5台帳SQLiteでの取得中commit検知・archive非残存・source DB不変確認。observerを開けないstoreはそのstoreを未確認扱いにし、欠損・不整合を補完しない。対象外はstore間write barrier、canonical restore・selective recovery実行、restore pointやjob identityへの昇格、権限変更、実外部作用、C08.03 live/provider、別repo、公開・出荷判断。`used_for_authority=false`、`may_execute=false`、`canonical_state_cross_store_atomic=false`を維持する。

最小確認は、source versionが不変の場合の既存5-store snapshot検査、copy開始後の別台帳commitを検出して全archiveを消すこと、snapshot後のinspectionが全store未確認として表示すること、read-only observerがsource bytesや状態を変更しないこと。対象test、`pnpm typecheck`→`pnpm build`、recovery surface smoke、必要なdocs/repo-health gate、`git diff --check`を実行する。全suite、実restore、credential/live/provider、5OS実機、QE_QC／QE_QAは対象外。

## 前回の実績

取得開始前に5台帳の読取専用観測connectionを開き、各`data_version`とBigInt精度のsource file identityを前後比較する。1台帳のcommitまたはsource file差異を検出した場合、保存済みarchiveを全て除去し、存在していた各台帳を`snapshot_failed`へ閉じる。通常取得は5台帳全てverifiedを保ち、合成commit競合では0 archive・5台帳未確認となることを確認した。`cross_store_atomic=false`は変更していない。

| 限定確認 | 結果 |
|---|---|
| `apps/gateway/test/recovery_surface.test.ts` | PASS、12 tests。通常5台帳snapshotと取得中commit検知、archive全破棄、inspectionの未確認表示、sourceの状態不変を確認。 |
| `pnpm typecheck`→`pnpm build` | PASS。15 workspace projects。 |
| build後の分離root `--recovery-inspect --json` smoke | PASS。期待exit 2、unavailableを表示しstate rootを作成しない。 |
| `pnpm docs:check` | PASS。docs check／licensing PASS、日本語基底監査PASS、移行負債76件（既存）。 |
| `pnpm validate:repo-health`／`git diff --check` | 両方PASS。 |
| 全suite、実state復旧、credential/live/provider、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03=`BUILD_GAP`を維持する。source変更を検出しない結果もstore間atomic snapshotやrestore pointの証明ではない。C08.03実provider試験は保留し、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、別repo・実業務作用・公開・出荷判断の境界を維持する。

## それ以前のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-REQUEST-SCOPE-RESIDUAL-SEPARATION`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。開始HEAD／`origin/main`=`be85af9f76fe45023954609587a2d49d6fa6a8f4`、開始worktree clean。編集前local復旧branch二世代とremote backup tag二世代を現世代=`be85af9f76fe45023954609587a2d49d6fa6a8f4`、前世代=`32b8a67c7a141b72dd56ebd18a120fbf569df6e5`へ回転・照合した。

目的は、前バッチで検証済みInboundRequest単位のdigest相関を、Recoveryの次の通常consumerである操作者の破損範囲把握へ接続すること。Operation Plan依存scopeと文書整理checkpointを同じ`request_scope_digest`単位で集約し、両台帳に現れた範囲、片側のみの範囲、残差依存、identityを安全に結べず未リンクの件数をread-onlyで表示する。これはrequest範囲の診断であり、仕事/job identity、復旧可能性、restore point、権限やresume許可を意味しない。

対象はGateway operator projectionのrequest-scope集約、Control Centerでの固定digest／件数／enum表示と検査、`--recovery-inspect` CLI表示、合成fixtureによる同一scope集約・他scope非波及・未リンク残差・raw ID非露出の確認。破損したcheckpointへscopeを推定付与せず、未検証／不整合なprojectionはboundary invalidにする。対象外はcanonical backup作成・復元、store間barrier、仕事単位selective recovery実行、repair／resume、Approval／HDS／Broker権限変更、外部作用、C08.03 live/provider、別repo、公開・出荷判断。`external_backup_restore_point="not_examined"`、`used_for_authority=false`、`may_execute=false`を維持する。

最小確認は、二つ以上のrequest scopeを集約し、一方のplan residualが他方へ波及しないこと、plan-only／checkpoint-only／両台帳の関係とunlinked件数が正しく出ること、raw ID・actor・source・payloadが出ないこと、壊れたcheckpointをscopeへ結ばないこと、改ざん／不整合な集約をoperator projectionとControl Centerが拒否すること。対象test、`pnpm typecheck`→`pnpm build`、Control Center script構文、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## 今回の実績

Gateway operator projection schema v8で、Operation Plan dependency scopeと検証済み文書整理checkpointを`request_scope_digest`ごとに集約した。両台帳一致・plan-only・checkpoint-only・相手範囲未解決を分け、plan残差と未完了checkpoint件数をscope内に保つ。相手台帳の未完・省略・未リンク行がある場合は片側のみと断定せず`counterpart_unresolved`とし、inventory不完全時の未リンク総数は`null`で返す。scopeは診断専用で、壊れたcheckpointにscopeを割り当てない。CLIとControl Centerへ固定digest・enum・件数のみを接続し、Control Centerは集約を再計算してprojectionと一致しなければ全体境界を無効にする。復旧操作・job identity・restore point・権限は生成しない。

| 限定確認 | 結果 |
|---|---|
| Gateway recovery inspection／WebChat focused tests | PASS、2 files／94 tests。scope間の残差非波及、両台帳／片側／未解決分類、未リンク行による誤断定防止、不完全inventoryのnull件数、破損checkpoint拒否、API projectionを確認。 |
| `pnpm typecheck`→`pnpm build` | 両方PASS。buildは15 workspace projects。 |
| build後Control Center script構文 | PASS。 |
| 分離root `--recovery-inspect` text smoke | 期待どおりexit 2。unavailableを表示し、scopeは未確認件数を`unavailable`と表示。state／file rootを新規作成しない。 |
| `pnpm docs:check`／`pnpm validate:repo-health`／`git diff --check` | すべてPASS。日本語基底の既存移行負債76件。 |
| 全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03は`BUILD_GAP`を維持する。独立restore point、store間atomicity、guarded selective recoveryの実行は未接続。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

## 前回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-INBOUND-REQUEST-RECOVERY-SCOPE`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。開始HEAD／`origin/main`=`32b8a67c7a141b72dd56ebd18a120fbf569df6e5`、開始worktree clean。編集前にlocal復旧branch二世代とremote backup tag二世代を現世代=`32b8a67c7a141b72dd56ebd18a120fbf569df6e5`、前世代=`e7c1528c10934ced7b0d082a8ea9b4991f14db30`へ回転・照合した。

目的は、実装上で同一と確認できるInboundRequest.idをOperation Planと文書整理checkpointの読取専用復旧検査へ接続すること。Operation Planは`operation-request:<InboundRequest.id>`、文書整理checkpointは`InboundRequest.id`を含むtask/request identityを保存する。raw IDではなく、保存キーと共通のchannel／actor digestも含めたドメイン分離`request_scope_digest`で両consumerを結び、Operation PlanのBroker／delivery／M／Cron依存とcheckpoint状態を同じrequest範囲として操作者が照合できるようにする。

対象は、両producerのidentity変換の厳密な検査、Operation Plan summary／dependency scopeとdocument checkpoint recordへのdigest-only相関、Gateway/operator projectionと`--recovery-inspect`への接続、Control Centerの既存projectionでの表示、synthetic fixtureによる一致・不一致・不正・raw ID非露出の確認。identity形状・整合性が検証できない記録はrequest scopeへ結ばず未分類残差として残す。対象外は永続schema変更、request/task IDの新設、document checkpointと他台帳の未確認相関、restore point判定・restore／resume・Approval／HDS／権限変更、外部作用、C08.03 live/provider、別repo、公開・出荷判断。`request_scope_digest`は診断相関専用で、task/job identity・recoverability・権限を意味しない。`used_for_authority=false`、`may_execute=false`、`external_backup_restore_point="not_examined"`を維持する。

最小確認は、同一InboundRequest.idからOperation Plan／文書checkpointに同じdigestが出ること、prefix不一致・構造不正・checkpoint integrity不一致を誤相関しないこと、投影・CLI・Control Centerにraw request/task IDが出ないこと、読取検査でstore bytesが変わらないこと。対象test、`pnpm typecheck`→`pnpm build`、Control Center script構文、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## 前回の実績

共有utilityでcheckpoint storeと同じchannel／actor digestを計算し、`blue-tanuki.inbound-request-scope.v1`へInboundRequest.idと共にdomain-separated SHA-256化した。Operation Planの厳密な`operation-request:` prefixと、完全検証済みdocument checkpointのtask/request bindingから同じ`request_scope_digest`を導出した。plan summary／dependency scopeとcheckpoint recordへ通し、Gateway recovery report schema v8、operator projection schema v7、CLI、Control Centerへdigest-onlyで接続した。prefix不一致、計画revision不整合、checkpoint integrity不整合はscopeへ結ばず`null`／unlinkedのままにする。

| 限定確認 | 結果 |
|---|---|
| recovery inspection／Operation Plan／document checkpoint／WebChat Control Center focused tests | PASS、4 files／105 tests。同一InboundRequest.idのdigest一致、未リンク・破損境界、raw ID非露出、checkpoint DB bytes不変を確認。 |
| `pnpm typecheck`／`pnpm build` | 両方PASS。buildは15 workspace projects。 |
| build後Control Center script構文 | PASS、配布scriptをFunction構文解析。 |
| `pnpm docs:check`／`pnpm validate:repo-health`／`git diff --check` | すべてPASS。日本語基底の既存移行負債76件。 |
| 全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QA | 未実施。 |

request scopeはInboundRequest由来の診断相関でありtask/job identity、依存隔離の実操作、復旧可能性、restore point、権限ではない。未検証・壊れた行のscopeは不明のまま。E03.03=`BUILD_GAP`を維持し、独立restore pointとguarded selective recoveryを未接続として残す。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

## それ以前のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-DOCUMENT-ORGANIZATION-CHECKPOINT-INSPECTION`。開始HEAD／`origin/main`=`e7c1528c10934ced7b0d082a8ea9b4991f14db30`、開始worktree clean。編集前のlocal復旧branch／tagおよびremote backup tag二世代を照合済み。

目的は、実際の`document_organization_checkpoints` SQLite保存行を起動・変更せず検査し、保存行単位の完全性statusをdigest-onlyでGateway recovery report、`--recovery-inspect`、operator projection、Control Centerへ接続すること。保存行はchannel／actor digest／source digestで再利用されるため、opaque referenceはtask/job IDと呼ばず、Operation Plan・Broker・M・Cronとの未接続相関を明示する。

対象はFILE_ROOT配下の既存J checkpoint SQLiteのread-only path/schema/integrity/行digest検査、行上限と省略、固定status投影、合成SQLiteでの他行非波及・元bytes不変確認。対象外はcheckpoint/store/schema書込み、job/task IDやrequest IDの新設・変更、Operation Plan等との推定相関、task単位復旧判定、restore point・canonical snapshotへの採用、復旧・resume・Approval／HDS／権限変更、外部作用、C08.03 live/provider、別repo、公開・出荷判断。raw request／task ID、actor、source、payload、path、例外を出さず、`used_for_authority=false`、`may_execute=false`、`external_backup_restore_point="not_examined"`を維持する。

最小確認は、read-only接続・sidecar/schema/SQLite異常のfail-closed、行別digest／JSON整合の分類、上限超過の未観測、無関係行への非波及、元DB bytes不変、CLI／operator projectionの固定enum・件数・digest境界と不正report拒否。続けて対象test、`pnpm typecheck`→`pnpm build`、Control Center script構文、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## それ以前の実績

`inspectDocumentOrganizationCheckpointLedger`を追加し、既存`document_organization_checkpoints`をread-onlyで検査してGateway recovery report schema v7へ接続した。operator projection schema v6、`--recovery-inspect`、Control Centerへdigest-onlyの行別integrity、固定reason/status、集計数を渡す。行上限128、schema／SQLite異常、sidecar、digest／JSON／shape／identity不整合は未確認・残差として閉じ、Control Centerの重複digest・件数不整合・欠落配列も境界不正として拒否する。read-only接続前後のDB bytes不変とmissing rootを作らないことを確認した。

checkpointの永続identityはchannel／actor digest／source digestの再利用キーであり、task/job IDではない。表示用digestからOperation Plan・Broker・M・Cronの相関やtask単位の復旧範囲は導出しない。ソースspanの意味検証、restore point、restore／resume、Approval／HDS／権限、外部作用には接続していない。E03.03=`BUILD_GAP`を維持する。

| 限定確認 | 結果 |
|---|---|
| document checkpoint recovery／Gateway recovery／Operation Plan recovery／WebChat Control Center focused tests | PASS、4 files／104 tests。行上限・省略、schema不一致、digest不整合、重複参照の拒否、raw値非露出、DB bytes不変を確認。 |
| execution result reconciliation focused tests | PASS、1 file／30 tests。built file-search workerが必要なため`pnpm typecheck`→`pnpm build`後に実行。 |
| `pnpm typecheck`→`pnpm build`／build後Control Center script構文 | すべてPASS。15 workspace projects。 |
| `--recovery-inspect`分離root smoke | 期待どおりexit 2、checkpoint ledger unavailable／residualを表示し、state root／file rootを作らない。 |
| `pnpm docs:check`／`pnpm validate:repo-health`／`git diff --check` | PASS。日本語基底の移行負債76件は既存。 |
| 全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QA | 未実施。 |

ownerの実provider試験保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。別repo変更、実外部作用、公開・出荷判断を行っていない。

## 直前のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-OPERATION-PLAN-DEPENDENCY-SCOPING`。開始HEAD／`origin/main`=`e75ea1eb20cb586d189996b400398c7f66b050b9`、開始worktree clean。編集前のlocal復旧branch／tagおよびremote backup tag二世代を照合済み。

目的は、read-only Recovery inspectionでOperation Planごとの記録整合性と既存Broker／delivery／M／Cron approval相関の残差・未観測範囲をdigest単位で束ね、無関係なPlanへ波及させずCLIとControl Centerへ接続すること。現行OperationPlanにtask/job識別子がないため、表示単位はOperation Plan digestに限定する。`observed`は観測範囲内で残差を検出しなかったという診断statusであり、job復旧可能性、restore point、実行許可を意味しない。

対象はOperation Plan read-only inspectorのplan summary、Gateway recovery report／operator projection、CLIとControl Centerの固定status projection、合成ledger回帰確認。対象外はOperationPlan schema、job/task単位の復旧判定、依存隔離の実操作、restore point確認・復元、Approval／HDS／権限変更、store書込み、外部作用、C08.03 live/provider、別repo、公開・出荷判断。上限超過・不整合は未観測またはinvalid reportとして閉じ、raw ID／path／payloadを出さず、`used_for_authority=false`、`may_execute=false`、`external_backup_restore_point="not_examined"`を保つ。

最小確認は、計画間の破損非波及、計画内のbroker／delivery／memory／cron依存残差、行省略のunobserved表示、operator projectionとControl Centerの件数・digest境界、raw identifier非露出を合成fixtureで確認する。続けて対象test、`pnpm typecheck`→`pnpm build`、Control Center script構文、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## 直前の実績

`OperationPlanRecoveryInspection`にdigest-keyed plan summaryとplan別省略binding件数を追加した。Gateway recovery report schema v6／operator projection schema v5は既存のbinding相関からplan別の`observed`／`residuals_present`／`unobserved` scopeを導出し、residual／unobserved dependency categoryを固定enumで返す。CLIとControl Centerへ接続し、projection側でsummary総数・計画別binding件数・相関所属・UI表示件数を照合する。復旧動作やtask/job識別は接続していない。

| 確認 | 結果 |
|---|---|
| Operation Plan recovery inspection／Gateway recovery projection／WebChat Control Center focused tests | PASS、3 files／99 tests。計画別残差隔離、Broker欠損時のDelivery未観測扱い、raw ID非露出、200 binding上限、読み取り専用を確認。 |
| `pnpm typecheck`→`pnpm build` | PASS。順次実行、15 workspace projects。 |
| Control Center script構文確認 | PASS。build後の配布scriptをFunction構文解析。 |
| `pnpm docs:check`／`pnpm validate:repo-health`／`git diff --check` | PASS。日本語基底の既存移行負債76件。 |
| 全suite、credential/live/provider、job復旧・実外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03=`BUILD_GAP`を維持する。Plan digestはjob/task同一性ではなく、独立restore point、job単位の破損依存隔離、guarded selective recoveryも未接続。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

## 直前のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CANONICAL-SQLITE-SNAPSHOT-INSPECTION`。開始HEAD／`origin/main`=`acc1465cb11e5fec7bf18f15656b86ae1d8117db`、開始worktree clean。編集前復旧refはlocal branch／remote tagとも現世代=`acc1465cb11e5fec7bf18f15656b86ae1d8117db`、前世代=`45b0c9363bac3733366641d174a7d560f27d345a`を確認済み。

目的は、独立recovery packにJ/M、Broker、Operation Plan、Cronの5正本SQLiteをstore別online snapshotとして保存し、snapshotごとのSQLite integrity／digestを読み取り検査する実consumerへ接続すること。保存内容は機密扱いとし、公開・通常operator projectionへraw payload、path、行、IDを出さない。DBごとのsnapshotは各DB内で一貫するが、store間の同時点原子性は保証しない。そのためsnapshot検査を横断復旧点、仕事単位の復旧可否、権限、承認、resume許可として扱わない。既存generic Restore経路ではcanonical snapshotを適用しない。

対象はrecovery backup producer、read-only backup inspection、Control Centerの固定status projectionと合成SQLite確認。対象外はSQLite stores/schema、approval/HDS/監査/権限、job単位selective recovery、store間pause/barrier、canonical snapshot restore、外部作用、C08.03 live/provider、別repo、公開・出荷判断。欠損storeは欠損、破損・snapshot失敗は未確認として他storeへ伝播させず、部分coverageを完全なsnapshotと表示しない。

最小確認は合成5-store DBのcapture／integrity／digest／元DB bytes不変、欠損・破損を含む部分coverage、archive改変の検出、generic Restoreがcanonical snapshotを適用しないこと。続けて対象test、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## 直前の実績

`apps/gateway/src/canonical_state_backup.ts`で5つのcanonical SQLiteを専用read-only接続から個別snapshotする。現在の各storeが要求するDELETE journal modeを確認し、read transactionのshared lockを保ってDB fileをcopyする。snapshotを再read-only openし`integrity_check`、byte count、SHA-256を記録する。source pathや行・payloadをinspectionへ出さない。破損／busy／snapshot失敗はそのstoreだけ`unverified`とし、成功した他storeを保つ。

`createRecoveryBackup`がsnapshot manifestをrecovery packに加え、`inspectLatestRecoveryBackup`がdigestとSQLite integrityを再検査してcoverageを返す。Control Centerはcomplete／partial／noneを固定値・件数だけ表示する。storeごとのDB内整合は示すが`cross_store_atomic=false`を固定し、仕事単位の復旧点や許可へ昇格させない。旧manifestは`not_included`として読める。既存generic Restoreはsnapshotを適用しないことを合成試験で確認した。

既存`recovery_inspection.ts`も同じcanonical store path tableを使うため、台帳inspectionとbackup producerが異なるDB配置を指す driftを避ける。

### 確認結果

| 確認 | 結果 |
|---|---|
| recovery surface／recovery inspection／Operation Plan recovery inspection／WebChat Control Center focused tests | PASS、4 files／108 tests。全5store、部分coverage、tamper、source不変、generic Restore非適用、共有canonical pathの既存ledger検査を確認。 |
| `pnpm typecheck`→`pnpm build` | 両方PASS。順次実行、15 workspace build。 |
| `pnpm docs:check` | PASS。日本語基底の既存移行負債76件、license確認を含む。 |
| `pnpm validate:repo-health`／`git diff --check` | 両方PASS。 |
| 全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03=`BUILD_GAP`のまま。store間の原子的snapshot、job単位の依存隔離、snapshotからのguarded selective recoveryは未接続。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。次consumerは仕事別の破損依存範囲と安全な復旧適用境界。

## 前回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CRON-READONLY-RECOVERY-INSPECTION`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。到達目的はCronのdurable inbox／outbox／approval handoff台帳を、runtime storeを起動・変更せずに復旧検査consumerへ接続し、`--recovery-inspect`と既存Recovery Operator/Control Centerで確認可能にすること。

### 対象と停止境界

- Cron DBは専用read-only SQLite connectionで開く。path/root/symlink、SQLite sidecar、journal mode、schema、DB integrityを確認する。runtime constructor、mkdir、schema作成・修復、write transactionは使わない。
- 行ごとにinbox/outbox対応とapproval handoff形状を確認し、verified／unverified／orphan／pending／interrupted等の固定statusと件数のみ返す。event・source・command・request・payloadの値や識別子、path、raw例外を返さない。scan上限到達・missing DB・schema不一致・論理破損を成功へ読み替えない。
- read-only報告をGateway recovery reportへ加え、CLIとdigest・件数限定のoperator projection／Control Centerへ接続する。Cronがunavailable、residualsあり、または未決cursor／approvalを持つ場合は統合replay checkpointをverifiedにしない。
- `unresolvedEvents()`／claim／dispatch／Approval／resume／HDS/J/M／監査・権限・外部作用・store schemaは変更しない。read-only inspectionはrepair、restore point、復旧可能性、権限、再開許可を生成しない。`external_backup_restore_point="not_examined"`、`used_for_authority=false`、`may_execute=false`を維持する。
- E03.03は`BUILD_GAP`。一貫snapshot、job単位の依存隔離、独立restore point、guarded selective recoveryは未接続のまま。C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

### 確認・Git

- 合成SQLite fixtureで、未作成DBが作成されないこと、正常なcursor／approval集計、単独論理破損・outbox孤立・malformed handoff・sidecar/schema異常の残差、識別子／raw例外の非露出、入力DB bytesの不変を確認する。Control Center projectionは不正／旧schemaをfail closedにする。
- 対象test、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`。全suite、live/provider、credential、外部作用、5OS実機、QE_QC／QE_QAは対象外。
- 編集前復元refsを二世代照合する。現世代=`1b8360efe1e4fc11a06ed9fb10283e0b88cb06a2`、前世代=`38364a549e0b36e273877caac4be20a0484d047f`。バッチcloseoutで限定commit／push、main・backup refs・clean worktreeを再照合する。秘密・内部原典は追加しない。

## 前回の実装結果

Cron recovery inspectorを追加し、recovery report schema v4／operator projection schema v3としてCLIとControl Centerへ接続した。pending approval、unresolved cursor、論理破損、orphan outbox、未走査件数は統合replay checkpointの成立を止める。read-only SQLite bytes不変、raw識別子／payload／path非露出、欠損・sidecar・schema不一致の未確認扱いを確認した。repair、restore、resume、approval、authority、外部作用は接続していない。

| 確認 | 結果 |
|---|---|
| focused regressions | PASS、5 files／133 tests。最終projection整合変更後に2 files／91 testsも再実行PASS。 |
| `pnpm typecheck`／`pnpm build` | 両方PASS、順次実行。 |
| `pnpm docs:check` | PASS。日本語基底の既存移行負債76件。 |
| `pnpm validate:repo-health`／`git diff --check` | 両方PASS。 |
| 分離rootの実CLI検査 | Cron unavailable／`residuals_present`／exit 2は未確認ledgerに対する期待値。検査がrootを作らないことを確認。 |
| 全suite、live/provider、credential、実外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03=`BUILD_GAP`、C08.03保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。復旧ref移行状態=`MIGRATION_COMPLETE`。

## 直前のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CRON-APPROVAL-PLAN-CORRELATION`。関係単位=E03.03「破損範囲の隔離復旧」。実経路はCron durable approval handoff→保存済み`command.id`→Operation Plan binding→recovery report/operator projection。Cron handoffとOperation Planが実コード上で同じcommand IDを保存することを確認済み。Cronの生command IDを保持・表示せず、両側で同じSHA-256入力規約を用いるdigest相関により、未決handoffの依存stepを読み取りで示す。

境界：Cron ledger／Operation Plan schema、claim／dispatch／Approval／resume、HDS/J/M、監査・権限・外部作用は変更しない。相関は状態観測のみで、復旧可能性、restore point、再開許可、承認の有効性を作らない。欠損・未走査・破損・複数handoffは未確認／ambiguousとして閉じる。`used_for_authority=false`、`may_execute=false`、`external_backup_restore_point="not_examined"`を保持する。既存Recovery Backup検査は別のControl Center操作で、`canonical_state_coverage="not_included"`のため正本復元点とは扱わない。

最小確認：合成Cron/Operation Plan fixtureで同一commandのpending／interrupted／resolved handoff相関、未記録、複数一致、未検証／上限超過を確認する。生command ID／request ID／event payloadがreport・operator projection・UIへ出ず、read-only inspectionでDB bytesが変化しないことを確認する。変更箇所の試験、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、承認・復旧操作、QE_QC／QE_QAは対象外。

開始HEAD／`origin/main`=`9ffc93eb24ce329b5f8c2851e423caac367fe398`、開始worktree clean。編集前復旧refsは現世代=`9ffc93eb24ce329b5f8c2851e423caac367fe398`、前世代=`1b8360efe1e4fc11a06ed9fb10283e0b88cb06a2`で、local branchとremote tagを実照合済み。

## 直前の実績

Operation Plan recovery inspectorの生command ID digestとCron approval handoffの`command_id_digest`を結び、同一計算規約で相関した。Cron側ではapproval rowのsource／sequence／event／payload digestを現cursorと照合し、検証済み行だけを相関へ渡す。集約結果はraw identityを含まない固定enumとしてrecovery report schema v5、CLI、operator projection schema v4、Control Centerへ接続した。pending／interruptedは状態として表示し、ambiguous／未検証／走査省略はresidualとして統合checkpointを止める。操作、resume、承認、restore、復旧可否は追加していない。

| 確認 | 結果 |
|---|---|
| recovery inspection／Operation Plan recovery inspection／WebChat Control Center | PASS、3 files／97 tests。未記録・pending・interrupted・resolved・複数一致、projection境界、raw ID非露出、DB bytes不変。 |
| execution result reconciliation | PASS、1 file／30 tests。 |
| `pnpm typecheck`→`pnpm build` | 両方PASS。buildはtypecheck完了後に順次実行。 |
| `pnpm docs:check`／`pnpm validate:repo-health`／`git diff --check` | すべてPASS。日本語基底の移行負債76件は既存。 |
| 分離state rootの実Gateway `--recovery-inspect` | 期待どおりexit 2、state rootを作らず、新しい相関残差数を表示。 |
| 全suite、live/provider、credential、実承認・復旧操作、外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03=`BUILD_GAP`。canonical全store snapshot、job単位の依存隔離、独立restore point、guarded selective recoveryは未接続。C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。次回は三点正本・適用AGENTS・active指示・現物・HEAD／差分を再同期してから、これらの未接続consumerのうち次の一つをBUILD_BATCHとして確定する。復旧・承認・再開の実操作は今回の完了状態に含めない。
