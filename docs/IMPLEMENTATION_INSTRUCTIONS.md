# BLUE-TANUKI 有効な実装指示

現単位: **C02.02 — 目的と共有手段の関係網**。`PRODUCT_BUILD_MODE`、core profile。今回はこの単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じて停止する。C02.01は `88136224a1711750f0f717f03a598ef61eafeecf` に保存済み。親C02のscenario全体は未実行である。

ownerは全工程を一単位ずつ委任している。検証済みの通常成果をGitHubへ履歴・成果物としてcommit/pushし、remote refsを照合する。公開主張、実業務作用、他repo変更、出荷判断、owner GOは別境界。私有原典、封印詳細、raw証拠、秘密、runtime stateをrepoへ含めない。

## 1. 目的

BT-R-C02-03の複数親・共有手段・寄与・抵触を、strictな関係網と表示木に接続する。表示木から項目が隠れてもcanonical graph全体へ復元できる状態を、今回の有限条件とする。

## 2. Phase 境界

対象はprotocol契約、HDSの通常Controller decision/audit経路、局所文書、正負の合成試験。外部業務作用、別repo、秘密や実データ、LLM接続、GUI変更、配布・release操作を行わない。

## 3. Scope

- `packages/protocol/src/goal_relations.ts`、protocol barrel、対応test
- `packages/hds-brain/src/goal_relations.ts`、`frame.ts`、`types.ts`、`controller.ts`、barrel、対応test
- `docs/GOAL_RELATIONS.md`、この指示、`docs/INDEX.md`、`docs/開発進捗.md`、`docs/ROADMAP.md`、`CHANGELOG.md`、`規定/移行台帳.json`
- 既存C02.01やC02.03、無関係なpathへscopeを広げない

## 4. Non-goals

自然言語からの意味同定、寄与の成功判定、目的への採用・変更、権限や実行判断、永続semantic memory、動的UI編集、別consumer、親C02全体受入、live/installed/他OS、release/GA/P13/owner GOを扱わない。親scenario BT-T-C02-01..04は全体としてNOT_RUNのまま維持する。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底、作業標準要領、active instruction、ROADMAP、SECURITY/AUDIT/CONFIG/README/CHANGELOG、C02.02・親C02・C02.01閉鎖証拠、指定仕様s01/s03/s05/s06/s14/s15/s16、原典D0 §7／H5 第6章／A12 §6.2.1を確認する。現物は `GoalProjectionSchema`、`FrameResult`、`frame()`、`ControllerOptions`、`HDSUpperController.decide()`、`model()`、`commit()`、`DecisionLog`、`AuditLog.append()`、protocol/HDS exportと近傍testsを追う。

## 6. 必須grep

`GoalRelationGraphSchema`、`goal_relation_graph`、`goal_relation_tree`、`parent_goal`、`means_contribution`、`joint_contribution`、`goal_conflict`、`FrameResult`、`HDSUpperController.decide`、`AuditLog.append`、`model`、`commit`を追跡する。関係をinbound metadataから取り込む経路、関係をmodel/commit/Approval Gate/実行へ混ぜる経路、raw自由記述を関係recordへ保存する経路を追加しない。

## 7. 既存anchor

`ControllerOptions`は構築時の明示設定を受け、`frame()`が`FrameResult`を返し、ControllerはF→M→C後の`DecisionLog`を`AuditLog`へ追加する。`model()`はgoal/protected values/request/actor/process/memoryを読むが、関係木は読まない。`commit()`はscoringを評価する。既存protocolには目的射影はあるが関係網schema・consumerは無い。現行HDS経路へoptionalな監査projectionを足し、既存判断入力は変えない。

## 8. 実装要件

