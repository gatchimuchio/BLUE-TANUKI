# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 現在のBUILD_BATCH

K-B0／K-B1で現行入口、通常・復旧writer、I-01対象guard、I-03 main appから通常Computeへのbudget設定を照合・接続した。E2E-01とK-B2では、合成仕事のC→J→L3→M→次task再評価を限定接続し、meaning-update専用J/Mを7-store復旧経路へ接続した。これらは部分経路の証拠であり、製品全体の結合形状を示さない。

K-B3ではC候補評価を`meaning_update_candidate.ts`、承認済み候補からM record／interpretationを作る純粋処理を`meaning_update_semantics.ts`へ、解釈JSON正規化・検査・content digestを`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在Mと検証済み監査履歴から再評価候補を導出する意味処理を`memory_judgment_reassessment_candidate.ts`へ移した。controllerが監査・現在Mを取得し、Approval Gate／L3／監査書込／J-M writerはTypeScript HDS-BRAINに残る。HDS focused 3 files／5 tests、HDS typecheck/build/standalone、Gateway typecheck/buildはPASS。Gateway process smokeは前バッチでhealth readyに至らず統合実行未確認。今回の抽出で新しい利用者仕事や全体`SYSTEM_SHAPED`／`BUILD_COVERED`は成立しない。K-B3全体の責任抽出完了、C08.03、OD-03、他repo変更、P13 GOは未成立／保留。

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続を行った。K-B5では、数値policy採否・rule provenance、保存時purpose bindingと現行`GoalGovernanceLedger`投影との鮮度、SUSPEND後の人間復帰、L3承認後の二種のM更新遷移・残差集計をRust comparison codeへ接続した。HDS controllerはdecision／reason／triggered thresholdの一致を先に確認し、同じ出所と確認できる場合だけ数値projectionをRustへ渡す。今回追加した現行目的版比較の実process結果は未確認。Rustの操作判断は`hold`であり、作用権限・M正本writerを持たない。

現行J projection v6は保存時bindingと現行bindingを別項目にし、Rust receiptとGateway observer logでIPC輸送一致と目的版鮮度を区別する。鮮度不一致は比較残差であり、TypeScript authorityの判断・実行・M writerを変更しない。raw goal ref・目的本文は渡さず、目的の意味適合は未評価。今回のコード確認は`pnpm typecheck`、Rust `cargo check`、`cargo fmt --check`がPASS。Rust実process／Gateway runtime統合／testは未実施。

K-B5のJ/M全体意味比較とHDS Framework Kernel意味責務の実consumer、`RUST_SHADOW_WIRED`、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。次はHDS Framework Kernel意味責務を現行TypeScript authorityの実consumerへ接続し、Rustは比較用shadowのまま保つ。目的本文・task意味への適合は確認済みに昇格させず、C08.03、OD-03、別repo変更、P13公開・出荷GOも保留する。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
