# BLUE-TANUKI 開発作法の参照先

本ファイルは旧リンク用であり独立の規範ではない。AGENTS.md、docs/作業標準要領.mdのQE規律を正本とする。全体設計→QE_BUILDで一気通貫実装→BUILD_COVERED→QE_QC実物検査・改良→QE_QA対象別保証の順を採用する。

最終対応対象はWindows／Linux／macOS／Android／iOSの5OS。AndroidとiOSは独立した実装・QC/QA対象であり、旧RCのMobile非搭載を新AGI製品の要求除外に利用しない。

Gitの正規方式はD4Pocketと同じく、localの二世代branch（refs/heads/codex/backup-main、refs/heads/codex/backup-main-prev）、remoteの二世代tag。BUILD_BATCH単位で復旧点を保存し、小単位ごとには回転しない。refs/tags/codex/backup-mainとrefs/tags/codex/backup-main-prevをremote正本にする。BLUEの実移行状態はMIGRATION_COMPLETE（2026-10-12）であり、旧remote backup branchはtag照合後に整理済みである。完了SHAはdocs/BACKUP_REF_MIGRATION.mdを参照する。

毎小単位のAGENTSと指示書の再読は維持するが、毎回の全suite、QC/QA、Git世代回転を挟まない。製品開発停止、C08.03実provider保留、P13=PENDING_OWNER_GO／public_claim_allowed=falseを維持する。
