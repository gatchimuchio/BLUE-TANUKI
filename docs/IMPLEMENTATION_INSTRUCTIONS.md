# BLUE-TANUKI 有効な実装指示

現単位: **C06.02 — 目的が実際に採否へ作用する接続**。受信依頼に明示されたcriteriaとLLM tool candidateを同じrequest/Decisionへ束ね、候補の寄与・抵触をHDSのgoal-review dispositionに反映する。request由来のrelationは外部事実の検証ではない。支持は仮定として扱い危険未確認なら保留、明示的な抵触は拒否する。criteria本文、criterion参照、tool名、候補本文、argumentsをHDS auditへ保存せずdigestと限定状態だけを残す。候補は実行・承認・権限にならない。環境構築は完了済み、通常開発はWindows / PowerShellで行う。GitHubは検証済み成果と履歴の保管先であり、本単位も検証後に二世代backup、main commit・push、remote照合まで閉じる。

## 1. 目的

C06.01のcandidate-only feedbackを、現行requestの明示criteriaとの照合へ接続する。HDSはstrictな`GoalCriteria` contractをInboundRequest境界で検査し、accepted requestのIDと本文digestへ束ねる。HDSはcandidateのtool identifierとrequestが宣言したcriteria relationを比較し、支援・抵触・未照合を別に記録する。requestの支援宣言は未検証仮説のままなので`held`、criteriaとの明示的抵触は`rejected`、criteria不在・binding不整合・危険未確認は保留とする。数値scoreは安全条件を相殺しない。

有限到達条件: 通常Gateway inbound境界からHDS Decision/frameへrequest-bound criteriaが届き、通常executor-feedback経路で候補別relationがdigest-only auditへ記録される。支持・抵触・未知が採否状態へ異なる形で作用し、根拠・危険未確認は保留、明示的抵触は拒否となる。`may_execute=false`、`used_for_authority=false`を保つ。

## 2. Phase 境界

対象はprotocolのrequest criteria contractと正規化、HDS frame投影、candidate criteria照合と採否縮約、通常Gateway/HDS feedback consumer、`apps/gateway/test/serve_boundary.test.ts`による受信境界からfinalizationまでの結合確認、関連試験、C06.02のactive指示・roadmap・進捗・changelog、およびCHANGELOG fingerprintを固定する移行台帳の既存hash一項である。HDS-BRAIN standalone、唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、Layer A/Bを維持する。

C06.03の懐疑・追加観測・対象枠再開放、独立した意味・危険検証、criteriaを編集するUI、candidateのToolRegistry接続・実行・承認・goal変更、外部送信、実provider/live、Control Center、installer・bundle・release・GA・P13・owner GO、他repo、環境再構築は対象外。private施工pack、原典、実行state/evidence、secretはrepositoryへ含めない。

## 3. Scope

