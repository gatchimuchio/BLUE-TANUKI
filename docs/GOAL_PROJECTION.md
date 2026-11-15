# 目的射影

## 目的と境界

HDS-BRAINのframeは、受理した入力本文を目的解釈済みの事実として扱わず、原文参照と目的射影を別々にdecision recordへ置く。通常の自然文・metadataから目標要素を同定しない。例外として、内部認証済みowner入力に結合した明示的な完了規則がある場合、対象状態は「参照された全規則が検証済み結果で成立している」と規則参照の範囲で識別する。これは達成済みの観測ではなく、`state`は引き続き`identifying`である。必要性、適用期間、委任権限は根拠が別途確認されるまで`unknown`である。

`FrameResult.goal`は既存互換の文字列fieldとして維持される。本文の先頭200文字を使う既存値であり、目的の必要性、完了条件、採用、権限を示さない。新しい`goal_projection`が独立した契約recordである。

## 記録内容

- `original_request_ref`: 入力request ID、raw本文のSHA-256、参照が不変であることを示す固定値。本文そのものはprojectionへ複写しない。
- `necessity`: その目的を持つ理由。
- `target_state`: 対象、成立条件、適用範囲。
- `evaluation_rules`: 成立を観測・判定する規則。ownerが明示した規則は本文を保存せず、規則digest・件数・依頼参照だけを結ぶ。
- `validity_period`: 適用開始・終了時点。
- `authority`: 委任者と許可範囲の参照。
- `state`: いずれかが未知の間は`identifying`。全項目が根拠参照付きでidentifiedとなる契約条件を満たす場合だけ`ready`。

各意味fieldは`{ "status": "unknown" }`または根拠参照付きidentified値を取る。unknown fieldへ値を付けた形、根拠のないidentified値、矛盾する期間、必要項目がunknownの`ready`はschemaが拒否する。schemaの`ready`は実行承認やHDSの判断結果を意味しない。

受理済み入力ではHDSが正確な受信本文を一時的にdigest化し、request IDとともにprojectionへ結ぶ。boundaryで拒否された入力はraw本文を使わず、安全な拒否placeholderへの参照として区別する。digestは原文本文を復元できず、外部整合性や人間の確認を単独では証明しない。

## 実行・監査

`HDSUpperController.decide()`はprotocol契約を使う`frame()`を通り、projectionを`FrameResult`に追加して既存`DecisionLog`とaudit hash-chainへ渡す。recordと子recordはruntimeでfreezeされる。raw/正規化入力の既存監査、legacy `goal`、既存F→M→C・Approval Gateは今回変更しない。

projectionはmemory、自然文、LLM、session、履歴、UI、metadataから昇格しない。現在は必要性等を未知のまま記録するだけで、`model()`、`commit()`、Approval Gate、実行可否の入力ではない。正例・負例は合成requestによるlocal runtime evidenceであり、永続database、UI、親scenario全体、release readinessの証拠ではない。

ownerの完了規則を参照したprojectionも実行許可や達成判定ではない。実際の達成判定はOperation Plan側で、全規則に対する一致した実行結果と検証済みM receiptが揃った場合にだけ成立する。規則参照の有無は、他の未知要素を補完せず`ready`へ昇格させない。

局所確認:

```powershell
pnpm exec vitest run packages/protocol/test/goal_projection.test.ts packages/hds-brain/test/goal_projection.test.ts
```
