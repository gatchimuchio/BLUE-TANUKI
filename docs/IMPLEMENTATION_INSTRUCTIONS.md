# BLUE-TANUKI 有効な実装指示

現単位: **C06.01 — 候補検査と判断の分離**。LLM tool candidate の機械契約検査、元command process allowlist による領域検証、目的との意味判断を別記録にする。候補由来を推論として示し、意味判断が未評価・unknownなら採用を保留する。候補は実行可能化せず、引数や候補本文をHDS auditへ保存しない。環境構築は完了済みとして再実施せず、通常開発はWindows / PowerShellで行う。GitHubは検証済み成果と履歴の保管先であり、本単位も検証後に規定の二世代backup、main commit・push、remote照合まで閉じる。

## 1. 目的

C05.02で通常Gateway finalization経路からHDSへ届くLLM tool candidateを、実行候補のまま保持しながら、機械検査・process領域検証・意味判断の状態を独立して記録し、採用可能性へ限定的に結び付ける。未知、推論、仮定、未評価の意味根拠を支持事実として扱わない。HDSはcompute requestを発行する上流判断主体であり、判断中にLLMを呼び出さない。

有限到達条件: 厳密な候補schema、重複call ID検査、元Decisionのprocess allowlist照合、意味判断と根拠状態が独立に記録される。機械検査または領域検証の失敗は拒否、照合元command不在や未評価・不確かな意味根拠は保留とする。すべての検査を通ったcandidateであっても到達先はgoal review適格性に限り、実行・承認・権限にならない。raw candidate、tool名、argumentsをHDS auditへ保存しない。

## 2. Phase 境界

対象はHDS executor-feedback audit record、純粋な採否縮約関数、通常Gateway finalizationから届く候補の評価、controller testsおよびC06.01のactive指示・roadmap・進捗・changelog更新である。HDS-BRAIN standalone、唯一authority、owner最終責任、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、Layer A/Bを維持する。

C06.02の基準寄与・衝突評価、C06.03の懐疑・再開評価、候補の意味判定器、goal更新・採用処理、tool実行、Approval Gate変更、外部送信、実provider/live、Control Center、installer・bundle・release・GA・P13・owner GO、他repo、環境再構築は対象外。private施工pack、原典、実行state/evidence、secretはrepositoryへ含めない。

## 3. Scope

- packages/hds-brain/src/controller.ts
- packages/hds-brain/src/types.ts
- packages/hds-brain/src/policy.ts
- packages/hds-brain/test/controller.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md

上記外は変更しない。追加pathが必要ならprivate施工stateと受入記録を先にREPLAN・再同期する。

## 4. Non-goals

candidateの実行・ToolRegistry接続・承認・goal変更、LLMを呼ぶ意味判定、候補本文やargumentsの永続化、candidate由来の権限生成、semantic conflictの自動解消、C06.02/03のcriterion実装、memory/history authority化、policyまたはApproval Gateの変更、外部送信、credential/live provider、UI、installer/release/GA/owner GO、環境再構築を行わない。

## 5. 最初に確認する files / symbols

ExecutorFeedbackAuditTrace、ExecuteFeedback、LLMToolCallCandidateSchema、HDSUpperController.onFeedback、DecisionLog.frame.process.execution_policy、evaluateDecision、Gateway finalize_command_output.ts、C05.02のcandidate-onlyおよびdigest-only監査境界、C06.01受入条件を確認する。開始時のmain/remote/backup refs・clean状態とNode/Corepack/pnpm版を記録する。既存環境を再設定しない。

## 6. 必須grep

llm_tool_candidates、LLMToolCallCandidateSchema、onFeedback、executor_feedback、allowed_command_types、allowed_tools、ToolRegistry、may_execute、used_for_authority、semantic_judgment、adoption_disposition、hds_calls_llmを検索する。candidateがToolRegistryへ届かないこと、HDSにLLM呼出しがないこと、候補raw内容がaudit・history・operator resultへ追加されないこと、process allowlistが候補の実行・承認へ昇格しないことを確認する。

## 7. 既存 anchor

C05.02はstrict schemaのLLM tool candidateを通常Gateway finalization経路からHDS feedbackへ渡し、HDS auditにはcountとdigestだけを保持する。candidateは実行型ではなく、ToolRegistryやApproval Gateへ接続しない。HDS onFeedbackは元DecisionLogを引けるが、従来は候補の構造・領域・意味状態を独立したassessmentとして記録しない。

HDS process execution policyにはcommand typeとtool名の許可一覧がある。これはprocess範囲との照合に使えるが、実ToolRegistryの登録、tool固有argument schema、実行可能性や目的適合性を証明しない。意味判断は本単位で未評価とし、C06.02以降へ残す。

## 8. 実装要件

