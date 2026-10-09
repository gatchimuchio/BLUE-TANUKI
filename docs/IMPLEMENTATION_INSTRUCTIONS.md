# BLUE-TANUKI 有効な実装指示

現単位: **C06.03 — 懐疑・追加観測・対象枠再開放**。owner委任に基づきC06.02を依存として、一単位のみを実施する。懐疑入力は下流からの未検証claimとして扱い、元の目的文と影響しない機械・process検査を維持したまま、指定scopeだけを再検討する。追加観測は依頼状態として記録し、独立検証や外部作用は行わない。通常開発はWindows / PowerShellを使い、GitHubは検証済み成果と履歴の保管先として単位ごとのpushまで閉じる。

## 1. 目的

C06.02のrequest-bound criteria/candidate feedbackへ、厳密な懐疑review inputを接続する。既知の局所検査を保ちつつ、対象criterion範囲の再観測要求、代替仮説のdigest、目的文を変えないcriteria projection correction案をHDS feedback auditへ記録する。

有限到達条件: 通常Gateway finalizationからHDSUpperController.onFeedbackまでsynthetic reviewを通し、矛盾したreportをclaimとして識別し、影響scopeだけを保留・再観測待ちにする。proposed criteriaをrequest ID・元本文digestへ束ねてcandidate relation/dispositionを再計算する。元のgoal projection、機械契約検査、process allowlist検査を維持し、review内容のraw文字列をauditへ保存しない。すべてmay_execute=false、used_for_authority=falseである。

## 2. Phase 境界

通常Gateway feedbackからHDS auditへの非権威review計画を追加する。追加observer、provider出力からのreview自動生成、UI操作面、永続的なworld-state変更は追加しない。矛盾reportやproposed correction自体を独立証拠とみなさず、独立観測の実施完了も主張しない。

## 3. Scope

- packages/protocol/src/types.ts
- packages/protocol/test/types.test.ts
- packages/hds-brain/src/candidate_criteria.ts
- packages/hds-brain/src/controller.ts
- packages/hds-brain/src/types.ts
- packages/hds-brain/src/skeptical_review.ts
- packages/hds-brain/test/controller.test.ts
- apps/gateway/test/serve_boundary.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（CHANGELOG fingerprintの既存SHA-256のみ更新）

上記外は変更しない。追加path、UI/provider producer、evidence store、観測実行が必要になった場合は実装前にprivate施工記録をREPLANする。

## 4. Non-goals

C06.01/02の再実装、criteria意味の独立検証、独立観測の作成・取得、恒久的な対象枠更新、candidate実行・採用・承認・権限、Approval Gate変更、ToolRegistry接続、LLMによる自己評価、raw report/hypothesis/criteriaのaudit保存、HDSからLLM/API呼出し、外部作用、credential/live provider、UI authoring、他repo変更、release/GA/P13/owner GO、環境再構築を行わない。対象枠訂正案は同じ依頼のcriteria projectionに限る。元の依頼文・goal projectionは変更しない。

## 5. 最初に確認する files / symbols

SkepticalReviewRequestSchema、ExecuteFeedbackSchema、GoalCriteriaSchema、projectRequestGoalCriteria、projectGoalCriteriaForBinding、HDSUpperController.onFeedback、ExecutorFeedbackAuditTrace、assessCandidateGoalCriteria、determineCandidateAdoptionDisposition、Gateway finalizeCommandOutput、C06.02 closeout evidenceを確認する。開始時にbranch/head/remote/dirty状態、Node/Corepack/pnpm版、backup refs、通常consumerとtest selectorを記録する。

## 6. 必須grep

skeptical_review、SkepticalReviewRequestSchema、observation_reports、alternative_hypotheses、proposed_goal_criteria、onFeedback、ExecutorFeedbackLog、candidate_goal_criteria、may_execute、used_for_authorityを検索する。raw report/hypothesis/proposed criteriaがauditへ入らないこと、未知・scope不一致がcandidate状態を変えないこと、source command不在時にreviewを起動しないことを確認する。

## 7. 既存 anchor

C06.02はstrict request criteriaをrequest IDと元本文SHA-256へ束ね、candidateのcriteria関係をHDS通常feedback監査へ記録する。supportはassumed / risk unverifiedでheld、conflictはrejected、unknownはheldであり、candidateは非実行・非権威である。C06.03はこの既存assessmentを上書きしない。review audit traceへ前状態、維持した機械契約・process allowlist確認、影響scopeのreview dispositionを別投影する。proposed criteriaは同じrequest bindingを再利用し、入力claimとしてassumedのまま扱う。

