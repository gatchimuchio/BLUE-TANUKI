# Architecture

## 設計の核

BLUE-TANUKI は safety-first resident AI control plane であり、active roadmap は `docs/ROADMAP.md` を正とする。
OpenClaw との決定的な違いは **authority path と LLM の位置付け**。

OpenClaw は LLM agent に手足を与える設計。
BLUE-TANUKI は HDS authority core の下に LLM / tools / channels / plugins / memory を従属させる設計。

| | OpenClaw | BLUE-TANUKI |
|---|---|---|
| LLM の位置 | Gateway 中核 | 下流のツール扱い |
| 上位制御 | LLM 自身が判断 | HDS-BRAIN が独立判断 |
| 監査性 | LLM 出力ベース | F→M→C トレース + hash chain |
| 状態管理 | LLM コンテキスト依存 | 上流ステートマシンで明示管理 |
| Channel 統合 | LLM context と密結合 | HDS 判定後にのみ送出 |

## 二層 + チャネル

```
                     ┌────────────────────────┐
                     │       Channels         │
                     │  webchat / slack / ...│
                     └────────┬───────────────┘
                              │ InboundRouter
                              ▼
┌──────────────────────────────────────┐
│  HDS-BRAIN (上流制御・純粋ロジック)  │
│  - F→M→C 判定                        │
│  - 状態機械 (SUSPEND/RESUME)         │
│  - hash-chain audit                  │
└──────────────┬───────────────────────┘
               │ ExecuteCommand (protocol)
               ▼
┌──────────────────────────────────────┐
│  BLUE-TANUKI core (実行機)           │
│  - LLM 呼び出し                      │
│  - tools                             │
│  - OutboundDispatcher                │
└──────────────┬───────────────────────┘
               │ ChannelSendPayload
               ▼
                     ┌────────────────────────┐
                     │       Channels         │
                     │  (Outbound 側で再利用)│
                     └────────────────────────┘
```

### 上流: HDS-BRAIN (`packages/hds-brain`)

純粋ロジック層。**LLM を呼ばない**。役割:

1. **F (Frame)** — Inbound から目的・保護値・世界閉包 W=(X,R,M) を導出し、適用する `problem_definition_id` (= policy 選択キー) を解決
2. **M (Model)** — Frame を抽象化と構造に変換し、policy が指定する detector を一括実行して per-axis スコアと重み付き aggregate を算出
3. **C (Commit)** — Operational Policy の閾値ルールを順に評価し、`ASSERT/SUSPEND/OUT_OF_SCOPE/FAIL` の判定を出す
4. **Audit** — 各判断を hash-chain 付き append-only ログに保存 (in-memory / 任意のJSONL永続化)

ASSERT 時のみ `ExecuteCommand` を生成して下流に渡す。

#### 判定パイプライン

```
InboundRequest
  │
  ▼
[Frame]  goal / protected_values / W=(X,R,M) / problem_definition_id
  │
  ▼
[Model]  per-axis スコア (各 detector が [0,1] を返す。1.0=望ましい)
         × 重み → aggregate ∈ [0,1]
  │
  ▼
[Commit] 閾値評価:
         1) per_axis_fail        : axis ≤ thr → FAIL
         2) per_axis_suspend_below: axis < thr → SUSPEND
         3) aggregate < out_of_scope_below     → OUT_OF_SCOPE
         4) aggregate ≥ aggregate_assert       → ASSERT
         5) otherwise                          → SUSPEND
  │
  ▼
DecisionLog (audit chain に追記)
```

#### State machine

```
       decide()
         ├── ASSERT/OUT_OF_SCOPE/FAIL → DECIDED
         └── SUSPEND                  → SUSPENDED
                                          │
                                  resume(id, verdict)  ← 人間のみ
                                          │
                                          ▼
                                    AWAITING_RESUME
                                          │
                                          ▼
                                       DECIDED
```

**RESUME は人間のみ**。Executor からの feedback で SUSPEND を覆す経路は設計上存在しない。これにより「下流が暴走しても上流の判断を上書きできない」という containment property が保たれる。

### 下流: BLUE-TANUKI core (`packages/blue-tanuki`)

実行機。**LLM 呼び出しはここに集約**。役割:

1. **LLM 抽象化** — Anthropic / OpenAI / Google / local — 任意のバックエンドを差し替え可能
2. **Tool 実行** — browser / file / web / canvas / cron 等 (Phase 3+)
3. **Channel 配信** — `OutboundDispatcher` を経由して `channel_send` を物理 channel に振り分け

上流が付与する `constraints` (timeout, allowed_tools, max_tokens) を実行時に強制する。

### Channel 層 (`packages/channel-*`) — Phase 2 で追加

