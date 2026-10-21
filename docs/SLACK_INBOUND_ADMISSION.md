# Slack受信のowner許可設定

`SLACK_INBOUND_GRANTS_JSON`はGatewayが読む受信元の完全一致許可表である。未設定・空配列は全拒否となる。Slack tokenとは別の設定であり、HDSの判断、owner本人性、Approval、L3最終レビュー、作用Permissionを与えない。

値は次の4項目だけを持つJSON配列とする。

| 項目 | 内容 |
|---|---|
| `team_id` | Slack workspaceのID |
| `channel_id` | 受信するDM／channelのID |
| `user_id` | 受信を許す投稿者のID |
| `thread_ts` | channel rootは`null`、許すthread replyはそのrootのSlack `ts` |

```json
[
  { "team_id": "TEXAMPLE", "channel_id": "CEXAMPLE", "user_id": "UEXAMPLE", "thread_ts": null },
  { "team_id": "TEXAMPLE", "channel_id": "CEXAMPLE", "user_id": "UEXAMPLE", "thread_ts": "1712345678.123456" }
]
```

上記IDは形式例であり、実際のworkspace・channel・user・thread IDへ置き換える。ワイルドカード、余分な項目、重複grantは受け付けない。root許可はそのchannelのroot投稿だけに一致し、thread内の返信を許可するには対象threadの`thread_ts`を別grantに指定する。

許可判定はBolt Socket Modeの認証済み外側イベントから取得したworkspace IDと、messageのchannel／user／threadをすべて照合する。SlackはSocket Modeの接続を事前認証済みとして扱い、Events APIのworkspace ID・event IDは[Slack Events API](https://docs.slack.dev/apis/events-api/)に定義されている。イベントIDと内容digestはGatewayのprivate Inboxで重複・競合・中断を処理するために使い、イベント本文、イベントIDそのもの、tokenはInboxへ保存しない。grant不一致、永続Inboxの利用不能、同一event IDの内容競合はGateway consumerへ渡さない。中断後に作用結果を確認できないイベントも自動再実行しない。

eventごとのdigest記録は再送抑止のため保持する。長期運転で必要となる容量上限・記録回転は、Slack運転量と再送条件を含む製品全体QE_QCで確定する。この設定は現在のSlack `first-party-preview`受信境界を定める。実Slack credential／Socket Mode運転、live smoke、機能昇格の証拠ではない。
