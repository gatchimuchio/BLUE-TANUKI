# QE 現行正本ポインタ

このページが、owner指定のQE三点セットについて公開リポジトリ内で参照する唯一の現行ピンである。仕様本文・工程表本文・施工指示書本文と内部原典はPublic Gitへ複製しない。

## 現行セット

- 指定版：BLUE-TANUKI QE施工パッケージ rev2.3（5OS／D4Pocket backup tag規定を含む）
- 配布ZIP SHA-256：`779452AC46ED2E42040AFDCBB5F4E918B71B6FCCF436C194A69ED16D07F5E249`
- 仕様書 `01_BLUE-TANUKI_QE統合実装仕様書_rev2_3.md` SHA-256：`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`
- 工程表 `02_BLUE-TANUKI_QE工程表_rev2_3.md` SHA-256：`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF3099F77BABACC56796A1893FE77`
- 施工指示書 `03_BLUE-TANUKI_Codex_QE施工指示書_rev2_3.md` SHA-256：`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`

配布ZIP内のmanifestにある値と、配布ZIPから直接計算した三文書のSHA-256が一致することを確認した。ZIPの観測main SHAや過去工程の状態は現行repoのHEAD・active指示を置き換えない。

## 更新と参照

ownerが新しい仕様書・工程表・施工指示書を指定した場合、三文書とmanifestの整合を確認し、このページの現行値を新しい三点へ置き換える。旧セットと完了済み施工の記録は履歴ログとして保持し、現行正本として併読しない。

独立した作業の開始・切替・再開時は、この現行ピンが示す仕様書・工程表・施工指示書の三文書すべてと適用AGENTS.mdを読み、active instruction、最新HEAD・差分も確認する。同一作業内の連続した小単位切替では、今回に関係する要求・契約・コード・文書節を再同期する。過去の三点セット、閉じたBUILD_BATCH、進捗履歴全体はログとして保持し、現行の依存・変更系譜・矛盾を解く必要がある場合だけ該当箇所を参照する。
