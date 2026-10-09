# BLUE-TANUKI 有効な実装指示

現単位: **C05.03 — provider fallback許可と実行同一性**。指定済みの代替providerへ切り替える場合、HDSが渡すprovider・入力source・必要能力・最大費用の許可、owner設定のprovider能力/費用上限、通常のdata exposure範囲をすべて満たす場合だけ実行する。切替元・先、失敗分類、許可範囲、推定費用をCompute execution identityへ記録する。費用は設定に基づく上限推定であり実請求額ではない。環境構築は完了済みとして再実施せず、通常開発はWindows / PowerShellで行う。GitHubは検証済み成果と履歴の保管先であり、本単位も検証後に規定の二世代backup、main commit・push、remote照合まで閉じる。

## 1. 目的

C05.02のtimeout/cancel、typed provider failure、candidate-only応答を保ったまま、retry可能なprimary failure後のprovider切替を限定的に認可する。切替先はowner設定fallbackとHDS発行authorizationの交差範囲に限る。Compute実行identityは実際の切替元/先、failure kind、入力source、必要能力、費用上限と推定合計を記録し、結果・provider metadata・identityを権限外に維持する。

有限到達条件: 許可provider、入力source、能力、通貨、設定上限をすべて満たすretry可能failureだけが代替providerを呼ぶ。許可欠落、不一致、能力不足、異通貨、上限超過、timeout/cancel、non-retryable failureでは代替providerを呼ばない。通常Gateway→HDS→Executor→Compute→Registry経路で成功時に切替identityと推定費用が記録され、拒否時に外部送信なしで元failureが維持される。

## 2. Phase 境界

対象はprotocolのfallback authorization契約、HDS controllerのroute固定とcompute context接続、Registryのowner設定profile・許可判定・切替trace、Compute identity、Gateway環境設定、関連testsと利用文書である。HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、Layer A/Bを維持する。

実provider、credentialed/live送信、実請求額照合、provider独自追加認可、control center表示、Mini Dora接続、installer/bundle/release/GA/P13/owner GO、他repo、環境再構築は対象外。private施工pack・原典・実行state/evidence・secretはrepositoryへ含めない。

## 3. Scope

- packages/protocol/src/types.ts
- packages/protocol/test/types.test.ts
- packages/hds-brain/src/controller.ts
- packages/hds-brain/test/controller.test.ts
- packages/blue-tanuki/src/llm/base.ts
- packages/blue-tanuki/src/llm/index.ts
- packages/blue-tanuki/src/llm/registry.ts
- packages/blue-tanuki/src/llm/compute.ts
- packages/blue-tanuki/src/executor.ts
- packages/blue-tanuki/test/llm_registry.test.ts
- packages/blue-tanuki/test/llm_compute.test.ts
- packages/blue-tanuki/test/executor_compute.test.ts
- apps/gateway/src/llm_config.ts
- apps/gateway/test/llm_config.test.ts
- apps/gateway/test/compute_identity.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CONFIG.md
- CHANGELOG.md
- 規定/移行台帳.json（変更済み文書のfingerprint同期に限る）

上記外は変更しない。追加pathが必要ならprivate施工stateと受入記録を先にREPLAN・再同期する。

## 4. Non-goals

実provider呼出し、credentials、外部事業者送信、実費用の保証、providerごとのlive品質検証、fallback候補の動的探索、HDS authorizationの下流生成、policy/Approval Gate変更、権限昇格、native tool実行、memory/history authority化、UI/installer変更、Mini Dora本体、GA/release/owner GO、他repo作業、環境再構築を行わない。

## 5. 最初に確認する files / symbols

