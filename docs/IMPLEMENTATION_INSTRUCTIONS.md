# BLUE-TANUKI 現行QE_BUILD指示

ownerの2026-10-21再確認：まずQE_BUILDで全体を一気通貫に接続し、`SYSTEM_SHAPED`／`BUILD_COVERED`成立後に実物のQE_QC、改善・再検査、対象別QE_QAへ進む。構築中は前進に必要な型・接続・build確認と、安全欠陥を止める確認に限る。小単位ごとに全体品質を追跡・最適化しない。

現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) の三点だけとする。各作業では現行三点の該当節、適用AGENTS、ここにある最新BUILD_BATCH、今回に直接関係する要求・コードを確認する。旧版と閉じたBUILD_BATCHは履歴として保持し、依存・変更系譜・矛盾の解決に必要な場合だけ読む。

### 最新BUILD_BATCH：`QEB-11-E03.03-CANONICAL-STORE-INVENTORY-RECOVERY-BARRIER`

開始HEAD／`main`／`origin/main`=`9f22aa49a08a82e603f303dd83f402ebbcbe3a77`。owner指定rev2.3の三点pinとE03.03「回復可能な仕事と破損依存仕事を分け、確認済み復元点と残差を示す」、適用AGENTSのQE_BUILD・安全・Git条項、現行capture／Recovery consumerを関係範囲で確認した。tracked worktreeはcleanで、Linux `target/`は保護対象untracked。

対象はcanonical SQLite snapshot作成中のsource inventory変化を見落とさないこと。既存DBのcommitだけでなく、開始時に不在だったstoreの出現も捕捉終了時に再照合し、変化を検出した場合は全storeのarchiveを破棄して共同captureを未確認へ閉じる。変化がなければ既存の個別snapshot結果を保持する。Recovery inspection／restore preflightが既存statusから未確認を消費する。

境界：`cross_store_atomic=false`を維持し、atomicity、job-level restore point、復旧可能性、権限、復元・再開許可を生成しない。復元操作、HDS判断、Approval、J/M/Brokerのruntime状態、外部作用、秘密、別repoは変更しない。対象は`apps/gateway/src/canonical_state_backup.ts`とそのRecovery surface focused test。E03.03のjob-level依存隔離、独立restore point、guarded selective recoveryは引き続き`BUILD_GAP`。

source inventoryをcapture終了時に再照合し、canonical storeの出現／消失または再照合失敗時は全archiveを破棄して全storeを`snapshot_failed`へ閉じる。stableなsource inventoryと既存DB状態を保持できた場合だけ既存の個別snapshot statusを残す。Recovery inspection／restore preflightは既存statusを通じて未確認を消費する。これで新規storeの未観測による古い部分snapshotの有効化を止めるが、共同atomicity・job-level復旧点は主張しない。

| QE_BUILDの必要最小確認 | 結果 |
|---|---|
| source store新規出現中のcapture | `recovery_surface.test.ts` 15/15 PASS。新規storeを再現しarchive全削除・5 store全件`snapshot_failed`を確認。 |
| `pnpm typecheck`／`pnpm build` | 両方PASS。buildは15 workspace projects。 |
| `git diff --check`／`pnpm docs:check` | 両方PASS。日本語基底の移行負債76件は継続管理。 |
| restore実操作、全workspace suite、実provider／credential／外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

このcanonical source inventory fail-closed consumerを`WIRED`とする。E03.03のjob-level依存隔離、独立restore point、guarded selective recoveryと製品全体の`SYSTEM_SHAPED`／`BUILD_COVERED`は未成立。C08.03実provider保留、D4Pocket／ミニドラ別repo変更なし、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。実装commit=`e5b3f18de7869d04a114bd4b453b8c9c3f71ec5b`、closeout commit=`002873ee0674aac195f60fcd6e1ba22c05e5c7ac`。確認済みremote main／current backup tagは`002873ee0674aac195f60fcd6e1ba22c05e5c7ac`、previous backup tagは`9f22aa49a08a82e603f303dd83f402ebbcbe3a77`。local recovery branch／tagとremote tagの二世代が一致し、backup ref移行状態=`MIGRATION_COMPLETE`を確認済み。

### 履歴参照

閉じたBUILD_BATCHの詳細は必要時のみ[IMPLEMENTATION_HISTORY.md](IMPLEMENTATION_HISTORY.md)から参照する。ここには最新BUILD_BATCHだけを置き、旧版・完了記録を現行指示として併読しない。