OpenClaw と同様のチャネル多様性を、**LLM 結合なし**で再実装。

#### 抽象 (`channel-base`)

| インターフェース | 役割 |
|---|---|
| `InboundChannel` | 外部プロトコル → `InboundRequest` 正規化 + handler 呼び出し |
| `OutboundChannel` | `ChannelSendPayload` → 外部プロトコル送出 |
| `InboundRouter` | 複数の InboundChannel を多重化、handler 例外を contain |
| `OutboundDispatcher` | `payload.channel` をキーに OutboundChannel へ振り分け |

実装クラスは多くの場合 In/Outbound の両方を実装する (例: WebChat の HTTP+WS は 1プロセスで双方向)。lifecycle (`start()` / `stop()`) は `InboundChannel` 側のみが持ち、Outbound はロジカルな送信機能のみを担う。

#### WebChat (`channel-webchat`) — 本実装

| エンドポイント | 認証 | 動作 |
|---|---|---|
| `POST /inbound` | Bearer | `{user, content}` を `InboundRequest` 化、handler に投入。同期で `{accepted, request_id}` を返す |
| `POST /ws-ticket` → `GET /ws?ticket=...` | inbound Bearer → 単回ticket | ticketに束縛されたuser単位でWS接続し、`OutboundChannel.send`を受信 |
| `POST /runtime/ws-ticket` | 専用D4 Runtime Bearer | 登録済みruntimeとsessionを照合し、HMAC session scopeだけを受信する単回ticketを発行 |
| `POST /runtime/intent` | 専用D4 Runtime Bearer | `{runtime_id, session_id, submission_id, intent}`を受ける。UUIDv4 submission IDをsession scopeへ束縛してprivate inboxへ先にclaimし、同じID・同じ入力は再dispatchせず既存request ID／stateを返す。同じIDの異入力は`409` |
| `POST /runtime/intent/status` | 専用D4 Runtime Bearer | `{runtime_id, session_id, submission_id}`で同sessionの`found`、request ID、dispatch state、J/Mの非権威task outcome、記録済み取消観測を返す。intent、結果本文、command IDは返さない |
| `POST /runtime/intent/cancel` | 専用D4 Runtime Bearer | `{runtime_id, session_id, submission_id}`だけを受け、private inboxで同sessionのrequest IDを引き、HDS planに束縛された現在実行中commandへAbortSignalを要求する。command ID／intent／結果本文は返さない |
| `POST /owner/task-submission-status` | 専用owner Bearer | `{submission_id}`から受付状態、同じHDS requestに束縛したJ/M outcomeとowner task取消台帳の非権威観測を返す。仕事本文とcommand IDは返さない |
| `POST /owner/task-submission-cancel` | 専用owner Bearer | `{submission_id}`だけで受付記録を解決し、HDS planのowner/channel/request境界と一意なactive execution bindingを照合してAbortSignalを要求する。command ID／本文は受け取らず、応答にも返さない |
| `POST /resume` | Bearer (`WEBCHAT_RESUME_TOKEN`) | `{request_id, verdict}` を `onResume` コールバックに転送 (Phase 1 の人間 RESUME 窓口) |
| `GET/POST /update/*` | Bearer (`BLUE_TANUKI_MAINTENANCE_TOKEN`) | manual update verify / prepare の保守操作 |
| `GET/POST /recovery/*` | Bearer (`BLUE_TANUKI_MAINTENANCE_TOKEN`) | backup / restore / reset / factory-reset の保守操作 |
| `GET /healthz` | なし | liveness 用 |

