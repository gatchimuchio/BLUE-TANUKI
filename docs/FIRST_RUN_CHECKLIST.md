# BLUE-TANUKI First-Run Checklist

v1.0 RC provides a guided first-run path, not a verified 5-minute beginner guarantee.

このチェックリストは、初回起動で WebChat Control Center に入り、最初のメッセージを安全に通すための手順である。永続運用の確認は [PERMANENT_USE_CHECKLIST.md](./PERMANENT_USE_CHECKLIST.md) を使う。

## 1. 前提

- Node.js `>=22.14.0`
- Corepack または pnpm
- ローカルのターミナル
- `127.0.0.1:8787` を使えること
- 外部 LLM を使う場合は任意の LLM API key

`LLM_BACKEND=stub` なら外部 LLM key なしで初回経路を確認できる。

## 2. セットアップ

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm run setup -- --yes
```

Recommended guided path:

```bash
pnpm installer:run
```

Non-serving guided path:

```bash
pnpm installer:run -- --no-serve
```

The guided installer performs setup, doctor, and Control Center handoff. It is
not a signed native installer, not an automatic updater, and not a verified
5-minute setup guarantee. Use `Verify LLM` in Settings before saving non-stub
LLM provider changes.

`pnpm run setup -- --yes` はローカル env file を生成する。生成された secret は公開しない。既存 env file を上書きする場合、`.bak` backup が作られる。

手動 env で起動する場合:

```bash
export WEBCHAT_TOKEN="replace-with-32chars-inbound-token"
export WEBCHAT_RESUME_TOKEN="replace-with-32chars-resume-token"
export BLUE_TANUKI_MAINTENANCE_TOKEN="replace-with-32chars-maintenance-token"
export LLM_BACKEND="stub"
```

## 3. 起動

setup が env file を出力した場合:

```bash
pnpm gateway:serve -- --env-file .blue-tanuki/blue-tanuki.env
```

portable installer の resident launcher を使う場合:

```bash
blue-tanuki resident-start
blue-tanuki resident-status
```

手動 env の場合:

```bash
pnpm gateway:serve
```

開く:

```text
http://127.0.0.1:8787/
```

## 4. 最初の WebChat メッセージ

Control Center の WebChat から短いメッセージを送る。HTTP で確認する場合:

```bash
curl -X POST http://127.0.0.1:8787/inbound \
  -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user":"local-user","content":"hello blue-tanuki"}'
```

期待結果:

- gateway が 2xx を返す
- Control Center に応答または `noop` / `tool` 結果が表示される
- `/runtime/snapshot` の Runtime Invariants が期待値のまま
- audit chain に decision が残る

## 5. Runtime Snapshot

```bash
curl -H "Authorization: Bearer $WEBCHAT_TOKEN" \
  http://127.0.0.1:8787/runtime/snapshot
```

期待値:

```json
{
  "hds_calls_llm": false,
  "process_policy_enforced": true,
  "external_metadata_can_escalate_authority": false,
  "memory_used_for_authority": false,
  "complete_history_used_for_authority": false,
  "final_review_boundary_enforced_by_approval_gate": true
}
```

## 6. Optional Telegram

Telegram は v1.0 RC first-party channel だが、WebChat の初回成功とは分けて確認する。

```bash
export TELEGRAM_BOT_TOKEN="123456:telegram-bot-token"
pnpm gateway:serve
```

BotFather で作った bot に `/start` を送り、Bot API long polling が動くことを確認する。outbound target は Telegram `chat_id`。

## 7. Approval Gate Smoke

final-review 操作は full access でも止まる。

```text
tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
```

期待結果:

- request は pending approval になる
- schedule は承認前に fire しない
- `/approval` で pending を確認できる
- approve 後に active になる

## 8. よくある失敗と次の行動

| 失敗 | 状態 | 次の行動 |
|---|---|---|
| `pnpm` が見つからない | 依存 install 前で停止 | Corepack を有効化するか、Node 環境の PATH を直す |
| `WEBCHAT_TOKEN is required` | gateway は起動しない | `WEBCHAT_TOKEN`、`WEBCHAT_RESUME_TOKEN`、`BLUE_TANUKI_MAINTENANCE_TOKEN` を別値で設定する |
| `BLUE_TANUKI_MAINTENANCE_TOKEN is required` | update/recovery 保守面を起動できない | inbound/resume/settings token と別値の maintenance token を設定する |
| resume token が inbound token と同じ | gateway は起動しない | resume 用 token を別に生成する |
| port `8787` が使用中 | gateway は bind できない | 既存 process を止めるか `WEBCHAT_PORT` を変える |
| `doctor` exit code `2` | 安全に起動できない | `pnpm run doctor` の error check を直してから再起動する |
| Telegram が応答しない | WebChat には影響しない | token、`/start`、chat_id、BotFather privacy mode を確認する |
| audit chain が broken | boot を止めるべき状態 | [AUDIT.md](../AUDIT.md) と [UPDATE_ROLLBACK_RUNBOOK.md](./UPDATE_ROLLBACK_RUNBOOK.md) の quarantine 手順へ |

## 9. 初回後に必ず読むもの

- [PERMANENT_USE_CHECKLIST.md](./PERMANENT_USE_CHECKLIST.md)
- [CHANNEL_READINESS_MATRIX.md](./CHANNEL_READINESS_MATRIX.md)
- [CREDENTIAL_READINESS_MATRIX.md](./CREDENTIAL_READINESS_MATRIX.md)
- [UPDATE_ROLLBACK_RUNBOOK.md](./UPDATE_ROLLBACK_RUNBOOK.md)
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
