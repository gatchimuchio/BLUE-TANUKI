# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、作業標準要領、現物、active対象要求を再読した。前回開始HEAD／`origin/main`=`1b8360efe1e4fc11a06ed9fb10283e0b88cb06a2`。今回開始HEAD／`origin/main`=`acc1465cb11e5fec7bf18f15656b86ae1d8117db`、worktree clean。復旧ref移行状態=`MIGRATION_COMPLETE`。ownerは製品開発を続行するよう明示済み。C08.03実provider試験は保留、別repo変更・実業務作用・公開行為・出荷判断はこの委任外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CANONICAL-SQLITE-SNAPSHOT-INSPECTION`。開始HEAD／`origin/main`=`acc1465cb11e5fec7bf18f15656b86ae1d8117db`、開始worktree clean。編集前復旧refはlocal branch／remote tagとも現世代=`acc1465cb11e5fec7bf18f15656b86ae1d8117db`、前世代=`45b0c9363bac3733366641d174a7d560f27d345a`を確認済み。

目的は、独立recovery packにJ/M、Broker、Operation Plan、Cronの5正本SQLiteをstore別online snapshotとして保存し、snapshotごとのSQLite integrity／digestを読み取り検査する実consumerへ接続すること。保存内容は機密扱いとし、公開・通常operator projectionへraw payload、path、行、IDを出さない。DBごとのsnapshotは各DB内で一貫するが、store間の同時点原子性は保証しない。そのためsnapshot検査を横断復旧点、仕事単位の復旧可否、権限、承認、resume許可として扱わない。既存generic Restore経路ではcanonical snapshotを適用しない。

対象はrecovery backup producer、read-only backup inspection、Control Centerの固定status projectionと合成SQLite確認。対象外はSQLite stores/schema、approval/HDS/監査/権限、job単位selective recovery、store間pause/barrier、canonical snapshot restore、外部作用、C08.03 live/provider、別repo、公開・出荷判断。欠損storeは欠損、破損・snapshot失敗は未確認として他storeへ伝播させず、部分coverageを完全なsnapshotと表示しない。

最小確認は合成5-store DBのcapture／integrity／digest／元DB bytes不変、欠損・破損を含む部分coverage、archive改変の検出、generic Restoreがcanonical snapshotを適用しないこと。続けて対象test、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を実行する。全suite、credential/live/provider、実復旧、5OS実機、QE_QC／QE_QAは対象外。

## 今回の実績

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
