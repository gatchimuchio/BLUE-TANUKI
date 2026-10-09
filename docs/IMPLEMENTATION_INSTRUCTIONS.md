# BLUE-TANUKI 有効な実装指示

現単位: **C05.02 — provider応答・tool candidate・中断境界**。profileはcompute-local。provider応答は検証して型付きnon-authority dataとしてGatewayへ返し、native tool callは実行せず候補として保持する。timeout・cancel・disconnect・partial/malformed responseは秘匿情報を含まないtyped failureへ分類する。環境構築は完了済みとして再実施せず、通常開発はWindows / PowerShellで行う。GitHubは検証済み成果と履歴の保管先であり、本単位も検証後に規定の二世代backup、main commit・push、remote照合まで閉じる。

## 1. 目的

C05.01のgeneric Compute identityを維持し、LLM provider responseを安全に解釈して通常Gateway出力・HDS feedback auditへ接続する。OpenAI互換のnative tool_callsとAnthropic tool_useを、schema検証済みのcandidate-only dataへ正規化する。Executor、adapter、SDKはtoolを実行しない。ownerによる別操作の承認とHDS-BRAINの既存Approval Gateは本単位の外に維持する。

有限到達条件: provider応答を消費する間もtimeoutとcaller cancellationが有効であり、正常な文章応答は従来経路で返る。native tool callは実行不能・非権限フラグ付きcandidateとしてExecutor feedbackと最終表示経路へ伝わり、HDS auditにはraw引数を保存せずdigest/countだけを残す。部分・不正応答、切断、timeout、cancelは安定したtyped failureになる。通常Gateway fixtureで、候補がHDS finalizationを通ってもToolRegistry等が呼ばれないこととhash-chain auditを確認する。

## 2. Phase 境界

対象はprovider response adapter、LLM abort/timeout/error型、Executor feedback、protocol schema、HDS feedback audit型と処理、Gateway finalization fixture、active instructionおよび作業進捗文書である。HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、Layer A/Bを維持する。

C05.03のfallback/egress allowlist、credentialed/live provider、費用実額、Mini Dora provider、Control Center表示、installer/bundle、release/GA/P13/owner GOは対象外。private施工pack・原典・実行state/evidence・secretはrepositoryへ含めない。providerへ要求するtool schema追加、SDK導入、LLM outputによる判断・実行も行わない。

## 3. Scope

- packages/protocol/src/types.ts
- packages/protocol/test/types.test.ts
- packages/hds-brain/src/controller.ts
- packages/hds-brain/src/types.ts
- packages/hds-brain/test/controller.test.ts
- packages/blue-tanuki/src/llm/base.ts
- packages/blue-tanuki/src/llm/index.ts
- packages/blue-tanuki/src/llm/fetch_timeout.ts
- packages/blue-tanuki/src/llm/openai_compatible.ts
- packages/blue-tanuki/src/llm/anthropic.ts
- packages/blue-tanuki/src/llm/compute.ts
- packages/blue-tanuki/src/llm/registry.ts
- packages/blue-tanuki/src/executor.ts
- packages/blue-tanuki/test/llm_provider_responses.test.ts
- packages/blue-tanuki/test/llm_compute.test.ts
- packages/blue-tanuki/test/llm_registry.test.ts
- packages/blue-tanuki/test/executor_compute.test.ts
- apps/gateway/test/compute_identity.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（既存CHANGELOG fingerprint debtの同期に限る）

上記外は変更しない。追加pathが必要ならprivate施工stateと受入記録を先にREPLAN・再同期する。

## 4. Non-goals

fallback semantics・fallback provider allowlist・provider別egress authorization、実provider/外部送信/credentials、provider費用推定、provider出力の意味的妥当性保証、tool実行、tool schema送信、memory/history authority化、Approval Gateやpolicy変更、LLMによるapproval/risk判断、GUI/UI変更、Mini Dora本体、GA/release/owner GO、他repo作業、環境再構築を行わない。C05.01のCompute identity意味論を再設計しない。

## 5. 最初に確認する files / symbols

