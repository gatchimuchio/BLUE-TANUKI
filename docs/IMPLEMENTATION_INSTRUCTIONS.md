# BLUE-TANUKI 有効な実装指示

現単位: **C01.01 — 共通record・状態の境界検証**。PRODUCT_BUILD_MODE、contract profile。直接依存B03.03はmain 5eb5ebaに保管済み。今回は一単位だけを実装・検証し、Gitのcommit、push、remote照合まで閉じる。

ownerは全工程を一単位ずつ委任している。通常の単位成果はGitHubを履歴・成果物保管庫としてcommit・pushする。製品公開主張、実業務作用、別repo変更、出荷判断、owner GOは本単位の範囲外である。私有原典、封印詳細、raw証拠、秘密、運転状態はrepoへ含めない。

## 1. 目的

共通recordと状態をJSON入力境界で検査し、現行CompleteHistoryの旧recordを読取専用の共通record投影へ接続する。履歴から現在の意味、実行結果、権限を復活させない。

## 2. Phase 境界

合成JSON、隔離した一時JSONL、protocolとHDS-BRAINの既存APIだけを扱う。稼働中Gateway、Approval Gate、監査chain、Runtime Invariants、資格情報、保存済み製品data、外部サービスを変更しない。

## 3. Scope

- packages/protocol/src/common_record.ts、packages/protocol/src/index.ts
- packages/hds-brain/src/complete-history/codec.ts、store.ts、index.ts、packages/hds-brain/src/index.ts
- packages/protocol/test/common_record.test.ts、packages/hds-brain/test/complete_history.test.ts
- docs/IMPLEMENTATION_INSTRUCTIONS.md、docs/開発進捗.md、docs/ROADMAP.md、docs/INDEX.md、CHANGELOG.md
- 規定/移行台帳.jsonは今回更新したCHANGELOG.mdのhashのみ

## 4. Non-goals

C01.02のTS/Rust同値性、C01.03のvalidate:agi実試験接続、実approval・実行、Gateway経路変更、外部業務作用、別repo、HDS原典の公開、GA、P13 owner GOは行わない。

## 5. 最初に確認する files / symbols

AGENTS.md、日本語基底正本、作業標準要領、SECURITY.md、AUDIT.md、CONFIG.md、README.md、CHANGELOG.md、C01.01とその親、共通仕様の指定節を確認する。

現行anchorはpackages/protocol/src/types.tsのInboundRequestSchemaとparseInboundRequestAtBoundary、packages/hds-brain/src/complete-history/codec.tsのdecodeCompleteHistoryEntry、store.tsのloadFromFile・replay・exportSnapshot。approval_policy.tsは変更しない。

## 6. 必須grep

JSON.parse、schema_version、CompleteHistoryStore、used_for_authority、complete_history_used_for_authority、parseInboundRequestAtBoundary、validate:agiの定義・consumer・既存試験を確認する。既存のprotocol JSONテキストparserや共通record schemaは未確認として扱い、存在を仮定しない。

## 7. 既存anchor

protocolのZod strict境界とCompleteHistory JSONL readerを利用する。CompleteHistoryは元payloadを保持する既存読取・再生契約を維持し、新しい共通record投影からはraw payloadを返さない。旧schema_versionを一律拒否しない。

## 8. 実装要件

1. CommonRecordの必須field、opaque ID、参照、時刻、content_ref/content_digestの組をschema化する。unknown field、ID上限超過、重複JSON key、有限でない数値、壊れたJSONをfail-closedで拒否する。
2. 意味、運用、仕事、作用、証拠の状態を別の固定schemaにする。不明は明示的unknownとして保持し、状態名やIDから権限を推定しない。
3. CompleteHistoryの実JSONL readerで共通JSON検査を通し、旧記録のchain/hashと現行read/replayを維持する。
4. replayAsCommonRecordsは読み取り専用のmetadata projectionを返し、raw payloadを含めず、used_for_authority=falseとcomplete_history_used_for_authority=falseを固定する。旧payload内のapproval等は現在権限として解釈しない。
5. schema、実consumer、正例・負例をつなぐ。runner追加、Gateway表示接続、別状態移行を混ぜない。

## 9. Safety invariants

HDS-BRAINが唯一のauthorityであり、Approval Gate、final review、audit hash-chain、Runtime Invariants、fail-safeを迂回しない。履歴、parser出力、projection、metadataはauthorityではない。未知・不正な入力は採用せず、raw入力や秘密をエラーへ出さない。

## 10. Operator usability

失敗理由はinvalid_json、duplicate_key、non_finite_number、schema_validation_failed等の安全な分類で返し、入力本文・値・未知keyを反射しない。既存raw replayと新projectionの用途差、再試行可能な検査範囲を開発者向けに明示する。

## 11. Tests

- BT-U-C01.01-P: packages/protocol/test/common_record.test.tsの同名テストでopaque参照、schema版、意味・実行・証拠の独立状態を境界parserで確認する。
- BT-U-C01.01-N: 同ファイルでunknown authority field、201文字ID、escaped duplicate key、NaN、1e999、参照とdigestの片側欠落を拒否する。
- CompleteHistory testで旧schema_versionの読取保持、raw replayの維持、payloadを含まないprojectionと両non-authority flagを確認する。JSONL readerの重複key・NaN・overflowも検査する。
- BT-T-C01-01/02の今回の局所部分だけ実行する。BT-T-C01-03はC01.03、BT-T-C01-04全体のmigration/live条件は未実行として残す。

## 12. Validation commands

必須:

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm build
    pnpm test
    pnpm docs:check
    pnpm validate:repo-health
    pnpm run doctor
    pnpm validate:packaging

局所selector:

    pnpm --filter @blue-tanuki/protocol exec vitest run test/common_record.test.ts -t BT-U-C01.01-P
    pnpm --filter @blue-tanuki/protocol exec vitest run test/common_record.test.ts -t BT-U-C01.01-N
    pnpm --filter @blue-tanuki/hds-brain test -- test/complete_history.test.ts

validate:agiはC01.03で実装・登録されるまで呼ばない。timeout、assertion、既存gateを緩めない。

## 13. Manual smoke

合成入力を上記protocol parserとCompleteHistoryStoreの専用一時JSONL readerへ通し、受理・拒否・hash-chain・raw replayと共通projectionの差を確認する。Gatewayを起動・再起動せず、runtime・資格情報・liveサービスへ接続しない。

## 14. Permanent-use check

この単位が証明するのはWindows上のworkspace build/typecheck/test、既存JSONL reader、および合成legacy recordの読取projectionまで。installed配布、実保存物、実approval、live Gatewayの再起動後、TS/Rust互換、長期運用は別条件として保持する。

## 15. Final report format

有限受入と状態、変更path、実consumer、リスク・経路・証拠分類、正確なselectorと全必須commandの結果、未実施、P13状態、branch・commit・push・remote HEAD、二世代backup refsと復元点を報告する。unit acceptance、Git統合、製品・release判定を混同しない。

## 16. Next-phase dependency

C01.01のlocal acceptance、必須検証、二世代backup、main commit/push、remoteとclean照合後にこの単位を閉じる。次候補はC01.02であり、言語間同値性の範囲・依存・mode・公開範囲を新入口で再同期してから扱う。C01.03のrunner接続と親C01全体の受入は未成立のままとする。
