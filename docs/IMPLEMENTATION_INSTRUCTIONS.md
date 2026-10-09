# BLUE-TANUKI 有効な実装指示

現単位: **C05.01 — C計算入出力とprovider/model識別の結合**。profileはcompute-local。現在のHDS射影と実際のprovider入力digestを分けて保持し、要求routeと実provider/model、local P版、data exposure scope、resource limits、cost状態を共通Compute結果へ結ぶ。C05.02以降、外部作用、公開、出荷判断、owner GOは別境界である。環境構築は完了済みとして再実施せず、通常開発はWindows / PowerShellで行う。GitHubは検証済み成果と履歴の保管先であり、この単位も検証後に規定の二世代backup、main commit・push、remote照合まで閉じる。

## 1. 目的

BT-R-C05-01、BT-R-C05-04、BT-R-C05-06の今回範囲として、現在射影・Cの入力/出力・実計算routeを一つの非権限execution identityへ結合する。LLM provider adapterを共通Compute契約の下流実装とし、将来のMini Doraも同じ権限なし契約へ接続できる形にする。

有限到達条件: **Gatewayの通常HDS→Executor→LLM provider経路で、HDSの現在射影digest、実入力digestと結果digest、要求routeと選択されたcanonical provider/model、C profile、local P版、入力data exposure scope、resource limits、金額cost状態がresult identityへ結合し、Compute出力とprovider metadataが非権限のままHDS feedback auditでdigest拘束される。** providerから金額が得られない場合はcostをunknownとする。Mini Dora実装や別権限経路は今回作らない。

## 2. Phase 境界

対象はprotocolのLLM compute context、HDS command生成、LLM registry provider identity、ExecutorのCompute contract、Gateway CLI/serve wiring、局所fixture testsと本書に限る。HDS-BRAINが唯一authorityであり、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、Layer A/Bを維持する。

C05.02のstructured output / tool-candidate境界、C05.03のfallback方針、provider費用の実報告、credentialed/live provider、Mini Dora provider、Control Center表示、installer/bundle、release/GA/P13/owner GOは対象外。private施工pack・原典・実行state・secretはrepositoryへ含めない。

## 3. Scope

- packages/protocol/src/types.ts
- packages/hds-brain/src/controller.ts
- packages/blue-tanuki/src/llm/base.ts
- packages/blue-tanuki/src/llm/index.ts
- packages/blue-tanuki/src/llm/compute.ts
- packages/blue-tanuki/src/llm/registry.ts
- packages/blue-tanuki/src/executor.ts
- packages/blue-tanuki/test/llm_compute.test.ts
- packages/blue-tanuki/test/llm_registry.test.ts
- packages/blue-tanuki/test/executor_compute.test.ts
- apps/gateway/src/runtime.ts
- apps/gateway/src/serve.ts
- apps/gateway/test/compute_identity.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- docs/作業標準要領.md
- CHANGELOG.md
- 規定/移行台帳.json（既存CHANGELOG fingerprint debtの同期に限る）

上記外は変更しない。追加pathが必要になればprivate施工stateと受入packetをREPLAN・再同期する。

## 4. Non-goals

C05.02/03の実装、fallback semanticsの変更、provider別egress許可制御、外部LLM資格情報/live呼出し、実金額推定、provider遵守の保証、Mini Dora本体、memory/history authority化、Approval Gateやpolicy変更、LLM出力による判断・実行、GA/release/owner GO、別repo作業、環境再構築を行わない。C04.03のmemory引用・依存版意味論を再設計しない。

## 5. 最初に確認する files / symbols

LLMCallPayloadSchema、LLMRequest/LLMResponse、LLMRegistry.callWithRetry、HDSUpperController.buildCommand、goal_projection.projection_id、buildMemoryCitationSystemMessages、Executor.executeLLMCall、SessionStore、runtime.tsとserve.tsのExecutor生成箇所、FINAL_REVIEW_OPERATION_LIST、feedback/output audit、C01.03/C04.03の局所前提を確認する。開始時のmain/remote/backup refs・clean状態・Node/Corepack/pnpm版を記録する。ローカル既存環境を再設定しない。

## 6. 必須grep

LLMComputeAdapter、ComputeRequest、ComputeResult、execution_identity、compute_context、projection_digest、input_digest、output_digest、local_p_version、requested_egress_provider、backend_hint、session_history、used_for_authority、FINAL_REVIEW_OPERATION_LIST、onFeedbackを検索する。Gateway production Executorが両方adapterを構成すること、HDS context欠落時にproviderを呼ばないこと、providerにCompute metadataが渡らないこと、provider/model識別が実選択と一致することを確認する。Compute result/provider metadataがApproval Gateや第二authority pathへ到達しないことも確認する。

## 7. 既存anchor

HDS goal_projection.projection_idは現在のaccepted inbound requestに結び付いている。Cへ渡すmemory citation system messagesはHDSが検証した現在の選択参照であり、履歴全体ではない。Executorはprovider呼出し直前にSessionStore履歴を結合できる。LLMRegistryは要求hint/既定routeをcanonical backendへ解決する。Gateway CLI/serveはExecutorを生成する二つの通常production入口である。

C04.03が作るmemory参照・依存版と過去decisionは証拠のみで、現在権限ではない。HDS feedback auditはresult全体のdigestを記録するがraw resultを複製しない。provider応答が金額costを返す現行contractはない。A12 §5に基づくlocal PはC入力側のsystem-owned規則版であり、外部model weightsやpermissionではない。

## 8. 実装要件