1. protocol schemaをstrict・版付きにし、不透明UUID/hash参照と各relationの根拠参照、参照先存在、node kind、一意性、親循環、意味重複、joint contribution人数を検査する。graph/treeに`used_for_authority=false`を必須化する。上限は256 nodes、1024 relations、tree 2048 entries/depth 32。自由記述・表示名・raw本文を受け入れない。
2. `parent_goal`は複数親を許し、`means_contribution`は未検証、`joint_contribution`は複数手段の未検証、`goal_conflict`は未解決として記録する。寄与の存在を達成の証明にしない。
3. 画面用forestでは親・寄与の関係ごとに共有ノードを複製する。canonical graph全体をdigest付きrecovery sidecarへ保持し、viewから隠した表示要素があっても復元し、sidecar改変時はfail closedとする。
4. 明示構築設定から検証し、凍結したtreeを`FrameResult`、`DecisionLog`、hash-chain `AuditLog`へ接続する。inbound metadataから設定や関係を作らない。
5. treeはmodel、commit、approval、executionの入力にしない。未設定時はoptional field自体を省略し、従来経路と判定を維持する。
6. 文書は契約、consumer、境界、復元方法、限界、検証を日本語で説明する。文書・manifest・fixtureだけを本番挙動の証拠にしない。

## 9. Safety invariants

HDS-BRAIN唯一authority、owner最終責任、Approval Gate/L3 final review、audit hash-chain、Runtime Invariants、fail-closed/SUSPEND、metadata non-authority、memory/history non-authority、Layer A/Bを変更・迂回しない。関係網は判断・権限を生成せず、未知または破損は自動許可へ進めない。scope外の不足を今回の完成主張に含めない。

## 10. Operator usability

`docs/GOAL_RELATIONS.md`に4種類の関係、各保持状態、forestの複製表示、canonical recovery sidecar、digest拒否、構築設定の入口、判断への非影響、現状限界、局所検証を説明する。raw内容が無くても参照先と関係種別を解釈できる前提と、永続性を保証しない境界を明記する。

## 11. Tests

- `BT-U-C02.02-P`: 複数親、共有手段、共同寄与、抵触がstrict graphに保存される。実`HDSUpperController.decide()`経路でforest・復元sidecarがFrameResult/DecisionLog/auditへ届き、全要素freezeと`AuditLog.verify()`を確認する。表示木から枝を隠してもcanonical graphを完全復元する。
- `BT-U-C02.02-N`: dangling/wrong-kind/重複/cycle/不完全joint/未知field/自由記述参照/破損sidecarを拒否し、値をerrorへ出さない。inbound metadataが関係を作成・置換できないことを確認する。
- graph有無の同一requestを比較し、model、commit hash、command type/payloadが不変であることを確認する。乱数command IDは比較対象から除外する。
- selector: `packages/protocol/test/goal_relations.test.ts` と `packages/hds-brain/test/goal_relations.test.ts`。
- 親scenario BT-T-C02-01..04は本単位で閉じない。

## 12. Validation commands

commit前の必須:

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
pnpm exec vitest run packages/protocol/test/goal_relations.test.ts packages/hds-brain/test/goal_relations.test.ts
```

失敗は今回起因、既存、環境限定、未確定に分類し、ログを残す。credentialを表示・設定せず、既存processを停止しない。0件・未実行・非ゼロはPASSにしない。

## 13. Manual smoke

Windows/PowerShellの現在workspaceで上記Vitest selectorを実行し、child process終端、件数、出口値を回収する。試験内ではHDS Controllerの合成requestのみを処理する。Gateway、外部service、credential、実データ、installed bundle、別repoは起動・変更しない。

## 14. Permanent-use check

証拠範囲はWindows workspaceのprotocol契約と通常HDS local decision/audit経路で、関係forestからのcanonical graph復元まで。UI、永続semantic memory、installed配布、他OS、live外部作用、C02親scenario、製品完成、release readinessは証明しない。

## 15. Final report format

C02.02有限受入とBT-R-C02-03の成立範囲、変更path・実consumer、リスク/経路/証拠源、selectorと8必須commandのexit・結果、失敗・未実施・profile・限界、親C02/P13状態、branch/commit/push/remote HEAD、二世代backup refsと復元点を日本語で記録する。local受入、Git統合、製品/release判断を区別する。

## 16. Next-phase dependency

有限正負条件、必須検証、整理・安全review、二世代backup、main単一commit/push、remote refs/clean照合、private引継ぎまでをC02.02一単位で閉じる。親C02はPARTIAL、BT-T-C02-01..04はNOT_RUN_AS_WHOLE、C02.03は候補のまま着手しない。P13は`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持し、owner GOやGAを推定しない。
