# BLUE-TANUKI 現行QE_BUILD指示

2026-10-13。最新版の非公開QE rev2.3三点正本と適用AGENTS.mdを再読し、現行ownerの開発委任をBLUE本体の接続実装へ適用する。過去のQE-GOV-SYNCと製品開発停止は履歴へ保持する。規定更新だけを再開の根拠にしない。

## 対象と到達状態

QE_STAGE: QE_BUILD。BUILD_BATCH: QEB-01-RESULTS。関係単位はD01.02の依存結果入力、D01.03の実結果producerと改訂経路。今回の接続は「既存HDS-issued command → 既存Approval／Executor → 実結果の識別 → HDS feedback監査 → digest履歴 → Control Center表示」。

型・metadataだけで終了せず、専用一時領域の実file.searchをこのconsumerへ通す。実行口を呼ぶ前の拒否、呼出し後の結果不明、console表示のみを区別し、raw検索内容・対象・errorを追加の結果記録へ保存しない。

## 現物・変更範囲

開始時local／remote mainは66a21a84545666fbeb178ff003bc14b3fd5796f7、作業ツリーはクリーン。旧D01.03差分は既存stashに保全し、復元・上書きしない。parentを単一writerとし、調査subagentはread-onlyとする。

protocolのcommand結果契約、HDSの実request IDとfeedback相関、既存Executorの結果producer、gatewayの履歴projection、既存Control Centerの表示と必要な限定試験を変更する。既存planのOperationExecutionResultとは別の未結合command観測として記録する。

## 次consumerと未接続

D01.03はBUILD_GAP。実command結果をplan/stepへ結び付ける内部binding、旧plan保持、実行済み・試行済みstepの再実行防止、改訂された未実行stepのHDS採否と旧pending承認の失効を次に接続する。今回の結果はplan_step_binding=unboundであり、依存準備へ自己申告のplan/step IDを渡さない。

GatewayでLLM planから自動stepを起動する経路は今回追加しない。失敗・timeoutを「作用なし」とみなす自動再実行も追加しない。現在の結果記録だけで複数step完遂・SYSTEM_SHAPED・BUILD_COVEREDを宣言しない。

## 安全・停止条件

既存HDS standalone、Approval Gate、L3、hash-chain監査、output audit、M非権限、fail-closedを維持する。未承認command、相関不一致、未知commandの結果を実行権限・実行済みstepの根拠にしない。console fallbackは配送成功の証拠へ昇格させない。

C08.03実provider試験、実credential、実外部業務作用、D4Pocket／ミニドラ別repo変更は保留。P13=PENDING_OWNER_GO、public_claim_allowed=false、version=1.0.0-rc.1。非公開QE／HDS原典・要求対応表・raw証拠はPublic Gitへ置かない。

他writerの変更、重大な安全逸脱、owner停止指示があれば該当変更を止めて再同期する。バックアップref移行はMIGRATION_COMPLETEであり、旧ZIPの移行待ちを現在へ転記しない。

## 技術確認と復元点

Windowsでtypecheck → build → 変更した実consumerと未承認・不一致の限定確認を実施する。HDS standalone、gatewayのserve/resume smoke、変更文書のdocs:check、差分チェックを行う。全体suite、耐久、性能、全OS、実provider、QC／QAはこのBUILD_BATCHでは未実施。

編集前復元点はlocal refs/heads/codex/backup-main／prevとremote refs/tags/codex/backup-main／prevを66a21a84545666fbeb178ff003bc14b3fd5796f7／b31be61b55f4097f2b638d3a2ae3be88d2a4a251へ期待SHA付きatomic pushで照合済み。意味ある接続と必要な確認を終えたら限定commit/pushし、remote main・二世代tag・stash・作業ツリーを再照合する。

## 再同期

毎作業・小単位の開始／切替／再開時に、最新版の仕様書・工程表・施工指示書すべてと適用AGENTS.md、active指示、actual HEADと差分を読み直す。前回要約・記憶で代替しない。詳細QCを小単位へ先行させず、次の実consumerを接続する。