LLMResponse、LLMBackend.call、LLMProviderError、fetchWithProviderTimeout、provider request/response parsing、LLMRegistry.callWithRetry、Executor.executeLLMCall、ExecuteFeedbackSchema、HDSUpperController.onFeedback、OutputAudit、Gateway finalization、ToolRegistry.invoke、FINAL_REVIEW_OPERATION_LIST、C05.01 Compute identityを確認する。開始時のmain/remote/backup refs・clean状態とNode/Corepack/pnpm版を記録する。既存環境を再設定しない。

## 6. 必須grep

LLMResponse、tool_calls、tool_use、finish_reason、stop_reason、AbortSignal、fetchWithProviderTimeout、callWithRetry、retryable、ExecuteFeedbackSchema、onFeedback、ToolRegistry.invoke、finalizeCommandOutput、used_for_authority、OutputAudit、FINAL_REVIEW_OPERATION_LISTを検索する。response body読取り全体がtimeout/cancelの内側にあること、raw HTTP error body/provider payloadをerror・auditへ出さないこと、candidateが実行経路に接続されないこと、feedback auditがraw argumentsではなくdigest/countを記録することを確認する。fallbackの既存動作は今回変更せず、cancel済み処理をretry/fallbackへ進めない。

## 7. 既存anchor

provider adapterはraw fetchであり、外部SDKやtool executorはない。OpenAI互換tool_callsとAnthropic tool_useはC05.02開始時点で応答から失われている。既存のHDS/Gateway finalizationはreview・feedback・OutputAuditの統治済み経路を持つ。HDS feedback auditはdigest主体でraw resultを複製しない。C05.01はprovider input/outputと実provider/modelをnon-authority Compute identityに結んでいる。

候補は下流のprovider outputであり、approval origin・authority・commandを作らない。HDS-BRAINのfeedback受理とoutput auditは既存の唯一経路を保つ。timeoutはHTTP header受信時点で解除せず、body消費完了まで有効にする。

## 8. 実装要件

1. Protocolにstrict schemaのtyped LLM failureとtool-call candidateを定義する。failureはkind/provider/status/retryability等の限定情報、candidateはprovider/id/name/検証済みJSON argumentsとcandidate-only/non-authority flagsに限る。raw provider message、credential、HTTP error bodyを載せない。
2. OpenAI互換tool_callsとAnthropic tool_useをcandidateへ変換する。欠落・不正なID/name/arguments、危険なJSON key、過大/過深/過多な構造をfail-closedで拒否する。providerへtool schemaは送信しない。SDK・executorによるnative call自動実行を導入しない。
3. Provider responseのJSON/bodyを上限付きで検証する。malformed/partial/unsupported structured responseはtyped invalid/partial failureとし、provider raw textをerrorやfeedbackに含めない。HTTP errorはstatus等の限定metadataだけを使う。
4. timeoutをheader取得からbody全読了まで適用し、caller AbortSignalをfetch/provider/compute/Executorへ伝播する。cancel/timeout時は処理を打ち切り、後続retry/fallbackを開始しない。network disconnectはtyped failureへ分類する。
5. malformed/partial/network/cancel/timeout failureのretry可否を型へ結ぶ。C05.03 fallback policyを先取りせず、既存のretry/fallback挙動を不必要に拡張しない。
6. Executorは候補をExecuteFeedbackへ返し、candidate-onlyフラグを検証する。candidateだけの応答で空assistant messageをsessionへ永続化しない。ToolRegistry、Approval Gate、実行権限、risk分類へ接続しない。
7. HDS feedback auditはtyped failure要約とcandidate count/digestを記録し、raw candidate arguments/contentを保存しない。Gateway通常finalizationを通すintegration fixtureでcandidateが保持され、表示/output auditが成立することを確認する。
8. C05.01のcompute identity、provider/model識別、output digest、既存Approval GateとHDS standalone境界を維持する。credential/live providerは使わない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、high-risk/unknown/tool.callのL3 final review、audit hash-chain、Runtime Invariants、fail-closed、memory/history/LLM/provider/candidate metadataのnon-authority、standalone HDS、Layer A/Bを維持する。candidateの存在・schema妥当性・LLMの文章から承認や実行資格を推定しない。cancel後にprovider処理を再開・再送しない。監査へraw prompt/response/tool arguments/credentialを漏らさない。

