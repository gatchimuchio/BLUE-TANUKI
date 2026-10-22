# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 次のBUILD_BATCH

rev3.0 K-B0／K-B1で、実際の最新HEADを基準にCR-0～CR-3とI-01～I-06の残りを再照合し、HDS Frameworkの意味処理、J/M writer、Gateway／Executor、Approval／Brokerのproducer→consumerと所有境界を一仕事に沿って対応付ける。既存のCR-0～CR-3完了記録を引き継ぐが、パッケージ作成時の`e28a73f`を現行HEADとして使わず、現HEADで成立済みの変更は重複実装しない。削除・外部作用の危険を見つけた場合はその作用口を止め、非破壊の安全修正を優先する。

次にCR-2の実利用条件とE2E-01の同一WebChat仕事（目的→C→J→安全な合成作用→結果／M→返信・再計画・復帰）を前進させ、CR-3の現行consumer状態を再照合する。その後rev3.0 K-B2以降のFramework意味契約・責任抽出・Rust shadow・比較へ進む。順序は工程表に従い、実物の現状と未解決の危険に応じて再同期する。Rustのsingle-writer cutoverは比較、停止、未決作用、rollback、権限境界が成立するまで行わない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
