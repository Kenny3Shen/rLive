# Douyin platform API documentation

Updated 2026-07-27. This page documents rLive's Douyin live-web browse, playback, and real-time-chat boundary. It is not official Douyin Open Platform or Live SDK documentation.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories and recommendations | Supported | Anonymous SSR is reliable for the first page only; later browser-signed pages are not exposed as Load more. |
| Search | Supported | Requires a complete logged-in Cookie. |
| Room details and playback | Supported | Parses web/reflow data and offers actually supplied qualities and stream URLs. |
| Account | Supported | QR or manual Cookie storage; anonymous browsing establishes a transient web session. |
| Real-time chat receive | Supported | A user-configured signer returns a temporary WSS address for chat, gifts, likes, entries, and similar events. |
| Chat sending | Not supported | Receiving credentials do not establish a write permission. |

## Adapter surface

The adapter implements rLive's shared browse, room, quality, and playback methods. SSR browse does not reliably expose an iterable cursor, while the later web endpoint requires browser verification, so rLive never fakes offset paging or uses a saved Cookie to bypass it. **Load more** is therefore not exposed for Douyin browse pages.

For a short room id, the adapter first parses the SSR room page for its internal id and then requests the public reflow API. The reflow request does not replay a `.douyin.com` Cookie or `msToken` to `amemv.com`, avoiding the browser-signed web-enter path that can return code 101. Stream URLs are short-lived web data and should be refreshed after a room/playback failure.

## Signer and chat

Douyin chat WSS addresses require a short-lived signature. rLive does not ship a reverse-engineered signer or bundle a signer service. Under **Settings → Account → Douyin real-time danmaku**, enter the complete endpoint of a service you operate or explicitly trust, for example:

```text
http://127.0.0.1:18080/sign
```

To protect the effective web session, rLive accepts HTTPS endpoints or HTTP endpoints on `localhost`, `127.0.0.1`, or `::1`; URLs with credentials or a fragment are rejected. It never follows redirects. A loopback HTTP signer bypasses the app proxy, while an HTTPS signer follows the user's explicitly configured proxy. A compatible signer returns a temporary WSS URL; rLive then sends heartbeat/ack frames and decodes inbound events.

A complete Cookie can improve the signing session. For the connection only, rLive supplies the effective session to the signer the user configured; it does not log or frontend-cache the Cookie or short-lived WSS URL. The signer endpoint is device-local, excluded from profile export, and preserved when a profile is imported.

### Signer contract

The app sends a JSON `POST` request with `roomId`, `liveId`, and `cookie`. A compatible service responds with `wssUrl` (or `wss_url`) and may include a `headers` object plus `heartbeat.intervalMs` (or `heartbeat.interval_ms`). The returned URL must be a secure `wss://` URL. Values are used only for the connection and are never surfaced in the UI or logs.

### Diagnosis record

The previous implementation forced `127.0.0.1:18080/sign`, even though rLive did not bundle that companion service or expose a setting for it. A room therefore failed immediately unless a separate process happened to be listening on that exact port. The configuration is now visible and validated before the request; missing, unsafe, unreachable, and invalid-response cases are reported separately. This transport contract does not distribute or emulate a signing or anti-bot bypass.

The signer authorises a receiving connection only. rLive has no Douyin chat sender. Reconsider that only if the platform provides desktop-suitable formal interaction authorisation, moderation, and rate-limit contracts.

## Limits and source locations

Cookies, signed URLs, and raw upstream payloads are not logged or kept in frontend caches. QR login and search may receive a browser-verification page; QR requests use the explicit application HTTP(S) proxy when configured, but rLive does not imitate or solve browser verification. Website verification, Cookie expiry, region, and risk controls can affect browsing, search, room lookup, and playback; rLive preserves a verified first page rather than fabricating data.

- Site and playback: `src-tauri/src/sites/douyin.rs`
- Chat protocol: `src-tauri/src/danmaku/douyin.rs`
- Signer call: `src-tauri/src/commands/danmaku.rs`