1. Protocolにstrictな非権限compute contextを追加し、HDSがgoal_projection.projection_idと実際に選択したmemory messagesのdigestから現在projection digestを作る。raw request / memory textを新しいidentityやauditへ複製しない。
2. HDSはC profile blue-tanuki.llm-call@1、local P版 blue-tanuki.c-input-rules.v1、入力source、要求provider routeをcommandへ載せる。入力sourceはaccepted inbound request、実際にmessageへ選んだmemory referenceに限る。
3. Executorはproviderへ渡す直前の実際のLLMRequest全体（effective messages、model/temperature、route hint、resource optionsを含む）をSHA-256でdigest化し、request ID、現在projection digest、data exposure scope、resource limitsと共通Compute requestへ結ぶ。実際にprependしたsession historyはsourceとして追記する。既存Approval Gate証明の前提を変更しない。
4. ComputeBackend/ComputeRequest/ComputeResultはgeneric input/output型とし、approve/execute/permission/risk/final review APIを持たない。LLM adapterだけがLLM payloadを扱い、providerへ通常のLLMRequestだけを渡す。Compute identity/contextをprovider payloadへ漏らさない。configured adapterでcontext、profile、route bindingが無効ならprovider call前に失敗する。
5. LLMRegistryは実際に選択したcanonical providerをresponse metadataへ付与する。Compute resultは要求routeと実provider、要求/実model、profile、local P版、input source、resource limitsと実provider output digestを記録する。既定route/fallback時もrequestedとactualを別々に保持する。
6. Monetary costはproviderが報告しない限りunknownとし、token countから金額を推定しない。結果はcompute_output_used_for_authority=false、provider_metadata_used_for_authority=false、used_for_authority=falseを保つ。
7. Gateway CLI/serveの両production Executor経路へadapterを接続する。既存C05.02/.03の責務を先取りしない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、high-risk/unknown/tool.callのL3 final review、audit hash-chain、Runtime Invariants、fail-closed、session/memory/history/LLM/provider metadataのnon-authority、standalone HDS、Layer A/Bを維持する。Compute resultはcommand発行、承認、risk/process分類、policy更新、fallback authority、second authority pathに使わない。data exposure metadataは実際の入力・要求routeを記述するidentity情報であり、provider accessの許可を生成しない。

## 10. Operator usability

局所diagnosticsでrequest、projection/input digest、要求/実provider/model、local P版、入力source、resource limits、cost unknownを区別できる。失敗はprovider call前か後かを分かる形で返し、secret・raw message・credentialを出さない。missing contextやroute mismatchをfail-closedにし、調査・再試行可能なerrorを保つ。

## 11. Tests

- BT-U-C05.01-P: HDSが有効なprojection digest/local P/source/request routeを作る。Gateway integration fixtureでcommandを既存approval authorityへ渡し、Executor→LLMRegistry→選択providerの通常経路でactual provider/model、requested route、cost unknown、resource identityとnon-authority resultを得る。HDS feedback hash-chainを検証する。
- BT-U-C05.01-N: digest形式/route mismatchはprovider call前に拒否する。configured computeにcontextがない場合もprovider callしない。providerには通常LLMRequestのみが届き、Compute contextは含まれない。
- BT-U-C05.01-D: 異なるaccepted requestは異なるprojection digestを持つ。session historyが実際に適用されたときだけinput digestとsource scopeへ含め、resource limitsはcommand constraintsと一致する。
- Registry試験でrequested alias/defaultと選択されたcanonical providerを区別する。fixtureはFIXTURE証拠であり、実provider、外部egress許可、Mini Dora実装を証明しない。
- Selector: packages/blue-tanuki/test/llm_compute.test.ts、packages/blue-tanuki/test/llm_registry.test.ts、packages/blue-tanuki/test/executor_compute.test.ts、apps/gateway/test/compute_identity.test.ts。

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
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/blue-tanuki/test/llm_compute.test.ts packages/blue-tanuki/test/llm_registry.test.ts packages/blue-tanuki/test/executor_compute.test.ts apps/gateway/test/compute_identity.test.ts

標準pnpm testの既知・今回発生timeoutは実結果のまま記録する。必要時はtimeout/script設定を緩和せず、同じ全testを逐次実行して原因を分類する。smoke:serve/resume、credentialed live、release gateは本単位の受入selectorではないため、未実施を報告する。credentialを読み出さず、既存listenerを停止しない。

## 13. Manual smoke

専用fixture selectorでprotocol validation、HDS command生成、Executorの実入力digest、Registry選択provider identity、provider境界へのmetadata非送信、audit hash-chainを通す。credential、live外部provider、GUI、送信先は使わない。外部のproviderへデータを送る操作を実施しない。

## 14. Permanent-use check

今回成立させるのはWindows上のGateway構成、通常HDS command/Executor/provider route、result identityと局所audit digestまでである。証拠はsource inspection、FIXTUREとINTERNAL_STATE。providerの実受領、金額請求、外部egress policy、fallbackが許可する情報範囲、session/history保持の恒久品質、長期運転、crash/installed、Mini Dora、release readiness、親C05全体は未成立である。owner GO、GA、公開claimを推定しない。

## 15. Final report format

BT-R-C05-01/04/06の局所成立範囲、変更path、production consumerとroute/evidence分類、専用selectorおよび必須commandの正確な結果、doctor/標準testの失敗・未実施・環境限界、C05親とP13状態、branch/commit/push/remote main、二世代backup refsとrollback pointを日本語で報告する。fixture/local、provider live、installed/releaseを区別する。

## 16. Next-phase dependency

本単位の整理、安全review、必須検証、二世代backup rotation、main単一commit/push、remote refs/clean照合、private引継ぎを完了した後に停止する。C05.02へ自動進行しない。C05親はpartialのまま、P13はPENDING_OWNER_GO、public_claim_allowed=falseを保つ。
