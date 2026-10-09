# 目的・手段関係網

## 目的

`GoalRelationGraph` は、目的間の複数親、目的と手段の寄与、共有手段、共同寄与、未解決の抵触を不透明な参照で保持する。これは関係の記録であり、目的の意味同定や手段の成功確認ではない。

## 契約

protocol の `blue-tanuki.goal-relations.v1` は、自由記述を含まない `graph_ref`、目的または手段の `node_ref`、根拠を指す `source_ref`、関係ごとの根拠参照を受け付ける。参照は UUID または固定長16進識別子の形に制限し、raw本文、表示名、秘密、任意metadataを持たない。graph自身は `used_for_authority=false` を必須にする。

関係の種類は次のとおり。

| 関係 | 意味と保持状態 |
|---|---|
| `parent_goal` | 一つの上位目的から下位目的への辺。同じ下位目的に複数の親を持てる。親辺の循環は拒否する。 |
| `means_contribution` | 一つの手段と一つの目的の関係。成立確認ではなく`unverified`として保持する。同じ手段を複数目的へ接続して共有を表す。 |
| `joint_contribution` | 二つ以上の異なる手段と一つの目的の関係。成立確認ではなく`unverified`として保持する。 |
| `goal_conflict` | 二目的間の抵触。解消したとは推定せず`unresolved`として保持する。 |

参照先の存在、ノード種別、識別子の一意性、意味上の重複、複数手段の要件を境界で検査する。契約は最大256ノード、1024関係、表示木2048項目・深さ32で上限を設ける。tree viewにも `used_for_authority=false` を保持する。

## HDSへの接続

`HDSUpperController` に明示的に渡した `goal_relation_graph` だけを構築時に検証し、凍結した関係木を `FrameResult.goal_relation_tree` へ添付する。通常の `decide()` から `DecisionLog` と既存の `AuditLog` に届く。受信本文や inbound metadata から関係を作らない。

このfieldは表示・監査用であり、`model`、`commit`、Approval Gate、実行commandへ渡さない。`FrameResult.goal`、既存のF→M→C、final review、hash-chainを置き換えない。設定がなければfieldそのものを省略する。

## 木表示と復元

親目的と寄与関係を画面向けのforestとして投影する。複数親の目的と共有手段は、関係ごとに表示木へ複製する。抵触は木の親子関係へ変換せず、canonical graph内に保持する。

木にはcanonical graph全体とそのSHA-256を復元sidecarとして含める。表示側でnodeを隠したり並べ替えたりしても、sidecarが保たれていれば完全な元graphへ戻せる。復元時にsidecarのdigestが一致しない場合は失敗し、内容や参照値をエラーへ含めない。表示木を編集してcanonical graphを書き換える機能ではない。

## 現在の限界

一つのController構築時に渡された関係網を検証・記録する範囲である。自然言語解釈、意味の真偽、目的への採用・変更、永続的な意味記憶、UI操作、動的な関係更新、外部作用は扱わない。監査への保存は既存 `AuditLog` 設定の範囲に従い、この機能単独では保存先や永続性を保証しない。

## 検証

局所selector:

```text
pnpm exec vitest run packages/protocol/test/goal_relations.test.ts packages/hds-brain/test/goal_relations.test.ts
```

正負例では、複数親、共有・共同寄与、抵触の保持、木表示からの完全復元、sidecar改変の拒否、inbound metadataからの権限外生成の拒否、関係網による判断結果の不変を検査する。これらは合成入力の `FIXTURE` 証拠であり、installed / live / release 挙動の証明ではない。
