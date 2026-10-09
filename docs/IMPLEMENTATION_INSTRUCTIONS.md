# BLUE-TANUKI 有効な実装指示

現単位: **C04.03 — 権限非復活と依存版失効**。`PRODUCT_BUILD_MODE`、profile `core`。直接依存C04.02の有限受入とpush済みcommitを参照し、証拠を今回のprofile全体へ拡張しない。現在射影が実際に消費する不変記録の版を個別に追跡し、過去decisionを履歴証拠として保持しながら現在権限へ戻さない。検証後は二世代backup、`main`への単一commit・push、remote照合まで閉じ、ここで停止する。GitHubは検証済み成果と履歴の保管面である。別repo、業務上の外部作用、公開主張、出荷判断、owner GOは別境界である。環境構築は完了済みとして再実施せず、作業環境はWindowsを使う。

## 1. 目的

BT-R-C04-05/06の今回範囲として、HDSの過去判断を出所付きの履歴証拠として明示し、今回の許可・承認・grantへ変換しない。Cへ渡した現在射影が実際に含むF record IDとimmutable hash版を個別の依存版一覧として残し、同じ候補集合をJの引用照合へ渡す。

有限到達条件: **過去承認は証拠のみとし、実際に依存する版の変更だけを再評価へ結ぶ。** 現行LTMは追記専用であり、依存版が一致しない候補は引用受入時に拒否する。依存一覧外の追記だけでは既存参照を全失効させない。局所条件を満たしたらここで停止し、親C04やreleaseの成立へ拡張しない。

## 2. Phase 境界

対象は既存の`MemoryTrace`、C向け候補context、J引用review、HDS hash-chain audit、Gateway audit-dumpである。C向けcontextとJ admissionは同じ現在候補集合・record/hash版を使う。HDS-BRAINの唯一authority、Approval Gate、grant store、L3 final reviewは変更しない。memory出所の過去decisionは証拠であり、current approvalではない。LongTermMemoryStoreのcanonical entryとappend-only/hash-chain動作を維持する。raw answer、summary本文、claim本文、command、secretを新しい監査項目へ複製しない。

## 3. Scope

- `packages/hds-brain/src/types.ts`
- `packages/hds-brain/src/memory_citation_review.ts`
- `packages/hds-brain/test/memory_citation_review.test.ts`
- `packages/hds-brain/test/controller.test.ts`
- `apps/gateway/src/audit_dump.ts`
- `apps/gateway/test/audit_dump.test.ts`
- `docs/IMPLEMENTATION_INSTRUCTIONS.md`
- `docs/ROADMAP.md`
- `docs/開発進捗.md`
- `CHANGELOG.md`
- `規定/移行台帳.json`（既存負債のCHANGELOG hash同期が必要な場合だけ）

上記以外は変更しない。追加pathが必要ならREPLANし、新たに再同期する。

## 4. Non-goals

C04.01の検索・意味解釈・引用採否の再設計、C04.02のsummary projectionや除外復帰の再設計、approval policy/grant storeの変更、過去grantの復元機構、全memory schema刷新、全履歴投入、session-store/CompleteHistoryの改修、全LTM再走査・global memory epoch、別repo、外部作用、credentialed provider/live、実ユーザーデータ、GUI大型変更、release/GA/P13/owner GOを扱わない。rev1.1原典、owner原文、private運転状態、secret、raw実行証拠はrepoへ含めない。

## 5. 最初に確認する files / symbols

対象repoの`AGENTS.md`、日本語正本、SECURITY/AUDIT/CONFIG/README/CHANGELOG、ROADMAP、開発進捗、C04.03・親要求、指定仕様節・原典、C04.02実装と受入記録を照合する。`MemoryRecordProvenance.source_decision`、`buildMemoryTrace`、`verifiedCandidates`、`currentProjectionCandidates`、`buildMemoryCitationSystemMessages`、`reviewMemoryCitationOutput`、`MemoryCitationReviewLog`、`HDSUpperController.reviewMemoryCitations`、`evaluateApproval`、LTM `verify/all/findByRequestId`、Gateway audit-dumpを追う。開始HEAD、remote、dirty帰属、local recovery refs、remote backup refsを記録する。

## 6. 必須grep

`source_decision`、`used_for_authority`、`MemoryCitationReference`、`candidate_references`、`dependency_versions`、`accepted_citations`、`reviewMemoryCitations`、`evaluateApproval`、`LongTermMemoryStore`、`FINAL_REVIEW_OPERATION_LIST`、`memory.citation_review`、`AUDIT.md`を検索する。過去decisionをgrant/ApprovalGateへ渡す経路、現在候補とJ admissionの不一致、依存集合外の全失効、同一IDの版不一致を通す経路、raw contentの監査複製がないことを確認する。

## 7. 既存anchor

LTMはimmutable entry hash-chainを検証し、記録の更新・削除APIを持たない。`MemoryTrace`は候補のF参照、entry hash、provenanceを持つ。`verifiedCandidates`はsource/reference/hashの一致を確認し、explicit F指定では`currentProjectionCandidates`が完全一致した候補だけに絞る。Jは同じ候補から作ったrecord ID/hash版のmapで引用を照合し、古いhashは`version_mismatch`で拒否する。Approval評価は現在のExecuteCommandと現在のgrantsだけを入力とし、memory traceを読まない。high-risk `tool.call`、`shell.exec`、unknown等はfull accessでもL3 final reviewとなる。

