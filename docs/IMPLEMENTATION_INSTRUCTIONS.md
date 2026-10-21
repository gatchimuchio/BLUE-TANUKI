# BLUE-TANUKI 現行QE_BUILD指示

設計・工程・施工の現行正本は [`QE_CURRENT_AUTHORITY.md`](QE_CURRENT_AUTHORITY.md) が固定するowner指定の最新三点セットである。本指示は現在のactive BUILD_BATCHだけを扱う。完了作業と旧版は [`IMPLEMENTATION_HISTORY.md`](IMPLEMENTATION_HISTORY.md)／[`開発進捗.md`](開発進捗.md) の履歴ログとして保持し、今回の依存・変更系譜・矛盾の解消に必要な箇所だけを参照する。

## QE状態

`QE_STAGE=QE_BUILD`。工程順は全体設計→一気通貫の全体実装→結合形状成立→QE_QC→対象別QE_QA→ownerの公開・出荷判断。全体実装が未完了の間は詳細QC／QAを先行させない。構文・型・build・次consumerへの短時間疎通、安全を保つために必要な確認は行う。

D05.02は部分的に`WIRED`。Gateway emergency-stop／shutdownからExecutor→toolへの取消signal伝播、local shell workerの停止観測、CompleteHistory未設定・永続化失敗時の非権威lifecycle evidence回復経路がある。D05.02全体、`SYSTEM_SHAPED`、`BUILD_COVERED`は未成立。

残る`BUILD_GAP`は、Gatewayのtask単位cancel callsite、remote provider内部処理の停止確認、AbortSignalに従わないgeneric toolの強制停止。取消要求・local worker停止・provider側処理停止を同じ結果にしない。generic toolのprocessを任意に強制killできたと報告しない。

## 次のBUILD_BATCH

`QEB-41-D05.02-TASK-SCOPE-CANCEL-CALLSITE`。実際のowner-facing task操作から、対象task／command同一性の照合、取消受理、既存AbortController、Executor、tool、停止観測、結果表示までのproducer→consumerをつなぐ。

開始時に現行三点セット全文・適用AGENTS.md・HEAD／dirty state・対象routeと呼出元を再確認する。現存するControl Center／WebChat等の保護済みsurfaceを先に追い、別の権限経路を作らない。取消受付、取消signal伝播、local停止、外部provider停止は個別の観測状態として扱う。対象taskを同定できない要求はfail-closedにする。未承認の外部作用、実provider／credential、D4Pocket／ミニドラ別repo変更、公開・出荷判断を含めない。

最低限の確認は、変更した型・buildと実際のcancel producer→consumerの限定疎通、安全な誤対象拒否に絞る。全workspace suite、全異常注入、性能・耐久、OS別QAは全体実装形状成立後へ置く。

## 共通の保護とGit

HDS-J、Approval Gate、L3 final review、Broker Permission、M非権限、監査、秘密、復旧、fail-closed、ownerの独立した最終権限を維持する。C08.03実provider保留、P13=`PENDING_OWNER_GO`／`public_claim_allowed=false`を維持する。

main一本・単一writer・通常Windows開発。開始前にmain／remote・dirty差分・他writer・復元点を確認する。意味あるBUILD_BATCH終端で限定commit／pushを行い、remote HEAD、local復旧branch二世代、remote backup tag二世代、保護対象untracked、作業ツリーを再照合する。GitHub Actionsは現行AGENTS.mdのowner許可条件に限る。
