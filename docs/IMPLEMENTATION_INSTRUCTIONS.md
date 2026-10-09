# BLUE-TANUKI 有効な実装指示

現単位: **B03.03 — single-writer移行設計**。資料工程、文書profile。直接依存B03.02は資料受入・必須6検証・main保管を閉じた（`bde29777448cbe20424c52b59c8cb6b455b27c7e`）。今回は旧新の停止・切替・照合・戻しと非公開差分をADRへ記録する。今回の有限資料条件と必須6検証は受入済み。Git完結は該当main commitのremote・backup・clean照合を要する。実移行の成功は条件に混ぜない。

ownerの全工程委任と、GitHubを履歴・成果物保管庫として使う明示指示に基づく。通常成果を各単位で検証・commit・pushする。私有原典・封印詳細・完全対応表・秘密・運転状態・raw証拠は公開しない。J0完了、J1未承認。P13凍結、`PENDING_OWNER_GO`、`public_claim_allowed=false`、版 `1.0.0-rc.1`を維持する。

## 1. 目的

一仕事一writerを保つ旧新停止・切替・未決照合・戻し・互換読取を、実ソースの不足と後継consumerへ接続して固定する。

## 2. Phase 境界

一つの資料単位を編集前二世代保存、方式決定、整理、必須検証、main commit・push・remote照合まで閉じる。稼働process、実保存物、資格、外部先は変更しない。source読取を実棚卸し・停止・切替の証明へ昇格しない。

## 3. Scope

- `docs/旧新切替と復元の判断記録.md`、`docs/開発進捗.md`
- 本指示、`docs/ROADMAP.md`、`docs/INDEX.md`、`CHANGELOG.md`
- `規定/移行台帳.json`の審査済みCHANGELOG hashのみ

## 4. Non-goals

新DB・protocol・切替管理の実装、影実行、稼働backup／restore、実writer切替、D/E/G製品試験、別repo変更、全面改修、J1、GA、owner GO、外部業務作用。Git復元を運転状態・外部世界の巻戻しとしない。

## 5. 最初に確認する files / symbols

AGENTS、日本語基底正本、作業標準要領、現指示、ROADMAP、SECURITY／AUDIT／CONFIG／README／CHANGELOG。serve shutdown、runtime CLI、schedule／cron、controller inflight／suspended、audit／approval／session／history、recovery／update、watchdog／service、Executor timeoutの実consumerを読む。

## 6. 必須 grep

`shutdown`、`runServe`、`persist`、`onFeedback`、`sourceSpecs`、`restoreRecoveryBackup`、`prepareManualUpdate`、`withTimeout`、`assertExecutionApproved`、`Restart=on-failure`、`schema_version`の定義とconsumerを確認する。推測pathがなければ実在pathへ戻り、予定pathの不存在と現readerの限界を確認する。

## 7. 既存 anchor

[旧新切替と復元の判断記録](旧新切替と復元の判断記録.md)§1を観測基点へ照合する。停止処理、逐次copy、JSON保存、AbortSignal、chain検査の成立範囲を保ち、実drain・全状態snapshot・世代fencing・互換writeへ拡張解釈しない。

## 8. 実装要件

初回は一局所serviceの参加jobと保存系を静止させる。Jの切替record、M更新、Brokerの現Permission・消費・receiptを別所有にし、全体ACIDを主張しない。shadowには合成済み観測と読取専用射影だけを渡す。全writer・再起動元・保存先を棚卸しし、受付凍結、排出、T0、変換、未決照合、実効失効、新世代取得、作用禁止検査、限定再開を定める。

## 9. Safety invariants

J採否 AND 現在Broker Permission AND 必要Owner Approval。shadow外部作用・正本書込み、旧新writer重複、消費復活、旧binaryの新schema書込み、projection権限化を禁止する。HDS-BRAIN standalone、Approval Gate、L3、brand、監査、Runtime Invariants、独立保護を維持する。

## 10. Operator usability

段階、writer、作用禁止・保留、変更済み範囲、未決結果、照会方法、互換write可否、次操作を示す。停止要求・worker terminal・子孫停止・外部取消を分け、unknownを未実行へ戻さない。戻しにも新writer停止・未決照合・新世代を要する。

## 11. Tests

資料正例はsource、writer棚卸し条件、barrier、照合、互換読取、四復元面、私有差分と後継の対応。資料負例9件を拒否し、独立読取監査を行う。実shadow・移行・crash・OS停止・外部取消と親scenario全体はNOT_RUN。既存試験は既存契約の範囲だけを証明する。

## 12. Validation commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm docs:check
pnpm validate:repo-health
```

文書工程のためdoctor、packaging、release生成、installed／live smokeは対象外。通常日本語gateはdocs:checkに含む。厳格gate成功を今回の条件に追加せず、既存検査・timeoutを弱めない。

## 13. Manual smoke

索引→進捗→ADR、実在／予定path、shadow非作用、停止と切替条件、未決と復元、公開除外・後継を読取監査する。新製品経路を起動しない。

## 14. Permanent-use check

runtime開始時に実保存先・起動元・writer・未決を確認する。再起動、flush、古い世代、消費、crash窓、外部結果、旧binary read／write互換を後継実consumerへ渡す。Git・文書・旧試験だけで恒久切替を証明しない。

## 15. Final report format

有限成果、変更ファイル、リスク・経路・証拠分類、正確な検証と全失敗、未実施、P13、main commit、push／remote、二世代refsと復元点を示す。資料受入、runtime、Git統合、releaseを別状態で報告する。

## 16. Next-phase dependency

次候補はC01.01。今回の受入・Git完結・引継ぎを確定して境界停止する。範囲委任に従い、次単位は現在の指示、直接依存、PRODUCT_BUILD_MODE、HEAD、未決状態、許可path、contract profileを新入口で再同期する。G01.01へはD09.03／E03.03の直接依存を満たすまで進まない。
