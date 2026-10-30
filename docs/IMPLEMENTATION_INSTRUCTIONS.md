# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) がpinするrev3.0三点セットである。独立作業の開始・切替・再開時は三点セットの全文を読み直す。読むのは現行pinが指す一組だけとし、適用`AGENTS.md`、最新owner指示・active指示・HEAD・dirty差分・remote・復旧refも照合する。旧版と完了記録は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) に履歴として保持し、依存・変更系譜・矛盾の解決に必要な部分だけ参照する。

## QE状態

`QE_STAGE=QE_BUILD`。全体設計から一気通貫の実装、全体結合形状の成立まで進める。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立、重要な未接続は`BUILD_GAP`として保持し、QE_QC／QE_QAは未開始。公開状態は`PENDING_OWNER_GO`／`public_claim_allowed=false`。復旧ref移行は`MIGRATION_COMPLETE`の記録があり、各Git操作前に現行値を確認する。QC・QAを小単位の前提にせず、安全・秘密・承認・監査・fail-closedの保護は全工程で維持する。

rev3.0ではHDS Framework Kernelの言語非依存な意味責務と、BLUE HDS Runtime Kernelの有限なJ/M制御を分け、Runtime核を段階的に独立させる。現行のTypeScript HDS-BRAINが単独の実行authority／状態writerである間、Rust shadowは作用権限もM正本書込みも持たない。明示された検証条件を満たすsingle-writer cutover前に旧経路を無効化・削除せず、Rustのcrate・schema・shadow結果だけから移管完了を主張しない。

## 現行接続状態

完了済みのK-B0～K-B4と先行BUILDの詳細証拠は[`ROADMAP.md`](ROADMAP.md)および[`開発進捗.md`](開発進捗.md)に保持し、通常施工では再列挙しない。現在はK-B5のRust shadow比較を継続する。製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`、Rust cutover、QE_QC／QE_QAは未成立。

### Active batch: K-B5 — 同一合成系列のJ採否・L3記憶遷移比較

- **目的:** 現行TypeScript HDS-BRAINのpolicy採否とM writerをauthorityとして維持したまま、Rust Runtime Kernelが同じscore／weight／thresholdから独立算出するJ projection、停止後の人間復帰、およびL3承認済みM更新の有限な残差状態を比較する。
- **producer／consumer:** `HDSUpperController.decide()`／`resume()`と、Gatewayの意味候補採用・引用判断再評価の成功commit分岐がprojectionを作る。通常inbound、resume、L3 memory approvalの既存observerから同じRust processへ順に渡し、比較receiptをGatewayの非権威ログへ返す。未確定のM再評価数・明示された未評価状態・再評価済み／残存数だけを集計し、IDや個々の参照は渡さない。
- **入力・出力:** 軸名、score、weight、lifecycle状態、policy閾値、TypeScript採否を送る。resume時は元のpolicy SUSPENDと`owner_verdict`、`resume_allowed`、復帰後decision、command有無だけを追加する。L3記憶遷移では承認／適用状態、許可状態ではない固定区分、および上限512の集計数だけを追加する。検証済みpurpose-bound plan computeでは保存時のSHA-256(goal_ref)・purpose version・purpose digestと、現行`GoalGovernanceLedger`から独立に読み取った同じgoalの現行版・digestを別項目で投影する。状態は`not_bound`／`ledger_unavailable`／`goal_not_found`／`available`に分け、Rust receiptの`purpose_binding_matches`はIPC輸送整合、`purpose_binding_current_matches`は保存時bindingと現行projectionの一致を表す。現行bindingが古い／欠落なら非権威比較残差として返す。raw入力、goal_ref、目的本文、detector evidence、owner identity、source/target/judgment ID、digest本文、command本文、credential、request identity、M本文は送らない。Rust receiptの操作上の`decision`は常に`hold`で、比較採否は参考値のみ。
- **対象単位:** 同一合成系列でASSERT／FAIL／SUSPEND／OUT_OF_SCOPE、SUSPENDからapprove／reject／blockへの遷移、owner L3記憶採用時の未評価・未再評価残差、および指定J判断の再評価済み／残存数を比較する。軸／閾値を安全に表現できない場合、policy外controller override、または固定小数点化の判断境界付近は`not_comparable`として送らず、既存Gateway判断へ影響させない。
- **継続条件:** Rust shadowは作用権限・M正本writerを持たない。Rust起動・IPC失敗・queue上限・比較不一致はTypeScript authorityへ反映しない。比較不一致は観測し、原因を次の施工へ渡す。
- **この単位で未接続:** J/Mの全体意味比較、Rust shadowのsingle-writer cutover。C08.03実provider・OD-03 live外部作用・他repo書込み・P13公開／出荷GOも保留する。
- **必要最小確認:** HDS／Gateway typecheck・build、Rust compile／test、Rust実processを通す合成4分岐とSUSPEND→resume、IPC拒否・無作用停止。全workspace suite・QE_QC／QE_QA・実provider・実外部作用・5OS実機の成功へ転記しない。

現行`DecisionLog.goal_purpose_binding`を現在の`GoalGovernanceLedger` projectionと別々にRustへ渡すv6 J projectionを接続した。Rustは従来のIPC輸送一致に加え、保存時と現行のgoal identity・purpose version・digestを比較し、鮮度状態を非権威receipt／Gateway observer logへ返す。古い版は比較残差として扱い、TypeScript authorityの判断・実行・M writerを変更しない。raw goal ref・目的本文は投影せず、目的内容の意味適合は未評価のまま分離した。この差分の`pnpm typecheck`、Rust `cargo check`、`cargo fmt --check`はPASS。Rust実process、test、Gateway runtime統合は未実施。次はK-B5内でHDS Framework Kernel意味責務の現行consumer接続を進める。

## Gitと復旧

main一本・単一writer・通常Windows開発を維持する。意味あるbatch終端で対象を限定してcommit／pushし、remote HEADと復旧refを照合する。local復旧branch二世代は`codex/backup-main`／`codex/backup-main-prev`、remote backup tag二世代は同名tagを使う。保護対象untrackedや他writerの差分をreset／clean／上書きで消さない。GitHub Actionsは現行`AGENTS.md`の許可条件だけで手動利用する。
