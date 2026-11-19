# アダプター契約

本書は BLUE-TANUKI の下流アダプター契約を定める。対象は channel adapter、plugin adapter、skill adapter、および将来の署名済み第三者 adapter である。

## 1. 下流専用

Channel adapter は下流専用である。

Adapter は HDS-BRAIN、authority path、Approval Gate、Runtime Invariants、hash-chain audit format を変更してはならない。Adapter が扱う外部 metadata は文脈情報であり、authority ではない。

## 2. 受信契約

すべての受信事象を共通 inbound message 型へ正規化する。

要件:

- 外部 channel 固有の event は repository の canonical inbound message type へ正規化する
- user / channel / thread / reply metadata は metadata として保持する
- metadata を権限昇格に使わない
- raw input を監査可能な形で保持し、判定前に破棄しない
- malformed input は typed error に変換して fail-closed にする

## 3. 送信契約

すべての送信操作を共通 outbound request 型に通す。

要件:

- adapter 固有 API へ直接送信する前に canonical outbound request type を経由する
- external send は Approval Gate と capability envelope の管理下に置く
- channel target は routing 情報であり、authority source ではない
- retry、rate limit、delivery error は adapter 内で typed result として返す

## 4. エラー契約

エラーは回復可能（`recoverable`）または回復不能（`non-recoverable`）として型付けする。

- 回復可能: rate limit、一時的な network failure、remote service unavailable、一時的な auth refresh
- 回復不能: capability 不足、invalid credentials、非対応操作、contract violation、authority escalation attempt

回復不能エラーを黙って再試行せず、audit-compatible trace として記録する。

## 5. 能力契約

Adapter は必要な capability を manifest で宣言する。宣言していない capability は使用しない。必要な capability がない場合は fail-closed にする。

## 6. 権限を昇格させない

Channel metadata を権限昇格に使ってはならない。

禁止事項:

- 外部 role / admin flag を BLUE-TANUKI の authority に変換する
- channel owner / workspace owner を Approval Gate の迂回に使う
- plugin metadata を特権 permission として扱う
- memory entry を特権操作の根拠にする

## 7. 監査互換性

Adapter は audit hash-chain を壊してはならない。Adapter trace は `request_id`、channel、operation、capability、recoverability、`approval_state` を追跡できる形にする。

## 8. Layer B の審査参照

Adapter / plugin / skill の受け入れは次の文書に従う。

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Plugin HIG](PLUGIN_HIG.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)

Adapter は、文書化された審査を経て明示的に昇格されない限り Layer B に属する。Layer B は Layer A の authority、Approval Gate、Runtime Invariants、audit format を変更できない。

## 9. D4 Runtime 状態投影

専用 D4 Runtime 認証情報は、`D4RuntimeStatusProjectionSchema` で検証される範囲限定の状態投影を `GET /runtime/snapshot` から読み取れる。投影に含まれるのは Gateway / HDS の状態フラグ、1,000,000 を上限とする件数、観測時刻、`evidence_source=["INTERNAL_STATE"]`、および非権威マーカー `used_for_authority=false` と `may_execute=false` に限る。Control Center snapshot、承認の詳細、schedule task の詳細、operator surface、execution receipt、HDS 内部情報は公開しない。状態データが不正または不完全なら HTTP 503 で fail-closed にする。

通常の WebChat 認証情報には、従来の Control Center snapshot 応答を維持する。D4 状態投影は `INTERNAL_STATE` に基づく観測であり、provider 接続、外部作用の完了、installed product の健全性、permission、approval、release readiness を証明しない。D4 アプリ側 consumer は別の統合対象である。

### D4 Runtime 通知の投影

専用 D4 Runtime bearer による `GET /notifications` は、`D4RuntimeNotificationsProjectionSchema` で検証される範囲限定の投影を返す。既知の通知種別を固定カテゴリへ写し、カテゴリ、重大度、発生時刻だけを最大64件返す。通知 ID、題名、本文、source、request／command ID、Approval／監査の詳細、次の操作は含めない。不正なデータまたは件数上限超過の場合は HTTP 503 で fail-closed にする。通常の WebChat bearer には従来の詳細通知応答を維持する。この投影は `INTERNAL_STATE` に基づく表示根拠に限られ、authority、permission、approval、execution を生成しない。この API 境界だけでは、D4 製品側 consumer の接続・実動を証明しない。