1. executor feedback auditに、候補契約の不在・通過・失敗状態と候補ごとのdigest-only assessmentを記録する。malformed inputはraw payloadを保持せず安全に失敗状態を記録する。
2. 候補由来はinferredとして記録する。機械契約のstrict schema通過と重複call ID検査、元commandのprocess allowlist照合、目的との意味判断を独立したfieldにする。
3. 元commandを参照できない領域検証はunknownとする。照合可能なprocess policyにcandidate toolが含まれない場合はfail、含まれる場合はprocess allowlist上のpassとする。実registryやargument schemaの検証済みとは表示しない。
4. 本単位では意味判断をnot_assessed、証拠状態をunknownとする。機械/領域failまたは意味conflictはrejected、必須検査や意味根拠が未成立ならheld、全検査とobservedな支持意味根拠がある場合もeligible_for_goal_reviewまでに留める。
5. assessmentにはcandidate digest、状態、限定reason code、adoption disposition、may_execute=false、used_for_authority=falseだけを持たせる。candidate raw object、tool_name、argumentsはassessmentへ複製しない。
6. 候補malformed・重複ID・process allowlist外・元command不在・意味unknownの負例を検証し、監査hash-chainが維持されることを確認する。candidateからToolRegistry・execute・approval・goal adoptionへの呼出しを追加しない。
7. docsにはHDS process allowlistの検証限界、意味未評価、goal reviewまでの境界を明記する。C06.02/03や外部証拠の成立を主張しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate、high-risk/unknown/tool.callのL3 final review、audit hash-chain、Runtime Invariants、fail-closed、standalone HDS、Layer A/Bを維持する。LLM candidate、candidate digest、process allowlist照合結果、assessment、memory/historyは権限でない。HDSはLLMを呼ばない。candidateはexecute不可であり、adoption dispositionはgoal reviewより先へ進まない。

## 10. Operator usability

候補の機械検査、process allowlist照合、意味判断、採否状態を別々に追跡できるようにする。理由コードは検査範囲を説明し、process allowlist passを実在toolやargument安全性の保証に見せない。unknownまたは未評価はheldとして扱う。raw candidateやargumentsをoperator result、audit、historyへ露出しない。

## 11. Tests

- BT-U-C06.01-P: 通常のHDS決定からonFeedbackへ届くprocess allowlist内候補で、機械検査・領域検証・意味未評価が別々に記録され、意味unknownの採用状態がheldである。
- BT-U-C06.01-N: process allowlist外候補はrejected。malformed candidateのraw内容を記録せず契約失敗を記録する。重複call IDを拒否する。
- 採否縮約関数でsemantic evidence statusのobserved / inferred / assumed / unknown、検査fail、semantic conflictの結果を検証する。observed supportであっても到達先はeligible_for_goal_reviewに限定する。
- candidate argumentsがauditにないこと、audit chain verification、candidateの非実行・非権限境界、HDS standalone性を確認する。証拠は合成fixtureとlocal validationに限り、tool実行・実provider・installed動作・release readinessを証明しない。

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
    pnpm exec vitest run --no-file-parallelism --maxWorkers=2 packages/hds-brain/test/controller.test.ts

日本語基底規定自体を変えないためstrict language gateは今回の範囲外とする。credentialed live、release gateは実施しない。smoke:serve/resumeは本単位の対象外であり、省略はscope上未実施と記録する。credentialを読み出さず、既存listenerを停止しない。標準test timeoutやgate閾値を変更しない。

## 13. Manual smoke

専用Vitest selectorで通常Decision生成、候補feedback、process allowlist pass/fail、malformed入力、重複ID、意味unknownの保留、raw引数非保持、audit hash-chainを検証する。credential、live provider、外部送信先、実tool実行は使わない。

## 14. Permanent-use check

今回成立させるのは通常Gateway finalizationから届くcandidateについてのHDS内digest-only局所assessmentと、保守的なgoal-review dispositionまでである。process allowlistはcommand policyとの照合であり、ToolRegistry登録・tool固有schema・実行安全を確認しない。意味判定器、criteria contribution/conflict、懐疑・再開、永続的な採用処理、長期運転、installed/release readiness、C06親全体は未成立である。owner GO、GA、公開claimを推定しない。

## 15. Final report format

BT-U-C06.01の成立範囲、変更path、通常Gateway/HDS feedback consumer、候補の非実行・非権限境界、assessmentが確認する範囲と限界、証拠源分類、専用selectorと必須commandの正確な結果、doctor/標準testの失敗・未実施・環境限界、C06親とP13状態、branch/commit/push/remote main、二世代backup refsとrollback pointを日本語で報告する。fixture/local、live/installed、releaseを区別する。

## 16. Next-phase dependency

本単位の整理、安全review、必須検証、二世代backup rotation、main単一commit/push、remote refs/clean照合、private引継ぎを完了した後に停止する。次候補C06.02の基準寄与と衝突評価は、private施工状態と実装指示を新規同期し、ownerの継続指示後に別単位として扱う。C06親はpartialのまま、P13はPENDING_OWNER_GO、public_claim_allowed=falseを保つ。
