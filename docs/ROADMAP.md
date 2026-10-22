# BLUE-TANUKI QE統合工程・公開ロードマップ

## 現在の位置

`QE_STAGE=QE_BUILD`。2026-10-22にowner指定の現行正本をrev3.0へ切り替えた。HDS Framework Kernelの意味責務とBLUE HDS Runtime Kernelの有限J/M制御を区別し、Runtime核は段階移管する。現行TypeScript HDS-BRAINは明示的なsingle-writer cutover条件が成立するまで唯一の実行authority／状態writerである。Rust shadow、契約、schemaだけでは権限移管や製品機能の成立を示さない。

製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、QE_QC／QE_QAは未開始。Windows-firstを維持し、最終対象はWindows／Linux／macOS／Android／iOSの5OS。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラの別repo変更、P13 owner公開GOは保留する。

## 次のBUILD_BATCH

K-B0／K-B1で現行入口、通常・復旧writer、I-01対象guard、I-03 main appから通常Computeへのbudget設定を照合・接続した。E2E-01とK-B2では、合成仕事のC→J→L3→M→次task再評価を限定接続し、meaning-update専用J/Mを7-store復旧経路へ接続した。これらは部分経路の証拠であり、製品全体の結合形状を示さない。

K-B3では`meaning_update_candidate.ts`に続き、承認済み候補からM record／interpretationを作る純粋処理を`meaning_update_semantics.ts`へ、解釈のJSON正規化・検査・content digestを`memory_interpretation_semantics.ts`へ分離した。永続writer、Approval Gate、監査、現在M再読込はTypeScript HDS-BRAINの現行境界に残す。content review→L3→proposal／candidate／target／source-observation digest照合→J/M適用のコード経路は接続済みと確認した。HDS 5 files／10 tests、HDS／Gateway typecheck、HDS build、standalone smokeはPASS。Gateway smokeはWindows実行で15秒以内にhealthへ到達せず、Gateway統合経路は未確認のまま保持する。Rust shadow、C08.03 provider、OD-03 live、他repo変更、P13 owner GOは開始していない。

次のBUILD_BATCHは、controller内のmemory-judgment reassessment候補導出を純粋意味関数へ分離し、検証済み監査・現在Mの取得と、L3／J writerを現行controllerに保持すること。各局所経路の確認をQE_QC／QE_QAや全体完了へ昇格させない。

## 維持する境界

独立作業の開始・切替・再開時は、固定された現行三点セット全文を読み直す。current pinは[`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md)。内部三点セット・原典・全要求対応表はPublic Gitへ転載しない。完了バッチや旧版の証拠は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md)のログに保持し、通常作業で現行正本として併読しない。J4 strict closureは通常のdocs gateから推定しない。

Approval Gate／L3、Brokerの現在権限、Mの非権限性、監査、秘密、停止・復旧、fail-closedを維持する。Gitはmain一本、Windows通常開発、単一writer、local復旧branch二世代／remote backup tag二世代。backup-ref migrationは`MIGRATION_COMPLETE`で、closeout時はremoteの`refs/tags/codex/backup-main`と`refs/tags/codex/backup-main-prev`を実SHAで照合する。意味あるBUILD_BATCHの末に限定commit／pushとremote/ref照合を行う。
