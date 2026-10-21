# Discord inbound admission

Discordの通常message入口は、bot tokenで認証したDiscord Gateway接続を`discord.js`で受ける。Discordの説明ではGatewayはsecure WebSocketであり、bot認証はIdentify時のtokenで行われる。この経路はWebhookではないため、個々のmessageにWebhook署名を要求しない。Webhook／Interaction入口を追加する場合は別の署名検証契約を実装する。

Gatewayの`MessageCreate`から得たguild／channel／author／message snowflakeを検査し、ownerが設定した`DISCORD_INBOUND_GRANTS_JSON`のguild・channel・user完全一致を通ったDMまたはbot mentionだけをGatewayへ渡す。DMは`guild_id:null`で表す。設定なし・空配列はdeny-all。不正な設定はGateway起動時に拒否する。

```json
[
  {
    "guild_id": "123456789012345678",
    "channel_id": "234567890123456789",
    "user_id": "345678901234567890"
  },
  {
    "guild_id": null,
    "channel_id": "456789012345678901",
    "user_id": "567890123456789012"
  }
]
```

IDはDiscord snowflakeのdecimal stringで設定する。Discordはsnowflakeを最大64-bit unsigned IDとして扱い、HTTP APIでは整数精度の損失を避けるため文字列で返す。[Discord API Reference: Snowflakes](https://docs.discord.com/developers/reference#snowflakes)

`DISCORD_BOT_TOKEN`は保護されたローカルsecret store等から環境変数として供給し、設定変更後にGatewayを再起動する。BotのDeveloper PortalではMessage Content privileged intentを有効にし、Gatewayの接続要件を満たす。[Discord Gateway: Intents and Message Content](https://docs.discord.com/developers/events/gateway#gateway-intents)

Admission grantは入口の範囲制限であり、HDS-Jの採否、実行Permission、Approval、L3 final reviewを付与しない。表示名はactor identityに使わず、HDS向けactorはguild・channel・userの組から計算したdigestとする。Gateway private SQLiteにはbot scope、message ID、payloadのdigestとdelivery stateだけを保存し、raw message本文やID、tokenは保存しない。同じmessage IDの再送は抑止し、同一IDで内容が変わった場合も拒否する。dispatch中の中断は結果不明として再処理しない。

許可されたinboundへの応答は元チャンネルへ送り、元Discord message IDをnative reply referenceとして渡す。Gateway private SQLite outboxは送信待機中だけ返信本文・対象・message referenceを保持し、terminal settlementで消去する。queued／rate-limit waitは再起動後に復帰するが、dispatch中断は`outcome_unknown`として再送しない。discord.jsのchannel routeでrate-limit rejectionを明示的に返し、SDK内のtimeout／5xx自動再試行を無効化する。確認できたrate-limit拒否と有効なRetry-Afterだけを永続待機後に再試行し、通信例外・timeout・5xx等の曖昧な結果は宛先状態を確認してからownerが再送を判断する。

`DISCORD_LIVE_TARGET`は送信先を指定するoutbound smoke設定であり、inbound grantの代わりにはならない。資格・試験guild・recipient・scope・費用等のOD-03条件がない状態ではlive接続や送信を行わず、Discordを`first-party-preview`のまま扱う。
