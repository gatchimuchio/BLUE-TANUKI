# BLUE-TANUKI 有効な実装指示

現単位: **B03.02 — 実行分離・認証・外殻契約**。資料工程、文書profile。直接依存B03.01は資料受入・必須6検証・main保管を閉じた（`0dd49528ce7517cfd2c16d11fdca834bd312ac09`）。今回の有限資料条件と必須6検証は受入済み。Git完結は該当main commitのremote・backup・clean照合を要する。旧成功を新IPC・隔離の実証へ転記しない。

ownerの全工程委任と、GitHubを履歴・成果物保管庫として使う明示指示に基づく。通常成果を各単位で検証・commit・pushする。私有原典・封印詳細・完全対応表・秘密・運転状態・raw証拠は公開しない。

J0完了、J1未承認。P13は凍結、`PENDING_OWNER_GO`、`public_claim_allowed=false`、版 `1.0.0-rc.1`を維持する。

## 1. 目的

IPC、issuer/audience、世代、承認内容のcanonical bytes、非信頼実行と保護の故障分離を、既存責任・consumerへ接続する方式として固定する。GUI-ShellのPermissionをJが発行しない。

## 2. Phase 境界

一つの資料単位を編集前二世代保存、方式決定、整理、必須検証、main commit・push・remote照合まで閉じる。新endpoint、鍵、worker、OS隔離、実業務作用は作成しない。固定外殻ソースは参照であり、現在の外殻完成状態の証拠ではない。

## 3. Scope

- `docs/実行分離と接続認証.md`、`docs/開発進捗.md`
- 本指示、`docs/ROADMAP.md`、`docs/INDEX.md`、`CHANGELOG.md`
- `規定/移行台帳.json`の審査済みCHANGELOG hashのみ

## 4. Non-goals

B03.01の新DB実装、B03.03のwriter移行、D02–D07の実通信・永続消費・秘密使用・独立停止・OS実証、別repo変更、全面改修、製品名・言語刷新、J1、GA、owner GO。既存IPCの不足を確認せず新transport必須と断定しない。

## 5. 最初に確認する files / symbols

AGENTS、日本語基底正本、作業標準要領、現指示、ROADMAP、SECURITY／AUDIT／CONFIG／README／CHANGELOG。webchat認証・token、Executor brand／timeout／shell、protocol parser、projection digest、secret storeの実consumer、gateway停止・schedulerを読む。固定外殻のnative IPC、Permission／Approval、登録、取消、Taskを照合する。

## 6. 必須 grep

`checkAuth`、`resume_approval_token_store`、`assertExecutionApproved`、`withTimeout`、`stableJson`、`resolveAllSecretRefs`、`emergencyStop.active`、`AbortSignal`、`process.kill`、`canonical_payload_hash`、`expected_client_pid`の定義とconsumerを確認する。推測pathの不在を記録し、実在pathへ戻る。将来予定5pathの不存在を確認する。

## 7. 既存 anchor

[実行分離と接続認証](実行分離と接続認証.md)§1を観測基点へ照合する。既存Bearer・同一process brand・native session認証・nonce再送拒否を保持し、その成立範囲を新issuer/audience結合、独立停止、OS隔離へ拡張解釈しない。

## 8. 実装要件

既存native IPCと登録Adapterを優先し、保護登録簿・opaque handle・受領Broker記録へ主体、内容、世代、用途、期限、単回消費を束縛する。追加transportは具体的不足時だけD03.03候補。制限JCS profileのraw拒否と凍結bytes、J/Cから独立する保護process、用途限定秘密参照、外殻一般射影、失敗・復元・実consumerを記録する。

## 9. Safety invariants

J採否 AND 環境Brokerの現在Permission AND 必要Owner Approval。Jは外殻Permissionを発行しない。peer認証・metadata・登録・UI・記憶を現在権限へ昇格しない。HDS-BRAIN standalone、Approval Gate、L3、既存brand、監査、Runtime Invariantsを維持し、Trinity policy Mと意味記憶Mを混同しない。

## 10. Operator usability

認証、期限、世代、内容、Permission不一致と結果不明を分ける。停止要求、worker terminal、子孫停止確認、外部取消確認を別状態にする。未決receiptは照会し、別IDで再実行しない。復帰は原因修復と現Permission・世代・対象の再照合を要する。

## 11. Tests

資料正例は方式・所有・実consumer・拒否・後継の接続。資料負例8件はJ発行Permission、認証同意代替、自己申告issuer、旧epoch、NFKC命令変更、同じqueueの保護、汎用秘密env、timeout即停止確定を拒否。独立読取監査を行う。新通信・秘密・停止・OS隔離の製品試験と親scenario全体はNOT_RUN。

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

索引→進捗→方式文書の参照、現物と予定path、接続認証と操作権限、未実施、公開除外、後継・復元を読取監査する。新製品経路の起動は対象外。

## 14. Permanent-use check

文書整合や旧試験を認証済み通信・永続単回消費・秘密制限・独立停止・OS隔離の証拠にしない。再起動、期限・失効、queue／DB障害、子孫、外部取消、egress、TS/Rust同値を後継実consumerへ渡す。

## 15. Final report format

有限成果、変更ファイル、リスク・経路・証拠分類、正確な検証と全失敗、未実施、P13、main commit、push／remote、二世代refsと復元点を示す。資料受入、runtime、Git統合、releaseを別状態で報告する。

## 16. Next-phase dependency

次候補はB03.03。本単位の受入・Git完結・引継ぎを確定し境界停止する。範囲委任に従い、次単位は現指示、依存、HEAD、未決状態、許可pathを新しい入口で再同期する。別repo変更・実業務作用・出荷GOは別判断。
