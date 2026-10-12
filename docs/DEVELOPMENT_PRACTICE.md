# BLUE-TANUKI 開発作法の参照先

本ファイルは旧リンク用の案内であり、独立した規範ではない。AGENTS.mdとdocs/作業標準要領.mdのQEを現行施工方法とする。

QE_BUILDで全体を一気通貫で実装し、BUILD_COVERED後にQE_QCで実物検査・改善し、QE_QAで対象・条件別の保証を判定する。毎小単位でAGENTSと指示を再読するが、毎回の全suite・局所QA・Git世代回転は行わない。

Gitはmain一本、単一writer、BUILD_BATCH単位の保全・commit/push。現行二世代remote backupの正本はrefs/heads/codex/backup-mainとrefs/heads/codex/backup-main-prev。既存の同名refs/tagsは歴史資料であり現行復元正本ではない。

D4Pocketからは責任・証拠・安全・現物照合の共通原理のみ採用する。D4固有の技術条件、完了値、手動Actions許可、別repo変更権限は移植しない。製品開発停止、C08.03実provider保留、P13公開保留は継続する。
