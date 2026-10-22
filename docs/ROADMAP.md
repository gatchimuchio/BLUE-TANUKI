# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。Windows-firstで全体の実consumer接続を進めている。最終対象OSはWindows／Linux／macOS／Android／iOSの5OSであり、現時点で対応済みという意味ではない。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。

## 次のBUILD_BATCH

rev2.4のCR-0を最優先し、Unixの全install／update／uninstall入口とWindows開発用Force installで、root／HOME／data root等の危険対象を実体同一性で拒否する。危険な作用口は修復・非破壊確認が終わるまで無効にする。次にCR-1でmanual `workflow_dispatch`許可と自動trigger拒否をrelease／packaging gateへ同期し、CR-2でGUI設定LLMの費用profile／budgetと通常Executorを結んで、一仕事をJ→合成Broker→receipt→M→返信・再計画／復帰へ通す。QE_BUILDは継続し、製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QC／QAは未開始。

F15.03とComposio／PostHogの既存作業は履歴に保持する。具体consumerへの展開は、rev2.4の安全是正と一仕事の統合形状を前進させた後に戻る。

## 維持する境界

独立作業の開始・切替・再開では、固定された現行三点セット全文を読み直す。J4 strict closureは通常のdocs gateから推定しない。Git復旧refsは`MIGRATION_COMPLETE`で、local二世代branch／remote二世代tagを使う（例：`refs/tags/codex/backup-main`）。

HDS-BRAINの判断・Approval Gate L3、Broker permission、M非権限、監査、秘密保護、fail-closedを維持する。C08.03実provider試験は保留、P13は`PENDING_OWNER_GO`／`public_claim_allowed=false`。実装完了後に全体QC、対象別QA、ownerの独立した公開・出荷判断へ進む。

詳細な完了バッチと観測証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)および[`開発進捗.md`](開発進捗.md)に保存する。完了ログや旧版仕様は、現行の依存・変更系譜・矛盾を解く場合だけ参照する。
