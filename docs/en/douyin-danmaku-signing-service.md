# Douyin danmaku signing-service integration

Douyin chat WSS URLs are short-lived and signed. rLive intentionally does not bundle a signer; configure a service that you operate or explicitly trust so Cookie and signing logic stay within a boundary you chose.

## Endpoint and safety

Enter a full endpoint under **Settings → Account → Douyin live chat**, for example `http://127.0.0.1:18080/sign`. rLive accepts only HTTPS endpoints or loopback HTTP (`localhost`, `127.0.0.1`, `::1`) and rejects public plain HTTP so a saved Cookie is never sent in cleartext across the network.

rLive does not follow redirects from this request: the configured endpoint itself must return the response. This prevents a 307/308 from replaying the Cookie-bearing body to another address.

## Request

rLive issues a JSON POST:

```json
{
  "roomId": "7666175273884879635",
  "liveId": "522864404974",
  "cookie": "sessionid=…; ttwid=…; msToken=…"
}
```

`roomId` is the internal room ID and `liveId` is the web room id. `cookie` is the effective per-connection session: the saved account Cookie plus any transient `ttwid` / `msToken` obtained while entering the room. It may therefore contain an anonymous transient session even without a saved login Cookie; transient values stay in backend memory and are never written back to SQLite. Do not log this body, Cookie, a signed WSS URL, or signing parameters.

## Response

Return HTTP 2xx plus:

```json
{
  "wssUrl": "wss://…/webcast/im/push/v2/?…&signature=…",
  "headers": {
    "Cookie": "ttwid=…",
    "User-Agent": "Mozilla/5.0 …",
    "Origin": "https://live.douyin.com"
  },
  "heartbeat": { "intervalMs": 10000 }
}
```

`wssUrl` must use `wss://`. `headers` are optional; rLive forwards only `Cookie`, `User-Agent`, `Origin`, `Referer`, and `X-*` headers. `heartbeat.intervalMs` is optional (10 seconds by default; clamped to 3–60 seconds). rLive refreshes the signing response on the next room entry/reconnection.

The client then sends normal heartbeats, processes gzip PushFrame data, acknowledges `needAck`, and decodes normal/emoji chat, gifts, likes, entries, and common social messages. This document defines a transport contract; it does not distribute a signature or anti-bot bypass implementation.
