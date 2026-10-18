# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、直前active指示、現物HEAD／差分、E03.03、Recovery APIと既存consumerを読み直した。`docs/制御/QE再同期規約.md`はrepoに存在しないため、Git同期は`AGENTS.md` §21.4と`docs/作業標準要領.md` §4に従う。対象はBLUE-TANUKIだけ。D4Pocket／ミニドラrepo、実provider／資格、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-RESTORE-PREFLIGHT-ATOMICITY`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`e9c1df7ecdcd0ed4a3dd854414f6da9ccb87592f`、clean。編集前のlocal復旧branchとremote backup tagは二世代を条件照合して更新し、現世代=`e9c1df7ecdcd0ed4a3dd854414f6da9ccb87592f`、前世代=`30a3d4176ea50f2adc51a3fda0a595129e2a333e`でlocal／remote一致を確認した。backup-ref状態=`MIGRATION_COMPLETE`。

### 目的

既存restore consumerが選択済みmanifestの全targetとarchiveを、変更前に構造・設定path・archive path・kind・digestまで検証する。後段itemの破損で先行targetを部分更新する経路を塞ぎ、無効manifestでpre-restore backupの副作用も起こさない。

### 対象と境界

- 対象：`apps/gateway/src/recovery_surface.ts`、`apps/gateway/test/recovery_surface.test.ts`、本進捗、公開ROADMAP、本指示。
- 既存`RESTORE`確認とHDS authority境界を維持する。manifest全itemの形状・重複・期待target・archive payloadを事前検証し、通過後にだけpre-restore backupを作成してrestoreを進める。
- SHA-256 sidecar／archive digestは破損・不一致検出に限り、独立anchor、真正性、権限、restore可能性証明とは扱わない。manifest検査は復旧操作UI、repair、resume、owner承認を追加しない。
- 実際のrestore実行、実state／live serve、資格・provider・外部業務作用、独立backup／異host復元、D4Pocket／ミニドラ、5OS実機、QE_QC／QE_QA、P13 owner GOは対象外。E03.03／QEB-03=`BUILD_GAP`、C08.03 provider試験保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### 成立条件

1. manifest全itemの検証が完了するまでtarget変更とpre-restore backup作成を開始しない。
2. 後段archiveのdigest不一致時にtarget内容が全て保持され、不要なpre-restore packが作成されないことをfocused testで確認する。
3. 既存の通常restore、path拒否、秘密非出力を壊さず、Gateway focused suite、typecheck、build、必要なdocs gate、`git diff --check`を確認する。
4. batch末に限定commitをmainへpushし、HEAD、remote、backup refs、clean stateを再照合する。remoteに他writer更新があれば上書きせず停止・再同期する。

### 技術確認・Git閉包

- Gateway recovery focused suite：`recovery_surface.test.ts` 1 file／7 tests PASS。
- `pnpm typecheck` PASS、`pnpm build` PASS（15 workspace projects）。distを消去する型検査の後にbuildを順次実行した。
- `pnpm docs:check` PASS（日本語基底通常gate・licenseを含む、移行負債77件）。`git diff --check` PASS。
- 実装commit=`4bfecebbe162d4ab0543f5cb71d81cebc5e825d8`をpush済み。文書closeoutも限定docs-only commitとしてpushし、再fetch後のlocal／remote main一致、復元二世代refs一致、clean treeを確認済み。
