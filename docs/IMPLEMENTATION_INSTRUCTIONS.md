# BLUE-TANUKI 有効な実装指示

直近施工単位: **D01.01 — 操作記述子と複合効果**。Windows / PowerShellを通常開発環境とし、WSLを必須にしない。単位ごとに有限受入、必須検証、二世代backup、commit、push、remote照合まで行う。C08.03の実LLM/provider試験はowner指示で保留し、今回行わない。外部provider、実資料、外部業務作用、公開主張、release/GA、出荷判断、owner GOは範囲外。

## 1. 目的

審査済み操作記述子を通常router、tool registry、operator projection、OperationPlan検査へ接続する。tool、operation、adapter、effects、capabilityの重複表をなくし、実装済み作用を全て列挙する。未知toolを成功扱いせず、Jへ未対応失敗を返す。

## 2. Phase境界

D01.01だけを実施する。直接依存C08.02はorigin/mainで閉鎖済み。対象は合成・局所の通常コード経路。D01.02の依存step具体化、D01.03のplan改訂、C08.03実LLM、別repo、実provider、実資料、外部業務作用、release判断へ進まない。有限受入とGit閉鎖後に停止する。

## 3. Scope

変更を次の限定pathに収める。

- packages/protocol/src/operation_catalog.ts（追加）
- packages/protocol/src/index.ts
- packages/protocol/src/operation_core.ts
- packages/protocol/test/operation_catalog.test.ts（追加）
- packages/protocol/test/types.test.ts
- packages/hds-brain/src/action_router.ts
- packages/hds-brain/test/controller.test.ts
- packages/blue-tanuki/src/operation_core.ts
- packages/blue-tanuki/src/executor.ts
- packages/blue-tanuki/src/tools/registry.ts
- packages/blue-tanuki/src/tools/builtin.ts
- packages/blue-tanuki/src/tools/composio.ts
- packages/blue-tanuki/src/tools/google_read.ts
- packages/blue-tanuki/src/tools/google_write.ts
- packages/blue-tanuki/src/tools/shell_exec.ts
- apps/gateway/src/runtime_schedule.ts
- apps/gateway/src/serve_operator_permissions.ts
- packages/blue-tanuki/test/executor_operation_core.test.ts
- packages/blue-tanuki/test/executor_dispatch.test.ts
- packages/blue-tanuki/test/tools_builtin.test.ts
- apps/gateway/test/runtime_schedule.test.ts
- apps/gateway/test/unsupported_tool.test.ts
- packages/operator-writing/src/surface.ts
- packages/operator-writing/src/operation_core.ts
- packages/operator-writing/test/writing.test.ts
- packages/operator-daily/src/surface.ts
- packages/operator-daily/src/operation_core.ts
- packages/operator-daily/test/daily.test.ts
- packages/operator-developer/src/surface.ts
- packages/operator-developer/src/operation_core.ts
- packages/operator-developer/test/developer.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（変更した既存移行負債のhash同期に限る）

scope外のpathが必要なら編集前に差分・理由・依存を再評価してREPLANする。秘密、credential、runtime state、private施工pack、raw evidenceをstageしない。

## 4. Non-goals

実LLM/provider接続、C08.03、他の施工単位、第三者plugin導入、外部業務作用、GA/P13/owner GO、製品の公開主張、全言語刷新、権限モデルの変更、Final Reviewリスト複製、無関係refactorや依存更新は行わない。GUI Shell/D4 Pocketを読書きせず、既存listenerを停止しない。

## 5. 最初に確認するfiles / symbols

operation catalog、OperationPlanSchema、OperationAdapterRegistry、inspectOperationPlanAdapterRegistry、action_routerのrouteAction/buildToolRoute、ExecutorのnoopとexecuteToolCall、ToolRegistryと全builtin toolのrequired_capabilities、blue-tanuki operation_coreのadapter/effects mapping、Writing/Daily/Developer surfaceとprojection builder、Approval Gateのrisk/level決定、関連testsを読む。呼出し元から結果表示までの責任境界を追う。

## 6. 必須grep

OperationPlan operation/adapter/effects、inspectOperationPlanAdapterRegistry、routeAction、TOOL_SPECS、required_capabilities、operationAdapterForCommand、operationEffectsForCommand、effectsFor、adapterFor、case noop、unsupported tool、approval_level、secrets:、external:send、process_spawn、credential_accessを検索し、重複定義・未接続consumer・既存負例を確認する。

## 7. 既存anchor

HDS-BRAINのaction_routerとcontrollerが権限・routeの正本、Approval Gateが承認の正本、Executor/ToolRegistryが下流実行である。protocolの記述子catalogは非権威な意味契約と候補照合に限る。operatorは表示投影であり権限を持たない。tool registryを通す後続能力検査とL3 final reviewは維持する。

