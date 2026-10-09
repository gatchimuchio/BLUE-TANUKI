# 目的の権限・版・適用時点

## 目的

目的の解釈訂正と目的自体の変更を別のeventとして保持し、委任目的・運用目的・下位目的ごとに変更権限を検査する。各eventは記録時刻、事前承認記録、適用開始時点を別に持つ。自由記述の目的本文はこの契約へ複製せず、原文参照とSHA-256 digestだけを扱う。

## 契約

protocolの`blue-tanuki.goal-governance.v1`は、目的参照・原文参照・版・本文digest・親目的の版・event参照・承認参照と時刻から成るstrictな契約である。委任目的は親を持たず、運用目的は委任目的の下、下位目的は運用目的または下位目的の下に置く。子目的は結び付いた親版を持つ。親参照の循環、欠落、識別子重複、未知field、本文などの自由記述を拒否する。

| event | 変更される状態 | 想定権限 |
|---|---|---|
| `interpretation_correction` | 同じ目的版の解釈digestと解釈改訂番号 | HDS-J。目的本文digestと目的版を維持する。 |
| `purpose_change` | 目的digestと版を一つ進める | 委任目的はowner、運用・下位目的はHDS-J。旧版を履歴に残す。 |

目的変更が適用された時点で旧解釈は新しい目的へ自動継承せず、解釈状態を`unidentified`へ戻す。必要なら別の`interpretation_correction`で確定する。目的変更eventは版の増分、前版、前digest、新digestを照合する。記録時刻より前への適用、版の飛越し、旧digestとの不一致、eventの再利用、承認記録の再利用を拒否する。

運用・下位目的は親目的の版にも結び付ける。親版だけが進み子の対応eventがない場合、子とその下位孫はprojectionで`requires_review`となる。子の目的変更eventは適用時点で有効な親版への再結合を明示し、古い親版のまま更新を通せない。これは関係と再確認要求の検査であり、digestから意味的な委任範囲を証明するものではない。

承認記録は承認時刻とevent全体のcanonical SHA-256へ結び付く。HDS ledgerはevent種別、目的種別、権限ラベル、参照先、時刻、digest一致を検査する。将来の適用時刻を持つ承認済みeventは、時刻前には`pending_effective`、到達後に`effective`として射影する。

## HDSへの接続

owner管理下の明示的な`HDSUpperController`構築設定だけから`GoalGovernanceLedger`を生成し、`decide()`ごとに時刻基準の凍結projectionを`FrameResult.goal_governance`へ添付する。projectionは`DecisionLog`および既存hash-chain `AuditLog`を通る。受信metadata、UI、LLM、memory、executor feedbackは設定や承認を作成・置換できない。未設定時はoptional fieldを省略し、不正な構築設定は安全側に拒否する。

projectionは監査・後続の帰属参照用であり、model、commit、Approval Gate、command executionへ渡さない。通常の判断入力、権限、final review、F→M→C、監査chainを変えない。`purposeVersionForEventTime`は遅延結果の発生時刻を既知版へ照合できるが、この単位ではGateway/executorの結果consumerへ新しい帰属経路を接続しない。親scenario全体は別受入である。

## 承認経路と限界

この単位で検査する承認記録は、HDSのowner管理下構築設定として渡される事前検証済みレコードであり、event digestへの束縛を示す。レコードの存在や`authority_kind`文字列だけで本人性を証明せず、署名検証器や対話的owner承認経路を新設しない。実運用でこの設定を生成するL3/owner承認接続は現状未接続であり、recordを直接受信しただけでは承認済みとみなせない。

運用目的・下位目的の親階層と権限ラベルは機械検査するが、digestだけから意味的に上位目的の範囲内かを証明しない。自然言語の同定、動的更新、永続DB、UI、owner identity認証、実結果の目的帰属、Installed/Live経路、親C02全scenarioは対象外である。監査への保存は既存`AuditLog`設定に従い、この機能が永続保存先を保証しない。

## 検証

局所selector:

```text
pnpm exec vitest run packages/protocol/test/goal_governance.test.ts packages/hds-brain/test/goal_governance.test.ts
```

合成入力で、三種目的、権限ラベル、digest結合、無権限・偽装・再利用・時刻不整合の拒否、解釈訂正と目的変更の分離、旧版保持、遅延時刻の版照合、通常Controller/audit接続、model/commit/command不変を検査する。証拠源は`FIXTURE`であり、owner承認経路、実業務、installed製品、live外部作用、release readinessの証明ではない。
