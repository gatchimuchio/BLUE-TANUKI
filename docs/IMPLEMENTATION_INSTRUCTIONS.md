# BLUE-TANUKI 有効な実装指示

現単位: **C01.02 — 言語間契約の同値性**。PRODUCT_BUILD_MODE、contract profile。直接依存C01.01はmain `12410aec` でlocal acceptanceと通常GitHub保管まで確認済み。今回はこの一単位だけを実装・検証し、二世代backup、main commit/push、remote照合まで閉じる。

ownerは全工程を一単位ずつ委任している。通常の検証済み単位成果はGitHubを履歴・成果物保管庫としてcommit・pushする。製品公開主張、実業務作用、別repo変更、出荷判断、owner GOは本単位の範囲外。私有原典、封印詳細、raw証拠、秘密、運転状態はrepoへ含めない。

## 1. 目的

BLUE-TANUKI protocolに版付きの制限JSON交換境界を追加し、同一の合成入力をTypeScript境界とRust conformance実装に通して、受理・拒否・canonical UTF-8 bytesの一致を確立する。型とcanonical bytesは権限・承認・実行を作らない。

## 2. Phase 境界

raw UTF-8 byteと共有fixtureだけを扱う。D4/GUI-Shell repo、Gateway、Approval Gate、監査chain、Runtime Invariants、credential、保存済み製品data、外部serviceへ接続しない。Rust conformance crateは開発検証専用とし、通常runtimeからimportしない。D02の実通信、issuer/audience、期限、epoch、再送・receipt検証は未実施として残す。

## 3. Scope

- `packages/protocol/src/境界交換契約.ts`、`packages/protocol/src/index.ts`
- `packages/protocol/test/境界交換契約.test.ts`、`packages/protocol/test/fixtures/c01_02_境界交換vector.json`
- `packages/protocol/rust-conformance/Cargo.toml`、`Cargo.lock`、`src/lib.rs`
- `.gitignore`はこのRust conformance crateの生成`target/`だけを除外
- `docs/実行分離と接続認証.md`、本書、`docs/開発進捗.md`、`docs/ROADMAP.md`、`docs/INDEX.md`、`CHANGELOG.md`
- `規定/移行台帳.json`は今回変更する`CHANGELOG.md`のhashだけ

## 4. Non-goals

C01.03のvalidate:agi実試験接続、D02の実通信・認証・deadline・replay、実Rust Broker接続、Gateway/Approval/audit経路変更、他repo変更、別言語の全面刷新、HDS原典の公開、GA、P13 owner GOを行わない。

## 5. 最初に確認する files / symbols

root/近傍AGENTS、日本語基底正本、作業標準要領、SECURITY.md、AUDIT.md、CONFIG.md、README.md、CHANGELOG.md、C01.02とC01親、C01.01 acceptance、仕様s03/s05/s06/s07/s13/s14/s15/s16、原典D0 §5–6／A12 §16／H5 §14-24を確認する。

現行anchorは`packages/protocol/src/common_record.ts`の`parseJsonTextAtBoundary`、`packages/protocol/src/types.ts`の`parseInboundRequestAtBoundary`と`normalizeInboundRequestForAuthority`、`packages/protocol/src/index.ts`の公開export、`packages/protocol/test/`のVitest設定である。既存InboundRequestのNFKC/trim/metadata削除は承認内容に流用しない。

## 6. 必須grep

`parseJsonTextAtBoundary`、`normalizeInboundRequestForAuthority`、`canonicalJsonObject`、`canonicalJsonValue`、`NFKC`、`CompleteHistory`、`used_for_authority`、`FINAL_REVIEW_OPERATION_LIST`、`境界交換契約`、Cargo manifest、Rust importを定義・consumer・testから確認する。Rust product consumerが現repoにない場合は、開発専用conformanceの範囲とlive/runtime未接続を記録する。

## 7. 既存anchor

C01.01のduplicate-key/finite-number boundary parserを再利用できる範囲で使う。channel入力正規化は独立責任として維持する。新契約を既存runtimeへauthority pathとして接続しない。

## 8. 実装要件

