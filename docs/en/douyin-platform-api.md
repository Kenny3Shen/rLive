# Douyin platform API documentation

Updated 2026-07-27. This page documents rLive's Douyin live-web browse, playback, and real-time-chat boundary. It is not official Douyin Open Platform or Live SDK documentation.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories and recommendations | Supported | Anonymous SSR is reliable for the first page; a valid web session can attempt real upstream pagination. |
| Search | Supported | Requires a complete logged-in Cookie. |
| Room details and playback | Supported | Parses web/reflow data and offers actually supplied qualities and stream URLs. |
| Account | Supported | QR or manual Cookie storage; anonymous browsing establishes a transient web session. |
| Real-time chat receive | Supported | A fixed local signer returns a temporary WSS address for chat, gifts, likes, entries, and similar events. |
| Chat sending | Not supported | Receiving credentials do not establish a write permission. |

## Adapter surface

The adapter implements rLive's shared browse, room, quality, and playback methods. SSR browse does not reliably expose an iterable cursor, so rLive never fakes offset paging. Once a complete Cookie is stored, it may call Douyin's own web-pagination endpoint and exposes **Load more** only when that endpoint really returns another page.

Room data comes from web room/reflow APIs with an SSR fallback. On recoverable failures the adapter refreshes the transient web session once. Stream URLs are short-lived web data and should be refreshed after a room/playback failure.

## Local signer and chat

Douyin chat WSS addresses require a short-lived signature. rLive does not ship a reverse-engineered signer; it always calls:

```text
http://127.0.0.1:18080/sign
```

The request is loopback-only, bypasses the global proxy, and never follows redirects. A compatible local service returns a temporary WSS URL; rLive then sends heartbeat/ack frames and decodes inbound events. A complete Cookie can improve room/signing-session reliability, but it is not uploaded to a remote signing service by rLive.

The signer authorises a receiving connection only. rLive has no Douyin chat sender. Reconsider that only if the platform provides desktop-suitable formal interaction authorisation, moderation, and rate-limit contracts.

## Limits and source locations

Cookies, signed URLs, and raw upstream payloads are not logged or kept in frontend caches. Website verification, Cookie expiry, region, and risk controls can affect browsing, search, room lookup, and playback; rLive preserves a verified first page rather than fabricating data.

- Site and playback: `src-tauri/src/sites/douyin.rs`
- Chat protocol: `src-tauri/src/danmaku/douyin.rs`
- Local signer call: `src-tauri/src/commands/danmaku.rs`
