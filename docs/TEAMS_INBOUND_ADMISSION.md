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

Gateway private SQLite outboxはTeamsの返信payload digestと状態を持ち、本文とreply targetはqueued／dispatching／retry_wait中だけ保存してterminal settlementで消去する。再起動時にdispatchingだった送信は`outcome_unknown`へ固定して本文・targetを消し、自動再送しない。Microsoft Graphが明示的な429拒否と有効な`Retry-After`を返した場合だけ同じ返信を永続待機後に再送する。timeout／通信例外／5xxは結果不明として再送せず、他の4xxも自動再送しない。channel replyは元messageへの`/replies`、personal／groupChatはconversationのchat message consumerを使う。reply destinationは検証済みtenant／conversation／team／channel／message identityから組み立て、これらのmetadataからHDS判断・権限・承認を生まない。

ローカル合成fixtureで確認するのはactivity拒否・identity/admission・Gateway boundary・native reply route・durable outbox・明示429 Retry-After・再起動時のunknown固定まで。実Teams tenantの有効JWT、credential、実conversation、実Graph API／返信、HDS実運転、Teams昇格判定は未確認で、Teamsは`first-party-preview`を維持する。F13.03のlive受入は製品全体の実装成立後、OD-03条件を満たしてから別途判断する。
