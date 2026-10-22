# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev3.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.0ではHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。明示された検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 現在のrepo基点

ownerがrev3.0を指定した時点のlocal／remote `main`は`2964db41dc11ddc3057f47447a85f8a49395c377`だった。パッケージ内の`e28a73f330cb155f46aea00e58cffd3a6b005ae8`はパッケージ作成時の観測値であり、現行HEADではない。CR-0～CR-3の完了根拠は既存履歴にあるが、K-B0で実際の最新HEADと入口を再照合し、古い監査結果を現行状態として転記しない。既に現HEADで成立していれば再実装しない。

## 現行接続状態と次のBUILD_BATCH

K-B0／K-B1で現行入口と一仕事のproducer／consumer、J/Mの通常・復旧writerをコードで再照合した。公開可能な責任対応は[`OPERATION_CORE_ARCHITECTURE.md`](OPERATION_CORE_ARCHITECTURE.md)に置く。これは`BASELINE_OBSERVED`／`RESPONSIBILITY_MAPPED`の静的確認範囲であり、全OSの実行証拠や全体実装の完成ではない。

I-01のroot直下の二重slashによる広域対象ガードの抜けを修正し、I-03のメイン`/app`にも費用profile・予算policy・timeoutの保存／Verifyを接続した。provider疎通と通常Computeの設定準備を別に表示し、設定変更後の古い準備判定を破棄する。現在の予算消費は仕事ごとの実行時照合が必要であり、設定のreadyは実行許可ではない。I-04の共通試験fixtureには現行Compute／予算／worker lifecycleの依存を渡し、候補生成前の拒否を本番guardの緩和で隠さない。

E2E-01の同一owner WebChat試験では、委任目的のL3確認・J/M反映、再起動後の再読込、safe synthetic search、receipt/M、同一taskの返信・再計画まで局所経路を確認した。K-B2では、Jが明示選択・再照合した有限なoperation-result observationを`plan:compute`のC候補へdigest拘束し、Jの再照合、既存owner L3、M解釈更新、更新後の次task再評価までのconsumerを接続した。`plan:reflect`は入力から除外し、reflection出力を採用候補や権限へ変換しない。meaning-update J/M storeは7-store canonical snapshot inventoryとinspectionへ追加したが、restore前quiescence／restore後reopen consumerは未接続であり、そのstoreを含むrestoreはfail-closedの`BUILD_GAP`に残す。従来の5-store snapshotはpartialとしてread-only inspectionできるが、新store状態を証明できないためrestore対象にしない。限定HDS testとGateway synthetic smokeはこの局所経路の証拠であり、全Gateway経路・製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を示さない。次はmeaning-update store restoreのquiescence、HDS hold、再観測consumerを接続する。pending reconcile、projection再構築、migrationのwriterを無視してRust shadowを接続しない。

旧Jの現writerは確認なしに二重化・移管しない。C08.03実provider、OD-03 live外部作用、D4-Pocket／ミニドラ別repo変更、P13公開・出荷GOは保留する。試験用一仕事は製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`を自動成立させず、限定testを全suiteや実機の成功へ転記しない。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。