## 8. 実装要件

1. 審査済みtool/operation/adapter/effects/capability/timeout/実装参照を単一のprotocol catalogへ固定し、版付き・読み取り専用にする。surface aliasは実際のdownstream toolまたは既存LLM/channel/runtime実装に結び付ける。
2. HDS action router、tool実装のrequired_capabilities、operator projectionのcapabilities/effects/adapterをcatalog consumerへ接続し、重複表を撤去する。引数coercionとHDSの権限判断責任は移動しない。
3. OperationPlanの外部宣言は候補のまま扱う。operationがcatalogに存在し、descriptor version/実装参照に対応し、adapterとeffects全体が一致した場合だけnon-authority evidenceとして有効化する。未知operation、adapter不一致、効果欠落は拒否する。
4. 複合作用を全列挙する。例: file.editはread+write、Google/Gmail読取はexternal_send+read+credential_access、書込みはexternal_send+write+credential_access、schedule変更はschedule_changeとwrite/deleteを合成する。能力から必要となるL3表示は既存HDS Approval Gateと一致させる。
5. 理由付きunknown/noopはExecutorでfailedとしてbounded errorを返し、理由なしの意図的noopのみ従来のsuccess/nullを許す。unknown toolをLLMやtoolへ再解釈・転送しない。
6. catalog照合とprojection証拠にused_for_authority=falseを保つ。ApprovalRisk、ApprovalLevel、FINAL_REVIEW_OPERATION_LISTをcatalogへ複製しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、capability containment、Layer A/B、external metadata non-authorityを維持する。catalog、LLM plan、operator projection、adapter evidence、tool outputは権限を作らない。unknown、missing capability、descriptor mismatchを自動許可しない。

## 10. Operator usability

拒否はどのoperation/adapter/effectの不一致かを安全な範囲で示し、raw payload、secret、command本文をerror/evidenceへコピーしない。unsupported toolは利用側で失敗として判別できる。既存のsurface名とactionableなHDS errorを保つ。

## 11. Tests

BT-U-D01.01-P: catalogと全通常router/tool/operator consumerが同一記述子を参照し、代表的複合作用が保持される。OperationPlan候補の有効descriptorはnon-authority evidenceとなる。unknown routeはJ/Executor結果でfailedになる。

BT-U-D01.01-N: 未知operation、adapter不一致、effects欠落を拒否する。未知toolはsuccessにならない。Google secret capabilityとoperator approval表示の不整合、file.editのread欠落、shell/browser/composioの効果欠落が再発しない。

実test selectorをコード上で確認し、実行件数と結果を記録する。未実行selectorやskipをPASS扱いしない。

## 12. Validation commands

commit前に必須:

- pnpm install --frozen-lockfile
- pnpm typecheck
- pnpm build
- pnpm test（必要なら直列のVitest実行も行い、初回失敗と再試験を分けて記録）
- pnpm docs:check
- pnpm validate:repo-health
- pnpm run doctor
- pnpm validate:packaging
- git diff --check

Doctorのhost依存要因、既存listener、credential欠如はコードを迂回せず環境制約として分類する。D4 Pocketと重い検証の競合が疑われる場合、実行前にthread/process状態を再観測して直列化する。

## 13. Manual smoke

外部providerや業務データを使わない。単体・package testの通常consumer経路で、descriptor lookup、router route、executor結果、operator projection、plan rejectを確認する。実listenerへの衝突、既存owner service停止、credential確認、live smokeはしない。

## 14. Permanent-use check

操作名・作用・能力の追加時に一箇所の審査済みcatalogと通常consumerへ接続できることを確認する。surface表示とruntime approvalの不一致、unknown成功、provider/live動作、installed pathの恒久性はこの単位の証拠として主張しない。P13はPENDING_OWNER_GO、public_claim_allowed=falseのまま維持する。

## 15. Final report format

単位ID、変更概要、変更path、risk、実行経路と証拠源、HDS/authority境界、正負受入、検証commandごとのexit/result、未実行/失敗/環境制約、release/P13状態、branch、commit hash、push結果とremote HEAD、二世代backup refs、rollback point、次の単位候補と開始条件を日本語で報告する。

## 16. Next-phase dependency

D01.01以外へ自動進行しない。有限条件、cleanup、横断整合、安全再確認、必須検証、二世代backup、限定stage、単一commit、push、remote main/backup ref照合、clean treeが全て成立したらD01.01を閉じて停止する。次候補は新しい同期と依存確認を経て選ぶ。C08.03の実LLM試験はownerの保留指示を維持する。
