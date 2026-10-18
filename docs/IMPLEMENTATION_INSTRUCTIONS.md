# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、作業標準要領、現物、active対象要求を再読した。開始HEAD／`origin/main`=`38364a549e0b36e273877caac4be20a0484d047f`、開始worktree clean。三点正本はowner指定rev2.3 ZIPから読み直し、旧版・旧SHAを現行状態へ転記しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-CRON-PARTIAL-CURSOR-INSPECTION`。関係単位=E03.03「破損範囲の隔離復旧」、E03.02「未決作用・M pendingの回復」。対象はresident notification向けのCron unresolved-event読取で、論理的に不整合な一行が検証可能な別sourceの通知まで全件隠す伝播を限定して分離すること。

### 到達・停止境界

- 通知専用の読み取り検査でcursor行ごとにinbox/outbox整合性を確認し、検証できた未決eventを保持する。不整合行と孤立outboxは件数だけを残差として扱い、source/event/payload識別子やraw例外を表示しない。台帳全体のSQL・store障害は従来のgeneric unavailable警告とする。
- 実行・解決経路の`unresolvedEvents()`、`unresolvedEvent()`、claim、dispatch、Approval、resume、no-replay判断、HDS/J/M、監査、権限、永続状態は変更せず、strict fail-closedを維持する。通知警告も`read_only=true`、`authority=display_only`とし、復旧可能性・継続許可・再開許可を生成しない。
- E03.03は`BUILD_GAP`を維持する。canonical storeの一貫snapshot、job単位の破損依存隔離、独立restore point、guarded selective recoveryは未接続。C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

### 確認・Git

- 複数sourceのうち一行を不整合にした場合、strict一覧は引き続き拒否し、通知専用一覧は不整合行を除いて検証済み行を保持し、固定の部分未確認警告を出すことを確認する。raw row・ID・例外を通知へ出さない。
- 対象test、`pnpm typecheck`→`pnpm build`、`pnpm docs:check`、`pnpm validate:repo-health`、`git diff --check`を行う。全suite、live/provider、credential、外部作用、5OS実機、QE_QC／QE_QAは対象外。
- 編集前復元refsはlocal branch／tag／remote tagで現世代=`38364a549e0b36e273877caac4be20a0484d047f`、前世代=`c57706efa4734890c6554a83bc361545431dda73`。`MIGRATION_COMPLETE`。バッチcloseoutで限定commit／pushし、remote HEAD、二世代refs、clean worktreeを照合する。秘密・内部原典を追加しない。

## 結果と未接続

通知専用projectionを追加し、Cron inbox/outbox cursorを行ごとに検証する。論理不整合行と孤立outboxは個別内容を返さず件数だけを残差として返し、検証済みの別source通知を保持する。resident notificationへ部分未確認の固定警告を追加した。strictな`unresolvedEvents()`とclaimは不整合を拒否し続ける。read-only表示であり、全台帳の一貫snapshot・破損依存のjob単位特定・restore point・選択復旧は行わない。

| 限定確認 | 結果 |
|---|---|
| Cron event store／resident notification focused tests | PASS、2 files／28 tests。複数sourceの論理不整合と孤立outboxを通常store起動後に作り、strict claim/listの拒否、通知用の正常source保持、残差数のみの返却、異常IDの非露出を確認。 |
| `pnpm typecheck`／`pnpm build` | 両方PASS。buildはtypecheck完了後に単独実行。 |
| `pnpm docs:check` | PASS。日本語基底の既存移行負債76件。 |
| `pnpm validate:repo-health`／`git diff --check` | 両方PASS。 |
| 全suite、live/provider、credential、実外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

E03.03は`BUILD_GAP`を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。
