# BLUE-TANUKI バックアップ参照のD4Pocket方式への移行

**状態：PENDING_BACKUP_REF_MIGRATION（2026-10-12観測）**。方法規定はD4Pocketの現行AGENTS.md §20と一致させる。**ref実移行は未成立**。文書改訂だけで完了を宣言しない。

## 正規の二世代

- ローカル：refs/heads/codex/backup-main、refs/heads/codex/backup-main-prev
- リモート：refs/tags/codex/backup-main、refs/tags/codex/backup-main-prev
- main一本・単一writer。意味あるBUILD_BATCHまたは統治変更の編集前に一度だけ世代を回し、remote tagを比較確認したSHAへのforce-with-leaseで二本とも保全する。
- remote backup branch二本（refs/heads/...）はD4Pocketの標準では保持しない。tag二本の実保存を確認した後、競合がないときにのみ整理する。

## 移行前の観測参照

| GitHub ref | 2026-10-12時点に確認したSHA（固定の実行対象ではない） |
|---|---|
| refs/heads/codex/backup-main | 4e32c0cd776afbdeb37dc0c5537ca180981188fa |
| refs/heads/codex/backup-main-prev | 35a6b2dd72283363cd4074d982a78f091055b4c7 |
| refs/tags/codex/backup-main | dca73281f0857cb73a408f613023dd27bc2327b8 |
| refs/tags/codex/backup-main-prev | 68f85b5c85d4b8157080305b63a677cd8e43565d |

旧remote tagとbranchの保存SHAが違うため、まだD4Pocket方式へ整合していない。**復旧点を失わないことを最優先**とし、tag移行前にremote branchを削除してはならない。上表は当時の観測点であり、移行実行時には最新remote refsと他writerを再取得してから判断する。

## Codexによる安全な移行手順

1. 認可済みWindowsローカルGit経路でmainをfetchし、local mainとorigin/main、dirty state、他writerの作業を照合する。未同期・dirtyなら変更せず停止する。
2. remoteの二世代branchと古いtagの正確なSHAを取得する。現在refs/headsに保存された二世代のcommitを、D4Pocket形式のrefs/tagsへ移す。旧tag SHAに対する明示的なlease、原子的な二tag push、remote tagのSHA一致確認を必要とする。古い固定SHAに無条件forceしない。
3. 二tagが一致したことを確認してから、refs/headsの旧remote backup branch二本を、各々の旧SHAに対する競合検出付きで整理する。ローカルの復元用branchは保持する。
4. main HEAD、remote二tag、旧remote backup branchの不在、ローカル復元点、作業ツリーを再照合する。すべて成立したときだけMIGRATION_COMPLETEに変更する。
5. tag変更API・認証済みGitが利用不能、競合、失敗、main更新が検出された場合、PENDING_BACKUP_REF_MIGRATIONを保持し、remote branchを消さずblockerを記録する。次の製品QE_BUILD着手前に再処理する。

非公開施工パッケージrev2.2に、DRY_RUNから開始するための安全確認付きPowerShell補助手順を収録する。Public Gitへ内部原典、資格、トークン、監査生証拠を投入しない。既存mainをforce push／resetしない。