- `packages/protocol/src/goal_criteria.ts`
- `packages/protocol/src/types.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/test/goal_criteria.test.ts`
- `packages/protocol/test/types.test.ts`
- `packages/hds-brain/src/candidate_criteria.ts`
- `packages/hds-brain/src/frame.ts`
- `packages/hds-brain/src/controller.ts`
- `packages/hds-brain/src/policy.ts`
- `packages/hds-brain/src/types.ts`
- `packages/hds-brain/test/candidate_criteria.test.ts`
- `packages/hds-brain/test/controller.test.ts`
- `apps/gateway/test/serve_boundary.test.ts`
- `規定/移行台帳.json`（CHANGELOG.mdの既存SHA-256のみ更新。負債分類、件数、strict gateは変更しない）
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`

上記外は変更しない。追加pathが必要ならprivate施工stateと受入記録を先にREPLAN・再同期する。

## 4. Non-goals

criteria本文の自然言語解釈、LLMによる自己評価、未検証relationの観測済み化、危険の独立認定、bounded trialの実行、ToolRegistry接続、candidate実行、Approval Gate変更、goal/criteria更新、raw criteria/candidate/tool名/argumentsのHDS audit保存、権限生成、外部作用、credential/live provider、UIによるcriteria編集、release/GA/owner GO、他repo変更、環境再構築を行わない。criteriaはトップレベルの厳密なrequest contractだけで受理し、metadataから昇格しない。

## 5. 最初に確認する files / symbols

`GoalCriteriaSchema`、`InboundRequestSchema`、`parseInboundRequestAtBoundary`、`normalizeInboundRequestForAuthority`、Gateway `canonicalizeGatewayInbound`、`HDSUpperController.decide`、`FrameResult`、`HDSUpperController.onFeedback`、`LLMToolCallCandidateSchema`、`assessLLMToolCandidates`、`determineCandidateAdoptionDisposition`、`finalize_command_output.ts`、C06.01受入条件を確認する。開始時のmain/remote/backup refs・clean状態、Node/Corepack/pnpm版を記録する。既存環境は再設定しない。

## 6. 必須grep

`goal_criteria`、`GoalCriteriaSchema`、`candidate_goal_criteria`、`assessCandidateGoalCriteria`、`LLMToolCallCandidateSchema`、`onFeedback`、`ExecutorFeedbackLog`、`adoption_disposition`、`may_execute`、`used_for_authority`、`GoalProjection`、`finalizeCommandOutput`を検索する。criteriaがトップレベルrequestからだけ入り、metadata・candidate・LLM出力がauthorityへ昇格しないこと、候補がToolRegistry/execute/approvalへ届かないこと、raw criteria/tool名/argumentsがHDS feedback auditへ入らないことを確認する。

## 7. 既存 anchor

C06.01は通常Gateway finalizationから`HDSUpperController.onFeedback`へcandidateを渡し、strict contract/process allowlist/意味状態をdigest-only auditへ記録する。`GoalProjection`は通常request本文のdigest参照を保持するが、必要性・対象状態・evaluation rulesを自動同定しない。既存のgoal relation graphは表示・監査用であり候補criteriaの供給源ではない。criteriaがないrequestはgoal projectionを昇格させず、candidateを保留する。

新criteria contractは受信者がtask fitを明示する局所入力であり、危険の事実証拠・LLM自己評価・実行許可ではない。requestが宣言したtool/criterion支援は仮定、抵触はrequest内の明示禁止との照合であり、実ToolRegistry・引数schema・作用結果・criteriaの正しさを証明しない。

## 8. 実装要件

1. optionalなstrict `GoalCriteria`を`InboundRequestSchema`のトップレベルだけで受ける。空・重複・未知fieldはboundaryで拒否し、metadataからは取り込まない。
2. HDS frameにrequest IDと受信本文SHA-256へ結んだdigest-only projectionを置く。criterion refとtool名をhash化し、criteria本文とraw tool identifierは監査へ写さない。
3. feedback candidateのtool identifierを元Decisionのcriteria projectionと照合する。support/conflict/no matchを分け、候補・criterion・requestの関係と根拠状態を記録する。
4. request由来supportはassumed、riskはunverifiedとするため`held`。明示conflictは`rejected`。criteria不在・不一致・未知も`held`。aggregate scoreでこの縮約を相殺できない。
5. malformed requestは既存boundary fail-closed経路へ送る。criteria不在は合成基準を作らずunknownのまま保つ。
6. auditに候補digest、criterion/tool digests、限定enum/reason、`may_execute=false`、`used_for_authority=false`だけを残す。hash-chainを維持し、HDSからLLM・外部APIを呼ばない。
7. docsにはrequest contractの限界、built-in UI/channelでのcriteria authoring未接続、リスク未検証時の保留、実行・authority非接続を記録する。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、high-risk/unknown/tool.callのL3 final review、audit hash-chain、Runtime Invariants、fail-closed、standalone HDS、Layer A/Bを維持する。criteria、relation match、candidate、candidate digest、memory/historyはauthorityでない。LLMはcriteria・riskを自己認定しない。candidateはexecute不可で、goal-review dispositionは実行・承認・採用確定を意味しない。

## 10. Operator usability

request内criteriaとのmatch状態・根拠状態・reason codeを分けて追跡できるようにする。criteriaを送らない通常requestはheldになる。contractはトップレベルInboundRequest入力用であり、現行built-in UI/channelがcriteria authoringを提供するとは主張しない。support matchは依頼内の宣言に過ぎず、実ToolRegistry登録・tool固有argument schema・目的達成・危険検証ではない。raw criteria/candidateをauditやoperator resultへ露出しない。

## 11. Tests

- BT-U-C06.02-P: request-bound criteriaがsupportとcandidateをdigest-onlyで結び、assumed relationとunverified riskのためheldになる。
- BT-U-C06.02-N: explicit conflictはrejected。criteriaなし、no match、request binding不一致、risk unverifiedはheld。scoreがcriteria/safety gateを覆さない。
- malformed/duplicate/unknown criteriaはstrict boundaryでrejectし、raw payloadをauditへ残さない。metadataのみではcriteriaを作らない。
- Gateway inbound boundaryから`finalizeCommandOutput`までの合成fixtureでcriteria binding、HDS feedback assessment、digest-only auditを通し、実toolを呼ばない。
- audit chain、candidate non-execution/non-authority、既存`GoalProjection` unknown状態を確認する。証拠は合成fixtureとWindows local validationに限り、実provider、UI authoring、installed behavior、release readinessを証明しない。

## 12. Validation commands

commit前必須:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

実装を含む単位追加:

```bash
pnpm run doctor
pnpm validate:packaging
pnpm hds:standalone
pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/protocol/test/goal_criteria.test.ts packages/protocol/test/types.test.ts packages/hds-brain/test/candidate_criteria.test.ts packages/hds-brain/test/controller.test.ts apps/gateway/test/serve_boundary.test.ts
```

日本語基底規定自体を変えないためstrict language gateは今回の範囲外とする。credentialed live・release gateは実施しない。`smoke:serve/resume`はsmoke・root workspace・release gate単位ではない今回のscopeから外し、未実施として報告する。既存listenerは停止せず、標準timeoutやgate閾値を変更しない。

## 13. Manual smoke

専用Vitest selectorで通常InboundRequest boundaryからGateway finalization、criteria projection、request/command binding、candidate support/conflict/no-match、malformed criteria、raw非保持、audit hash-chain、non-authority boundaryを検証する。credential、live provider、外部送信先、実tool実行は使わない。

## 14. Permanent-use check

成立するのはrequestがトップレベルcriteriaを明示したときのHDS内digest-only照合とgoal-review dispositionまでである。criteriaを省略した通常requestはheld。built-in UI/channelからcriteriaを作るoperator導線、criteria意味検証、危険の独立証拠、bounded trial、ToolRegistry/tool argument安全性、実行・採用、長期運転、installed/release readiness、C06親全体は未成立である。owner GO、GA、公開claimを推定しない。

## 15. Final report format

BT-U-C06.02の成立範囲、変更path、Gateway/HDS consumer、request criteriaの非authority性、support/conflict/unknownの意味と限界、証拠源分類、専用selectorと必須commandの正確な結果、doctor/標準testの失敗・未実施・環境限界、built-in authoring未接続、C06親とP13状態、branch/commit/push/remote main、二世代backup refsとrollback pointを日本語で報告する。fixture/local、live/installed、releaseを区別する。

## 16. Next-phase dependency

本単位の整理、安全review、必須検証、二世代backup rotation、main単一commit/push、remote refs/clean照合、private引継ぎを完了した後に停止する。C06親はpartial、C06.03は未着手、P13は`PENDING_OWNER_GO`、`public_claim_allowed=false`を保つ。次候補C06.03は状態・依存・mode・criteria入力の実利用可能性を新しい入口から再同期して別単位で扱う。