設計上の制約:
- bind 既定 `127.0.0.1` (loopback only)。外部公開は明示的に `WEBCHAT_HOST` を変える必要がある
- `WEBCHAT_TOKEN` は `/inbound` と通常の `/ws-ticket` 用に8文字以上必須。D4 Runtime用ticket発行と意図入力は別の `BLUE_TANUKI_D4_RUNTIME_TOKEN`・固定 `BLUE_TANUKI_D4_RUNTIME_ID` を使い、通常WebChat資格とは分離する
- D4 Runtimeは同じsessionで `/runtime/ws-ticket` を先に呼び、返された単回ticketで `/ws` に接続してからUUIDv4の`submission_id`付き `/runtime/intent` を送る。応答接続がなければ`409 not_dispatched`となりclaim／HDS handlerは呼ばれず、再接続後は同じIDで再送できる。ticketは期限付きで、raw runtime/session ID・intent・submission ID・credentialはInbox／状態応答に含めず、保存するsubmission ID digest、runtime/session scope digest、token-keyed payload HMAC、request ID、dispatch stateだけから同一受付を照合する。同じID・異入力は`409`、inbox保存失敗は`503`でhandlerへ渡さない。handlerが未起動の場合もclaim前に`503 runtime_intent_handler_unavailable`を返し、同じIDを後で安全に再送できる。HDS出力が同じscopeへ送られた場合、その接続だけが既存`channel_send` frameを受信する。`202`は受付のみを示す
- `/runtime/intent/status`は専用Bearerで同じruntime/sessionから照会する。返すtask outcomeはHDS Operation Planのrequest/owner/channel境界へ束縛された非権威projectionであり、`handler_returned`はhandler callbackの復帰に過ぎず、使用者目標の達成、結果配送、M receiptを意味しない。取消projectionは同じrequestへ束縛されたprivate execution ledgerの記録だけを返す。記録がない・曖昧・読取不能なら`unknown`とし、「未取消」へ読み替えない。`execution_observed`はローカルexecutorの観測であり、外部処理停止を保証しない。intent、結果本文、内部command IDは返さない。handler失敗や再起動で結果が不明になったsubmissionは自動再実行しない。結果本文の保存・再取得は未実装である。inboxの保持上限／期限は未設計で、自動pruneを行わず、容量影響は未評価
- `/runtime/intent/cancel`は専用Bearer・登録runtime・private inboxの同一session／submission照合後にだけ進む。GatewayはHDS Operation PlanのD4 Runtime owner digest、WebChat channel digest、request ID、active execution registryの現在command IDを一意に照合し、callerからcommand IDを受け取らない。照合不能・複数候補・既にexecutorがsettledした依頼は拒否する。`202`はAbortSignalを送ったことだけを示し、Executor終了や外部処理停止を主張しない。応答本文と監査には依頼本文を含めない。このBlue側endpointはD4アプリから未接続である
- `/owner/task-submission-cancel`もsubmission IDからGateway private storeのrequest IDを解決し、owner task actor digest・WebChat channel digest・request binding・active executionの単一一致を要求する。取消台帳は`owner_task` token種別で分離し、owner task statusは同一bindingの記録だけを返す。`202`はAbortSignal送信の受付であり、executor settlement・local worker停止・外部処理停止を証明しない。対象なし・曖昧・既settledは拒否し、caller指定command IDを受け付けない
- Blue側の一回claim・session-scoped状態照会・戻りtransportは接続されたが、D4アプリ側producer・受信loopとの結合、workspace登録、再接続・切断後の処理結果回復は未確認。D03.01全体は未成立で、D4 Pocket repoは変更していない
- WSは長期Bearerでなくsingle-use ticketで認証する。ticket消費後は再利用できない。接続はin-memoryで、Gateway再起動後の継続・結果再取得を保証しない
- セッションは in-memory (`Map<user, Set<WebSocket>>`)。プロセス再起動で切断
- 通常HTTP bodyのhard capは1 MiB。`/owner/audio-transcribe`と`/owner/task-compute`は個別の媒体上限に対応したbody capを使う。owner taskは画像1枚（最大5 MiB）と音声1件（最大20 MiB）を併用できるが、Canvas成果物と音声は併用できない。

#### Slack / Discord (`channel-slack`, `channel-discord`) — release-polished preview

現行実装:
- token 未設定 → 警告ログ + `silent` モードで `start()` を成功させ、send は fail-closed typed result を返す
- Slack: `@slack/bolt` Socket Mode + `chat.postMessage`
- Discord: `discord.js` v14 Gateway + channel send
- adapter-level retry/backoff と typed `recoverable` / `non_recoverable` delivery error
- first-party 昇格は owner-run credentialed live smoke 完走後に判断する

## 連結プロトコル (`packages/protocol`)

二層の境界。zod スキーマで厳密に型定義。

- `InboundRequest` — チャネル横断の正規化済み入力
- `ExecuteCommand` — 上流→下流の指令 (discriminated union: llm_call / tool_call / channel_send / noop)
- `ExecuteFeedback` — 下流→上流の実行結果
- `UpstreamDecision` — 全コマンドに付与される F→M→C トレース (audit 用)

Phase 2/3 ではこれらのスキーマを **無変更** で維持。`upstream_commit_hash` は Channel 層では `SendMeta` として別経路で渡す (protocol を破壊的に変えない)。Phase 3 で追加された `metadata.reply_to` は既存の `InboundRequest.metadata: z.record(z.unknown()).optional()` の中に収まるため、これも互換維持。

## Gateway (`apps/gateway`)

二モード:

| モード | 起動 | 用途 |
|---|---|---|
| CLI 1ショット | `pnpm gateway:dev "msg"` | Phase 1 互換、判定確認用 |
| serve | `WEBCHAT_TOKEN=... WEBCHAT_RESUME_TOKEN=... BLUE_TANUKI_MAINTENANCE_TOKEN=... pnpm gateway:serve:dev` | 長期駐在、WebChat + Slack/Discord (実 SDK) |

