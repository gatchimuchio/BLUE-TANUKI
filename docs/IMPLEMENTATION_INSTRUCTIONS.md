# BLUE-TANUKI 現行実装指示：QE-GOV-SYNC（5OS／backup ref移行）

## 1. 目的

AGENTS.mdのQE規律へ作業標準・工程・戦略・非対象・文書整合検査を同期する。今回はバックアップ方式のD4Pocket一致、5OSの設計・工程・文書gate統合という規定整合の限定taskであり、製品コードの新規開発ではない。

## 2. Phase境界

D01.02は2026-10-10に局所実装・検証されmainへ反映した過去成果。ownerの製品開発停止を維持し、D01.03へ自動進行しない。C08.03の実LLM/provider試験は保留。別repo、実資格、実外部作用、公開、P13 Owner GOの権限は本規定同期から生まれない。

## 3. Scope

今回の追加対象はAGENTS.md、docs/PLATFORM_TARGETS_QE.md、docs/BACKUP_REF_MIGRATION.md、docs/作業標準要領.md、docs/ROADMAP.md、docs/DEVELOPMENT_PRACTICE.md、docs/INDEX.md、scripts/check_docs.mjs、必要な日本語基底試験の整合である。

AGENTS.md、docs/作業標準要領.md、docs/ROADMAP.md、docs/開発進捗.md、docs/STRATEGY_FRAME.md、docs/NON_GOALS.md、docs/DEVELOPMENT_PRACTICE.md、docs/OPENCLAW_REJECTION_AUDIT.md、docs/INDEX.md、関連する文書ゲートと旧v1 RCの公開境界。

## 4. Non-goals

製品コード、HDS/Approval/L3、credential、実OS作用、D4Pocket／ミニドラの別repo実装、製品release、J1日本語移行を開始しない。内部QE/HDSの設計原典・要求対応表をPublic Gitへ置かない。

## 5. 最初に確認する files

AGENTS §§0/2/3/5/19/20/21/24、作業標準要領、ROADMAP、STRATEGY_FRAME、NON_GOALS、PRODUCT_ROADMAP、開発進捗、移行台帳、scripts/check_docs.mjs、最新main HEAD。

## 6. 必須grep

QE_BUILD、BUILD_BATCH、QE_QC、QE_QA、D01.02、PENDING_OWNER_GO、D4Pocket、GUI Shell、ClawHub、selected-scope、refs/heads、refs/tags、pnpm testを確認する。

## 7. 既存anchor

J/HDS判断とBrokerの現在Permissionは独立であり、Owner最終責任、Approval Gate、L3、hash-chain監査、Runtime Invariants、M非権限、fail-closedを保持する。D4Pocketは新AGIの予定外殻であり、旧RCの実導入証拠はない。

## 8. 実装要件

バックアップ正規方式はD4Pocketと同じlocal二世代branch／remote二世代tagとする。現在BLUEはPENDING_BACKUP_REF_MIGRATIONであり、tag二本の実SHAが保存されてから旧remote branchを整理する。tag変更手段・権限がないときはref移行を完了扱いせず、既存branchを保護してCodexの認可済みGitへ移送する。

最終対応対象はWindows、Linux、macOS、Android、iOS。AndroidはG09、iOSはG10として独立実装し、旧F16のモバイル入力媒体と分ける。旧v1.0 RCのMobile非搭載は現在の完成主張とは独立した制限である。内部QE rev2.2三点正本の実装索引は旧192＋6＝198単位。Public Gitへ非公開原典全文を投入しない。

QE_DESIGN→QE_BUILD→SYSTEM_SHAPED→BUILD_COVERED→QE_QC→QE_QA→QE_RELEASE_REVIEWへ統一する。198小単位（旧192＋Android/iOS各3）は実装索引であり、小単位の全体試験・QA・毎回Git保全を義務化しない。安全重要の拒否検査と既存保護は維持する。

OpenClaw/Museの観測能力を包含対象から勝手に削除せず、危険な実装方式は安全な代替経路へ置き換える。ClawHubの無審査コード実行を禁止し、安全な互換Adapterの検討まで禁止しない。

## 9. Safety invariants

HDS-BRAIN、Owner同意、D4Pocketの独立Permission、L3、秘密、監査、停止とfail-closedを維持し、非公開正本を公開しない。

## 10. Operator usability

実際に通った仕事と残るBUILD_GAP、次consumerを優先報告し、schemaやfixture成功を本番完成へ転用しない。

## 11. Tests

文書間の現行QE工程、backup refs、競合包含、D4Pocket責務、P13を突合する。既存testや保護ゲートを削除しない。

## 12. Validation commands

差分、関連docs:checkと日本語基底gate、移行台帳SHA、Git HEADと二世代backupを確認する。実行できない検証はNOT_RUNと記録する。

## 13. Manual smoke

この作業では実Provider、OS実機、installed製品、credentialed live、外部実作用の試験を行わない。

## 14. Permanent-use check

現行旧RCは1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。新AGIのQE_QC/QAは未開始と区別する。

## 15. Final report format

変更した文書、解消した不整合、保持した安全・停止、実施検査とNOT_RUN、commit/remote HEAD/backup SHAを記録する。

## 16. Next-phase dependency

QE-GOV-SYNCの完了は製品開発再開の承認ではない。ownerの明示再開、内部QE rev2.0三点正本の認可済み環境への供給、最新mainと現物差分の再照合後にのみ次のBUILD_BATCHを選ぶ。C08.03実provider保留と別repo変更には独立した承認が必要。