LLMFallbackAuthorizationSchema、LLMComputeContextSchema、LLMCommandRoute、HDSUpperController、LLMRegistry.callWithRetry、LLMRegistry.resolveWithName、LLMComputeAdapter、ComputeRequest/ComputeResult.execution_identity、buildLLMBackendFromEnv、buildLLMCommandRouteFromEnv、LLMRetryPolicy、C05.01/02 identity・failure境界を確認する。開始時のmain/remote/backup refs・clean状態とNode/Corepack/pnpm版を記録する。既存環境を再設定しない。

## 6. 必須grep

LLMFallbackAuthorization、fallback_authorization、fallback_profiles、callWithFallbackAuthorization、LLM_ROUTING_TRACE、execution_identity、data_exposure_scope、requested_egress_provider、max_attempts、classifyLLMError、AbortSignal、used_for_authority、provider metadataを検索する。HDS authorizationが未設定時にfallbackを許可しないこと、context scopeを縮めたり迂回したりしないこと、authorizationがprovider adapterへ渡らないこと、identityがRegistry-owned traceを使うこと、timeout/cancel後に切替ないことを確認する。

## 7. 既存 anchor

C05.01はgeneric Compute identityへ実provider input/output digest、provider/model、data exposure source、resource limitsを結合する。C05.02はtimeout/cancelの中断、typed failure、tool candidate-only化とdigest-only HDS feedback auditを通常Gateway経路で確認済み。Registryはretry policyと明示fallback設定を持つが、provider切替を実行同一性へ記録するfallback許可境界は未接続である。

設定されたfallback名だけ、environment metadata、provider応答、memory/session、LLM出力から切替権限を作らない。HDS routeから渡るstrict grantをRegistry内部で消費し、下流providerには露出させない。切替結果と推定費用は監査参照用のnon-authority dataとする。

## 8. 実装要件

1. strictなfallback authorizationに許可provider、許可入力source、必要能力、最大合計費用/通貨を含める。重複・未知値・余分field・空集合を拒否する。
2. HDS route構築時にauthorizationを検証・固定し、HDSが生成するcompute contextからExecutorへ渡す。無指定なら切替許可なしとする。
3. Registryへowner設定のfallback provider profileを登録する。能力と1試行当たりの最大費用/通貨を厳格検証し、health projectionでは設定由来・non-authorityと表示する。profileのないprimary/fallbackは切替不可とする。
4. 既存のprimary retry後に、retry可能かつ未cancelの場合だけ判定する。fallback providerがgrantに含まれ、要求入力sourceがgrantの部分集合で、必要能力を満たし、通貨が一致し、primary/fallbackの設定上限を各max_attempts分合算してgrant最大費用以下の場合だけ呼ぶ。条件不足はfail-closedでprimary failureを返す。
5. timeout/cancel後、non-retryable failure、provider自身のmetadataだけではfallbackを開始しない。authorizationやprofileをprovider requestへ含めない。外部SDKや別authority pathを追加しない。
6. Registryがfallback成功時に内部traceを生成し、Compute adapterが切替元/先、failure kind、許可source/能力、最大費用、設定上限による推定費用をexecution identityへ写す。internal symbolをresultへ残さず、cost statusをestimatedとしてunknown actualと区別する。
7. 費用計算は浮動小数点丸め誤差で上限を超過許可しない。failure、許可不足、scope不一致、能力不足、currency mismatch、cost超過、timeout/cancelの負例でfallback providerが未呼出しであることを確認する。
8. CONFIGと進捗文書に環境変数形状、設定例、 fail-closed条件、推定値の限界を記録する。資格情報値は記載しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、high-risk/unknown/tool.callのL3 final review、audit hash-chain、Runtime Invariants、fail-closed、provider/LLM/result/identity/profile/memory/history metadataのnon-authority、standalone HDS、Layer A/Bを維持する。fallback authorizationはHDSからの制約であり、provider切替やCompute成功から承認・execution eligibilityを推定しない。requested egress scope外への送信、許可されていないinput sourceの送信、cancel後の再送を行わない。

## 10. Operator usability