不足しているのは、C context内の依存版の明示的な集合名と、C04.03監査記録・operator audit-dumpへの同集合の記録である。source decisionの出所値はpromptと照合済み参照表示に現れるが、履歴証拠のみという表示が足りない。

## 8. 実装要件

1. C contextの`dependency_versions`は今回実際に渡す現在候補だけから作り、各要素を`{record_id, version}`とする。候補集合外のLTM全体hash/headを依存版として使わない。
2. 過去の`source_decision`とhashは「履歴証拠のみ」と明記し、今回の権限・承認・grantと区別する。引用表示にも同じ境界を示す。
3. `MemoryCitationReviewLog`へ同じ`dependency_versions`を記録し、既存のcandidate referencesと一致させる。旧監査recordで新fieldが欠けても読み取れるようにする。
4. J admissionは現在候補の同じ依存集合を用い、record IDとimmutable hash版の完全一致だけを採用する。依存版mismatchは候補単位で拒否し、他の一致候補や依存外の新規追記を一括失効させない。
5. Gateway audit-dumpで依存IDと完全版を表示し、raw summary、claim、result、commandを含めない。authority/non-authority flagsはfalseを保つ。
6. 履歴引用、dependency metadata、C提案はいずれもapprove/execute、risk/process分類、permission、approval、fallback authority、second authority pathを作らない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed、memory/history/external metadata non-authority、Layer A/B、standalone境界を維持する。high-risk/unknown/tool.callをmemory参照や過去`ASSERT`で許可しない。source verification failure、未解決参照、scope mismatch、版不一致時は照合済み引用を表示しない。依存版一覧は監査・再照合の証拠であり、権限や承認ではない。

## 10. Operator usability

利用者・次consumerが今回の射影に含まれたrecord IDと完全版、過去decisionの履歴上の意味、引用採否結果を確認できる。version mismatchならどの提案が拒否されたかをauditで特定できる。依存外の追加recordは当該射影の依存版を置換しない。未決状態を「承認済み」と表示しない。

## 11. Tests

- BT-U-C04.03-P: 合成LTMから明示参照の現在projectionを作り、C context、J review、hash-chain audit、audit-dumpの`dependency_versions`が同じrecord ID/hash版であることを確認する。別のmemory recordをappend後、新しい明示参照projectionが元の依存版だけで再構築・受理されることを確認する。source decisionが`ASSERT`の履歴でも、`tool.shell.exec`はfull access下でL3 `ask`のままであることを通常controller consumerで確認する。
- BT-U-C04.03-N: 同一F IDの旧hash版、候補外ID、誤scopeを拒否し、HDS照合済み引用を出さない。過去decisionは現在承認として表示せず、dependency/version以外のraw contentをaudit-dumpへ出さない。
- 実test selector: `packages/hds-brain/test/memory_citation_review.test.ts`、`packages/hds-brain/test/controller.test.ts`、`apps/gateway/test/audit_dump.test.ts`。
- Windows上の合成memoryと専用一時領域のみを使用し、fixture/local evidenceをlive/installed証拠へ読み替えない。

## 12. Validation commands

commit前必須:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

実装単位追加:

```text
pnpm run doctor
pnpm validate:packaging
pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/hds-brain/test/memory_citation_review.test.ts packages/hds-brain/test/controller.test.ts apps/gateway/test/audit_dump.test.ts
```

`pnpm test`並列実行にtimeoutがあれば正確な失敗を記録し、設定を変えず同じ全testを逐次で診断する。serve/resume/live smokeとrelease gateは今回のscope外であり、省略状態を報告する。既存Gateway/listener、credential、production memory、外部serviceは操作しない。

## 13. Manual smoke

固定したVitest consumer selectorを合成LTMで実行し、過去decisionの非権限表示、依存ID/hashの一致、unrelated append後の再構築、stale hash拒否、Approval Gate L3境界、hash-chain verify、audit-dump内容を確認する。実LLM provider/liveや外部書込みは起動しない。

## 14. Permanent-use check

今回成立させるのはWindows上の通常HDS projection/citation review、個別immutable版の再照合、non-authority audit projectionまでである。証拠源は`FIXTURE`とsource inspection/`INTERNAL_STATE`。semantic dependencyの完全な自動同定、全session/historyの依存解析、実providerの遵守、長期運転、OS crash/installed/live、release readiness、親BT-T-C04-01..04全体は未成立である。

## 15. Final report format

BT-R-C04-05/06の成立範囲、変更path、production consumer、risk/route/evidence分類、専用selectorと必須commandの正確な結果、doctorの失敗・未実施・残存限界、親C04/P13状態、branch/commit/push/remote HEAD、二世代backup refs、復元点を日本語で報告する。local acceptance、Git統合、live/installed、release判断を区別する。

## 16. Next-phase dependency

C04.03の正負条件、整理、安全review、必須検証、二世代backup、`main`単一commit/push、remote refs/clean照合、private引継ぎまで閉じて工程境界で停止する。C04親全scenario、session/full-history改修、release状態は未成立のまま保つ。P13は`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持し、owner GO/GAを推定しない。
