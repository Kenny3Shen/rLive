# Douyu platform API documentation

Updated 2026-07-27. This page documents rLive's Douyu browse, playback, account, and chat integration, including the repaired sender and its verification.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories, recommendations, category rooms, search | Supported | Uses web/H5 read APIs and their actual pagination. |
| Room details | Supported | Resolves host, cover, heat, notice, status, and start time. |
| Playback and qualities | Supported | Uses web-issued encrypted playback parameters to obtain lines and qualities. |
| Real-time chat receive | Supported | Joins the Douyu chat gateway and filters noisy entry events. |
| Account | Supported | QR or manual complete-Cookie storage on the device only. |
| Normal chat sending and room-session auto-send | Verified | Sent in a test room; each fragment still waits for platform semantics and real echo. |

## Adapter surface

The site adapter implements the shared category, room-list, search, room-detail, quality, and playback-URL methods. A room lookup derives the temporary web playback signature; it remains in memory only while fetching usable CDN lines and qualities.

`danmaku_connect` receives room events. `douyu_danmaku_send_status` and `douyu_danmaku_send` are the account sender's one-fragment commands, reused by both the manual composer and room-session auto-send. Receive and send use different gateway responsibilities and both honour the configured proxy policy.

## Sender repair and verification record

The former sender used legacy `loginreq` / chat fields and reported success immediately after a WebSocket write. The current webpage also requires a post-login encryption negotiation, so writable socket state alone did not prove platform acceptance.

The repaired state machine is:

```text
loginreq → loginres → getEncryption → livreq → livres → lsigreq → chatmessage → chatres / error
```

The implementation now uses current web-shaped login and chat packets, a stable device identity, a dedicated danmaku-session JWT, bounded encryption negotiation, and shared HTTP/WSS proxy handling. It treats `chatres(res=0)` as acceptance, `error` or non-zero `res` as rejection, and a post-write timeout/close/read failure as unconfirmed. It does not retry an ambiguous write.

The repaired path completed an end-to-end send in a test room. It covers the current web flow and test environment; Cookie state, room conditions, and upstream revisions can still change the result.

## Prerequisites and result semantics

Sending requires the default-off local `danmaku_send_enabled` switch, a complete saved account Cookie, a numeric room ID, a non-empty single-line message, and a three-second per-room cooldown. The right-side **Settings** tab in Bilibili, Douyu, and Huya rooms additionally offers a default-off, non-persistent room-session **Auto-send danmaku** control. It can turn on only when the shared permission, current Cookie/send status, and text validation are valid. Enabling it sends the first fragment immediately, normalises line breaks and consecutive whitespace to one space, then splits by grapheme into ordered fragments of at most 15 user-visible characters without exceeding Douyu's UTF-16 limit. It loops from the first fragment after the last, never overlaps requests, and keeps later send starts at least the configured interval apart. Editing text, changing rooms, leaving the page, closing the app, or any send failure disables it; it never retries a failed or ambiguous write. A single grapheme that cannot fit the platform limit is a validation error. rLive supports no bulk sending, auto-replies, gifts, payments, or automatic retry.

| Stage | Meaning |
| --- | --- |
| Local submission | rLive handed the request to the sender; it is not acceptance. |
| `chatres(res=0)` | Douyu's gateway confirmed acceptance. |
| Real room echo | The normal receiving connection saw the message; only then does rLive render it. |

The frontend never creates a synthetic message from a command result. Do not repeatedly resend an unknown result; use the live room's real state.

## Data handling and source locations

Cookie, JWT, signature, message text, and raw replies stay out of logs, exports, and uploads.

- Site and playback: `backend/src/sites/douyu/`
- Chat receive/send state machine: `backend/src/danmaku/douyu.rs`
- Commands, permission, and cooldown: `backend/src/commands/danmaku.rs`
