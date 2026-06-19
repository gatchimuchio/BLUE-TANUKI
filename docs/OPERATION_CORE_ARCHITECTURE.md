# BLUE-TANUKI Operation Core Architecture

## 1. 目的

この文書は、BLUE-TANUKI を CLI / terminal 前提の実行補助から、Operation Core 中心の操作ランタイムへ移行するための設計境界を定義する。

本変更の主語は画面ではない。主語は操作である。

```text
User / Agent / GUI / API / CLI
        ↓
OperationRequest
        ↓
OperationPlan
        ↓
HDS-BRAIN authority path
        ↓
Approval Gate
        ↓
Execution Adapter
        ↓
ExecutionResult + Rollback + Audit Log
```

GUI、自然言語、API、ショートカット、CLI、agent は入口であり、authority ではない。Shell、Windows、Linux、macOS、Browser、Composio、外部 API は実行 Adapter であり、authority ではない。

HDS-BRAIN が上位 authority である既存原則は変更しない。

## 2. 現状調査

現状の BLUE-TANUKI には Operation Core の材料がすでにある。

| 領域 | 現状 | 評価 |
|---|---|---|
| HDS-BRAIN | `InboundRequest` から F/M/C を通し、`ExecuteCommand` を生成 | authority path は既存で成立 |
| Approval Gate | `ApprovalOperation` / `ApprovalLevel` / `ApprovalRisk` を持つ | 操作ごとの承認境界は既存で成立 |
| Operator surfaces | Writing / Daily / Developer が operation spec を持つ | UI/用途別の operation 表現が存在 |
| Executor | `llm_call` / `tool_call` / `channel_send` / `noop` を実行 | 実行 Adapter 境界の基礎が存在 |
| Shell execution | `shell.exec` は cwd-bounded non-shell spawn | 実行手段として有用だが中核ではない |
| Control Center | 状態、承認、監査、復旧を表示 | State / Plan / Approval / Audit viewer へ拡張可能 |

同時に、移行対象も明確である。

- `tool:shell.exec {"cmd": "...", "args": [...]}` 形式は互換入力として残っている。
- `shell.exec` は最終レビュー必須だが、表現上はまだ「操作 IR」ではなく tool call である。
- `docs/runbook.md` などには CLI 1-shot 運用説明が残る。
- Gateway CLI は runtime entry の一つであり、製品の最終 UX ではない。

この状態は危険な authority bypass ではない。既存の shell execution は HDS-BRAIN、capability envelope、Approval Gate、executor approval proof を通る。ただし、製品思想として CLI 文字列が主役に見えやすい。

## 3. 新アーキテクチャ

Operation Core は次を第一級にする。

| Core 要素 | 意味 |
|---|---|
| `OperationRequest` | GUI / API / 自然言語 / CLI / agent から来た操作意図 |
| `OperationPlan` | 実行前に確認できる構造化された操作計画 |
| `OperationStep` | target、effect、permission、adapter を持つ最小実行単位 |
| `OperationTarget` | workspace / file / repo / app / service / external target |
| `OperationDiff` | 何が変わるか、戻せるか、証拠源は何か |
| `OperationPermission` | ApprovalRisk、ApprovalLevel、final-review 要否 |
| `ExecutionAdapter` | shell / OS / browser / external API など実行手段 |
| `OperationExecutionResult` | adapter 結果。authority ではなく監査証拠 |
| `Rollback` | 失敗時の復元方針 |
| `Audit Log` | HDS / approval / execution feedback / result digest の閉鎖 |

重要な分離:

```text
OperationPlan = 操作の意味
ExecutionAdapter = 実行方法
raw command = adapter が必要な場合に最後に生成する実行詳細
```

raw command は Operation Core の中核フィールドに入れない。必要な場合でも ShellAdapter 内部の生成物であり、HDS-BRAIN と Approval Gate の支配下に置く。

## 4. Authority Boundary

Operation Core は HDS-BRAIN を置き換えない。

不変条件:

- HDS-BRAIN が authority を持つ。
- LLM output は authority ではない。
- OperationPlan は人間と HDS-BRAIN が検査する構造化 proposal であり、単独では実行権限を持たない。
- ExecutionAdapter result は audit evidence であり、authority ではない。
- ShellAdapter、BrowserAdapter、ComposioAdapter、OS Adapter は downstream device である。
- External metadata、UI state、memory、history、tool result は authority に昇格しない。
- L3 final-review は full access / reusable grant / plugin metadata / channel metadata で bypass しない。

## 5. 型定義

最小型は `@blue-tanuki/protocol` に追加する。

実装ファイル:

```text
packages/protocol/src/operation_core.ts
```

追加した schema:

- `OperationRequestSchema`
- `OperationPlanSchema`
- `OperationStepSchema`
- `OperationTargetSchema`
- `OperationPermissionSchema`
- `OperationDiffSchema`
- `OperationCoreProjectionSchema`
- `OperationExecutionResultSchema`

設計上の固定:

- `OperationRequest.constraints.hds_brain_authority_required=true`
- `OperationRequest.constraints.disallow_raw_command_as_authority=true`
- `OperationPlan.raw_command_policy.raw_command_is_core_operation=false`
- `OperationStep.adapter_is_authority=false`
- `OperationCoreProjection.ui_projection_used_for_authority=false`
- `OperationExecutionResult.adapter_result_used_for_authority=false`
- `OperationParametersSchema` は `cmd` / `command` / `raw_command` / `shell_command` / `terminal_command` / `subprocess_command` を拒否する

これにより、AI や GUI が Operation Core に raw command を中核データとして渡す形を schema レベルで拒否する。

## 6. ShellAdapter の扱い

