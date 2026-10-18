# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、今回のownerによる継続指示、直前active指示、E04.02／E04要求、実際のHEAD／差分／producer・consumerを再読した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラrepo、実provider／資格の実試験、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E04.02-FAILURE-CAUSE-REVIEW`。関連単位=E04.02「原因・反対仮説と採否」。開始HEAD／`origin/main`=`58ec78e59b0ddde93e65d0497bb31a2bf21a4a8a`、clean。編集前にlocal復旧branch二世代とremote backup tag二世代を、現世代=`58ec78e59b0ddde93e65d0497bb31a2bf21a4a8a`、前世代=`9fb09257c8ec156fb609bc4cd391d964bce5f21c`へ期待値付きで回転し、local／remote SHA一致を確認した。backup-ref状態=`MIGRATION_COMPLETE`。

### 目的

明示的な開発者向け要求から保存済み失敗署名の限定digest射影をCへ渡し、原因候補・別仮説・観測誤差・反例・追加観測／再開条件の未信頼候補を生成し、HDS-Jが署名・投影への結合と未確認状態を裁定して非権威traceだけを返す。providerを自動・暗黙に起動しない。

### 対象と境界

- 対象：`packages/protocol/src/types.ts`の内部FailureReview契約、`packages/hds-brain/src/failure-memory/`の安全な射影・J評価、`controller.ts`の開発者向けcomputeとfeedback評価、`apps/gateway/src/serve.ts`のFailureMemory参照、関連focused tests、ROADMAP、開発進捗。
- Cへ渡すのは固定enum、allowlist済みunknown、元パターンを再hashしたdigestだけ。raw goal、command、target、error、message、notes、既存history本文を射影に含めない。
- `failure:review <id|latest>`はinternal Developer surfaceのowner/userだけが明示実行する。失敗保存や他のcommand実行の後に追加C要求を自動発行しない。通常のApproval、既存egress／費用制限を迂回しない。
- C候補の説明・原因・範囲・反例・再開条件は未検証としてdigestだけをJ auditに記録する。Jは根因を採用せず、独立観測を必要とする。memory、failure gate、permission、Approval、再試行、Broker、外部作用を更新・実行しない。
- 外部provider／資格を使った要求、C08.03実provider検証、D4Pocket／ミニドラ変更、実業務作用、別OS、QE_QC／QE_QA、P13 owner GOは対象外。

### 到達条件と限定確認

- 実producerはFailureMemoryStoreの署名から安全なprojectionを作る。通常consumerはHDS-issued C compute→署名・projectionに結合したJ評価→未検証candidate表示とdigest-only監査とする。
- 無効なcaller、存在しない／不正な署名、投影不一致、parse失敗ではCを呼ばずfail-closedにする。
- fixtureによるprotocol・射影・C→J接続確認、変更対象focused tests、typecheck、必要なbuild、docs gate、diff checkを行う。full suite・serve/live/provider・外部作用は実行しない。
- E04.02／QEB-03の残りは、実観測に基づく原因確定・反対仮説の採否、Memory反映、条件変化後の限定再試行が未接続なら`BUILD_GAP`として具体化する。

### 今回の到達状態

- FailureMemoryStore→Gatewayの明示Developer要求→digest-only C input→署名／projection結合済みHDS-J review→未検証candidate表示とdigest-only auditまで`WIRED`。
- JはCのscope判定を提案として記録し、原因を事実採用せず、独立観測を常に要求する。FailureReviewはM、failure gate、permission、retry、OperationPlan候補保存、外部作用を変更しない。
- focused tests、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`の結果をbatch閉鎖時に記録する。全suite・serve/live/provider・実外部作用は未実施。
- 実観測に基づくcauseの採否、M反映、条件変化後の限定retryは未接続であり、E04.02／QEB-03全体は`BUILD_GAP`を維持する。C候補だけでretryへ進まない。

### 限定確認結果

Windows PowerShell、Node `v22.23.3`、pnpm `9.12.0`で確認した。

| 確認 | 結果 |
|---|---|
| `packages/protocol/test/types.test.ts` | PASS、34 tests。内部metadataの外部入力stripを確認。 |
| `packages/hds-brain/test/controller.test.ts` | PASS、72 tests。digest-only C input、候補結合／非採用、監査本文非保存、外部／malformed拒否を確認。 |
| `apps/gateway/test/failure_review_runtime.test.ts` | PASS、5 tests。明示要求、id/latest選択、raw非射影、Gateway→HDS接続を確認。 |
| `packages/blue-tanuki/test/llm_compute.test.ts` | PASS、5 tests。未許可fallbackへの切替え拒否を確認。 |
| `pnpm typecheck` | PASS、workspace project references。 |
| `pnpm build` | PASS、15 workspace projects。 |
| `pnpm docs:check` | PASS。 |
| `git diff --check` | PASS。 |

全suite、`smoke:serve`、live/provider、実資格、実FailureMemory／Complete History、外部作用、OS別確認は未実施。

C08.03実provider試験保留、D4Pocket／ミニドラの別repo変更禁止、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### Git閉鎖

限定commitを`main`へfast-forward pushし、push後にlocal／remote main、作業tree、local復旧branch二世代、remote backup tag二世代を実SHAで照合する。今回保全した復旧点は現世代=`58ec78e59b0ddde93e65d0497bb31a2bf21a4a8a`、前世代=`9fb09257c8ec156fb609bc4cd391d964bce5f21c`。remote更新・ref競合があれば上書きせず停止する。backup-ref state=`MIGRATION_COMPLETE`。GitHub上の正本はbackup tag二世代であり、同名remote backup branchを維持しない。
