# QE 現行正本ポインタ

このページが、owner指定のQE三点セットについて公開リポジトリ内で参照する唯一の現行ピンである。仕様本文・工程表本文・施工指示書本文、内部原典、要求対応表はPublic Gitへ複製しない。

## 現行セット

- owner指定版：BLUE-TANUKI LLM QE三点セット rev4.0（2026-11-09）
- owner採用日：2026-11-09
- 配布ZIP SHA-256：`A7D53ED84EC30536FE257B56B6746DF75BF3F88E8DB089D33FB462A2FDBC3FE6`
- 配布 `MANIFEST.json` SHA-256：`7E1DAE2E0CD7CB022D6360C8317BE2068BDDB2DFD60E6BEFC79F83EF75177695`
- 仕様書 `01_BLUE-TANUKI_統合仕様書_rev4_0.json` SHA-256：`5CBBAE8BA9A1E00804049FF32D6325E209F7FDAC1BA13BA78F0100ED4B61F1ED`
- 工程表 `02_BLUE-TANUKI_全体施工工程表_rev4_0.json` SHA-256：`0F8D8DE62FB353731965CC1894B85574AF6FB63DF38B90EEBDAC64EFBD406B8E`
- 施工指示書 `03_BLUE-TANUKI_Codex施工指示書_rev4_0.json` SHA-256：`38098F3387362BF066C418443116A31357F496471A400050D02E7F93180224D1`

ownerの「これで作業して」という指定をrev4.0採用指示として扱い、三文書・manifestのSHA-256とバイト数、三文書の版・主語・目的、要求431件・親成果65件・施工単位198件・親QC260件・局所QC396件・競合ID61件の件数とID一意性、要求／単位／競合台帳一致を照合して本pinを更新した。採用時の配布記載main、local `main`、remote `main` は `a6d3e8502910afb55396618361f5a5d9726e6649` で一致していた。manifestの配布時状態は `候補=true`／`公開可否=false` だが、ownerの採用指示で内部施工正本として発効したことと、公開・出荷許可は別である。製品はQE_BUILD、`SYSTEM_SHAPED=false`、`BUILD_COVERED=false`、QE_QC／QE_QA未成立、P13 `PENDING_OWNER_GO` を維持する。ZIP本文・内部原典・要求対応表はPublic Gitへ転載しない。

旧rev3.1のpinと作業履歴はGit履歴に保持する。rev4.0の公開pinは三点セットの内部施工正本を識別するだけで、package本体の公開、実GitHub送信、他repo変更、Rust authority cutover、QE_QC／QE_QA、公開・出荷GOを成立させない。

## 更新と参照

ownerがさらに新しい三点一組を指定した場合、配布manifestと三文書それぞれのSHA-256を照合し、この唯一の現行pinを置き換える。旧セットと完了済み施工記録は履歴ログとして保持し、通常作業では現行正本として再読しない。

独立した作業の開始・切替・再開時は、この現行ピンが示す三文書すべてと適用AGENTS.mdを読み、active instruction、最新HEAD・差分も確認する。パッケージに記録された古い観測HEADや旧工程状態を現行repoへ書き戻さない。
