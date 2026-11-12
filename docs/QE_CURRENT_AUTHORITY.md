# QE 現行正本ポインタ

このページが、owner指定のQE三点セットについて公開リポジトリ内で参照する唯一の現行ピンである。仕様本文・工程表本文・施工指示書本文、内部原典、要求対応表はPublic Gitへ複製しない。

## 現行セット

- owner指定版：BLUE-TANUKI QE三点セット rev5.0（2026-11-13）
- owner採用日：2026-11-13
- 配布ZIP SHA-256：`B931D04AC4CB5EF364261BB6672238189B148C84923E2716ACDE3B5AB1169DF8`
- 配布 `MANIFEST.json` SHA-256：`4DEB56A00A2AFE513AA68FFE345F69A61A5CDFE4BDDB5BDE932E347167C70941`
- 仕様書 `01_BLUE-TANUKI_統合仕様書_rev5_0.json` SHA-256：`9B4E9F8D2183150D6CB3D9C2763CD43BFC21D6218C30B6CD99AFAECCF8588961`
- 工程表 `02_BLUE-TANUKI_全体施工工程表_rev5_0.json` SHA-256：`05F46C201FC9176AF1AAA0DEDF5E0289E439984FE944F25AF774E556EE2A253B`
- 施工指示書 `03_BLUE-TANUKI_Codex施工指示書_rev5_0.json` SHA-256：`AD6F35BCC99C8C9ABAC477E0BE4DD074EB344BA2E6B395C1DF1B733435261439`
- 同梱の継承監査資料SHA-256（証拠・非正本）：`98FA46256ED3FC72A82929D8081DEE139E29CB6F17E98930025948AA0FA5A31F`

ownerの「コレで作業しろ」という指定をrev5.0採用指示として扱い、本pinを更新した。manifestの「候補・owner未採用」は配布時点の状態であり、本指示によりrev5.0は内部施工正本として発効した。これは製品出荷GO、外部公開、他repo書込み、使用者のL3同意を意味しない。ZIP・manifest・四同梱ファイルのhash／byte数、三文書の版・主語・目的、431要求・65親成果・198索引・260親QC・396局所QC・61競合基準の件数／一意性／相互参照を照合した。改訂対照62件は監査資料の件数と一致し、全要求・施工単位・QC・競合IDの順序はrev4.0から維持されている。新manifestの継承旧版hashは直前のrev4.0 pinと一致する。採用時のlocal `main`、`origin/main`、GitHub `main` は `71addd5e6172a098b195ffdd6e97afeb2637d1ae` で一致し、復旧branchとremote tag二世代を照合した。ZIP本文・内部原典・要求対応表・監査資料本文はPublic Gitへ転載しない。

rev5.0の現行工程は全域設計から全体一括施工を続け、製品全体`SYSTEM_SHAPED`／`BUILD_COVERED`後にQC・OS別QAへ進む。Windows実PCを最終確認に使い、他OSは各OS契約に忠実な仮想環境で個別に確認する。製品状態はQE_BUILD、`SYSTEM_SHAPED=false`、`BUILD_COVERED=false`、QE_QC／QE_QA未成立、P13 `PENDING_OWNER_GO` のままである。

旧rev3.1のpinと作業履歴はGit履歴に保持する。rev5.0の公開pinは三点セットの内部施工正本を識別するだけで、package本体の公開、実GitHub送信、他repo変更、Rust authority cutover、QE_QC／QE_QA、公開・出荷GOを成立させない。

## 更新と参照

ownerがさらに新しい三点一組を指定した場合、配布manifestと三文書それぞれのSHA-256を照合し、この唯一の現行pinを置き換える。旧セットと完了済み施工記録は履歴ログとして保持し、通常作業では現行正本として再読しない。

独立した作業の開始・切替・再開時は、この現行ピンが示す三文書すべてと適用AGENTS.mdを読み、active instruction、最新HEAD・差分も確認する。パッケージに記録された古い観測HEADや旧工程状態を現行repoへ書き戻さない。