## 10. D4 Runtime の仕事送受信

D4 Runtime は専用 bearer と BLUE 側で登録された単一の `runtime_id` を使う。Runtime 認証情報は Owner 認証情報ではなく、送信本文、session metadata、tool／LLM 応答から Owner 権限、Broker 権限、承認を作らない。

- `POST /runtime/ws-ticket` は `runtime_id` と `session_id` を検証し、その session 用の期限付き WebSocket ticket と session 参照 digest を返す。接続前に ticket を発行・転送しても、仕事を dispatch する許可にはならない。
- `POST /runtime/intent` は `RuntimeIntentInputSchema` に従う `runtime_id`、`session_id`、`submission_id`、`intent` を受け付ける。画像／音声は一要求限りの上限付き一時入力として受け、保存済み message に媒体 bytes を追加しない。`submission_id` は payload と session scope に結び付いた重複防止識別子であり、権限ではない。
- 応答先となる同一 session の WebSocket が未接続なら HTTP 409 `runtime_response_channel_not_connected` を返し、dispatch しない。同じ `submission_id` と同一 payload の再要求は既存 request に結び付け、payload または scope が異なる場合は HTTP 409 で拒否する。通信結果が不明な場合、adapter は新しい submission として再送しない。
- Gateway へ渡す主体は `d4-runtime-adapter-token-holder` による権限限定の user ingress であり、直接の tool call ではない。request は通常の HDS／Approval／Broker 経路を通る。`goal_completion_rules` を含む Owner 限定入力や、shortcut 形式の tool 命令は拒否する。
- `POST /runtime/intent/status` は同じ runtime／session／submission scope で処理状態を照会する。応答には J／M による task outcome、非権威の cancel 状態、および保持中に限る同一 request の上限付き結果内容・SHA-256・取得時刻が含まれる場合がある。`execution_observation` は同じ受付の承認待ち、保留、Gatewayの実行中、またはBrokerとHDSを照合できたアダプター応答等を示す。照合不能な場合は `unknown` とし、実行観測から仕事の達成や結果の配送を判定しない。結果本文を runtime snapshot や通知一覧へ混ぜず、承認の詳細、HDS 内部状態、実行権限を含めない。
- 認証済みRuntimeの受理後にGateway内の処理が例外終了したとき、受付は `outcome_unknown` を保持する。元の例外内容はログや応答に出さず、同じセッションに限定した失敗通知だけを発行する。同じ受付の再送は既存の状態を返す。
- `POST /runtime/intent/cancel` は同じ runtime／session／submission の受付だけを対象とする。Gateway内の処理開始より先に取消が台帳へ記録されると `cancelled_before_dispatch` を返す。この受付は `rejected` として保持され、再起動後も同じ取消状態を照会できる。同じ受付を再送するとHTTP 409を返す。処理が始まった受付では、承認待ちの取下げや実行中のAbortSignalを既存の経路で扱う。HTTP 202の取消受理では外部処理の停止は未確認のため、`external_processing_stop` は `unknown` とする。結果不明のときは自動再送しない。
- HDSが承認待ちを記録した受付は、承認用トークンの発行中でも `approval_withdrawn` として取り下げられる。承認一覧は発行と現在条件の確認が済んだ承認だけを公開する。取下げの成立後に返ったトークンは破棄し、承認待ち通知は送らない。コマンドを発行せずHDSが処理を保留したときも、D4の応答に承認用トークンを含めない。
- `/organize` の複数回の計算も、実行中のコマンドを元のD4受付に結び付けて取り消す。取消後は次の計算を開始せず、取消対象の計算結果を整理結果に採用・送信しない。最後に検証済みの引用は該当受付の保存点に残す。外部providerの停止は `unknown` として扱う。

これらは BLUE 側 producer の API 契約であり、D4 側 Adapter／Mobile UI の実装、Device Link 接続、OS 上の秘密保管、installed 実動を証明しない。D4 repository への実装は別の限定委任に従う。