## 8. 実装要件

1. ExecuteFeedbackにstrictな懐疑review schemaを追加する。observation report、hypothesis、criteria proposalは下流claimである。
2. HDSはreview入力を再検証する。不正入力はraw valueを保存せずfailedと限定statusだけを記録する。
3. review auditはreport/hypothesis/criteria本文のdigest、affected criterion ref digest、conflicting report scope、binding状態、pending follow-upを記録する。
4. 対象refが現行または提案projectionに一致しない場合はunmatched_scopeとし、既存candidate assessmentを変更しない。
5. review時のcandidate traceは既存mechanical/domain checkをそのまま保持する。異議範囲だけをreview disposition heldにする。criteria correction案がある場合は同じrequest binding上でcriteria assessment/dispositionを再計算するが、独立観測前のproposalなのでauthority/executionへ接続しない。
6. 元の依頼文、元のgoal projection ID/content digest、元candidate assessmentは保持する。提案は元のgoal textを書き換えない。
7. Gateway finalizationからHDS feedback consumerまで通常経路の合成fixtureを通し、audit hash-chainとraw非保持を確認する。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、standalone HDS、Layer A/B、fail-closedを維持する。feedback、報告、LLM/tool output、memory/history、metadata、hypothesis、proposed frameは権限ではない。懐疑入力は元判断や確認済み局所checkを消去できず、追加観測要求は実行・外部接続・承認ではない。unknown/unmatchedは状態昇格しない。

## 10. Operator usability

audit traceはrecorded / invalid / unbound / unmatched_scopeを分け、claimはassumed、提案frameはproposed_unverified、次段はindependent_observationとして表示する。影響candidateだけの前後dispositionと維持した機械/process checkを示す。実際の独立観測・修正確定・長期保留回復導線は未実装と明記し、このtraceだけで永続停止を起こさない。

## 11. Tests

- BT-U-C06.03-P: 同一criterionの相反するreportは限定scopeだけ再開し、他candidateとobserved mechanical/process checksを維持する。hypothesis/report本文はdigest-only、次段は独立観測待ち、非権威・非実行。
- BT-U-C06.03-P: criteria frame correction案は元goal bindingを変えず、提案criteriaでcandidate relation/dispositionを再計算し、根拠未確認ならheld/rejectedのままにする。
- BT-U-C06.03-N: malformed reviewまたはunmatched scopeはrawを保存せず、既存assessmentに影響しない。
- protocol schemaを通常Gateway finalization→HDS onFeedbackまで通し、audit chainとcandidate non-executionを確認する。

## 12. Validation commands

commit前必須:

~~~bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
~~~

実装単位追加:

~~~bash
pnpm run doctor
pnpm validate:packaging
pnpm hds:standalone
pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/protocol/test/types.test.ts packages/hds-brain/test/controller.test.ts apps/gateway/test/serve_boundary.test.ts
pnpm validate:japanese-base
~~~

strict Japanese-base gateは移行負債が残るため今回の受入条件にしない。smoke:serve/resumeは今回のruntime scope外。credentialed live、release gateは実行しない。既存listenerを停止せず、timeoutやgate閾値を変更しない。

## 13. Manual smoke

専用Vitest selectorでGateway inbound、通常finalization、HDS feedback audit、request binding、限定scope、frame correction proposal、raw非保持、audit hash-chainを確認する。credential、実provider、実tool、外部送信先を使用しない。

## 14. Permanent-use check

成立するのは内部ExecuteFeedback契約経由のreview proposal記録・限定再計画までである。独立観測provider、観測証拠の出所検証、operator authoring/UI、保存をまたぐ再開、実world factの確認、恒久的な対象枠訂正、親C06全体、installed/live、release readinessは未成立。C06親はpartial、P13はPENDING_OWNER_GO、public_claim_allowed=falseのまま。

## 15. Final report format

C06.03の成立範囲、変更path、Gateway/HDS consumer、証拠源と経路分類、positive/negative test、全validation commandの正確な結果、未実施/live・release制限、C06/P13状態、main commit、push/remote main、二世代backup refs、rollback pointを日本語で報告する。fixture/local結果をindependent/live evidenceへ読み替えない。

## 16. Next-phase dependency

C06.03終了後ここで停止する。最新private stateとunit ledgerを再読し、次の一単位の依存・profile・許可scopeを新たに確認する。親C06完了、次unit開始、release/owner GOを自動推定しない。