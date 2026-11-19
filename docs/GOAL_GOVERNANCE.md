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

`HDSUpperController` は既存のowner管理下構築設定と、Jが採用して監査に記録した最初の委任目的を読み分ける。`decide()` ごとにその時点の投影を `FrameResult.goal_governance` へ添付し、`DecisionLog` と既存のhash-chain `AuditLog` に記録する。受信metadata、UI、LLM、memory、executor feedbackに設定や承認の権限はない。未設定時は目的の投影を省き、不正な構築設定は拒否する。

投影は非権威の参照情報である。`purposeVersionForEventTime` は遅延結果の発生時刻を当時の目的版へ照合できる。通常の仕事は、Gatewayが依頼を選択された現行の委任目的へ束縛してから、既存のJ計画・Approval Gate・実行権限の検査を通る。

## 承認経路と限界

最初の委任目的は、Control CenterのTasksで使用者が入力する。認証済みの提出でL3審査待ちとなり、承認画面で同じ原文を確認してから明示承認する。Jは対象・原文SHA-256・審査内容・承認の対応を確認し、原文を私有Mへ保存して版1を採用する。最初の解釈は `unidentified`。承認待ちの本文はブラウザーの審査応答とGatewayのメモリに限定される。本文の永続保存先は私有Mで、監査には参照と照合値を記録する。

Gateway再起動時には、採用記録とL3、Mの対応を再照合する。採用後に目的を変えるときは、既存の目的変更経路で現行版に結び付いた新しいL3承認が必要。目的の採用でファイルや外部サービスの実行権限が増えることはない。運用目的と下位目的の親階層は機械検査し、意味的な範囲への適合は結果ごとの根拠で判断する。

## 検証

局所selector:

```text
pnpm exec vitest run packages/protocol/test/goal_governance.test.ts packages/hds-brain/test/goal_governance.test.ts
```

合成入力で、三種目的、権限ラベル、digest結合、無権限・偽装・再利用・時刻不整合の拒否、解釈訂正と目的変更の分離、旧版保持、遅延時刻の版照合、通常Controller/audit接続、model/commit/command不変を検査する。証拠源は`FIXTURE`であり、owner承認経路、実業務、installed製品、live外部作用、release readinessの証明ではない。
