# BLUE-TANUKI 有効な実装指示

現単位: **C04.02 — 現在射影と可逆参照**。PRODUCT_BUILD_MODE、profile persistence。直接依存C04.01はC04.01 CLOSED/PUSHED_VERIFIEDの有限証拠を再利用する。ただしprofile coreの証拠は、既存HDS LTMの不変record/hash/sourceと引用review consumerに適用する範囲に限り、persistence profileの受入を代替しない。有限条件を実装・検証し、二世代backup、main commit/push、remote照合まで閉じて境界停止する。GitHubは検証済み成果と履歴の保管面とする。別repo、業務上の外部作用、公開主張、出荷判断、owner GOは別境界である。環境構築は完了済みとして再実施しない。作業環境はWindowsを使う。

## 1. 目的

BT-R-C04-03/04の今回範囲として、依頼scopeに沿うbounded HDS LTM候補からCへ必要な現在射影だけを渡し、射影が省く原記録の範囲・文字切詰め差・未評価の意味差と正確なF record/versionを結び、非採用・除外候補への復帰参照を監査記録に残す。

有限到達条件: **明示F参照がある依頼ではその完全一致候補だけがCのmemory contextと引用採用対象になり、ない場合は既存J検索policyのbounded候補を使う。射影差・非採用/除外参照がhash-chain監査に残り、元のLTM記録は変更・削除されない。**

## 2. Phase 境界

対象はHDS MemorySearchPlan/MemoryTrace、Cへ渡す候補射影、J引用照合、hash-chain audit、Gateway/WebChatのmetadata-only audit projectionである。記憶参照は意味解釈・監査に限り、承認、権限、process/risk分類、commit、実行、scheduleへ接続しない。LongTermMemoryStoreのcanonical entryとappend-only/hash-chain動作は維持する。raw answer、summary本文、未選択record本文を新しい監査fieldへ複製しない。

## 3. Scope

- packages/hds-brain/src/types.ts
- packages/hds-brain/src/memory_trace.ts
- packages/hds-brain/src/memory_citation_review.ts
- packages/hds-brain/test/controller.test.ts
- packages/hds-brain/test/memory_citation_review.test.ts
- packages/hds-brain/test/long_term_memory.test.ts
- apps/gateway/src/serve.ts
- apps/gateway/src/audit_dump.ts
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

C04.01の取得・意味解釈・引用reviewの再設計、C04.03の過去承認失効、全memory schema刷新、意味関係を正本entryへ書き戻すこと、全履歴投入、session-store改修、別repo、外部作用、credentialed provider/live、実ユーザーデータ、GUI大型変更、release/GA/P13/owner GOは扱わない。rev1.1原典、owner原文、private運転状態、secretはrepoへ含めない。

## 5. 最初に確認する files / symbols

対象repoのAGENTS、日本語正本、SECURITY/AUDIT/CONFIG/README/CHANGELOG、ROADMAP、開発進捗、C04.02・要求台帳・指定仕様section・指定原典、C04.01の実装と受入記録を照合する。MemorySearchPlan、MemoryTrace、buildMemoryTrace、MemoryHit.reason/matched_on/summary、LongTermMemoryStore.verify/all/findByRequestId、buildMemoryCitationSystemMessages、verifiedCandidates、reviewMemoryCitationOutput、HDSUpperController.buildCommand/reviewMemoryCitations、Gateway authority trace/audit-dumpを追う。開始HEAD、remote、dirty帰属、local recovery refs、remote backup tagsを記録する。

## 6. 必須grep

MemorySearchPlan、MemoryTrace、buildMemoryTrace、MemoryHit、buildMemoryCitationSystemMessages、verifiedCandidates、reviewMemoryCitationOutput、MemoryCitationReviewLog、candidate_references、accepted_citations、memory.citation_review、LongTermMemoryStore、used_for_authority、complete_history_used_for_authorityを検索する。明示F参照時のtag/recent fallback、C contextとJ admissionの候補集合不一致、summary truncationの差隠し、除外/非採用参照の喪失、原記録削除・書換え、raw contentの監査複製、authority経路接続がないことを確認する。

## 7. 既存anchor

buildMemoryTraceはexact/tag/recentとprocess policy max_hitsでLTM検索をboundedにし、MemoryTraceにsource record ID/hash/provenance/goal/problem_definition_id/abstractionを保持する。現状は明示F参照があっても取得hit全件をbuildMemoryCitationSystemMessagesがCへ渡し、goal/abstraction等を文字数で切っているが差を示さない。J reviewも同じ全hitを引用候補にする。review auditは候補参照と採用引用を持つ。DecisionLogのMemoryTraceとreview entryはhash-chain auditに保存され、Gatewayはmetadata projectionを提供する。LongTermMemoryStoreに削除APIはなく、append-only entry hash-chainをverifyする。実装anchorは探索結果であり、既存責任とテストconsumerを確認して限定変更する。

## 8. 実装要件

