# BLUE-TANUKI 有効な実装指示

現単位: **C07.01 — 一次記録と意味更新案の分離**。owner が委任した範囲から一単位だけを扱う。Windows / PowerShell を通常の開発環境とし、WSL は要件にしない。GitHub は検証済み成果と履歴の保管先として、単位ごとにバックアップ、commit、push、remote照合まで行う。公開主張、外部業務作用、出荷判断、owner GO はこの委任に含まれない。

## 1. 目的

正規境界を通った入力の取得記録と、Cから届く意味更新案を別々の記録として扱い、取得を真実性や採用へ読み替えない。

有限到達状態は、canonical inbound が未評価・未採用の observation acquisition として保存され、成功した既知LLM commandからの構造化proposalが、根拠・反証確認・適用範囲・旧版・反映先を備えた別の非権威履歴として保存されること。J承認またはM反映は行わない。

## 2. Phase 境界

通常のGateway inboundとLLM feedbackの経路に限定する。観測入力はGateway境界で受け入れたcanonical inboundのdigest記録とする。C proposalはExecutorを通してHDSが再検証し、Gatewayが成功した既知のLLM commandに限って履歴へ記録する。

proposalはreference/digestのclaimであり、内容の正しさ、証拠の実在、意味の採用を確認しない。標準providerにproposal生成機能があるとは主張しない。

## 3. Scope

- packages/protocol/src/状態更新契約.ts
- packages/protocol/src/types.ts
- packages/protocol/test/状態更新契約.test.ts
- packages/protocol/test/types.test.ts
- packages/blue-tanuki/src/llm/base.ts
- packages/blue-tanuki/src/executor.ts
- packages/blue-tanuki/test/executor_dispatch.test.ts
- packages/hds-brain/src/complete-history/codec.ts
- packages/hds-brain/src/complete-history/store.ts
- packages/hds-brain/src/controller.ts
- packages/hds-brain/src/types.ts
- packages/hds-brain/test/complete_history.test.ts
- packages/hds-brain/test/controller.test.ts
- apps/gateway/src/serve.ts
- apps/gateway/test/serve_boundary.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（既存CHANGELOG debtのSHA-256だけを同期）

この一覧以外を変更しない。追加pathが必要になったら編集前にprivate施工記録をREPLANし、stateとtask packetを更新・再照合する。

## 4. Non-goals

C07.02のJ承認/M反映、C07.03の誤記憶隔離・復旧、MemoryCommitの作成・適用、M/J保存取引、C07親全体、外部observer、標準providerのprompt/response形式変更、UI作成導線、cross-repo、外部送信、credential確認、release/GA/P13/owner GOを扱わない。raw inbound本文、raw proposal文、根拠本文は新しい記録へ保存しない。

## 5. 最初に確認する files / symbols

`InboundRequestSchema`、`ExecuteFeedbackSchema`、`LLMResponse`、`Executor.executeLLMCall`、`Gateway handler`、`recordExecutionHistory`、`finalizeCommandOutput`、`HDSUpperController.onFeedback`、`CompleteHistoryStore.append/decode/verify`、C03.04とC06.03の受入・Git閉鎖記録を確認する。開始時にrepo ID/origin、branch、HEAD、dirty状態、remote refs、Windows toolchain、依存profile、通常consumer、selectorをprivate記録へ固定する。

## 6. 必須grep

`meaning_update_proposal`、`observation_acquisition`、`ExecuteFeedbackSchema`、`LLMResponse`、`executeLLMCall`、`onFeedback`、`CompleteHistoryStore`、`record_type`、`used_for_authority`、`may_apply`を検索する。proposalが実行結果や表示へ漏れないこと、CompleteHistory JSONL再読込でも契約検査されること、誤った種別・未知fieldを拒否することを確認する。

## 7. 既存 anchor

Gateway handlerはcanonical inboundだけを通常履歴・返信・実行に渡し、raw invalid入力はHDSの独立fail-closed境界監査へ限定する。ExecutorはLLM応答からExecuteFeedbackを構成する。Gateway finalizationはHDS `onFeedback` と出力監査を通す。CompleteHistoryはhash-chainとdigest-onlyの共通record投影を持つ。C07.01はこの責任分担を使い、新しいauthority経路や記憶commit経路を作らない。

## 8. 実装要件

