# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev3.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.0ではHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。明示された検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 現在のrepo基点

ownerがrev3.0を指定した時点のlocal／remote `main`は`2964db41dc11ddc3057f47447a85f8a49395c377`だった。パッケージ内の`e28a73f330cb155f46aea00e58cffd3a6b005ae8`はパッケージ作成時の観測値であり、現行HEADではない。CR-0～CR-3の完了根拠は既存履歴にあるが、K-B0で実際の最新HEADと入口を再照合し、古い監査結果を現行状態として転記しない。既に現HEADで成立していれば再実装しない。

## 次のBUILD_BATCH：rev3.0 K-B0／K-B1

まず現行AGENTS・rev3.0正本・HEAD／dirty／他writer・保護入口・通常利用者仕事を照合する。I-01～I-06およびCR-0～CR-3の各変更が、現在のproduction入口・validator・GUI・consumerで実際に有効かをコードで確かめ、危険な削除・実外部作用は起こさない。I-01等に未保護の危険入口が見つかった場合はその作用口を止め、非破壊の範囲で修正する。

続いて一つの通常仕事を起点に、`controller.ts`／`operation_plan.ts`／`制御状態.ts`／`保存取引.ts`、Gateway、Executor、Approval／Broker、Mの実producer・consumer・write入口・権限源を結び、HDS Frameworkの意味責務とJ/Mの状態所有を対応付ける。行数、型、schema、test数だけで棚卸し完了にしない。今回の成果は`BASELINE_OBSERVED`／`RESPONSIBILITY_MAPPED`の範囲で報告し、未知は`UNKNOWN`として残す。

旧Jの現writerは確認なしに二重化・移管しない。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラ別repo変更、P13公開・出荷GOは保留する。CR条件を確認後、rev3.0工程順に従いCR-2・E2E-01を含む実consumer接続、CR-3の現行consumer再照合、K-B2以降へ進む。試験用一仕事は製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を自動成立させない。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。
