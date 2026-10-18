# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0、工程表SHA-256=7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77、Codex施工指示SHA-256=D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8）、適用AGENTS.md、作業標準要領、現物、active対象要求を再読した。開始HEAD／origin/main=1fc0d17888a62a6b4cc3f55bb2f1a50c72a8f952、開始worktree clean。三点正本はowner指定rev2.3 ZIPの新規展開から再読し、旧版や過去会話の状態を現行へ転記しない。

## 今回のBUILD_BATCH

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-03-E03.03-RECOVERY-BOUNDARY-OPERATOR-PROJECTION。関係単位=E03.03「破損範囲の隔離復旧」。対象はBLUE-TANUKIの既存read-only復旧診断からControl Center operator projectionへの検証境界表示接続。D4Pocket／ミニドラ、実provider／credential、外部業務作用、実復旧・再開、公開・出荷判断は対象外。

現行producerのJ/M/Broker recovery inspectorは検証済みevent数、未検証event数、破損開始ordinal、J/Mの最後の検証済みrevisionを持ち、CLIへ表示する。一方、Control Center向けdigest-only projectionはledger statusへ縮退し、operator consumerでは破損・検証境界位置を確認できない。これら数値と固定reason enumを非権威のoperator projectionへ渡し、Control Centerの既存read-only表示に結ぶ。

### 到達・停止境界

- projectionは検証済みprefixの件数、未検証suffixの件数、最初の未検証ordinal、取得できる最終検証revision、許可enumのreasonだけを表示する。event digest、raw event、task/command/credential、database pathは追加しない。
- used_for_authority=false、may_execute=false、external_backup_restore_point=not_examinedを維持する。検証済みprefixはbackup／restore pointではなく、復旧・再開の許可も作らない。
- 外側report boundaryが不正なら台帳境界の数値をnull／unknownへ落とす。ledgerがunavailable/schema不一致等で検証数を確定できない場合も0件と誤表示しない。件数とordinalの整合を検査してから投影する。
- 実DB修復、backup作成・復元、job別dependency graph、無関係jobの継続可否判断はこのバッチで実装しない。E03.03は仕事単位の破損影響範囲と独立backup照合が未接続のためBUILD_GAPのまま記録する。
- HDS-J／Approval／L3／Broker／M非権限／監査／fail-closedは不変。P13=PENDING_OWNER_GO、public_claim_allowed=false、C08.03実provider保留を維持する。

### 確認・Git

- 対象testsはGateway recovery projectionとWebChat Control Center描画。型検査、必要なbuild、文書変更のdocs gate、差分checkをバッチ境界で行う。
- 全suite、live/provider、credential、外部業務作用、5OS実機、QE_QC／QE_QAは実施しない。
- MIGRATION_COMPLETE（2026-10-12）。編集前の復旧refsはlocal branch／tagとremote tagで現世代=1fc0d17888a62a6b4cc3f55bb2f1a50c72a8f952、前世代=fdbd2738d6f51f9df5702f994aaff007c56fbd7e。実装と公開可能な進捗を限定commit／pushし、remote HEAD・二世代refs・clean worktreeを照合する。秘密・内部原典を追加しない。

次のconsumerはoperatorが実際の破損仕事と無関係な仕事を分けて復旧できるguarded recovery path。現在の単位でそれがなければ「可視化済み」と完了扱いせず、具体的なBUILD_GAPを残す。
