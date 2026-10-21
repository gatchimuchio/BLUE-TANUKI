# BLUE-TANUKI 現行QE_BUILD指示

作業正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定rev2.3三点セット。独立した作業の開始・切替・再開時は、三点セットの全文を読み直す。適用`AGENTS.md`、owner指示、active task、最新HEAD・差分も確認する。同一BUILD_BATCH内の連続作業では関係要求と現物を再同期する。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) にログとして保持し、依存・系譜・矛盾の確認時だけ必要な箇所を参照する。

## 現行状態

QE_STAGE=`QE_BUILD`。rev2.3 pinとbackup ref移行=`MIGRATION_COMPLETE`。`QEB-32-E06.01-RELATION-TRACED-RETURN`で、request-boundの結果反証を現行目的criterion digestへ返し、同じcriterionを参照する採用候補・非採用候補への関係経路と、影響しない候補の理由をexecutor-feedback監査記録へ接続した。報告本文はdigest化し、観測claimsは未検証のまま保持する。これは監査上の限定帰還であり、目的変更、M更新、実行許可は行わない。HDS controller focused tests 76/76、workspace typecheck/buildはPASS。全workspace suite、QE_QC／QE_QAは未実施。製品全体は`BUILD_GAP`で、`SYSTEM_SHAPED`／`BUILD_COVERED`未成立。

## 次のBUILD_BATCH

`QEB-33-E06.02-SEMANTIC-RESTORE-SEPARATE-FROM-EXTERNAL-EFFECT`として、内部記憶の意味復元要求と既に起きた外部作用の状態を分離して帰還させる。E06.02の要求、実consumer、変更対象、停止条件は次の独立作業開始時に現行三点セットと最新コードから再構成する。

HDS-J、Approval Gate、L3、Broker、監査、M非権限、fail-closedを維持する。実provider／credential、外部業務作用、D4Pocket／ミニドラ別repo変更、公開・出荷判断は含めない。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。全体実装形状の前に詳細QC／QAへ進まない。
