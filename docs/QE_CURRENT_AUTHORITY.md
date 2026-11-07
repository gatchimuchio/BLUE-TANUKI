# QE 現行正本ポインタ

このページが、owner指定のQE三点セットについて公開リポジトリ内で参照する唯一の現行ピンである。仕様本文・工程表本文・施工指示書本文、内部原典、要求対応表はPublic Gitへ複製しない。

## 現行セット

- owner指定版：BLUE-TANUKI HDSカーネル再構築・QE施工パッケージ rev3.1（2026-11-07）
- owner採用日：2026-11-08
- 配布ZIP SHA-256：`CFC9907CD17FFA87B461C5D7C8F8AA97A89FEA410C7E2F74EE60D37017D52C74`
- 配布 `MANIFEST.sha256` SHA-256：`EA172EF221516B27311119237BE6B28AC4DBBDBEB164C3AA0BCDC7DB1C06C29A`
- 仕様書 `01_BLUE-TANUKI_HDSカーネル統合仕様書_rev3_1.md` SHA-256：`651E016524A240976E0DF23E55AD76DB7A1CA8396AC57DE5103380A66273A054`
- 工程表 `02_BLUE-TANUKI_HDSカーネル再構築工程表_rev3_1.md` SHA-256：`926E6082CE4E4A962A969F23E2D248A144F86534488383230CC01756F4B29D2D`
- 施工指示書 `03_BLUE-TANUKI_HDSカーネルCodex施工指示書_rev3_1.md` SHA-256：`A924B705F170C7CC47718EA8262274FACB89122B22C54F1A50F4E89FA282F270`

ownerの指定によりrev3.1を現行正本として採用した。添付ZIPは三文書とmanifestの計4項目で構成され、manifestに列挙された全三文書の個別SHA-256が一致し、ZIP全体のSHA-256も上記値と一致した。採用時のlocal／remote `main` は `11cf1309cc6b9fd1922ba8d758b4764d4c5aad9f` で一致していた。ZIP内の作成時点の「未採用」「未着手」等の状態記述は採用後の現行状態を上書きしない。

旧rev3.0のpinと作業履歴はGit履歴に保持する。内部本文や296資産をPublic Gitへ転載しない。現行工程はQE_BUILDで、F05.02 GitHub write実consumer接続を開始する。実GitHub送信、他repo変更、Rust authority cutover、QE_QC／QE_QA、公開・出荷GOは本pinで成立しない。

## 更新と参照

ownerがさらに新しい三点一組を指定した場合、配布manifestと三文書それぞれのSHA-256を照合し、この唯一の現行ピンを置き換える。旧セットと完了済み施工記録は履歴ログとして保持し、通常作業では現行正本として再読しない。

独立した作業の開始・切替・再開時は、この現行ピンが示す三文書すべてと適用AGENTS.mdを読み、active instruction、最新HEAD・差分も確認する。パッケージに記録された古い観測HEADや旧工程状態を現行repoへ書き戻さない。
