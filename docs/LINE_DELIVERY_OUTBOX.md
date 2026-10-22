# LINE返信の永続outbox

LINEの送信はGatewayのprivate SQLite outboxを通す。返信の宛先・本文は配送待ちの間だけ保存し、終端状態では消去する。channel access tokenの値は保存せず、credential scopeの切替確認にはdigestだけを使う。待機中の行は期限切れとcredential scope変更時に本文を消去する。

Push messageのoutbox delivery IDは初回要求から`X-Line-Retry-Key`として使い、再試行にも同一のID・宛先・本文を渡す。LINE公式仕様はpush messageのretry keyを24時間有効とし、timeout／HTTP 500は同じkeyで再試行可能、受理済みkeyへの再要求は409と`x-line-accepted-request-id`を返す。BLUE-TANUKIはenqueue時点から最大24時間で期限を設け、期限内の同一要求だけを再送する。[LINE公式「Retry failed API requests」](https://developers.line.biz/en/docs/messaging-api/retrying-api-request)

429はLINEが未送信を返した場合として扱う。`Retry-After`が有効なら値を永続待機へ記録し、期限と再試行上限内で同じretry keyを使う。headerが欠落・不正なら再送しない。timeout／HTTP 500は結果不明のまま記録し、同じretry keyで上限付き指数待機を行う。その他の5xxも結果不明として保持するが、自動再送しない。再起動中に`dispatching`だった要求も、同じcredential scope・同じpayload・期限内の場合だけ同じkeyで回復する。その他の4xx、資格変更、期限切れでは本文を消去し、自動再送しない。

LINEのretry guideはHTTP 500／timeoutを再試行対象、一般の4xxを非再試行としている。API referenceは429をrate-limit拒否とし、そのerrorではメッセージ未送信と説明する一方、`Retry-After`応答headerは列挙していない。F14.02の429待機consumerは有効headerがある場合だけを合成入力で確認した経路であり、LINE実APIがそのheaderを返すことやrate-limit再試行を受け付けることは未確認である。実provider確認まではLINEをpreviewに保つ。[LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)

この経路の試験対象は署名付き合成webhook、Gateway reply routing、合成Messaging API応答である。実LINE credential、callback公開、LINE API送信、ownerのHDS運転は証明しない。LINEのpreview状態とF14.03のlive受入は別に扱う。
