# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。Windows-firstで全体の実consumer接続を進めている。最終対象OSはWindows／Linux／macOS／Android／iOSの5OSであり、現時点で対応済みという意味ではない。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。

## 次のBUILD_BATCH

rev2.4 CR-0ではUnix全install／uninstall入口とWindows開発用Force installに対象安全ガードを実装し、Windows・WSLの非破壊fixtureで確認した。実削除・実OS導入は行っていない。CR-1ではrelease hardening／packaging gateを共通のworkflow検査へ接続し、既存の手動Linux補助workflowを残したまま、`workflow_dispatch`一つ・明示read-only権限・job-level上書きなしだけを許可した。Actions自体は未実行。CR-2ではGUI保存env-fileから再起動したGatewayで、loopback合成providerの待機job再開→C→J→合成file.search→receipt／M→再接続後の結果返却を接続し、通常Compute費用予約も別のadapter試験で確認した。QE_BUILDは継続。次のCR-3は現行正本が指定する既知fixtureのうち、このconsumerを止める原因だけを現HEADで再現・修復する。詳細と試験射程は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)に記録する。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QC／QAは未開始。

F15.03とComposio／PostHogの既存作業は履歴に保持する。具体consumerへの展開は、rev2.4の安全是正と一仕事の統合形状を前進させた後に戻る。

## 維持する境界

独立作業の開始・切替・再開では、固定された現行三点セット全文を読み直す。J4 strict closureは通常のdocs gateから推定しない。Git復旧refsは`MIGRATION_COMPLETE`で、local二世代branch／remote二世代tagを使う（例：`refs/tags/codex/backup-main`）。

HDS-BRAINの判断・Approval Gate L3、Broker permission、M非権限、監査、秘密保護、fail-closedを維持する。C08.03実provider試験は保留、P13は`PENDING_OWNER_GO`／`public_claim_allowed=false`。実装完了後に全体QC、対象別QA、ownerの独立した公開・出荷判断へ進む。

詳細な完了バッチと観測証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)および[`開発進捗.md`](開発進捗.md)に保存する。完了ログや旧版仕様は、現行の依存・変更系譜・矛盾を解く場合だけ参照する。