## 10. Operator usability

局所failure kindからtimeout/cancel/disconnect/partial/invalid responseを区別でき、secret/raw contentを露出しない。tool candidateは候補であり未実行と明示できる構造を保つ。retry可否はtyped metadataと既存制御で判定し、error表示から再試行可能性を誤認させない。provider failureのHTTP statusがある場合もbodyは記録しない。

## 11. Tests

- BT-U-C05.02-P: OpenAI互換tool_callsとAnthropic tool_useがschema検証済みcandidateになる。通常Gateway→Executor→HDS feedback/finalization経路で候補が保持され、OutputAudit/hash-chainが成立する。
- BT-U-C05.02-N: malformed JSON/arguments、危険key、partial response、body上限超過、HTTP error bodyはtyped failureとなり、raw provider contentをfeedback/audit/errorへ露出しない。ToolRegistry.invokeは呼ばれない。
- BT-U-C05.02-D: timeoutがresponse body読了まで有効。caller cancellation/timeoutでprovider AbortSignalが停止し、retry/fallbackも開始しない。disconnectはtyped failureになる。
- C05.01 Compute testsを維持し、provider input/output digestとidentityの回帰がないことを確認する。test fixtureはFIXTURE、Gateway/HDS経路は局所INTERNAL_STATE evidenceであり、外部provider/live挙動やrelease readinessを証明しない。
- Selector: packages/blue-tanuki/test/llm_provider_responses.test.ts、packages/blue-tanuki/test/llm_compute.test.ts、packages/blue-tanuki/test/llm_registry.test.ts、packages/blue-tanuki/test/executor_compute.test.ts、packages/protocol/test/types.test.ts、packages/hds-brain/test/controller.test.ts、apps/gateway/test/compute_identity.test.ts。

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
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/blue-tanuki/test/llm_provider_responses.test.ts packages/blue-tanuki/test/llm_compute.test.ts packages/blue-tanuki/test/llm_registry.test.ts packages/blue-tanuki/test/executor_compute.test.ts packages/protocol/test/types.test.ts packages/hds-brain/test/controller.test.ts apps/gateway/test/compute_identity.test.ts

HDS standalone selectorも実行する。日本語基底strict gate、smoke:serve/resume、credentialed live、release gateは今回の受入範囲外であり、実施の有無を正確に報告する。標準test timeoutは実結果のまま記録し、timeout設定を緩和しない。必要な場合だけ同じ全testを逐次実行して原因を分類する。credentialを読み出さず、既存listenerを停止しない。

## 13. Manual smoke

専用fixture selectorでprotocol validation、provider candidate化、Executor cancellation/timeout、Gateway finalization、HDS digest-only audit/hash-chainを通す。credential、live external provider、GUI、外部送信先は使わない。tool実行を起動しない。

## 14. Permanent-use check

今回成立させるのはWindows上の既存Gateway/provider adapterから型付き応答・候補とtyped failureを通常Executor/HDS feedback経路へ渡す局所契約までである。証拠はsource inspection、FIXTURE、local validation、通常経路fixtureに限る。providerの実受領、external egress policy、候補の人間review UX、実資格情報/live運用、長期運転、installed/release、C05.03、親C05全体は未成立である。owner GO、GA、公開claimを推定しない。

## 15. Final report format

BT-R-C05-02の局所成立範囲、変更path、production consumerとroute/evidence分類、専用selectorおよび必須commandの正確な結果、doctor/標準testの失敗・未実施・環境限界、C05親とP13状態、branch/commit/push/remote main、二世代backup refsとrollback pointを日本語で報告する。fixture/local、provider live、installed/releaseを区別する。

## 16. Next-phase dependency

本単位の整理、安全review、必須検証、二世代backup rotation、main単一commit/push、remote refs/clean照合、private引継ぎを完了した後に停止する。C05.03へ自動進行しない。C05親はpartialのまま、P13はPENDING_OWNER_GO、public_claim_allowed=falseを保つ。
