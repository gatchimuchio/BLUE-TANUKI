# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。owner指定の最新版QE三点全文、適用AGENTS.md、active指示、HEAD・差分・対象producer／consumerを本作業開始時に再読済み。Windows上でBLUE本体を施工する。

## 現行施工単位

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-APPROVAL-POLICY-CONSUMER。ExecutorをHDS-BRAINの唯一のcommand分類consumerへ接続する。

`packages/hds-brain/src/approval_policy.ts`の`approvalContextFromCommand`と`finalReviewRequired`をExecutorが直接使用する。proof発行時と実行直前に`operation`、`risk`、`final_review_required`を実commandから再導出して照合し、unknown proof sourceとsource／decision不整合を拒否する。HDSがL3と判定したcommandはproof発行時とExecutor dispatch直前の双方で`human_final_review`由来を要求し、不正proofの永続ticketを先行発行しない。Executor独自のfinal-review operation分類は削除した。Core→HDS-BRAINのworkspace依存を追加し、HDS-BRAIN standaloneを維持する。

開始HEAD=`f85c681eb8ce0b8542b06c111dde354527eeca4c`。編集前にlocal復旧branch二世代とremote backup tag二世代を開始HEAD／直前HEADで照合した。local／remote共通の復元世代は`f85c681eb8ce0b8542b06c111dde354527eeca4c`／`6407a969df8f3dd64fb0d33546e5253242085534`。バックアップref方式の移行は`MIGRATION_COMPLETE`（2026-10-12）である。

## 確認状態

Core Executorの対象5 files／49 tests、Gateway実行意思・file.search worker・operation plan・operation resultの4 files／24 testsはPASS。全workspace `pnpm typecheck`、15 project `pnpm build`、`pnpm hds:standalone`もPASS。HDS standaloneはhealth=ok、audit chain valid、Runtime Invariants all_ok=true、hds_calls_llm=false。

Gateway結果調停の拡張suiteは29 tests中28 PASS／1 FAIL。失敗は「tool候補を成功・意味採用・作用へ変換しない」で、承認proofは通過した後の合成LLM tool候補処理が`llm_failure.kind=unknown`を返し、結果本文がないためoutput digest状態が`not_present`となる。今回の承認policy接続内の不一致ではないが、原因は未確定のため別途調査対象として残す。全suite PASSとは扱わない。

## 残る境界と閉鎖

D02.02の部分接続として扱う。D02.03の移行完了、Broker独立Permission、D08.01の単一外部作用・結果照合、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは主張しない。独立Broker Permission、汎用command内容結合、他作用の保存receipt調停、外部postcondition照合、5OS installed対応は引き続き`BUILD_GAP`。D4Pocket／ミニドラ別repo、provider・実credential・業務外部作用は変更・使用しない。C08.03実provider検証は保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。内部QE原典・ZIP・要求対応表・raw運転証拠はPublic Gitへ追加しない。

このバッチを閉じる前に、`pnpm docs:check`、`git diff --check`と差分レビューを完了し、限定commitをmainへpushする。最後にremote HEAD、local復旧branch二世代、remote tag二世代、clean worktreeを照合する。次consumerは最新正本と作業時点の実装を再読して選ぶ。
