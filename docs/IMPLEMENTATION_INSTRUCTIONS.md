# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0、工程表SHA-256=7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77、Codex施工指示SHA-256=D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8）、適用`AGENTS.md`、作業標準要領、現物、active対象要求を再読した。開始HEAD／`origin/main`=`4a864cc6eca5466cdb28422b29ace0bb4c83dc10`、開始worktree clean。三点正本はowner指定rev2.3 ZIPの新規展開から再読し、旧版・旧SHAを現行状態へ転記しない。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.03-RECOVERY-PACK-INTEGRITY-INSPECTION`。関係単位=E03.03「破損範囲の隔離復旧」。対象は既存`readManifest`／`preflightRestoreManifest`の読み取り検査を、maintenance tokenで保護されたControl Centerの明示的GET consumerへ接続すること。バックアップ作成・復元・reset・job再開は呼ばない。

### 到達・停止境界

- 選択対象は現行Recovery snapshotが示すlatest pack。manifest sidecar、固定manifest契約、各archive path・kind・symlink境界・SHA-256・byte countを読み取り検査する。
- APIは結果を固定enum、件数、backup ID digestだけに制限する。manifest、path、source値、archive内容、secret、raw errorを返さない。応答は`no-store`。検査失敗は固定結果に落とす。
- 表示ラベルは「pack内部のintegrity」。このRecovery packは設定・監査・session等の現行sourceSpecsだけを対象とし、canonical HDS J/M／Broker／OperationPlan状態を含まない。従って独立した完全復元点、復元成功、仕事の復帰可能性、実行許可を示さない。
- GETはファイル作成・変更・copy・restore・reset・restartを行わず、既存action routeと分離する。明示操作時だけhash検査を行う。
- E03.03は`BUILD_GAP`を維持する。仕事単位の破損依存隔離、確認済みcanonical restore point、guarded selective recoveryは未接続。このバッチではbackup writer、private-state backup、復元、job別隔離、他repoを変更しない。
- HDS-J／Approval／L3／Broker／M非権限／監査／fail-closed不変。C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`。

### 確認・Git

- 対象はGateway recovery surface、maintenance-token WebChat route、Control Center read-only表示。pack正常／manifestまたはarchive改変／packなし、認証拒否、GET限定、read-only不変を確認する。
- バッチ境界で対象test、typecheck、build、文書gate、repo health、diff checkを実施する。全suite、live/provider、credential、外部業務作用、5OS実機、QE_QC／QE_QAは対象外。
- 編集前復元refsはlocal branchとtag、remote tagで現世代=`4a864cc6eca5466cdb28422b29ace0bb4c83dc10`、前世代=`1fc0d17888a62a6b4cc3f55bb2f1a50c72a8f952`。`MIGRATION_COMPLETE`。バッチcloseoutで限定commit／pushし、remote HEAD、二世代refs、clean worktreeを照合する。秘密・内部原典を追加しない。

次consumerは、canonical J/M/Broker／OperationPlan storeの一貫したsnapshotと仕事単位の依存を確認した後にのみ、破損依存仕事を隔離して無関係仕事の継続を限定評価するguarded recovery path。pack integrityのPASSをその許可に使わない。
