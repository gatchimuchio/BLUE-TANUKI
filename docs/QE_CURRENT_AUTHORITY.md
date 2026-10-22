# QE 現行正本ポインタ

このページが、owner指定のQE三点セットについて公開リポジトリ内で参照する唯一の現行ピンである。仕様本文・工程表本文・施工指示書本文と内部原典はPublic Gitへ複製しない。

## 現行セット

- owner指定版：BLUE-TANUKI HDSカーネル主導再構築・QE施工パッケージ rev3.0（2026-10-22）
- 配布ZIP SHA-256：`E757FC0D091910A28589BDF1C59E63CA379DB82CAFADAD5E5227F4131B6BA3E0`
- 仕様書 `01_BLUE-TANUKI_HDSカーネル統合仕様書_rev3_0.md` SHA-256：`C71FD4B5983911752F523780BB52B15B01784D1B0B4F7AE3DBF678C8B2211085`
- 工程表 `02_BLUE-TANUKI_HDSカーネル再構築工程表_rev3_0.md` SHA-256：`14B2185C36D1F191948C7DE8D9F5B1D4D4E410A3C86DA244EE4164232D314B39`
- 施工指示書 `03_BLUE-TANUKI_HDSカーネルCodex施工指示書_rev3_0.md` SHA-256：`32E26B062DFB0A2FA1AB6F2125C1BF1AB13C7A605BA5E41DB581AC3444F4082F`

rev3.0内のSHA-256 manifestは296資産すべてを照合し、不足・余分・hash不一致がないことを確認した。2026-10-23にowner提供ZIPそのもののSHA-256、ZIP内296資産とmanifestの全hash、三文書の個別hashを再確認し、fresh展開上の同梱静的検証器もPASSした。パッケージ記載の観測main SHA `e28a73f330cb155f46aea00e58cffd3a6b005ae8` は作成時点の記録であり、ownerが本版を指定した時点の実HEAD／remote HEAD `2964db41dc11ddc3057f47447a85f8a49395c377` を置き換えない。ownerの2026-10-22の明示指定でrev3.0を現行正本へ採用し、2026-10-23にownerから再指定された同一ZIPと全hashを再照合して現行正本として再確認した。内部文書本文・原典・全要求対応表はPublic Gitへ転載していない。

添付ZIP内のmanifestと冒頭文書・三点本文には、作成時点の `current_public_pin=rev2.3; rev3.0 not activated` および「改訂候補」の記述が残る。これはZIP作成時の状態記録であり、ownerの後発の明示採用と本ページの現行pinにより置き換わった。元のZIPはhash証拠として変更せず保持し、この作成時記述を現行repo状態へ転記しない。静的検証PASSは要求索引・資産・文書の同一性を示すだけで、製品runtime、Rust cutover、5OS実機、QE_QC／QE_QAやownerの公開・出荷GOを証明しない。

## 更新と参照

ownerがさらに新しい三点一組を指定した場合、配布manifestと三文書それぞれのSHA-256を照合し、この唯一の現行ピンを置き換える。旧セットと完了済み施工記録は履歴ログとして保持し、通常作業では現行正本として再読しない。

独立した作業の開始・切替・再開時は、この現行ピンが示す三文書すべてと適用AGENTS.mdを読み、active instruction、最新HEAD・差分も確認する。パッケージに記録された古い観測HEADや旧工程状態を現行repoへ書き戻さない。