許可不足や費用上限不一致はprimaryのtyped failureを保持し、認可外providerへ送らない。identityはfallback有無、切替元/先、failure kind、適用された入力sourceと設定費用上限の推定を説明できる。実請求額・provider live成功を表すような表示を追加しない。設定JSONの構文/shape errorはsecretやraw payloadを含めず変数名を示す。

## 11. Tests

- BT-R-C05-05-P: 明示authorization、scope、profile、能力、通貨、総費用上限を満たすretryable primary failureで許可fallbackだけが呼ばれ、通常Gateway/HDS経路のCompute identityへ切替元/先とestimated costが記録される。
- BT-R-C05-05-N: grant欠落/許可外provider、入力source不一致、能力不足、profile欠落、通貨不一致、費用超過、invalid authorization、non-retryable errorでfallback providerを呼ばずprimary failureを維持する。
- BT-R-C05-05-D: timeout/cancelは後続fallbackを開始しない。fallback authorizationはprovider call payloadへ渡らない。結果identityはLLM/provider metadataから生成されない。
- C05.01/02 compute identity、timeout/cancel、typed provider failure、HDS audit/hash-chain、ToolRegistry未呼出しの回帰がないことを確認する。fixtureはFIXTURE、Gateway/HDS経路は局所INTERNAL_STATE evidenceであり、provider live挙動やrelease readinessを証明しない。
- Selector: packages/blue-tanuki/test/llm_registry.test.ts、packages/blue-tanuki/test/llm_compute.test.ts、packages/blue-tanuki/test/executor_compute.test.ts、packages/protocol/test/types.test.ts、packages/hds-brain/test/controller.test.ts、apps/gateway/test/llm_config.test.ts、apps/gateway/test/compute_identity.test.ts。

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
    pnpm hds:standalone
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/blue-tanuki/test/llm_registry.test.ts packages/blue-tanuki/test/llm_compute.test.ts packages/blue-tanuki/test/executor_compute.test.ts packages/protocol/test/types.test.ts packages/hds-brain/test/controller.test.ts apps/gateway/test/llm_config.test.ts apps/gateway/test/compute_identity.test.ts

日本語基底strict gate、credentialed live、smoke:serve/resume、release gateは今回の受入範囲外であり、実施の有無を正確に報告する。credentialを読み出さず、既存listenerを停止しない。標準test timeoutやgateの閾値は変更しない。

## 13. Manual smoke

専用selectorと通常Gateway finalization fixtureで、許可fallback成功のidentity、費用上限境界、fail-closed拒否、HDS audit/hash-chain、providerへauthorization非送信、timeout/cancel中断を検証する。credential、live provider、GUI、外部送信先は使わない。

## 14. Permanent-use check

今回成立させるのはowner設定profileとHDS route grantの交差範囲での局所fallback、および通常Compute identityへの記録までである。証拠はsource inspection、FIXTURE、local validation、通常経路fixtureに限る。profile値の正確さ、実請求額、providerのlive/installed動作、資格情報下の運用、長時間運転、外部整合性、release readiness、C05親全体は未成立である。owner GO、GA、公開claimを推定しない。

## 15. Final report format

BT-R-C05-05の局所成立範囲、変更path、production consumerとroute/evidence分類、専用selectorおよび必須commandの正確な結果、doctor/標準testの失敗・未実施・環境限界、費用推定の限界、C05親とP13状態、branch/commit/push/remote main、二世代backup refsとrollback pointを日本語で報告する。fixture/local、provider live、installed/releaseを区別する。

## 16. Next-phase dependency

本単位の整理、安全review、必須検証、二世代backup rotation、main単一commit/push、remote refs/clean照合、private引継ぎを完了した後に停止する。次単位は委任pack内の次候補を状態と実装指示から改めて同期し、ownerの継続指示を待つ。C05親はpartialのまま、P13はPENDING_OWNER_GO、public_claim_allowed=falseを保つ。
