# Douyin platform API documentation

Updated 2026-07-27. This page documents rLive's Douyin live-web browse, playback, and real-time-chat boundary. It is not official Douyin Open Platform or Live SDK documentation.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories and recommendations | Supported | Anonymous SSR is reliable for the first page only; later browser-signed pages are not exposed as Load more. |
| Search | Supported | Requires a complete logged-in Cookie. |
| Room details and playback | Supported | Parses web/reflow data and offers actually supplied qualities and stream URLs. |
| Account | Supported | QR or manual Cookie storage; anonymous browsing establishes a transient web session. |
| Real-time chat receive | Supported | A fixed local signer returns a temporary WSS address for chat, gifts, likes, entries, and similar events. |
| Chat sending | Not supported | Receiving credentials do not establish a write permission. |

## Adapter surface

The adapter implements rLive's shared browse, room, quality, and playback methods. SSR browse does not reliably expose an iterable cursor, while the later web endpoint requires browser verification, so rLive never fakes offset paging or uses a saved Cookie to bypass it. **Load more** is therefore not exposed for Douyin browse pages.

For a short room id, the adapter first parses the SSR room page for its internal id and then requests the public reflow API. The reflow request does not replay a `.douyin.com` Cookie or `msToken` to `amemv.com`, avoiding the browser-signed web-enter path that can return code 101. Stream URLs are short-lived web data and should be refreshed after a room/playback failure.

## Local signer and chat

Douyin chat WSS addresses require a short-lived signature. rLive does not ship a reverse-engineered signer; it always calls:

```text
http://127.0.0.1:18080/sign
```

The request is loopback-only, bypasses the global proxy, and never follows redirects. A compatible local service returns a temporary WSS URL; rLive then sends heartbeat/ack frames and decodes inbound events. A complete Cookie can supply the local signing session, but it is not uploaded to a remote signing service by rLive.

The signer authorises a receiving connection only. rLive has no Douyin chat sender. Reconsider that only if the platform provides desktop-suitable formal interaction authorisation, moderation, and rate-limit contracts.

## Limits and source locations

Cookies, signed URLs, and raw upstream payloads are not logged or kept in frontend caches. QR login and search may receive a browser-verification page; QR requests use the explicit application HTTP(S) proxy when configured, but rLive does not imitate or solve browser verification. Website verification, Cookie expiry, region, and risk controls can affect browsing, search, room lookup, and playback; rLive preserves a verified first page rather than fabricating data.

- Site and playback: `src-tauri/src/sites/douyin.rs`
- Chat protocol: `src-tauri/src/danmaku/douyin.rs`
- Local signer call: `src-tauri/src/commands/danmaku.rs`
