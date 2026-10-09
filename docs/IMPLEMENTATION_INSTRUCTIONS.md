# BLUE-TANUKI 有効な実装指示

現単位: **C04.01 — 記憶の取得・意味解釈・引用採否**。`PRODUCT_BUILD_MODE`、profile `core`。依存はC02.03とC03.04の適用可能な局所証拠に限る。今回の有限条件を実装・検証し、二世代backup、main commit/push、remote照合まで閉じて境界停止する。GitHubは通常の検証済み成果・履歴の保管面とする。別repo、業務上の外部作用、公開主張、出荷判断、owner GOは別境界である。環境構築は完了済みとして再実施しない。

## 1. 目的

BT-R-C04-01/02の今回範囲として、Jが現在依頼に限る検索目的・範囲を決め、Mが既存のHDS LTMから候補を機械検索し、Cが支持記録・反証候補を意味解釈して引用案を返し、Jがrecord ID・不変版・出所・今回の適用scopeを実照合して採否する経路をGatewayの通常応答へ接続する。

有限到達条件: **J→M→C→Jの検索責任と、出所・反証候補・適用範囲を明示した引用採否が、通常のLLM応答経路で通る。**

## 2. Phase 境界

対象はHDSの現在のmemory policy／LongTermMemoryStore／MemoryTrace、LLM command生成、応答後のJ引用照合、Gateway CLI/WebChatの表示・OutputAudit接続と、その監査projectionである。HDSはLLMを呼ばず、引用案の照合は権限・承認・実行判断を生成しない。新しい引用は今回の応答内だけの派生参照で、Mの正本記録や過去承認を変更しない。

## 3. Scope

- packages/hds-brain/src/types.ts
- packages/hds-brain/src/memory_trace.ts
- packages/hds-brain/src/controller.ts
- packages/hds-brain/src/memory_citation_review.ts
- packages/hds-brain/test/controller.test.ts
- packages/hds-brain/test/memory_citation_review.test.ts
- apps/gateway/src/finalize_command_output.ts
- apps/gateway/src/runtime.ts
- apps/gateway/src/serve.ts
- apps/gateway/src/audit_dump.ts
- apps/gateway/test/finalize_command_output.test.ts
- apps/gateway/test/audit_dump.test.ts
- packages/channel-webchat/src/webchat_types.ts
- packages/channel-webchat/test/webchat.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（CHANGELOGの既存負債hash同期）

上記以外は変更しない。追加pathが必要と判明したらREPLANし、新たに再同期する。

## 4. Non-goals

C04.02の現在射影・要約差・非採用記録への永続復帰参照、C04.03の過去承認失効、Mの意味記録schema変更、正本recordへのsemantic relation保存、全履歴の廃止、session-store改修、他repo、UI大型変更、memory source追加、外部作用、production資格情報、実ユーザーデータ、release/GA/P13/owner GOは扱わない。rev1.1原典、owner原文、private運転状態、secretはrepoへ含めない。

## 5. 最初に確認する files / symbols

適用規定、日本語正本、作業標準、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C02.03/C03.04のprofile適用性、C04要求・本単位・仕様s03/s06/s07/s14/s15/s16と指定原典を確認する。`MemoryReadPolicy`、`buildMemoryTrace`、`MemoryEntry`/`entry_hash`/`commit`、`HDSUpperController.buildCommand`/`onFeedback`/`onOutputAudit`、Gatewayの`executeAndEcho`とCLI応答、`renderCommandOutput`、監査表示を追う。LLM session historyはexecutor側の別経路として観測し、引用採否資格へ流用しない。開始HEAD、remote、dirty帰属、backup refsを記録する。

## 6. 必須grep

追跡語: `MemoryReadPolicy`, `MemoryTrace`, `buildMemoryTrace`, `MemoryEntry`, `entry_hash`, `memory_reference`, `memory.citation_review`, `buildCommand`, `onFeedback`, `onOutputAudit`, `renderCommandOutput`, `executeAndEcho`, `session_id`, `used_for_authority`, `complete_history_used_for_authority`。引用案のrank/score自己承認、候補外ID、古い版、異scope、未検証F参照の表示、raw LLM本文の監査保存、別authority pathがないことを確認する。

## 7. 既存anchor

HDS `MemoryReadPolicy`がJ側の許可source・検索mode・件数上限を決め、`buildMemoryTrace`がMの既存LTMから正確なrecord/hashを取得する。LongTermMemoryStore entry hashが不変版、request/F reference・timestamp・process/decision snapshotが利用可能な出所である。GatewayのCLI/WebChat応答は表示前にOutputAuditへ入る。実際の検索traceとin-flight DecisionLogを使い、並行の正本引用台帳や二つ目のauthority pathを作らない。

## 8. 実装要件

