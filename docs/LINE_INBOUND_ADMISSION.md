# LINE受信の署名検証と同一性確認

LINEは`first-party-preview`を維持する。本書はローカルで接続した受信経路と現在の証拠範囲を記録するもので、実provider、HDS運転、実業務、release acceptanceの成立を意味しない。

## 受付経路

LINE adapterはloopbackだけ（`127.0.0.1`または`::1`）で待ち受ける。本文サイズを制限してraw bodyを読み、`LINE_CHANNEL_SECRET`を使って`x-line-signature`のHMAC-SHA256署名を検証する。署名が有効な場合に限ってJSONをparseし、envelopeの`destination`が設定済み`LINE_CHANNEL_DESTINATION`と完全一致することを確認する。

Gatewayへ渡すのは、対応するtext messageで、形式が有効なevent IDとtimestamp、source type（`user`／`group`／`room`）、source ID、user IDが揃ったeventだけである。user sourceでは`source_id`と`user_id`の一致を必須にする。group／roomでuser IDが欠けるeventはuser単位のowner grantと照合できないため拒否する。添付を含む非text event、不完全な同一性、未対応のevent形状は転送しない。

`LINE_INBOUND_GRANTS_JSON`は完全一致の許可表である。各entryは次の四項目だけを持つ。

```json
[{
  "destination": "<exact-official-account-id>",
  "source_type": "group",
  "source_id": "<exact-group-id>",
  "user_id": "<exact-user-id>"
}]
```

未設定または空の許可表は全件拒否とする。wildcard、重複entry、余分なfield、role名による許可は認めない。許可表の一致は署名済みeventをGateway inbound consumerへ渡すためだけに使い、owner identity、権限、risk分類を作らず、HDS-BRAINやApproval Gateを迂回しない。

## 重複抑止とデータ保持

Gatewayの`GatewayLineEventStore`は、destination scope digest、event ID digest、受付内容digestを使い、dispatch前にSQLiteで原子的にeventをclaimする。raw event ID、本文、user ID、group ID、channel secret、reply tokenはこのinboxへ保存しない。同一eventの再送と、同一event IDに異なる内容が届いた競合は抑止する。dispatch中にprocessが停止したeventは再起動時に`outcome_unknown`とし、自動再実行しない。

adapterはLINEの`replyToken`を転送・保持せず、添付を取得しない。channel identityやmetadataを権限へ変換しない。受付後の本文は既存Gateway `InboundRouter`を通り、未信頼のuser inputとして扱う。

## 設定と外部公開

`LINE_CHANNEL_SECRET`と`LINE_CHANNEL_DESTINATION`は必ず対で設定する。secretは保護されたlocal secret storeに置く。任意のlistener設定は`LINE_WEBHOOK_HOST`（既定`127.0.0.1`、許可値は`127.0.0.1`または`::1`）、`LINE_WEBHOOK_PORT`（既定`3980`）、`LINE_WEBHOOK_ROUTE`（既定`/webhooks/line`）である。`LINE_CHANNEL_ACCESS_TOKEN`は送信側Messaging API pushを独立して設定する。受信にはoptional LINE pluginが必要となる。

listenerはpublic interfaceにbindしない。実際にproviderから受ける運用を別途許可された場合は、ownerが管理するHTTPS reverse proxyからloopback endpointへ転送する必要がある。本repoは外部公開を設定しない。LINE webhook確認用の署名済み`events: []`はHTTP 200で応答する。この環境では実LINE callback、credential、API request、外部送信を実施していない。

## 限定確認

synthetic HMAC署名を付けたloopback HTTP試験で、raw body検証、不正署名拒否、destination／grant照合、重複と内容競合の抑止、digest-only保存、dispatch中断時の再実行抑止、非loopback bind拒否を確認する。これらはローカル合成経路の証拠に限られる。

## LINE公式資料

- [Webhook署名の検証](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Webhook受信](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Messaging APIリファレンス](https://developers.line.biz/en/reference/messaging-api/nojs/)
