# BLUE-TANUKI QE統合工程・公開ロードマップ

2026-10-13。owner指定の最新版である内部QE rev2.3三点正本を設計・要求・198施工単位（旧192＋Android/iOS各3）の根拠とする。今後もowner指定の最新版を正本とする。本書はPublicに出せる順序・状態の概要であり、内部原典を転載しない。

## 現行のQE工程

| 工程 | 主な目的 | 状態 |
|---|---|---|
| QE_DESIGN | C/J/M、作用・記憶・外殻の全体設計 | 設計と現在コードの残差あり |
| QE_BUILD | 一気通貫の全体系を先行実装 | 計画・依存結果・未実行改訂、承認内容固定・永続実行意思・専用file.search workerと保存結果の再起動J調停を接続中 |
| SYSTEM_SHAPED | 試験仕事が目的→結果→M→復帰まで通る | 全体成立未確認 |
| BUILD_COVERED | 全機能群の結合形状を確認 | 未成立 |
| QE_QC | 実物の全体検査・欠陥・原因・改善・再検査 | 未着手 |
| QE_QA | QC証拠から対象別・OS別・版別保証 | 未着手 |
| QE_RELEASE_REVIEW | ownerによる独立公開・出荷判断 | 未着手 |

198小単位（旧192＋Android/iOS各3）は実装索引であり、個別のQC/QAを198回行うための工程ではない。毎作業および各小単位の開始・切替・再開時に最新版の三点セットすべてと適用AGENTS.mdを読み直し、実際の仕事を先へつなぐBUILD_BATCHで施工・限定技術確認・Git保全を行う。

## 公開可能なBUILD_BATCHの順序案

1. QEB-00：QE規律、現行正本、Git復元、安全と公開制限の同期。
2. QEB-01：既存コードを使った目的、計算C、判断J、記憶M、複数step作用、結果照合の接続。
3. QEB-02：D4Pocket汎用外殻とBLUEの認証済みAdapter／Broker接続、操作者導線と旧新切替。
4. QEB-03：長期運転、結果帰還、再計画、復旧、学習の接続。
5. QEB-04：OpenClaw/Museの観測された能力群を安全に実装。
6. QEB-05：ミニドラを交換計算Cとして接続。
7. QEB-05M：Android（G09）とiOS（G10）をそれぞれ独立したnative製品入口として一気通貫で結合する。Device Link、端末の資格・OS権限、仕事の承認・観測・取消・切断復帰、更新・削除まで対象とし、詳細QCはBUILD_COVERED後へ置く。
8. QEB-06：全能力のBUILD_GAPを照合してBUILD_COVEREDを判定。

この順序は完成の証拠や無制限な作業許可ではない。D4Pocket・ミニドラの別repo、実資格と業務作用は別の委任が必要。BUILD_COVERED後にQE_QCで実物を検査し原因を修正、QE_QAで対象別の保証を判定する。

## 5OSの製品完成スコープ

最終対応対象はWindows／Linux native／macOS／Android／iOS。Desktop三系統に加え、AndroidとiOSのnative製品入口を別々に実装し、両OSの実機QC／QAを独立して行う。F16の「モバイル入力媒体」はAndroid/iOSの製品完成を代替しない。詳細は[QE対応OS正本](PLATFORM_TARGETS_QE.md)。旧v1.0 RCのMobile非搭載は別の歴史的制限である。

## D4Pocket方式へのバックアップ移行

local二世代branch（refs/heads/codex/backup-main、refs/heads/codex/backup-main-prev）／remote二世代tag（refs/tags/codex/backup-main、refs/tags/codex/backup-main-prev）への移行状態は**MIGRATION_COMPLETE（2026-10-12）**。二tagのSHAを照合後、旧remote backup branch二本を競合検出付きで整理した。完了時SHAと手順は[復元ref移行記録](BACKUP_REF_MIGRATION.md)を参照する。新AGIの製品QE_BUILD再開とは独立した規定修正である。

## 既存の局所実装と現行接続

C01～C08.02、D01.01～D01.02などは現行Gitに局所成果を持つが、AGI全体の完成、D4Pocket実接続の証明ではない。QEB-01-RESULTSで実結果を既存監査・履歴へ、QEB-01-PLANSで旧plan保持、内部command-step対応、明示step選択、検証済み依存結果、未実行部分の再審査を接続した。QEB-01-APPROVAL-CONTENTはApproval受付からExecutorまで内容を固定する。QEB-01-EXECUTION-INTENTはlocal期限、私有SQLiteの単回消費・開始意思・receipt、再起動後の認証付きdigest照会を接続する。QEB-01-FILE-SEARCH-WORKERは組込みfile.searchを固定childの専用IPCへ通し、実worker世代・終了と既存Jの結果検証を接続する。現在のtarget resolverはfile.searchのdirectoryだけ。自動目的採否、独立D4 Broker Permission・汎用内容結合、保存receiptのJ再送調停、外部postcondition照合、OS強制隔離・全作用の独立停止はBUILD_GAP。操作は[計画接続の操作](計画接続の操作.md)、[承認内容の固定](承認内容の固定.md)、[実行意思と再照会](実行意思と再照会.md)を参照する。C08.03実LLM/providerは保留。

## 旧RCのP13と日本語基底J系列

旧v1.0 RCのP1–P12とP13は独立した出荷履歴・境界。version=1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。必要な実機、GA、release bundle、strict日本語基底とowner GOの条件は維持し、旧RCの局所PASSを新AGI構成の品質へ転用しない。

J0は日本語基底規定成立として完了。J1（活正文書）、J2（UI/installer）、J3（コード散文）、J4（strict closure）は未承認・未着手。J0通常gateの成功をJ4の証明にしない。

## 正本

AGENTS.mdがQE方法と保護、docs/作業標準要領.mdが運用、docs/IMPLEMENTATION_INSTRUCTIONS.mdが限定task、docs/開発進捗.mdが歴史的な観測、docs/STRATEGY_FRAME.mdが競合と外殻の戦略、docs/PRODUCT_ROADMAP.mdが旧v1 RCのrelease境界を扱う。次の製品QE_BUILDはowner再開指示と内部正本の再照合後にのみ行う。
