# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0、工程表SHA-256=7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77、Codex施工指示SHA-256=D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8）、適用`AGENTS.md`、作業標準要領、現物、active対象要求を再読した。開始HEAD／`origin/main`=`c57706efa4734890c6554a83bc361545431dda73`、開始worktree clean。三点正本はowner指定rev2.3 ZIPから再読し、旧版・旧SHAを現行状態へ転記しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CRON-NOTIFICATION-FAULT-CONTAINMENT`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。対象はresident notification生成時のCron unresolved-event一覧とinterrupted-approval一覧を独立して読み、片方の読取例外が承認・監査等を含む他通知全体を隠さないよう、失敗した情報源だけを未確認警告として表示すること。

### 到達・停止境界

- 各Cron read-only projectionを独立にtry/catchし、成功した読み取り結果は保持する。失敗時は固定の通知だけを追加し、例外本文、path、credential、個別識別子を含めない。
- 通知生成の例外隔離だけを変更する。Cron store、schedule claim/dispatch、Approval、resume、no-replay判断、HDS/J/M、監査、権限、永続状態は変更しない。
- 通知は`read_only=true`、`authority=display_only`を維持し、読取失敗を空・正常・解決済みとして見せない。これは仕事単位の復旧、継続可否、再開許可、完全なE03.03成立を証明しない。
- E03.03は`BUILD_GAP`を維持する。canonical storeの一貫snapshot、job単位の破損依存隔離、独立restore point、guarded selective recoveryは未接続。C08.03 provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

### 確認・Git

- 失敗したCron一覧だけを固定警告へ変換し、成功した一覧と無関係通知を残すこと、raw例外を漏らさないこと、両一覧失敗時も他通知を残すことを確認する。
- 対象test、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を行う。全suite、live/provider、credential、外部作用、5OS実機、QE_QC／QE_QAは対象外。
- 編集前復元refsはlocal branch／tag／remote tagで現世代=`c57706efa4734890c6554a83bc361545431dda73`、前世代=`4a864cc6eca5466cdb28422b29ace0bb4c83dc10`。`MIGRATION_COMPLETE`。バッチcloseoutで限定commit／pushし、remote HEAD、二世代refs、clean worktreeを照合する。秘密・内部原典を追加しない。

## 結果と未接続

Cron unresolved-event一覧とinterrupted-approval一覧を独立して読み、片方だけの読取失敗は固定warningへ変換した。例外本文を隠し、成功した一覧・監査warning・承認待ち等を維持する。変更はread-onlyの通知生成に限り、store／dispatch／Approval／resume／HDS権限を変更していない。

対象testは1 file／20 tests、`pnpm typecheck`、その後の`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`がPASS。全suite・live/provider・実外部作用・全OS・QE_QC／QE_QAは未実施。E03.03は`BUILD_GAP`のまま。

次consumerは、canonical storeの一貫snapshotとOperationPlan／J／M／Brokerの仕事単位依存を現物で確定し、scopeを証明できる場合だけ破損範囲の隔離を検討すること。通知故障の分離を復旧可能性や無関係jobの実行許可へ拡張しない。