1. ObservationAcquisition契約はcanonical request由来の参照・digest・件数だけを許し、semantic statusをunassessed、adoptionをnot_adopted、authority/world-truth flagsをfalseに固定する。
2. MeaningUpdateProposalはcandidate/target/prior version、support evidence、明示したcounterevidence review、applicability scope、reflection targetを要求する。入力はstrictに検証し、proposalはunverified・not_adopted・may_apply=false・used_for_authority=falseに固定する。
3. LLMResponseのproposal fieldは未信頼として扱う。Executorはそれを可視result/session出力から除き、HDS feedbackへ渡す。
4. HDS `onFeedback` はproposalを独立再検証し、statusと成功時digestだけをhash-chain auditへ記録する。未知command、失敗feedback、不正shapeはpassed扱いにしない。
5. Gatewayはcanonical inboundだけをobservation recordにし、proposalは成功・一致・LLM commandだけを`audit_history`の別payloadとして記録する。CompleteHistory appendとJSONL load/verifyはrecord_typeごとのstrict contractを再検査する。
6. proposalはCompleteHistoryの共通record/UI/API投影へ本文として出さない。既存digest-only projectionとnon-authority flagsを維持する。
7. いずれの経路もJ approval、MemoryUpdateLedger、MemoryCommit、永続semantic adoption、実行へ接続しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、standalone HDS、Layer A/B、fail-closedを維持する。inbound、LLM proposal、evidence ref、metadata、CompleteHistoryは権限を生成しない。C07.01は内容の検証・承認・採用・反映・実行をしない。invalid shapeやunknown record typeを履歴へ通さない。

## 10. Operator usability

観測記録の意味状態とproposalの契約statusを分ける。HDS auditにはproposalのraw fieldやreference本文を置かず、valid proposal digest、status、non-authority flagsのみを置く。CompleteHistory API projectionもdigest/metadataに限る。契約失敗は理由分類だけを表示・記録し、raw inputをerrorへ含めない。

## 11. Tests

- BT-U-C07.01-P: canonical inboundから未評価・未採用のobservation recordを作り、raw contentを保存しない。
- BT-U-C07.01-P: 構造化LLM proposalがExecutorからExecuteFeedback、HDS audit、別CompleteHistory eventへ届き、raw proposal本文をvisible result/audit projectionへ出さない。
- BT-U-C07.01-N: invalid inbound、malformed proposal、未知record field/kind、unknown command、非LLM command、failed feedbackはobservation/proposal adoptionまたは永続提案recordにならない。
- JSONL round-trip/load、hash-chain、digest-only common-record projectionを通す。

対象selector: `packages/protocol/test/状態更新契約.test.ts`、`packages/protocol/test/types.test.ts`、`packages/blue-tanuki/test/executor_dispatch.test.ts`、`packages/hds-brain/test/complete_history.test.ts`、`packages/hds-brain/test/controller.test.ts`、`apps/gateway/test/serve_boundary.test.ts`。

## 12. Validation commands

commit前に現行repoの必須検証をすべて実行する。

~~~powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
pnpm run doctor
pnpm validate:packaging
pnpm hds:standalone
pnpm validate:japanese-base
~~~

失敗を隠さず今回起因・既存・環境限定・未確定に分類する。smoke:serve/resumeは通常unit scope外なら未実行と明記する。live smoke、release gate/bundle/verify、strict Japanese-base gateは今回の受入条件でない。既存Gateway listenerやcredentialを停止・読取りしない。

## 13. Manual smoke

専用Vitest selectorで、canonical inbound、C proposal transport、HDS audit、CompleteHistory append/load、raw非保持、unknown/failed拒否を合成fixtureで確認する。実provider、外部送信先、実tool、credentialを使わない。

## 14. Permanent-use check

成立するのはcanonical acquisition receiptと、構造化proposalの限定的な受け渡し・digest audit・別履歴までである。根拠refの解決・真偽確認、標準providerによるproposal出力、J承認、Mへの反映・再起動後semantic adoption、誤記憶隔離・回復、C07親scenario、installed/live、release readinessは未成立。

## 15. Final report format

C07.01の成立条件、変更path、実consumer、positive/negative selector、各必須commandの正確な結果、証拠源/経路、doctorまたはhost制約、未実施、authority/release/P13状態、main commit、push/remote HEAD、二世代backup refs、rollback pointを日本語で報告する。fixture/local evidenceをlive/installed/external evidenceに読み替えない。

## 16. Next-phase dependency

この単位の局所受入とGit閉鎖を記録して停止する。親C07完了やC07.02開始を推定しない。次単位は最新private state・ledger・repo状態から別の入口で依存、profile、許可scopeを再照合する。