serve モードの中核ループ (`serve.ts`):

```
InboundRouter.start(handler)
  ↓
handler(req):
  1. hds.decide(req) → DecisionLog + (ASSERT 時) ExecuteCommand
  2. if command:
       executeAndEcho(cmd, log, req)        ← Phase 3 で関数化
         executor.execute(cmd) → ExecuteFeedback
         hds.onFeedback(fb)
         if cmd.type === "llm_call" && success:
           dispatcher.dispatch({channel: req.channel, target: replyTarget(req), content})
  3. else (SUSPEND/OUT_OF_SCOPE/FAIL):
       dispatcher.dispatch(humanizeDecision(...))
```

POST `/resume` から `onResume` 経由で `hds.resume()` が呼ばれる。Phase 3 では `resume()` が原 `InboundRequest` を返すよう拡張され、approve 時には ASSERT 経路と同じ `executeAndEcho` を呼ぶことで、resume 駆動の LLM 応答も channel に届くようになった (Phase 2 まではこの echo が欠落していた)。

`replyTarget(req)` は `req.metadata.reply_to ?? req.user` を返す。Slack/Discord は inbound 時に channel id を `reply_to` に埋め、WebChat は user 名そのまま。これにより、表示名と API id が異なるチャネル (Slack/Discord) でも正しく返信できる。

## Phase 3: 実 SDK 統合と認証強化

### Slack: Bolt + Socket Mode
- `@slack/bolt` を Lazy import (テスト時は dep 不要)
- `SlackTransport` インターフェースで本番/fake を切替可能
- inbound: DM 全件 + bot メンション。bot 自身の発言は drop
- outbound: `chat.postMessage`、`target` は Slack channel id

### Discord: discord.js v14
- 同じ Lazy import + transport DI パターン
- intents = `Guilds | GuildMessages | MessageContent | DirectMessages`
- inbound: DM + メンション、他 bot は drop

### WebChat: 一回限り ticket
旧 `?token=&user=` を完全廃止。新 flow:
1. `POST /ws-ticket` (`WEBCHAT_TOKEN` Bearer 必須、body: `{user}`) → 32B base64url ticket、TTL 30s
2. `GET /ws?ticket=...` → ticket を atomic 消費、user binding 確定
3. 同 ticket の再利用は不可 (リプレイ耐性)

Phase 5-S6 以降、`/resume` は `WEBCHAT_RESUME_TOKEN` のみを受理し、resume audit には human actor と `token_kind=resume` が記録される。

これにより、Bearer token が漏れても任意の user として WS を張る攻撃ベクトルが閉じる。

## なぜこの構造が OpenClaw 上位互換になるのか

1. **任意の LLM が使える**: BLUE-TANUKI は LLM をツール扱いするので置換コストがゼロに近い
2. **LLM が暴走しても上流で止まる**: HDS-BRAIN の判定は LLM 出力を入力としないので、LLM の幻覚やプロンプトインジェクションに左右されない
3. **監査トレースが構造化されている**: hash-chain で改竄検知可能。`upstream_commit_hash` が channel_send の SendMeta まで伝播するので、外部に出た 1 メッセージから F→M→C 判定まで追跡できる
4. **状態が明示的**: SUSPEND/RESUME を上流のステートマシンで持つので、長時間タスクや人間介入が綺麗に表現できる
5. **Channel 層は LLM 非依存**: チャネル増設のたびに LLM プロンプトをいじる必要がない。各 channel package は protocol 型しか触らない
6. **チャネル SDK は差し替え可能**: Phase 3 の `SlackTransport`/`DiscordTransport` 中間層により、SDK を変えても channel の inbound/outbound 契約は不変

## フェーズロードマップ

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | monorepo 骨格、protocol、HDS-BRAIN 最小、Executor 最小、CLI 動作確認 | **完了** |
| 1 | detector/weight/threshold 実装、SUSPEND/RESUME 状態機械、JSONL audit 永続化 | **完了** |
| 2 | Channel 抽象 + WebChat 実装 + Slack/Discord スタブ + serve モード | **完了** |
| 3 | Slack/Discord 実 SDK 統合、WS 一回限り ticket、resume echo | **完了 (本コミット)** |
| 4 | セッション永続化、レート制限/バックオフ、Voice Wake / Live Canvas / Skills | 未着手 |
| 5 | 残りチャネル群、iOS/Android/macOS ノード | 未着手 |
| 6 | 無料デプロイ (Docker/Fly.io)、リリース、ドキュメント整備 | 未着手 |
