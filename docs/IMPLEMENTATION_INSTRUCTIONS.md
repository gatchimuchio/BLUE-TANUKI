# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回のBUILD_BATCH開始時にowner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、直前active指示、現物HEAD／差分、E03.03要求、Recovery APIとWebChat consumerを読み直した。参照先の`docs/制御/QE再同期規約.md`はrepoに存在しないため、Git同期は`AGENTS.md` §21.4と`docs/作業標準要領.md` §4に従う。対象はBLUE-TANUKIだけ。D4Pocket／ミニドラrepo、実provider／資格、外部業務作用、公開・出荷判断は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-OPERATOR-RESIDUAL-ISOLATION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`30a3d4176ea50f2adc51a3fda0a595129e2a333e`、clean。編集前のlocal復旧branch／remote backup tagは期待SHAを指定して二世代回転し、現世代=`30a3d4176ea50f2adc51a3fda0a595129e2a333e`、前世代=`57dae6014ae4af984fa5a54c274238a0715342d1`で一致した。backup-ref状態=`MIGRATION_COMPLETE`を維持する。

### 目的

Recovery inspectionに、未決のOperationPlan bindingとM update残差を仕事単位でoperatorへ示す実consumerを加える。operatorが残差の区分と相関を識別できる一方、ID・内容から権限を推定できず、Recovery UIから実行・復旧を起動できない状態を作る。

### 対象と境界

- 対象：Gateway recovery reportからoperator向け投影、既存`GET /recovery/inspection` callback、WebChat Recoveryの表示、投影・consumerのfocused test、本進捗、公開ROADMAP、本指示。
- OperationPlan plan／step／command参照、admission参照、update参照はSHA-256 digestと固定enumのみ。raw ID／内容／path／command／ticket／外部actionを出さず、最大200件に制限する。
- source schema／surface／mode／authority・execution flagsをGatewayで確認し、invalid boundaryでは仕事別行を空にする。UIも投影schema、surface、flags、digest、enum、上限を再検査する。
- 既存inspectionはGET・maintenance-token・`no-store`境界を保つ。inspectionはapprove、execute、repair、restore、retry、resume、backup createを呼ばない。replay checkpointはbackupではなく、外部backupは`not_examined`のままとする。
- 実state／live serve、独立backupの完全性・restore可能性、実provider／credential／外部業務作用、D4Pocket／ミニドラ、5OS実機、QE_QC／QE_QA、P13 owner GOは対象外。E03.03／QEB-03=`BUILD_GAP`、C08.03 provider試験保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### 技術確認

Gateway recovery focused suiteは1 file／9 tests PASS、WebChat focused suiteは1 file／76 tests PASS。`pnpm typecheck`はPASS、`pnpm build`は15 workspace projects PASS、`pnpm docs:check`は日本語基底通常gate・licenseを含めPASS（移行負債77件）、`git diff --check`もPASS。

実装commit=`9372bb8c39e2ffe14ee897ece17a574f7ee4aaba`をpush済み。再fetch後のlocal／`origin/main`は同SHAで、編集前復元参照はlocal branch／remote tagとも現世代=`30a3d4176ea50f2adc51a3fda0a595129e2a333e`、前世代=`57dae6014ae4af984fa5a54c274238a0715342d1`で一致した。進捗記録を含むdocs-only closeoutをpushした後も再fetchし、main一致・clean tree・二世代ref一致を確認する。remoteに他writerの進行があればforceせず再同期する。
