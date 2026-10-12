# BLUE-TANUKI バックアップ参照のD4Pocket方式への移行

**状態：MIGRATION_COMPLETE（2026-10-12）。** local復旧branch二世代とremote backup tag二世代を同じSHAへ揃え、旧remote backup branch二本をtag実値の照合後に整理した。製品QE_BUILDの再開、release readiness、owner GOを意味しない。

## 正規の二世代

- ローカル復旧点：`refs/heads/codex/backup-main`、`refs/heads/codex/backup-main-prev`
- リモート正本：`refs/tags/codex/backup-main`、`refs/tags/codex/backup-main-prev`
- GitHub上に同名backup branchを維持しない。tagを保存・照合する前に既存branchを削除しない。

## 移行前の観測参照

rev2.3パッケージのmanifestとremoteで照合した、移行開始時の観測値。実行対象は固定値から推測せず、操作直前に取り直す。

| GitHub ref | 移行開始時のSHA |
|---|---|
| `refs/heads/main` | `6e0196b38f4b6f7296372d2d0200b7cd5077c969` |
| `refs/heads/codex/backup-main` | `c15c8994b872cbb96222bbebb02e14ae8e5dad6a` |
| `refs/heads/codex/backup-main-prev` | `4e32c0cd776afbdeb37dc0c5537ca180981188fa` |
| `refs/tags/codex/backup-main` | `dca73281f0857cb73a408f613023dd27bc2327b8` |
| `refs/tags/codex/backup-main-prev` | `68f85b5c85d4b8157080305b63a677cd8e43565d` |

## 完了時の実測

文書閉鎖commit前の復旧基点はlocal `main` と `origin/main` の `6e0196b38f4b6f7296372d2d0200b7cd5077c969`。

| 保持先 | ref | 完了時SHA |
|---|---|---|
| ローカルbranch | `refs/heads/codex/backup-main` | `6e0196b38f4b6f7296372d2d0200b7cd5077c969` |
| ローカルbranch | `refs/heads/codex/backup-main-prev` | `c15c8994b872cbb96222bbebb02e14ae8e5dad6a` |
| リモートtag | `refs/tags/codex/backup-main` | `6e0196b38f4b6f7296372d2d0200b7cd5077c969` |
| リモートtag | `refs/tags/codex/backup-main-prev` | `c15c8994b872cbb96222bbebb02e14ae8e5dad6a` |

リモートの `refs/heads/codex/backup-main` と `refs/heads/codex/backup-main-prev` は不在。作業branchは `main`、文書編集前の作業treeはcleanだった。ローカルtag参照も同じ二世代へ同期した。旧tagが指していたcommitは移行時mainの履歴内にあることを確認した。mainへのreset、force pushは行っていない。

## 実施記録

1. Windowsの認可済みGit経路でremote refsを取り直し、local/remote main、dirty state、他worktreeを照合した。remote branchの保存世代は `c15c899...`／`4e32c0c...`、旧tagは `dca7328...`／`68f85b5...`。
2. 旧tagの期待SHAをそれぞれ指定した `--force-with-lease` と `--atomic` で、保存branch世代 `c15c899...`／`4e32c0c...` をremote tagへ書き、remote SHAの一致を確認した。
3. tag照合後、旧remote branch二本を各旧SHAへのlease付きatomic pushで整理し、remote mainとtag二本、branch不在を再確認した。
4. 文書変更前にlocal recovery branchを現在のmain `6e0196b...` と直前世代 `c15c899...` へ回転し、remote tag二本も期待値 `c15c899...`／`4e32c0c...` へのlease付きatomic pushで同じ組に更新した。local branchとremote tagの一致を確認した。

添付rev2.3のPowerShell補助scriptは、関数名 `Git` の内部で `& git` を呼び、自身を再帰呼出しする不具合があった。DRY_RUNはremote変更前に停止し、外部Git処理へ到達しなかった。移行は補助scriptを使わず、上記の直接Git照合とlease付き操作で実施した。

## 今後の復旧点更新手順

1. `main` をfetchし、local/remote HEAD、dirty state、他writerを確認する。差分、未同期、競合があれば停止する。
2. 編集前mainをlocal `backup-main` に、旧 `backup-main` を `backup-main-prev` に保存し、二branchのSHAを確認する。
3. 操作直前のremote tag SHAを期待値にした `--force-with-lease` と `--atomic` で二tagを更新し、remote実値を照合する。無条件forceを使わない。
4. 旧remote backup branchが残る移行では、二tagがbranch保存SHAを持つと確認した後だけ、旧branch SHAへのlease付きatomic操作で整理する。
5. main、local二branch、remote二tag、旧remote branchの状態、作業treeを再照合する。一致しない場合は `PENDING_BACKUP_REF_MIGRATION` を維持し、復旧点を削除しない。
