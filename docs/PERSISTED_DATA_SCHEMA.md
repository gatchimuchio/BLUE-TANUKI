# 製品永続データ互換性契約

製品全体の互換性版は `packages/protocol/src/product_data_schema.ts` の
`PRODUCT_DATA_SCHEMA_VERSION` を唯一の生成元とする。release bundle、各OSの
installer manifest、インストール済みproduct-data markerは同じ値を記録する。

この版は、BLUE-TANUKIが所有する永続データの形式をまとめて識別する。
対象にはGateway／HDS-BRAINのJ/M状態、SQLite store、JSON/JSONL記録、approval・
operation・channel・schedule・停止・recovery・audit関連の記録、製品設定、OSの
native credential storeが含まれる。使用者が指定した外部workspace内のファイルは
製品データへ取り込まず、このinstaller契約で書換えない。

## 更新規則

- 製品管理下の永続表現、符号化、鍵・credential識別、store migration意味を変える
  変更では、この版を先に増やし、変更の影響範囲とmigration手段を実装する。
- 自動migrationは未対応。installerは保持data markerと候補packageの版が完全一致
  する場合にのみ、アンインストール後のdata再接続を許す。
- 不一致、旧marker、marker欠落、読取・root同一性の確認失敗は互換性不明として
  fail-closedにする。旧Windows marker schema 1/2、旧Linux/macOS marker schema 1
  には製品データ互換性版がないため、版1として推測しない。
- 同じ版の宣言はデータ形式の互換性だけを示す。Setupにはin-place application
  replacementおよびinstalled update/rollbackの実装がないため、更新画面の一致表示
  は置換許可を意味しない。

版1はこの契約の初版であり、既存の未記録dataに遡及適用しない。既存storeの
schema versionやmigrationを一律1へ変更するものではない。
