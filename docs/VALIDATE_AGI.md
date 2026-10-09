# 要求ID付き局所試験の実行

`validate:agi` は、登録済み要求IDをリポジトリ内のVitestファイルと試験名へ結び付け、選択した試験を子プロセスで実行する開発用の入口である。登録情報、子プロセスの終了値、JSON試験報告、成功・失敗件数、一時報告の回収を照合する。表示上の `PASS` や登録状態だけでは成功にならない。

## 実行方法

```powershell
pnpm validate:agi -- --list
pnpm validate:agi -- --unit C01.03
pnpm validate:agi -- --case BT-U-C01.03-P
pnpm validate:agi -- --case BT-T-C01-01
pnpm validate:agi -- --unit C01.03 --case BT-U-C01.02-P
pnpm validate:agi -- --case BT-T-C01-99
```

`--list` は登録IDと実装状態を表示する。`--unit` はその単位に登録されたケースをすべて選び、`--case` は一つのIDだけを選ぶ。両方を指定した場合は、単位とケースの両方に一致する必要がある。`--help` は引数の形を表示する。

実装済みケースは、`scripts/validate_agi.ts` の登録表にある実ファイルとtest-name selectorをVitestへ渡す。各実行のJSON報告はOS一時領域に一意の名前で作られ、検査後にそのファイルだけを回収する。子プロセスには試験起動に必要な限定環境変数だけを渡し、作業ディレクトリはこのリポジトリに固定する。

## 終了値と失敗分類

| 結果 | 終了値 | 意味 |
|---|---:|---|
| 選択した全selectorが成功 | 0 | 子プロセス終了値が0で、報告が妥当、成功件数が1件以上、失敗件数が0件、一時報告を回収した |
| `UNREGISTERED` | 1 | 未登録の単位またはケースID |
| `NO_CASES` | 1 | 登録済み単位とケースの組合せに一致するケースがない |
| `NOT_IMPLEMENTED` | 1 | 親scenarioなど、実行可能な受入selectorがまだ接続されていない |
| 実試験の非0終了・timeout・報告不備・成功0件・回収失敗 | 1 | 実行結果から成功を証明できない |
| 引数または登録表の不備 | 2または1 | 引数不正は2、登録表の不備は1 |

次の例は、表示内容ではなくexit 1を期待する。

```powershell
pnpm validate:agi -- --case BT-T-C01-01
pnpm validate:agi -- --unit C01.03 --case BT-U-C01.02-P
pnpm validate:agi -- --case BT-T-C01-99
```

それぞれ `NOT_IMPLEMENTED`、`NO_CASES`、`UNREGISTERED` である。C01親の未接続scenarioは単位の局所試験が通っても成功にならない。

## ケース登録と検証範囲

新しい局所ケースを追加するときは、試験コードのID、試験ファイル、test-name selector、`AGI_TEST_CASES` の登録、単位仕様の受入条件を対応させる。selectorが本当にその試験を選ぶことを `--case <ID>` で実行して確かめる。親scenario全体が未接続なら `NOT_IMPLEMENTED` のまま登録し、部分的な試験を親の成功へ読み替えない。

この入口は開発試験の接続と実行結果だけを示す。製品runtime、Gateway、HDS-BRAINの権限判断、`validate:product`、Rust product consumer、IPC、installed配布、別OS、live外部作用、親C01全体、製品完成、release readiness、P13 owner GOを証明しない。`pnpm test`、`pnpm docs:check`、`pnpm validate:product`の代替ではなく、既存の各検証経路は独立して実行する。
