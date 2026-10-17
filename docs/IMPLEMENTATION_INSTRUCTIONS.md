# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。毎作業・切替・再開時に、owner指定の最新版QE三点全文、適用AGENTS.md、active、HEAD・差分・対象producer／consumerを読み直す。現在のowner開発委任に従い、Windows上でBLUE本体を施工する。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-C07-SCOPE-PLAN-DIGEST-REVIEW。C07.01の意味更新案について、成功した現行LLM commandから届いた案のsupport／counterevidence記録ID・版とscope reference・digestを、同一commandの現在MemoryTraceへJが照合する。scope referenceは`application_scope_id`、scope digestは同traceのJ所有`MemorySearchPlan.plan_id`への一致を検査し、対象別の一致booleanと集約状態だけを非権威auditへ残す。plan digestの一致は同一検索計画への結合のみであり、意味的支持／反証、探索完全性、scopeの意味適合、真実、採用を判定しない。

このバッチの開始HEAD=origin/main=`62fa57927b7a138b87e71354f1ca154f03c63ecf`、clean。編集前にlocal復元branch二世代とremote backup tag二世代を期待SHA付きatomic操作で更新・照合した。変更はこのBUILD_BATCH内の単一writerへ集約する。

## 判定の境界

target_ref／prior_version_refはprotocol上の汎用参照文字列で、現行M record・interpretation lineageとの型付き対応が未定義のため、存在・版・適合を未検証のまま保持する。proposalには意味内容を含む型付き関係がなく、HDSはLLMを呼べないためsemantic relationは`not_assessed`のままにする。producer側でscope digestを生成する規約も未接続であり、現在はHDS consumerが同一traceのplan IDを基準に照合する。scope mismatchは採用候補に昇格しない。

結果は未採用・非権限・非適用である。実owner承認producer・M反映consumer・初期MemoryInterpretation producerは接続しない。D4Pocket／ミニドラ、provider／credential／外部業務作用は対象外。C08.03実provider試験を保留する。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、version=`1.0.0-rc.1`を維持する。内部QE原典・ZIP・要求対応表・raw運転証拠はPublic Gitへ追加しない。

## 対象と確認

対象は`packages/hds-brain/src/memory_citation_review.ts`、`packages/hds-brain/src/types.ts`、`packages/hds-brain/src/controller.ts`と対応test、ならびに公開可能な現行指示・進捗・ロードマップ・changelogである。必要な確認は照合consumer／auditの関連Vitest、`pnpm typecheck`、`pnpm build`、`pnpm hds:standalone`、`pnpm docs:check`、`git diff --check`。

STATUS=WIRED。`memory_citation_review.test.ts` 10/10、controller proposal selector 3/3（他67件skip）、typecheck、15 workspace build、HDS standalone、docs gate（日本語基底／licenseを含む）、差分確認はPASS。scope ID／plan IDの一致、不一致、失敗feedback、反証なし申告の未検証、raw参照・digest非重複記録を確認した。provider／credential／実外部作用、一般意味採用、全suite／QC／QA、公開・出荷判定は実施していない。

## 次の接続点

target／prior versionの参照producer・consumerを現行の型とM記録・解釈lineageへ追跡し、既存の型付き対応が見つからなければ推測で新resolverを作らず`BUILD_GAP`を具体記録する。semantic relationも意味内容のproducerまたは許可済み独立根拠consumerがない限り未評価とする。その後、C07の未解決点が製品経路を妨げるか確認し、次の実consumerへ進む。実owner承認producerや実providerへは接続しない。

backup ref移行状態は`MIGRATION_COMPLETE`。意味採用・C07全体、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは未成立。
