# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。owner指定rev2.3三点正本（統合実装仕様書SHA-256=`84B470455DF396FC33EA7470EB948437A7FE611FCD15CCE894C1B5D2720644F0`、工程表SHA-256=`7EDE8D84F34BC42ED183A0F45DBC2971FD5FFF309F77BABACC56796A1893FE77`、Codex施工指示SHA-256=`D91BF99BD6F54DBA04D7FBD4D8D4C53B73CB7420E44D789367DE6B212D4498D8`）、適用AGENTS.md、作業標準要領、ownerの継続開発指示、前batch指示、E03.02／E01.01要求とCron→Gateway approval→永続cursor→operator通知／resume拒否の現行経路を読み直した。前batch閉鎖後の開始HEAD／origin/mainは`4f85463e1924db1afb812a195f238ed2cd68a7e4`、worktree clean。

## 今回のBUILD_BATCH

QE_STAGE=`QE_BUILD`。BUILD_BATCH=`QEB-03-E03.02-CRON-PENDING-APPROVAL-RECOVERY`。関係単位=E03.02「未決作用・M pendingの回復」、E01.01「永続jobと重複event」。BLUE-TANUKI内だけを対象とし、D4Pocket／ミニドラ、実provider／credential、実外部業務作用、公開・出荷判断は対象外。

Cron起点のcommandがowner approvalを待つとき、Approval Gateの実行可能内容・tokenを保存せず、Cron event／payload digestとcommand/request IDのdigestをprivate SQLite handoffへ記録する。Gateway起動時に残存pendingを`interrupted`へ移し、Control Centerのresident notificationsへread-onlyで表示する。保存されたCron approval IDで再開要求が来ても`approval_unavailable_after_restart`を返し、HDS resume fallbackへ流さない。通常のnon-Cron approval経路は変更しない。

### 安全境界

- handoffへ保存するのは不透明event ID、digest、状態、時刻だけ。raw command、request ID、payload、token、承認内容は保存・表示しない。
- 起動時に旧pendingを復元・承認・再実行しない。interrupted通知は権限を持たず、ownerは元eventと結果証拠を確認して新規要求から再審査する。
- 処理済みapproval IDはstale-resume拒否用digest tombstoneとして保持する。handoff上限10,000件に達した場合、新しいCron approvalの保存をfail-closedする。
- C08.03実provider保留、P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

### 限定確認

| 確認 | 結果 |
|---|---|
| Cron event store／resident notification focused tests | PASS、2 files／22 tests。再起動時pending→interrupted、digest-only保存／表示、旧approval reference拒否を確認。 |
| `pnpm typecheck` | PASS。 |
| `pnpm build` | PASS、15 workspace projects。 |
| `git diff --check` | PASS。 |
| 全suite、live/provider、credential、実外部作用、5OS実機、QE_QC／QE_QA | 未実施。 |

実装commit=`64005e25f31deb21f2d3fe7b9491697a88b2bf91`は`main`へpush済み。未接続は実外部receipt／結果とのread-only照合、旧worker結果の世代別帰属、E03.02／E01.01のdurable job lifecycle全体であり、両単位とも`BUILD_GAP`を維持する。次consumerはCron eventと実外部結果のread-only reconciliationを安全な照会契約へつなぎ、古いworker／approvalを現世代の正本へ確定しない経路を具体化する。

復旧状態=`MIGRATION_COMPLETE`。編集前にlocal recovery branch二世代・local tag二世代・remote backup tag二世代を期待SHA付きで現世代=`4f85463e1924db1afb812a195f238ed2cd68a7e4`、前世代=`84860ffdca7f681fd98b00ad325823d65a609929`へ揃えた。実装push後のlocal／remote mainは`64005e25f31deb21f2d3fe7b9491697a88b2bf91`で一致し、復旧refsは編集前の二世代を保持する。closeout文書push後にrefsとworktreeを再照合する。