1. MemorySearchPlanにraw参照を保持せず、依頼に明示F参照が含まれる事実だけを保存する。明示参照があればCへのactive candidatesとJのadmission setをexact matchだけに制限する。明示参照が未解決でもtag/recentへfallbackしない。明示参照がない場合は現在policyが選んだbounded hitsを使う。
2. Cへ渡すrecordごとにrecord ID、immutable version、source/provenanceを残す。現在projectionが含めるsource fieldと省く原record fieldを機械可読metadataで示し、省略元field digestを参照版へ結ぶ。各文字切詰めfieldは元長、投影長、省略suffix digestを記録し、意味等価性は証明せず意味差が未評価で原文照合が必要と明記する。raw省略本文は保存しない。
3. 引用review監査へrecord単位のdispositionをhash-chainで記録する。採用、active context内の非採用、明示参照scopeによりC contextから除外、を区別し、各状態に正確なF ID/versionと理由を残す。summary difference metadataは参照とdigest/長さのみとし、claim本文/summary本文を複製しない。
4. C context生成とJ admissionが同じprojected candidate setを消費する。hidden/除外候補、候補外ID、旧版、誤scope、C score/rankによる引用を採用しない。
5. LongTermMemoryStore原記録へprojection status、C採否、summaryを追記・上書きせず、除外はderived request contextに限る。Append-only hash-chainの検証とsource recordへの復帰参照を保つ。
6. Gateway/WebChat auditはdisposition、F参照、版、理由、差分metadataだけを投影する。raw summary、raw answer、omitted textを出さない。authority/non-authority flagsはfalseを保つ。

## 9. Safety invariants

HDS-BRAIN唯一authority、LLM非authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed、memory/history/external metadata non-authority、Layer A/B、standalone境界を維持する。projection、summary-difference、citation statusはapprove/execute、risk/process分類、権限、承認、過去承認、fallback authorityを生成しない。source verification failure、未解決明示参照、scope mismatch時に別候補へ黙ってfallbackしない。

## 10. Operator usability

現在のC contextに含めた候補、非採用候補、contextから除外した候補、summary差を監査上区別できること。すべてのrecord状態はF IDとimmutable versionから原記録へ戻れること。意味差が未評価なら未評価と明示し、Cの意味提案を事実として表示しない。失敗・不一致後に再依頼で再検索できる。

## 11. Tests

- BT-U-C04.02-P: HDSの合成LTMへexact候補、明示されたが引用非採用の候補、明示されないrecent/tag候補を用意する。通常command生成からC payloadを検査し、explicit F refsだけが渡ること、summary difference/provenanceが出所版へ結ばれること、review auditに採用・非採用・除外の参照が保持されること、除外後もLongTermMemoryStore JSONLのentry/hash-chainがreload後に残ることを検証する。
- BT-U-C04.02-N: unresolved explicit referenceがあればtag/recent候補を渡さず採用もしない。LLMが除外recordを提案した場合も拒否し、raw omitted textをaudit/UIへ出さず、原記録を保持する。
- 実test selector: packages/hds-brain/test/controller.test.ts、packages/hds-brain/test/memory_citation_review.test.ts、packages/hds-brain/test/long_term_memory.test.ts、apps/gateway/test/audit_dump.test.ts、packages/channel-webchat/test/webchat.test.ts。
- Windows上の合成memoryと専用temp JSONLだけを使用し、fixture/local evidenceをlive/installed証拠へ読み替えない。

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
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/hds-brain/test/controller.test.ts packages/hds-brain/test/memory_citation_review.test.ts packages/hds-brain/test/long_term_memory.test.ts apps/gateway/test/audit_dump.test.ts packages/channel-webchat/test/webchat.test.ts

変更なしのserve/resume/live smokeおよびrelease gateは今回scope外。失敗は今回起因、既存、環境限定、未確定に分類し、正確なexit、件数、log pathを記録する。preexisting Gateway/listenerを停止・再起動しない。

## 13. Manual smoke

専用合成LTM fixtureで正例と未解決explicit F negativeをVitestの実consumer経路から実行し、C LLM payload、J review audit、Gateway/WebChat projection、JSONL reload/hash-chain verifyを目視可能なassertionで確認する。既存listener、credential、production memory、external serviceは操作しない。追加のlive providerは起動せず、その未観測範囲を報告する。

## 14. Permanent-use check

今回成立させるのはWindows Node runtime上のmemory current projection、citation review、監査projection、合成JSONL復帰までである。証拠源はFIXTUREとsource inspection/INTERNAL_STATE。real provider adherence、long-run memory growth/retention, session history exclusion, installed OS, crash durability beyond current file/hash tests, credentialed live interaction, release readiness、親C04全体は未成立である。

## 15. Final report format

BT-R-C04-03/04の成立範囲、変更path、production consumer、risk/route/evidence分類、実selector、必須commandの正確な結果、doctor失敗・未実施・残存限界、C04親/P13状態、branch/commit/push/remote HEAD、二世代backup refs、復元点を日本語で報告する。unit local acceptance、Git統合、live/installed、release判断を分ける。

## 16. Next-phase dependency

C04.02の有限正負条件、整理、安全review、必須検証、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまで閉じて境界停止する。C04.03は新しい入口・再同期から扱い、自動着手しない。親C04全scenario、session/full-history経路変更、永続semantic relation、release状態は未成立のまま保つ。P13はPENDING_OWNER_GO、public_claim_allowed=falseを維持し、owner GO/GAを推定しない。
