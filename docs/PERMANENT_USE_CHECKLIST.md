# BLUE-TANUKI Permanent-Use Checklist

初回成功は完成ではない。BLUE-TANUKI を常駐制御盤として運用する前に、この checklist で安全性、回復性、更新可能性を確認する。

## Startup

- [ ] Guided first-run installer users have recorded the env file path printed by `pnpm installer:run`.
- [ ] Non-stub LLM provider changes were checked with `Verify LLM` before saving.
- [ ] Portable installer users have selected foreground `start` or resident `resident-start` as the normal lifecycle path.
- [ ] If autostart is desired, `resident-autostart-status` was checked before running `resident-autostart-enable`.

- [ ] 起動方法を 1 つに決めている: source install、release bundle、Docker、systemd、portable installer
- [ ] 起動時に読み込む env file の場所を把握している
- [ ] `WEBCHAT_TOKEN`、`WEBCHAT_RESUME_TOKEN`、`BLUE_TANUKI_MAINTENANCE_TOKEN` が別値である
- [ ] `pnpm run doctor` が exit code `0` または warning-only `1`
- [ ] `http://127.0.0.1:8787/healthz` が 200 を返す

## Stop / Restart

- [ ] gateway process の止め方を把握している
- [ ] resident launcher users can run `resident-status`, `resident-logs`, and `resident-stop`
- [ ] restart 後も env、audit、session、memory の保存場所が変わらない
- [ ] restart 後に `/runtime/snapshot` の Runtime Invariants が変わらない

## Config

- [ ] `CONFIG.md` と実 env file の差分を把握している
- [ ] settings window を使う場合、`BLUE_TANUKI_SETTINGS_TOKEN` の場所を把握している
- [ ] settings 変更後は restart が必要だと理解している
- [ ] setup/settings による `.bak` backup を secret として扱っている

## Credentials

- [ ] [CREDENTIAL_READINESS_MATRIX.md](./CREDENTIAL_READINESS_MATRIX.md) の required / optional を確認した
- [ ] 不要な channel token は未設定のままにしている
- [ ] live smoke 用 target は本番 channel と分けている
- [ ] token rotation 時の restart 手順を把握している

## Audit

- [ ] Control Center Authority Audit shows chain validity and recent event/hash metadata without exposing secrets.

- [ ] `BLUE_TANUKI_AUDIT_DIR` は永続ディスク上にある
- [ ] `node apps/gateway/dist/main.js --audit-verify` が通る
- [ ] `--audit-dump` で decision / approval / schedule lifecycle を読める
- [ ] broken chain 時の quarantine 方針を決めている

## Approval Queue

- [ ] Control Center Approval Queue shows pending count, `ApprovalLevel`, final-review labels, token expiry, reason, and redacted authority trace.

- [ ] `/approval` は `WEBCHAT_RESUME_TOKEN` でのみ操作する
- [ ] final-review 操作は full access でも止まることを確認した
- [ ] one-time approval token を audit なしに再利用しない
- [ ] abandon された pending request の扱いを決めている

## Runtime Schedules

- [ ] Control Center Runtime Schedules shows active/pending state, pending approval linkage, timing, and payload hash only.

- [ ] boot-time schedule と runtime schedule の違いを理解している
- [ ] runtime schedule create/update/delete が L3 final-review であることを確認した
- [ ] pending/rejected/timed-out schedule が fire しないことを確認した
- [ ] `/runtime/snapshot` に schedule content が出ないことを確認した

## Resident Notifications

- [ ] Control Center Notification Center shows approval-required, schedule fired/failed, connector failure, and audit-warning states.
- [ ] `/notifications` is read-only, uses `WEBCHAT_TOKEN`, and returns `authority=display_only`.
- [ ] Notification output does not expose one-time approval tokens, schedule content, credentials, or raw connector payloads.

## Channel Readiness

- [ ] WebChat は必須 local console として動いている
- [ ] Telegram は必要なら live token で確認した
- [ ] Slack/Discord は release-polished preview 扱いとして typed error / live smoke / failure mode を理解している
- [ ] Slack/Discord/Teams/LINE は `pnpm validate:channels` の promotion gate を通るまで first-party と呼ばない
- [ ] WhatsApp は first-party core ではないことを理解している
- [ ] [CHANNEL_READINESS_MATRIX.md](./CHANNEL_READINESS_MATRIX.md) と互換 matrix が矛盾していない

## Update

- [ ] 更新前に git commit / release archive / env backup / audit backup のいずれかで戻れる
- [ ] source install の場合、pull 後に install/typecheck/build/test/doctor を実行する
- [ ] release bundle の場合、`.sha256` と manifest を検証する
- [ ] update 後に `doctor` と smoke を走らせる

## Distribution Readiness

- [ ] `doctor` includes `distribution_readiness` and it is `ok`.
- [ ] `pnpm validate:packaging` passes before publishing a bundle.
- [ ] `pnpm installer:verify` passes from the repository root.
- [ ] `pnpm installer:run -- --no-serve` has a documented recovery path if setup fails.
- [ ] installer docs do not claim a signed native installer.
- [ ] update docs do not claim an automatic updater.
- [ ] resident app docs explain start/status/stop/logs/open/autostart and uninstall cleanup.

## Rollback

- [ ] source rollback は前の commit に戻す手順を持っている
- [ ] portable rollback は前の release bundle を残している
- [ ] rollback 時に env/audit/session/memory を消さない
- [ ] audit chain broken の場合、rollback ではなく quarantine 判断を行う

## Uninstall / Purge

- [ ] 通常 uninstall は env/audit/session/memory を残す
- [ ] purge は secret と audit evidence を消す操作であると理解している
- [ ] purge 前に必要な audit archive を取得している
- [ ] dry-run option がある platform では先に dry-run する

## Backup / Restore

- [ ] env file と `.bak` backup は secret として backup する
- [ ] audit/session/memory/schedules directory の backup 先を決めている
- [ ] restore 後に `doctor` と `--audit-verify` を実行する
- [ ] multi-process writer を作らない

## Known Limitations

- v1.0 RC は signed native installer ではない
- v1.0 RC は automatic updater を持たない
- v1.0 RC の resident app path は portable launcher 統合であり、native tray app ではない
- v1.0 RC Daily Brief は scheduled message smoke が既定であり、Gmail/GCal/Drive は read-only source として optional
- Slack/Discord/Teams/LINE は first-party-preview。実 token / test target での live smoke、回復手順 review、`validate:channels` の証跡 gate 完走後に first-party 昇格判断を行う
- Teams/LINE は gateway-owned inbound listener closure が first-party promotion 前に必要
- WhatsApp は first-party core から除外
