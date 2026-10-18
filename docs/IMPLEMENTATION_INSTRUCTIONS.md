# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。E03.03向けBUILD_BATCH開始時に、owner指定のrev2.3三点正本（仕様SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用`AGENTS.md`、`docs/作業標準要領.md`、QE再同期規約、直前active指示、最新HEAD／差分、関連要求とJ/M実consumerを再読した。対象はBLUE-TANUKIのみ。D4Pocket／ミニドラのrepoは変更しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-READONLY-LEDGER-RECOVERY-INSPECTION`。関連単位=E03.03「破損範囲の隔離復旧」。開始HEAD／`origin/main`=`06474e29ee965f90adbae135b533a1bcb2fb0334`、開始時clean。編集前のlocal recovery branch／remote backup tagは現世代`06474e29ee965f90adbae135b533a1bcb2fb0334`、直前`89825a413eb4d23463243dbf26da79040e1fcd0e`へCAS／lease付きで回転し、local pair・remote pairの実SHA一致を確認した。backup ref移行=`MIGRATION_COMPLETE`。

### 目的と到達状態

J/Mのcanonical event ledgerをHDS-BRAIN内の再利用可能な読取専用検査経路で検査し、各台帳の再生可能prefix、最初の未検証位置、未検証suffix件数、投影状態を非権威の診断結果にする。Gatewayの通常startup・HDSUpperController生成・owner lease獲得に依存せず呼べるローカル`--recovery-inspect` consumerを接続する。検査は保存物を変更しない。

J/Mで照合できる更新はopaque digestで対応づけ、片側だけにある更新・内容digest不一致・未検証suffixを隔離残差として表示する。確認済み点は**canonical eventから再生できるcheckpoint**と明記し、独立backupや実際に復元可能な保存物が検証されていない場合は復元点として報告しない。CLIは破損範囲、利用できる検査結果、未照合残差、次の安全な手順を出すが、truncate、rebuild、restore、retry、resumeを行わない。

E03.03は診断consumerの実装・接続まで`BUILD_GAP`として扱う。これだけで破損DBの修復、回復可能な仕事の再開、SYSTEM_SHAPED、BUILD_COVERED、QE_QC／QE_QAを宣言しない。J/M両台帳が健全でも、診断結果は権限・承認・仕事の実行可否を発行しない。

### 対象と境界

- 対象：HDS-BRAIN J/Mのread-only ledger inspector、Gateway local CLI router、限定test、`docs/開発進捗.md`、`docs/ROADMAP.md`、本指示。
- 出力は状態名、revision／event digest、位置・件数、opaque update digest、固定の次行動に限る。raw event、update ID、内容、command、ticket、credential、保存先絶対pathは出さない。`used_for_authority=false`を保つ。
- inspectorはsqliteをread-onlyで開き、既存HDS parser・canonical/hash chain検査を再利用する。runtime権限・policy・Approval・M採否・正本書込み・外部作用へ接続しない。
- Node最小対応版`22.14.0`を維持する。最低版を引き上げるAPI、依存追加、実環境DBへのrepair/restoreは対象外。
- E03.02の結果照合・M pending、Cron event／job correlation、verified external backup/restore、OS ACL/network filesystem保証、Windows以外の証拠、実credential/provider・外部業務作用、D4Pocket／ミニドラ別repo、全体QE_QC／QE_QA、P13公開・出荷判断は未接続または対象外として記録する。

### 最小確認

合成SQLiteでJ/Mの健全ledger、派生projection差異、途中corruption、読取専用・保存物不変、二台帳間の照合残差、JSON／text診断出力を確認する。対象限定test、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`git diff --check`を実行する。実DB／service起動／資格情報／外部作用は使用しない。

### 実装・検証結果

HDS-BRAIN J/M inspectorとGateway `--recovery-inspect`を接続した。検査結果は非権威であり、正本更新・修復・restore・resume・外部作用を行わない。SQLite recovery副ファイルが存在する場合やDELETE journal modeでないDBはopenせず利用不能として返す。独立backupは未検査と表示する。

J/M focused testは2 files／34 testsで、健全ledger、derived projection mismatch、再生可能prefix／破損suffix、read-only・DB不変、副ファイル時のopen抑止を確認。Gateway focused testは1 file／2 testsで、空state rootの非作成・非権威表示・J/M digest残差分類を確認した。build済みGatewayのJSON／text CLIも空の一時state rootで実行し、両形式で未解決状態を出しexit 2、通常state rootを作らないことを確認した。`pnpm typecheck`、`pnpm build`（15 workspace projects）、`pnpm docs:check`（日本語基底／license gateを含む）、`git diff --check`はPASS。

この成果はE03.03のread-only診断consumerまでの部分接続であり、E03.03／QEB-03は`BUILD_GAP`のまま。verified canonical prefixは独立backupでも、仕事の復元・再開許可でもない。破損台帳の修復、backup検証、operator recovery UI、OS ACL／network filesystem保証、QE_QC／QE_QAを成立扱いしない。

### Git・停止条件

限定commitを`main`へpushし、remote HEAD、local二世代recovery branch、remote二世代backup tag、clean stateを再照合する。canonical ledgerを自動修復・切詰めする要求、破損台帳から権限を復元する経路、raw内容を診断出力へ露出する経路が生じた場合は、その作用を実装せずfail-closedのままにする。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、C08.03実provider保留を維持する。
