# Huya platform API documentation

Updated 2026-07-27. This page documents rLive's Huya browse, playback, account, and chat adapter. It is not official Huya Open Platform or partner-SDK documentation.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories, recommendations, category rooms, search | Supported | Parses Huya web/configuration data and actual upstream pagination. |
| Room details | Supported | Resolves host, cover, heat, status, notice, and playback metadata. |
| Playback and qualities | Supported | Handles available lines, bitrates, and anti-leech parameters. |
| Real-time chat receive | Supported | Decodes TARS/WebSocket room traffic. |
| Account | Supported | Manual device-local Cookie storage; no built-in QR login. |
| One normal chat message | Supported | Needs the local send switch, account Cookie, and room metadata. |

## Adapter surface

Huya implements the shared category, room-list, search, room-detail, quality, and playback-URL methods. Its playback adapter extracts lines and bitrates from room data and processes anti-leech fields at use time; stream URLs are not a durable external API.

`danmaku_connect` receives room events. `huya_danmaku_send_status` and `huya_danmaku_send` are internal, user-operated one-message commands. The sender resolves room metadata again before writing so it can derive required internal room arguments.

## Account and sending boundary

Under **Settings → Account → 虎牙**, manually save the local Cookie. Sending requires a numeric account ID (`yyuid` or `udb_uid`) and an opaque login proof (`udb_n` or `udb_cred`), the default-off `danmaku_send_enabled` switch, a valid room, a non-empty single-line message, and a three-second per-room cooldown.

The feature sends one user-initiated ordinary text message only: no bulk, loop, schedule, auto-reply, gift, payment, or retry of ambiguous results. A completed write does not manufacture a chat row; the list and floating layer wait for the normal room connection's real echo.

## 2026-07-27 send diagnosis and verification

A controlled send was verified in an authorised personal room. The initial fault was not an expired Cookie: the signal service completed login verification and returned a `liveui.sendMessage` WUP response, but rLive incorrectly reported that response as malformed.

The diagnosis and repair were:

- The site factory had discarded the user-saved Huya Cookie before room resolution, so the pre-send room refresh always used anonymous context. The Cookie is now attached only to `m.huya.com` and `www.huya.com` room-page requests, never replayed to list, search, or CDN hosts.
- An offline personal room can omit `lChannelId` / `lSubChannelId`. The old path substituted the public short room number as a signal channel. The resolver now uses desktop `TT_PROFILE_INFO.lp`, non-zero `TT_ROOM_DATA` channel fields, and the `privateHost` / `yyid` fallback; a public short room number never enters the TARS channel fields.
- The send path matches the current web player signal context: its current H5 signal UA, `WSConnectParaInfo.sCookie`, `WSVerifyCookieReq`, and one `liveui.sendMessage` WUP request. Cookie values and raw frames are not logged.
- The `tRsp` value is itself a TARS tag-0 `SendMessageRsp` wrapper. The old parser read that wrapper as `iStatus`, turning a confirmed platform response into an error. rLive now unwraps it before reading the status and safe toast text.

The repaired controlled test received the platform success status. Platform acceptance still is not a display acknowledgment: rLive adds no local echo and waits for the normal receiver's real room echo; an ambiguous result is never retried automatically.

## Limits and source locations

Web protocols, lines, and login requirements may change. Cookies stay on the device and are not logged, exported, or uploaded. This local feature is not a public application-write grant; confirm account/room eligibility and follow Huya terms.

- Site and playback: `src-tauri/src/sites/huya/`
- TARS chat transport: `src-tauri/src/danmaku/huya.rs`, `src-tauri/src/danmaku/tars.rs`
- Commands, permission, and cooldown: `src-tauri/src/commands/danmaku.rs`
