# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。新しいBUILD_BATCH開始時に、owner指定rev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、直前active指示、最新HEAD／差分、E03.03原文、Recovery APIとWebChat consumerを読み直した。active指示が参照する`docs/制御/QE再同期規約.md`はrepoに存在しない。実在する`AGENTS.md` §21.4と`docs/作業標準要領.md` §4をGit再同期正本とした。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラrepo、実provider／資格、外部業務作用、公開・出荷は対象外。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-OPERATOR-RECOVERY-INSPECTION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`57dae6014ae4af984fa5a54c274238a0715342d1`、開始時clean。編集前にlocal復旧branchとremote backup tagを現世代=`57dae6014ae4af984fa5a54c274238a0715342d1`、前世代=`0456640657249b5d641044274abee05eb8236747`へ期待SHA付きで回転し、local／remote二世代一致を確認した。

### 目的と到達状態

既存`--recovery-inspect`のread-only ledger reportを、既存maintenance-token保護Recovery面の実consumerへ接続する。operatorは明示的に診断を取得し、固定状態と残差件数を確認できる。権限、resume、restore、repair、retryその他の作用は作らない。

### 対象と境界

- 対象：WebChat recovery surface callback、`GET /recovery/inspection`、Gatewayの遅延import接続、Recoveryタブのallowlist projection、focused test、本進捗、公開ROADMAP、本指示。
- inspection endpointはmaintenance tokenを要求し、GET／`no-store`のみ。失敗本文は固定enumで、raw errorを返さない。
- UI表示はreport全体の直出しを避け、既知のstatus／non-negative countと非権威境界だけを投影する。再生checkpointはbackupではないこと、独立backup restore pointは`not_examined`であることを示す。
- inspectionからbackup／restore／provider reset／connector reset／factory resetは呼ばない。既存actionの認可・確認条件も変更しない。
- 外部backupの完全性・独立性・restore可能性、仕事別の修復・restore、実state／live serve、別repo、実credential／作用、QE_QC／QE_QAは対象外。E03.03／QEB-03は`BUILD_GAP`を維持する。

### 実装・限定確認の結果

- `packages/channel-webchat/test/webchat.test.ts`：PASS、1 file／76 tests。maintenance-token gate、`no-store`、GET限定、既存actionの非呼出し、UI入口を確認。
- `pnpm typecheck`：PASS、exit 0。
- `pnpm build`：PASS、exit 0、15 workspace projects。
- `pnpm docs:check`：PASS。文書、日本語基底通常gate、license。Markdown 186、移行負債77件。初回gateが検出した`MIGRATION_COMPLETE`記載漏れを修正後に再実行した。
- `git diff --check`：PASS。

### Git閉包

既存のbackup ref移行状態=`MIGRATION_COMPLETE`を維持する。

実装と本指示を含む限定commitを`main`へpushし、再fetch後のHEAD／`origin/main`、clean tree、local復旧branch二世代とremote backup tag二世代を照合して閉じる。remoteに他writerの進行があればforceせず再同期する。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。
