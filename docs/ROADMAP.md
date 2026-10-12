# BLUE-TANUKI QE統合工程・公開ロードマップ

2026-10-12。内部QE rev2.0三点正本を設計・要求・192施工単位の根拠とする。本書はPublicに出せる順序・状態の概要であり、内部原典を転載しない。

## 現行のQE工程

| 工程 | 主な目的 | 状態 |
|---|---|---|
| QE_DESIGN | C/J/M、作用・記憶・外殻の全体設計 | 設計と現在コードの残差あり |
| QE_BUILD | 一気通貫の全体系を先行実装 | ownerの製品開発停止を維持 |
| SYSTEM_SHAPED | 試験仕事が目的→結果→M→復帰まで通る | 全体成立未確認 |
| BUILD_COVERED | 全機能群の結合形状を確認 | 未成立 |
| QE_QC | 実物の全体検査・欠陥・原因・改善・再検査 | 未着手 |
| QE_QA | QC証拠から対象別・OS別・版別保証 | 未着手 |
| QE_RELEASE_REVIEW | ownerによる独立公開・出荷判断 | 未着手 |

192小単位は実装索引であって192件のQC/QAではない。小単位ごとに指示書とAGENTSを再読し、実際の仕事を先へつなぐBUILD_BATCHで施工・限定技術確認・Git保全を行う。

## 公開可能なBUILD_BATCHの順序案

1. QEB-00：QE規律、現行正本、Git復元、安全と公開制限の同期。
2. QEB-01：既存コードを使った目的、計算C、判断J、記憶M、結果の接続。
3. QEB-02：複数step実行、結果帰還、再計画、復旧。
4. QEB-03：D4Pocket汎用外殻とBLUEの認証済みAdapter／Broker接続。
5. QEB-04：OpenClaw/Museの観測された能力群を安全に実装。
6. QEB-05：ミニドラを交換計算Cとして接続。
7. QEB-06：全能力のBUILD_GAPを照合してBUILD_COVEREDを判定。

この順序は完成の証拠や無制限な作業許可ではない。D4Pocket・ミニドラの別repo、実資格と業務作用は別の委任が必要。BUILD_COVERED後にQE_QCで実物を検査し原因を修正、QE_QAで対象別の保証を判定する。

## 既存の局所実装・停止

C01～C08.02、D01.01～D01.02などは現行Gitに局所成果を持つが、AGI全体の完成、複数step完遂、D4Pocket実接続の証明ではない。2026-10-10のowner「いいとこでストップ」を維持し、D01.03へ自動進行しない。C08.03実LLM/providerは保留。

## 旧RCのP13と日本語基底J系列

旧v1.0 RCのP1–P12とP13は独立した出荷履歴・境界。version=1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。必要な実機、GA、release bundle、strict日本語基底とowner GOの条件は維持し、旧RCの局所PASSを新AGI構成の品質へ転用しない。

J0は日本語基底規定成立として完了。J1（活正文書）、J2（UI/installer）、J3（コード散文）、J4（strict closure）は未承認・未着手。J0通常gateの成功をJ4の証明にしない。

## 正本

AGENTS.mdがQE方法と保護、docs/作業標準要領.mdが運用、docs/IMPLEMENTATION_INSTRUCTIONS.mdが限定task、docs/開発進捗.mdが歴史的な観測、docs/STRATEGY_FRAME.mdが競合と外殻の戦略、docs/PRODUCT_ROADMAP.mdが旧v1 RCのrelease境界を扱う。次の製品QE_BUILDはowner再開指示と内部正本の再照合後にのみ行う。
