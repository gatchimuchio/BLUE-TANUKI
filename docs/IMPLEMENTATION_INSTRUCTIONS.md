# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。毎作業・切替・再開時に、owner指定の最新版QE三点全文、適用AGENTS.md、active、HEAD・差分・対象producer／consumerを読み直す。現在のowner開発委任に従い、Windows上でBLUE本体を施工する。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-C07-TYPED-TARGET-REFERENCE。C07.01の意味更新案v2に、既存`MemoryCitationReference`と同じ`(record_id, version)`の型付き`target_reference`を導入する。HDSは成功feedbackに付随する案について、同一commandの現在MemoryTrace内でrecord IDと不変entry hashの両方が完全一致するか照合し、raw参照／hashを重複しない非権威audit booleanへ残す。v1履歴は引き続き解析するがtargetを未検証とする。

v2の`prior_version_ref`はまだ汎用文字列のため、旧版の存在・対象との系譜・適合は未検証であり、`target_and_prior_version_verified=false`を維持する。targetの一致も記憶更新候補の意味、支持／反証、scopeの意味適合・探索完全性、採用、M反映、実行権限を判定しない。proposalは未採用・非権限・非適用のままとする。

この実装では実LLM/providerからv2が生成されることを検証しない。C08.03の実provider試験を保留する。

## 判定の境界

実装対象はprotocol v1/v2 parser、HDSの現在投影target照合とaudit、fallback型、対応tests。v2 targetが現projectionにない場合は`target_reference_mismatch`、v1のgeneric targetは`target_reference_unverified`、targetは一致してもprior versionが未検証なら`prior_version_unverified`とする。scope digestが一致する場合も同一planへの結合に限る。

実owner承認producer・M反映consumer・初期MemoryInterpretation producerは接続しない。D4Pocket／ミニドラ、credential、外部業務作用は対象外。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、version=`1.0.0-rc.1`を維持する。内部QE原典・ZIP・要求対応表・raw運転証拠はPublic Gitへ追加しない。

## 対象と確認

対象は`packages/protocol/src/状態更新契約.ts`、`packages/hds-brain/src/memory_citation_review.ts`、`packages/hds-brain/src/types.ts`、`packages/hds-brain/src/controller.ts`と対応tests、ならびに公開可能な進捗・ロードマップ・changelogである。必要な確認は関連protocol／HDS／Gateway／Executor tests、`pnpm typecheck`、`pnpm build`、`pnpm hds:standalone`、`pnpm docs:check`、`git diff --check`。

開始HEAD=origin/main=`6407a969df8f3dd64fb0d33546e5253242085534`、clean。編集前の復元点はlocal `codex/backup-main`／`codex/backup-main-prev`=`6407a969df8f3dd64fb0d33546e5253242085534`／`62fa57927b7a138b87e71354f1ca154f03c63ecf`、remote backup tag二世代も同じSHAへ更新・照合済み。

## 次の接続点

prior-versionの型付きproducerとM履歴consumer、意味関係を生成・独立評価する許可済み経路は未接続のまま残す。推測でresolverを作らず、これらが現行の製品経路を妨げるかを記録して、次の実consumerへ進む。実provider、実業務作用、別repo、公開・出荷判断は別境界で保留する。

prior-version履歴照合と意味評価は具体的な`BUILD_GAP`。C07親全体、意味採用、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは未成立。

backup refsの移行状態は`MIGRATION_COMPLETE`。編集前復元点の作成後、バッチ末にmain commit/push、remote HEAD、local復旧branch二世代、remote tag二世代、clean worktreeを照合する。