1. 検索planに目的、request/process境界、許可source、検索mode、上限、query digest、今回だけのapplication scopeを置く。raw request本文をplanへ保存しない。
2. M候補を使う前にLongTermMemoryStoreのhash-chain検証が成功していることを要する。検証器の欠落・失敗・例外時は候補を空にし、出所付き引用へ進まない。
3. 取得候補だけをCへ渡す。候補の文字列は未検証データとして区切り、命令・authority・真実へ昇格しない。record IDとentry hashを対で提示する。
4. CのJSON引用案は重複key・非有限値を拒否する厳密境界でparseする。支持・反証候補はそれぞれ一つ以上の別record、取得済みID、正確なhash版、今回scopeとの一致を必須にする。欠落・候補外・旧版・曖昧・過大・score追加は採用しない。
5. Jは保存recordからID・版・source store・captured time・利用可能なprocess/decision provenanceを再構成する。意味的な支持/反証性はCの提案と明記し、Jが証明したように表示しない。引用資格を満たさないF参照は応答から除き、引用なし/不正応答を区別する。
6. 引用review監査にはdigest、candidate/version参照、採否・理由code、適用scope、non-authority flagだけを保存し、raw answer・claim・memory summaryを複製しない。Gatewayはreview後の本文だけを表示し、元executor結果digestと表示digestをOutputAuditで結ぶ。
7. malformed output・feedback失敗・候補不在を安全に扱い、再試行可能性を保つ。MemoryTraceは検索・表示・監査用に限り、Approval Gate、commit、risk/process分類、permission、schedule等の作用へ接続しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、LLM非authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed、memory/history/external metadata non-authority、Layer A/B、standalone境界を維持する。検索順位、Cのscore、memory/version/provenance/counterevidence、監査UIは承認・実行・権限を生成しない。失敗時に参照未検証のまま確定表示しない。

## 10. Operator usability

引用はrecord ID・hash版・出所・支持/反証候補・今回限定scopeを人間が読める形で表示する。意味関係がC提案に留まること、照合不成立で引用案を採用しなかったこと、再依頼で再試行できることを明確にする。監査dump/serve projectionはdigestと参照metadataに限りraw本文を出さない。履歴全体、永続projection、未取得recordへの復帰は主張しない。

## 11. Tests

- BT-U-C04.01-P: 二つの合成M記録をJの現在scopeで取得し、Cへ候補・hash・出所を渡し、支持/反証引用案をJが照合してGateway表示とhash-chain監査へつなぐ。
- BT-U-C04.01-N: hash-chain検証器欠落、候補外record、古いhash版、異scope、支持/反証の重複、反証欠落、C score追加、duplicate-key JSONを拒否し、非権限flagを保つ。
- 実test selector: `packages/hds-brain/test/controller.test.ts`, `packages/hds-brain/test/memory_citation_review.test.ts`, `apps/gateway/test/finalize_command_output.test.ts`, `apps/gateway/test/audit_dump.test.ts`, `packages/channel-webchat/test/webchat.test.ts`。
- Windows上の合成LongTermMemoryStoreだけを使用する。fixture／local testをlive・installed evidenceへ読み替えない。

## 12. Validation commands

commit前必須:

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm build
    pnpm test
    pnpm docs:check
    pnpm validate:repo-health

実装単位追加:

    pnpm run doctor
    pnpm validate:packaging
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/hds-brain/test/controller.test.ts packages/hds-brain/test/memory_citation_review.test.ts apps/gateway/test/finalize_command_output.test.ts apps/gateway/test/audit_dump.test.ts packages/channel-webchat/test/webchat.test.ts

変更なしのsmoke/release gateは単位scopeにない。失敗は今回起因、既存、環境限定、未確定に分類し、正確なexitと件数を記録する。

## 13. Manual smoke

現在のWindows PowerShell workspaceで合成memory entryを使い、通常のHDS command generationからGateway共有finalization helperまで正例と負例を通す。既存Gateway/listener/process、credential、production memory、external serviceは操作しない。必要なsmoke scriptがこの単位のfixture応答を使えない場合は、実行可能な実test selectorと未観測範囲を記録し、live結果へ読み替えない。

## 14. Permanent-use check

今回成立させるのは、Windows Node runtimeの既存Gateway CLI/WebChat code pathに接続された検索・引用reviewと合成データでのlocal conformanceまでである。証拠源は`FIXTURE`とsource inspection/`INTERNAL_STATE`。外部LLM providerのschema遵守、session history廃止、長期保存した意味relation、credentialed live interaction、installed OS、release readiness、親C04全体の証明ではない。

## 15. Final report format

C04.01の有限条件とBT-R-C04-01/02の成立範囲、変更path、production consumer、risk/route/evidence分類、selectorと必須commandの正確な結果、doctor失敗・未実施・残存限界、C04親/P13状態、branch/commit/push/remote HEAD、二世代backup refs、復元点を日本語で報告する。local受入、Git統合、live/installed、release判断を分ける。

## 16. Next-phase dependency

C04.01の正負条件、整理、安全review、必須検証、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまで閉じて境界停止する。C04.02は新しい入口・再同期から扱い、自動着手しない。親C04全体、session/full-history経路変更、永続semantic relation、release状態は未成立のまま保つ。P13は`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持し、owner GO/GAを推定しない。
