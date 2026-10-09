# BLUE-TANUKI 有効な実装指示

現単位: **B03.01 — 状態所有と保存取引の配置**。資料工程、文書profile。有限資料条件と必須6検証は受入済み。Git完結は該当main commitのremote・backup・clean照合を要する。作業基点はmain `c5659dc7c02ba7c63324b926cbc376c7dc8e7344`。前単位B02.04は有限資料受入と検証・Git保管を閉じた。旧結果や既存試験を新取引の実証へ転記しない。

ownerの全工程委任と、GitHubを履歴・成果物保管庫として使う明示指示に基づく。通常成果を各単位で検証・commit・pushする。私有原典・封印詳細・完全対応表・秘密・運転状態・raw証拠は公開しない。

J0完了、J1未承認。P13は凍結、`PENDING_OWNER_GO`、`public_claim_allowed=false`、版 `1.0.0-rc.1` を維持する。

## 1. 目的

既存資産の採否、J/M保存所有、取引単位を具体的な配置へ固定する。既存HDS-BRAIN・protocol・Approval Gateへ接続する最小差分を設計し、第二の万能判断基盤を作らない。

## 2. Phase 境界

一つの資料単位を編集前二世代保存、配置決定、整理、必須検証、main commit・push・remote照合まで閉じる。今回の根拠は同版ソース、依存資料、公式保存仕様。新しいDBや製品取引は実装しない。

## 3. Scope

- `docs/状態所有と保存取引.md`、`docs/開発進捗.md`
- 本指示、`docs/ROADMAP.md`、`docs/INDEX.md`、`CHANGELOG.md`
- `規定/移行台帳.json` の審査済みCHANGELOG hashのみ

## 4. Non-goals

B03.02のIPC・認証・故障分離、B03.03のwriter移行、C03の実DB取引、実業務作用、別repo変更、全面改修、規定案全体の適用、製品名・言語刷新、J1、GA、owner GO。既存保護を外さず、共有DBを実隔離済みとしない。

## 5. 最初に確認する files / symbols

AGENTS、日本語基底正本、作業標準要領、現指示、ROADMAP、SECURITY／AUDIT／CONFIG／README／CHANGELOG。protocol型とparser、HDSUpperController、AuditLog、LTM／complete-history／approval／failure-memory store、executor session、gateway組立・schedule・recovery／updateを追跡する。

## 6. 必須 grep

`MemoryCommitSnapshot`、`captureMemoryReference`、`appendFileSync`、`writeFileSync`、`inflight`、`suspended`、`sourceSpecs`、`createBackupManifest`、`restoreManifest` の定義とconsumerを読む。driverの不存在を調べ、既存JSONLを原子取引と推定しない。新API pathは設計時点の不存在を確認する。

## 7. 既存 anchor

[状態所有と保存取引](状態所有と保存取引.md) §1の実pathを観測基点へ照合する。controllerの採否→audit→記憶→参照auditは別書込み、各storeの起動・復旧は個別。sourceの観測と未来の接続予定を区別する。

## 8. 実装要件

資産の採否、所有者、実consumer、限定更新API、保存・拒否・失敗、後続受入を記録する。新J/MのSQLite・別namespace・別取引を固定し、J pending→M反映→J帰還とBroker別所有を明示する。公式仕様、現driver import、未実証を分ける。

## 9. Safety invariants

HDS-BRAIN standalone、Approval Gate、L3 final review、hash-chain audit、Runtime Invariantsを維持。同じDBを同じ最終責任としない。意味記憶MをTrinityのdeterministic policy Mと混同しない。C・UI・metadata・過去承認・履歴から現在権限を生成しない。必要監査を正本取引へ結び、旧監査の欠損を捏造しない。

## 10. Operator usability

採否済みpending、M反映済み、J照合済み、外部結果不明を区別する。保存障害では変更有無、再試行・照会方法、停止状態、必要修復、未決作用を示す。commit結果不明を未commitと断定しない。コード復元と状態・消費済み権限・外部作用の復元を区別する。

## 11. Tests

資料正例は資産採否・J/M別所有・別更新API・保存取引の具体化。負例は同じDBを同じ最終責任とする案、第二正本、記憶権限化、JSONL原子性誤認、pending欠落、架空crash実証を拒否する。原文・source・公式仕様を照合し独立読取監査を行う。新DB crash／再起動／OS／writer移行の製品試験はNOT_RUN。

## 12. Validation commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

文書工程のためdoctor、packaging、release生成、installed／live smokeは対象外。通常日本語gateはdocs:checkに含む。全移行・GOを扱わず、厳格gate成功を今回の条件には追加しない。既存検査の削減やtimeout変更は行わない。

## 13. Manual smoke

索引→進捗→配置決定の参照、実pathと新pathの区別、取引の所有、未実施表示、公開除外、後継・復元条件を読取監査する。新しい製品保存経路の起動は対象外。

## 14. Permanent-use check

文書整合や既存試験を恒久保存・復帰・実隔離・現在Permissionの証拠にしない。driver/設定、write/sync障害、競合、receipt消失、再起動・epoch、投影再構築、対象OSの証拠を後続の実consumerへ渡す。

## 15. Final report format

有限成果、変更ファイル、リスク・経路・証拠分類、正確な検証と全失敗、未実施、P13、main commit、push／remote、二世代refsと復元点を示す。資料受入、実装、Git統合、releaseを別状態で報告する。

## 16. Next-phase dependency

次候補はB03.02。本単位の局所受入、Git完結、引継ぎを確定し境界停止する。範囲委任に従い、次単位は現指示、依存、HEAD、未決状態、許可pathを新しい入口で再同期する。別repo変更・実業務作用・出荷GOは別判断。
