# Douyin platform API notes

Updated: 2026-07-28. This page describes rLive's Douyin live browse, playback, and real-time chat boundaries.

## Capability overview

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories / recommendations | Supported | Anonymous SSR first page only; no fabricated "load more". |
| Search | Supported | Requires a complete logged-in Cookie; shows results only when the upstream succeeds. |
| Room detail and playback | Supported | Parses web/reflow data and exposes upstream qualities and play URLs. |
| Account | Supported | QR login or manual Cookie; anonymous browse creates a transient web session. |
| Real-time chat receive | Supported | Local MSSDK signature, direct official WSS; chat, gifts, likes, entries, and similar events. |
| Chat send | Not supported | The signature authorises a receiving connection only. |

## Local signature and chat

Douyin chat WSS addresses require a short-lived signature. rLive performs the following steps on-device:

1. Read the internal `room_id` from room detail.
2. Generate an anonymous 12-digit `user_unique_id`.
3. MD5 the fixed webcast client parameters, then evaluate embedded `webmssdk` with Boa to obtain `signature`.
4. Attach the signature to `wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/`.
5. Connect with Cookie / Origin / UA; handle gzip / protobuf frames, heartbeat, and ACK.

No external signer configuration is required. Cookies, short-lived WSS URLs, and signatures are never logged or exported.

## Limits and security

Browser verification pages, Cookie expiry, region limits, and platform risk controls can still break search, rooms, playback, or chat. rLive keeps verified first-page results rather than inventing pagination.

- Site / playback: `src-tauri/src/sites/douyin.rs`
- Chat transport: `src-tauri/src/danmaku/douyin.rs`
- Local signature: `src-tauri/src/danmaku/douyin_sign.rs`
- MSSDK script: `src-tauri/assets/douyin_webmssdk.js`
