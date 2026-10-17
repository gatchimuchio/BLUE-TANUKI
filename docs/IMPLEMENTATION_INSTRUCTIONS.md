# BLUE-TANUKI 現行QE_BUILD指示

2026-10-17。毎作業・切替・再開時に、owner指定の最新版QE三点全文、適用AGENTS.md、active、HEAD・差分・対象producer／consumerを読み直す。現在のowner開発委任に従い、Windows上でBLUE本体を施工する。

## 対象と到達状態

QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-01-C07-PROPOSAL-REFERENCE-REVIEW。C07.01の意味更新案について、成功した現行LLM commandから届いた案の支持・反証記録IDと版を、同一commandの現在M射影に対してJが照合し、非権威auditへ件数・限定状態を残す。plan:reflect由来の案を通常の意味更新CompleteHistoryへ保存しない。

この作業開始時はHEAD=origin/main=`7d3cc9555212a738c1e2d7b1b3f1a2b857cbfb17`、clean。編集前local復元branch二世代とremote backup tag二世代を現HEAD／直前HEADへCAS・期待SHA付きatomic pushで保全・照合した。変更はこのBUILD_BATCH内の単一writerへ集約する。

## 判定の境界

参照ID・記録版の現在射影一致と、scope reference文字列の一致だけを確認する。scope digest、意味的支持／反証、反証探索の完全性、候補target・prior versionの実在・適合は未確認のまま残す。「該当なし」は未検証とする。結果は未採用・非権限・非適用である。既存J/M更新coordinatorへの実owner承認producer・M反映consumer、初期MemoryInterpretation producerはこの単位で接続しない。

J auditにraw proposal・参照ID・digestを重複保存しない。成功していないcommand、契約不正、現在射影不在、旧版、scope参照不一致は照合済みと見せない。plan:reflectの候補は表示前J照合だけに限定し、意味更新履歴へ保存しない。通常OutputAudit／Approval／L3／HDS standalone／fail-closedは維持する。

## 対象・確認

対象は`packages/hds-brain/src/memory_citation_review.ts`、`packages/hds-brain/src/controller.ts`、`packages/hds-brain/src/types.ts`、対応test、`apps/gateway/src/serve.ts`と境界test。必要な確認は関連Vitest、`pnpm typecheck`→`pnpm build`、`pnpm hds:standalone`、文書gate、差分確認。provider／credential／実外部作用、D4Pocket／ミニドラ、全suite／QC／QAは対象外。

P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`、version=`1.0.0-rc.1`を保持する。内部QE原典・ZIP・要求対応表・raw運転証拠はPublic Gitへ追加しない。バッチ末に限定commitをmainへpushし、origin/main・復元refs・dirtyを照合する。

backup ref移行状態は`MIGRATION_COMPLETE`。意味関係・一般採用、承認producer、全体writer lease、独立D4 Permission、実provider、5OS製品は引き続き`BUILD_GAP`であり、この単位では解消しない。

STATUS=WIRED（現在M射影にある根拠ID／版の限定照合とaudit接続）。次consumerは意味関係・scope digest・target/prior versionの検査責任を具体化し、実owner承認producerへ無断接続しない。C07全体、SYSTEM_SHAPED／BUILD_COVERED、QE_QC／QE_QAは未成立。
