# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 現在のBUILD_BATCH

K-B0／K-B1で現行入口、通常・復旧writer、I-01対象guard、I-03 main appから通常Computeへのbudget設定を照合・接続した。E2E-01とK-B2では、合成仕事のC→J→L3→M→次task再評価を限定接続し、meaning-update専用J/Mを7-store復旧経路へ接続した。これらは部分経路の証拠であり、製品全体の結合形状を示さない。

K-B3ではC候補評価を`meaning_update_candidate.ts`、承認済み候補からM record／interpretationを作る純粋処理を`meaning_update_semantics.ts`へ、解釈JSON正規化・検査・content digestを`memory_interpretation_semantics.ts`へ分離した。今回、引用レビューからM解釈依存を組み立て、現在Mと検証済み監査履歴から再評価候補を導出する意味処理を`memory_judgment_reassessment_candidate.ts`へ移した。controllerが監査・現在Mを取得し、Approval Gate／L3／監査書込／J-M writerはTypeScript HDS-BRAINに残る。HDS focused 3 files／5 tests、HDS typecheck/build/standalone、Gateway typecheck/buildはPASS。Gateway process smokeは前バッチでhealth readyに至らず統合実行未確認。今回の抽出で新しい利用者仕事や全体`SYSTEM_SHAPED`／`BUILD_COVERED`は成立しない。K-B3全体の責任抽出完了、C08.03、OD-03、他repo変更、P13 GOは未成立／保留。

K-B4で通常Gateway inboundから開発専用Rust shadow processへの非権威接続を行い、K-B5では数値policy採否・rule provenance・purpose binding輸送値・SUSPEND後の人間復帰に加え、GatewayのL3承認後に発生する二種のM更新遷移と残差集計を同じRust実processへ接続した。HDS controllerはTypeScript commitのdecision・reason・triggered thresholdを通常policy評価と照合し、同じ出所と確認できる場合だけscore／weight／lifecycle／thresholdを固定小数点化してRustへ渡す。Rustは独立評価した結果を非権威receiptへ返す。purpose binding比較はobserverが同じprojectionからIPC値を設定するため、独立したcurrent-governance sourceとの比較ではなくtransport整合に限る。

今回の実consumer修正では、Gateway observerがmemory transitionのreceiptから遷移一致・残差状態・lifecycleを元projectionより再計算して照合するようにした。相互に矛盾するreceiptは採用せずobserverをfail-closeする。今回のコード確認はHDS／Gateway typecheck・build、Rust `cargo check`、`cargo fmt --check`、差分空白検査がPASS。テストおよびこの差分のRust実processは未実行。先行する実process・test結果は先行commitの証拠としてのみ保持する。

Rustの`decision`は常に`hold`、作用権限・M正本writerなし。K-B5のJ/M全体意味比較、HDS Framework意味機構の実consumer、`RUST_SHADOW_WIRED`、single-writer cutover、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`、QE_QC／QE_QAは未成立。目的本文・task意味への適合は未確認であり、transport一致から推定しない。C08.03、OD-03、他repo変更、P13 GOも保留。次の施工では、目的意味を保ったDecisionRecordと承認済みM更新の実consumerを接続する契約境界を現物で特定し、合成経路を前進させる。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
