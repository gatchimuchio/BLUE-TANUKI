# BLUE-TANUKI 有効な実装指示

直近施工単位: **D01.02 — 依存stepの実内容具体化**（局所受入PASS）。Windows / PowerShellで進め、環境再構築を行わない。C08.03の実LLM/provider試験はowner指示により保留する。

## 1. 目的

審査済みOperationPlanの依存結果から対象・引数・前提・検証・補償を実値へ具体化する。作用集合を保持し、未解決stepを準備未完として通常consumerへ返す。準備済みは実行許可ではない。

## 2. Phase境界

D01.02だけを実施する。D01.01の局所受入とmain / originの4209bbe534264805751fb3225717fd614c3ab6e8を再確認した。D01.03のplan改訂、plan自動実行、provider/live、実資料、外部業務作用、別repo、公開主張、release/GA、owner GOへ進まない。

## 3. Scope

- packages/protocol/src/operation_core.ts
- packages/protocol/src/operation_preparation.ts（追加）
- packages/protocol/src/index.ts
- packages/protocol/test/operation_preparation.test.ts（追加）
- packages/blue-tanuki/src/operation_core.ts
- packages/blue-tanuki/test/executor_operation_core.test.ts
- apps/gateway/src/serve_projection.ts
- apps/gateway/test/serve_projection.test.ts
- packages/channel-webchat/src/control_center_script.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md
- docs/ROADMAP.md
- docs/開発進捗.md
- CHANGELOG.md
- 規定/移行台帳.json（変更文書のdigest整合のみ）

## 4. Non-goals

新しいauthority、scheduler、式言語、provider取得、context永続化、承認機構を作らない。operatorの操作一覧templateを具体化済みplanにしない。実行済み・承認済みのLLM自己申告を採用しない。

## 5. 最初に確認するfiles / symbols

OperationStepSchema、OperationPlanSchema、inspectOperationPlanAdapterRegistry、inspectOperationCorePlannerOutput、Executor._llmCall、operationCorePlannerHistoryProjection、Control Center execution list、対応test、作業標準要領を読む。

## 6. 必須grep

`rg -n "OperationPlan|planner_output|step_summaries|inspectOperationCorePlannerOutput" packages/protocol packages/blue-tanuki apps/gateway packages/channel-webchat`。呼出し元、history記録、表示先、既存schema-only投影を確認する。

## 7. 既存anchor

通常経路はplanner JSON→core inspector→Executor feedback→Gateway history投影→Control Center。現状にplan自動実行経路はない。descriptor catalogのoperation / adapter / effects検査を保持する。

## 8. 実装要件

1. stepへ任意の準備契約を加える。欠落はlegacy schema-validのまま準備未完とする。
2. 依存graphと限定field bindingを検査する。未知・自己・循環・重複依存、bindingの重複/親子衝突、権限field変更を拒否する。
3. plan外の明示contextから、同じplan/request/step/対象の成功結果だけを具体化する。clockは明示入力とし、未実行・失敗・期限切れ・不足・型不一致を安全に返す。
4. 前提は別入力の対象・revision・鮮度を照合する。検証と補償候補も具体対象を持ち、補償不能は理由を明示する。差込後にschemaと全descriptor効果を再検査する。
5. 固定済み対象・宛先だけを準備済みとし、未知の将来出力・wildcard・templateを未完とする。一般本文中の記号を対象wildcardと混同しない。
6. 通常inspectorは必ず準備検査する。Executorは空contextで依存未解決を保持し、下流を実行しない。history/API/UIは状態・件数・固定理由code・digestのみを表示し、実値やraw contextを露出しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、capability containment、Layer A/Bを維持する。準備結果・LLM・context・履歴・UIに権限を作らず、may_execute=false / used_for_authority=falseを固定する。

## 10. Operator usability

準備未完と準備済み候補を表示し、どちらも未承認であることを示す。原因は固定codeで示し、前提・対象・output・補償本文をerrorへコピーしない。失効は再観測、未解決は依存結果確認・再計画へ戻す。

## 11. Tests

BT-U-D01.02-P: 合成の成功依存結果と新鮮なrevision観測から、対象・引数・前提・効果・検証・補償が具体値となる。入力を変更せず、通常inspector / Executor / Gateway投影へ準備状態を接続する。

BT-U-D01.02-N: 未知出力・失敗・失効・対象差異・wildcardを準備未完とする。graph不正、危険/衝突binding、schema/descriptor不一致は拒否する。planner自己申告を実行事実にせず、raw値をhistoryへ出さず、実行を開始しない。親scenarioの前提失効を局所検証し、plan改訂はD01.03へ残す。

## 12. Validation commands

`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm docs:check`、`pnpm validate:repo-health`、`pnpm run doctor`、`pnpm validate:packaging`、`git diff --check`を実行する。変更領域のtestを先行する。doctorのcredential不在・既存listenerは環境制約として結果を保存し、検査を弱めない。D4と重い検証を競合させず、既存processを変更しない。

## 13. Manual smoke

合成入力で通常Executor / Gateway history consumerを通す。実provider、実業務送信、既存listenerの停止・衝突、credential確認を行わない。smoke:serve / smoke:resumeはroot・release・smoke経路の変更がないためscope外として記録する。

## 14. Permanent-use check

legacy plan、依存未解決、期限失効を誤って準備完了にしない。準備APIの成功をmulti-step実行・installed/live evidenceへ読み替えない。P13はPENDING_OWNER_GO、public_claim_allowed=falseを維持する。

## 15. Final report format

成立範囲、path、risk、経路/証拠源、authority影響、正負受入、検証commandとexit、未実行/環境制約、P13、branch、commit、push/remote HEAD、二世代backup、rollback pointを日本語で簡潔に示す。

## 16. Next-phase dependency

有限受入、清掃、安全再確認、必須検証、限定stage、単一commit/push、remote ref一致を成立させてD01.02の境界で停止する。ownerの「いいとこでストップ」指示によりGit閉鎖後に一時停止する。D01.03を開始しない。次単位はownerの再開指示と新たな同期から選ぶ。Git閉鎖は現在のowner提示AGENTS §21.7と作業標準要領に従い、検証後に二世代backup branchを回す。disk AGENTSに残る旧tag方式は採用しない。C08.03保留、公開・外部作用・出荷判断の別境界を保持する。