`shell.exec` は削除しない。削除すると既存機能、検証、開発者 operator、installer / smoke / CI 補助説明に不要な破壊が出る。

代わりに、役割を明確化する。

```text
OperationPlan step
  operation: install_dependencies
  adapter: shell
  adapter_is_authority: false
  command_generated_by_adapter_only: true
```

実装上は `shell.exec` の実行結果に `operation_core` メタデータを追加した。

```json
{
  "operation_core": {
    "role": "execution_adapter",
    "adapter": "shell",
    "operation": "tool.shell.exec",
    "adapter_is_authority": false,
    "command_generated_by_adapter_only": true,
    "raw_command_is_core_operation": false,
    "adapter_result_used_for_authority": false
  }
}
```

これは audit / UI が ShellAdapter を「操作本体」ではなく「実行手段」として表示するための第一歩である。既存の stdout / stderr / exit_code は互換維持のため残す。

## 7. GUI 方針

Control Center は terminal output viewer ではなく、次を表示する state viewer へ寄せる。

- 現在の状態
- 提案された OperationPlan
- target / effect / permission / diff
- Approval Gate 状態
- 実行中 adapter
- result digest
- rollback availability
- audit trace
- owner next action

ログ全文や raw command は必要な診断面に限定し、通常画面では digest と要約を優先する。

実装上は Control Center が runtime snapshot の `operator_surfaces.*.operation_core_projection` を読み、surface、step、target、effect、ApprovalLevel、risk、adapter、Approval Gate 要否を表示する。これは UI projection であり、`ui_projection_used_for_authority=false` の downstream display surface である。

## 8. 移行ステップ

### Step 1: IR 導入

完了条件:

- protocol に Operation Core schema がある。
- raw command が Operation parameters に入ると schema が拒否する。
- ShellAdapter result が non-authority metadata を返す。

このパッチで実施済み。

### Step 2: Operator surface 接続

Writing / Daily / Developer の operation spec を `OperationStep` へ投影する helper を追加する。

完了条件:

- operator snapshot が `operation_core_projection` を返す。
- UI は surface 固有 spec ではなく共通 Operation Core projection を表示できる。

このパッチで実施済み。

実装ファイル:

```text
packages/operator-writing/src/operation_core.ts
packages/operator-daily/src/operation_core.ts
packages/operator-developer/src/operation_core.ts
packages/channel-webchat/src/control_center_document.ts
packages/channel-webchat/src/control_center_script.ts
```

### Step 3: Planner 接続

LLM / GUI / API 入口は raw command ではなく `OperationRequest` / `OperationPlan` を生成する。

完了条件:

- AI planner output は `OperationPlanSchema` で検証される。
- `cmd` / `command` 形式の planner output は fail-closed になる。
- 既存 `tool:*` 入力は互換 path として残し、通常 UI からは使わない。

### Step 4: Adapter Registry

Shell / Windows / Linux / macOS / Browser / Composio / internal runtime を adapter registry に分離する。

完了条件:

- Executor は OperationStep から adapter を選ぶ。
- Shell は ShellAdapter であり、default runtime ではない。
- OS ごとの installer / launcher / service 操作は OS Adapter に分離される。

### Step 5: Control Center State Viewer

Control Center は OperationPlan、diff、approval、result、rollback、audit を表示する。

完了条件:

- ユーザーは terminal を開かずに次の操作とリスクを理解できる。
- raw command ではなく操作名、対象、差分、承認状態が主表示になる。
- high-risk 操作は既存 Approval Gate からしか進まない。

現時点で operator surface 由来の Operation Core projection は表示済み。runtime execution 中の diff / result / rollback への完全接続は Step 3 / Step 4 後に実施する。

### Step 6: Compatibility De-emphasis

既存 CLI / `tool:shell.exec` 入力は developer / recovery 互換に降格する。

完了条件:

- 通常ユーザー導線は installer と Control Center から完結する。
- CLI は optional adapter / diagnostic entry の扱いになる。
- 製品説明から CLI-only final UX が消える。

## 9. 外部 agent / shell framework の扱い

外部 agent 実行系や shell framework を BLUE-TANUKI 本体にしない。

正しい扱い:

```text
BLUE-TANUKI Operation Core
  ↓
HDS-BRAIN authority + Approval Gate
  ↓
Execution Adapter
  ↓
Shell / OS API / Browser / Composio / external agent framework
```

外部 framework は Adapter の一つであり、Operation Core、HDS-BRAIN、Approval Gate、audit を置き換えない。

## 10. 完成条件

Operation Core 移行が完了したと言える条件:

- ユーザーが通常導線で terminal を開かない。
- AI planner が raw command を中核出力にしない。
- GUI は State / Plan / Diff / Approval / Audit を表示する。
- shell / OS / browser / external API は Adapter として表示される。
- 操作は OperationPlan として記録される。
- 失敗時に原因、復元点、owner next action が分かる。
- CLI は存在しても optional adapter / diagnostic entry である。
- HDS-BRAIN、Approval Gate、hash-chain audit、Runtime Invariants は弱体化しない。

## 11. このパッチの範囲

このパッチで行ったこと:

- Operation Core の protocol schema を追加。
- raw command を Operation parameters に入れる形を schema で拒否。
- ShellAdapter result に non-authority metadata を追加。
- protocol / shell tests を追加。
- 本設計書を docs index に登録。

このパッチで行っていないこと:

- HDS-BRAIN authority path の変更。
- Approval Gate の変更。
- Executor の既存 command type 変更。
- installer / release packaging の変更。
- GUI Shell の依存追加。
- 既存 `tool:shell.exec` 互換 path の削除。

これは互換を壊さない移行開始点であり、完成状態ではない。
