# Microsoft Teams受信入口の構成

Teams受信はMicrosoft 365 Agents SDKのメッセージendpointを使う。受信機能は次の三つの資格設定がすべてある場合だけ起動し、一つでも欠ければGatewayの起動を失敗させる。

- `TEAMS_AGENT_CLIENT_ID`: Azure Bot／AgentのApplication ID
- `TEAMS_AGENT_TENANT_ID`: Microsoft Entra tenant ID
- `TEAMS_AGENT_CLIENT_SECRET`: ローカルsecret storeで管理するclient secret

SDKのJWT認証を必須にし、connection-mapのaudienceを設定されたApplication IDへ固定する。issuer検証と、activity内`serviceUrl`の認証claim照合を有効にする。受信HTTP本文は256 KiBに制限する。アプリケーションID・tenant ID・秘密をrepository、grant、message本文へ複製しない。

認証後も、ownerが設定する`TEAMS_INBOUND_GRANTS_JSON`の完全一致がなければGatewayへ渡さない。設定は次の配列形式を使う。personal／groupChatではteam／channelを`null`とし、channelでは両方を指定する。

```json
[
  {
    "tenant_id": "72f988bf-86f1-41af-91ab-2d7cd011db47",
    "conversation_id": "Teamsが通知したconversation ID",
    "conversation_type": "personal",
    "user_id": "Teamsが通知したfrom.id",
    "team_id": null,
    "channel_id": null
  }
]
```

受信側は`channelData.tenant.id`を必須とし、activityにconversation／sender tenantがある場合は一致も要求する。`channelId`は`msteams`、activity種別は`message`に限定する。conversation typeは`personal`、`groupChat`、`channel`だけを扱い、channelではteam IDとchannel IDを必須にする。添付activity、bot sender、識別子の欠落、曖昧なscopeは拒否する。共有conversationを許可する場合も、tenant・conversation・type・user・team/channelの完全一致をownerが列挙する。

表示名、任意metadata、conversationの表示名はgrantやHDS actor identityに使わない。actor identityはtenantとplatform user IDから作るdigestで、grantは認証・HDS判断・Approval・操作権限を与えない。

Gatewayのprivate stateにはevent identity digest、payload digest、処理状態だけを保存する。初回処理中のまま再起動したeventは`outcome_unknown`として固定し、再実行しない。同一event IDで本文digestが異なる場合も拒否する。event本文、conversation ID、user ID、資格はinboxへ保存しない。

受信口は`127.0.0.1`固定のloopback bindで、`TEAMS_AGENT_PORT`は`3978`、`TEAMS_AGENT_ROUTE`は`/api/messages`。他のbind addressは拒否する。この実装はtunnel、proxy、公開network exposureを作らない。Teams serviceから到達する配置にはownerが管理する外部routingと、そのnetwork exposureに必要な個別承認が別途必要となる。受信を構成してもMicrosoft Graph送信資格`MICROSOFT_GRAPH_ACCESS_TOKEN`は別途必要である。

本施工で確認するのはローカル合成activity／認証拒否／owner grant／永続重複抑止／Gateway boundaryまで。Teams tenantの実資格・live endpoint・実conversation、HDS実運転、返信API、Teams昇格判定は含まない。Teamsは`first-party-preview`を維持する。
