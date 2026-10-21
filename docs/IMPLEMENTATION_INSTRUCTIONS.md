# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

## 現在の結合形状

D05.02は部分的に`WIRED`だが全体は未成立。remote provider内部の停止確認とAbortSignal非協調toolの強制停止は`BUILD_GAP`として残り、未確認の停止を表示しない。閉じた取消関連BUILD_BATCHの個別説明は履歴ログに保持する。

D08.01は部分的に`WIRED`。合成served経路から結果不明・再起動後照合までのlocal subpathを接続したが、実providerやowner実操作を含む全体は`BUILD_GAP`。F10.01 owner WebChat入口とF10.02 Telegram durable admission・entry identity・返信分割・UTF-8 text attachment consumerはそれぞれ局所経路を部分的に`WIRED`とする。F16.01でTelegramのJPEG／PNG原画像を要求限定の一時contextとしてGatewayからCの画像対応provider adapterまで運ぶ経路を部分的に`WIRED`とする。F16.02でTelegram音声をrequest-boundの揮発入力としてCの文字起こしconsumerへ渡し、確度不明の候補をHDS出力監査へ通すfixture経路を部分的に`WIRED`とする。音声能力はprovider／model単位の明示設定が既定offで、実provider／served Gatewayは未試験。文字起こしをHDS要求・承認へ戻さず、音声だけでは本人確認・承認・L3 final reviewにならない。F10.02全体は他media、live経路、複数入口運用が未接続のため`BUILD_GAP`。C08.03実provider試験は保留であり、能力設定とfixture serializationは実providerの対応証拠ではない。接続範囲と検査証拠の詳細は[`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)の該当QEB履歴を参照する。閉じたBUILD_BATCHの個別手順・試験結果はactive指示に複製しない。

## 次のBUILD_BATCH

次のBUILD_BATCHは現行工程表の`F16.03`。F16.02のTelegram音声→canonical Gateway boundary→HDS→Executor→C transcription→Output Auditはfixtureで部分的に接続した。実provider未検証のため利用には明示model capability設定が必要であり、C08.03の実provider試験保留を維持する。transcriptは確度未報告の候補として返し、HDSへ再投入しない。操作・承認が必要ならownerは通常の独立した入力経路を使う。F10.02は他media、live経路、複数入口運用が残り`BUILD_GAP`。P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。依存の完成QAや全workspace suiteを先行条件にせず、QE_BUILDを維持して製品全体の結合形状成立前に詳細QC／QAを開始しない。次の独立した作業・切替・再開時は`QE_CURRENT_AUTHORITY.md`の現行pinが固定する仕様書・工程表・施工指示書の三点セットの全文を読み直す。適用`AGENTS.md`も読み直す。旧版・完了記録は依存・変更系譜・矛盾の解消に必要な箇所だけ参照する。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。backup-ref migrationは`MIGRATION_COMPLETE`であり、[`BACKUP_REF_MIGRATION.md`](BACKUP_REF_MIGRATION.md)の現行記録に従う。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