1. raw UTF-8を厳格decodeし、重複decoded key、孤立surrogate、不正JSON、上限超過をfail-closedで拒否する。
2. version、canonicalization profile、UTCミリ秒timestampを必須・strict検査する。未知top-level field、危険keyを拒否し、暗黙defaultを置かない。
3. JCS準拠のcanonical UTF-8 bytesを作る。object keyは再帰的にUTF-16 code unit順、array順・文字列・改行・null/欠落を保持する。NFKC、trim、未知field削除、timezone変換をしない。
4. numberはsafe integer範囲の通常十進integer tokenだけ受理し、小数、指数、負のゼロ、範囲外を変換前に拒否する。
5. TypeScriptとRust conformance実装が同一のfixture corpusを読み、正例bytesと負例failure classを照合する。Rust crateは開発専用、製品runtimeに接続しない。
6. errorは本文・値・未知keyを反射しない。digest、issuer、permission、approval、実行、認証成功を生成しない。

## 9. Safety invariants

HDS-BRAIN唯一authority、Approval Gate、L3 final review、audit hash-chain、Runtime Invariants、fail-safeを変更・迂回しない。parser/conformance出力は証拠であり権限ではない。C01.02 local conformanceをinstalled/live/runtime proofやrelease readinessに昇格しない。

## 10. Operator usability

失敗は`invalid_utf8`、`invalid_json`、`duplicate_key`、`invalid_unicode`、`invalid_number_profile`、`schema_validation_failed`等の安全な分類で返し、入力本文を出さない。再実行できる対象は合成fixtureだけと示す。

## 11. Tests

- `BT-U-C01.02-P`: protocol testとRust conformanceが共通正例を受理し、fixture記載canonical bytesと完全一致する。UTF-16 key順、Unicodeを正規化しないこと、null/欠落、array順、UTCミリ秒timestamp、integer境界を含む。
- `BT-U-C01.02-N`: 両実装が共通負例を同じfailure classで拒否する。duplicate/escaped duplicate、invalid UTF-8、孤立surrogate、不正number、safe integer超過、version/field、危険key、offset/不正timestamp、size/depth上限を含む。
- 親scenario BT-T-C01-01〜04は全体としてNOT_RUN。C01.03 runner、migration、実通信/live条件を局所testから成立扱いしない。

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

    pnpm --filter @blue-tanuki/protocol exec vitest run test/境界交換契約.test.ts -t BT-U-C01.02-P
    pnpm --filter @blue-tanuki/protocol exec vitest run test/境界交換契約.test.ts -t BT-U-C01.02-N
    cargo test --locked --manifest-path packages/protocol/rust-conformance/Cargo.toml c01_02_positive
    cargo test --locked --manifest-path packages/protocol/rust-conformance/Cargo.toml c01_02_negative

`pnpm validate:agi`はC01.03でrunnerが登録されるまで実行しない。timeout/assertion/既存gateを弱めない。`doctor`の失敗は既存process/credential環境と今回差分を切り分け、資格情報を読まず停止processを変更しない。

## 13. Manual smoke

共通corpusをTypeScript boundaryとRust conformance validatorへローカルで通し、受理bytesと拒否classを比較する。Gatewayを起動・再起動せず、live/native broker、credential、外部serviceへ接続しない。

## 14. Permanent-use check

この単位が証明するのはWindows上のworkspace検証と、固定したprofileに対するTypeScript/Rust実装の合成vector同値まで。実Rust product consumer、実IPC、実承認・作用、installed配布、OS隔離、long-run、release readinessは証明しない。

## 15. Final report format

有限受入、変更path、実consumer/conformance validator、リスク・経路・証拠分類、正確なselectorと必須command、全FAIL、未実施/P13状態、branch・commit・push・remote HEAD、二世代backup refsと復元点を日本語で示す。unit acceptance、Git統合、製品・release判断を分ける。

## 16. Next-phase dependency

C01.02のlocal受入、必須検証、二世代backup、main commit/push、remoteとclean照合まで終えたらこの単位を閉じて停止する。次候補C01.03のrunner接続と親C01全体の受入は未成立のまま残す。
