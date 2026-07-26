# Bilibili danmaku sending research

Updated 2026-07-26. This records the implementation boundary and safety controls for rLive's supported Bilibili sender.

## Conclusion

This capability relies on a logged-in, non-public write endpoint. rLive formally supports a **default-off device-local sending permission** for one user-initiated ordinary scrolling text message. Formal support does not turn it into automation or make the endpoint a public Bilibili third-party write API: it never sends gifts or supports bulk, loops, schedules, auto-replies, styling controls, or automatic retry.

## Confirmed request shape

The live implementation in `bilibili-api-python` 17.4.2 uses:

```text
POST https://api.live.bilibili.com/msg/send
```

It requires a real room ID and logged-in cookies:

- Required: `SESSDATA` and `bili_jct`; use `bili_jct` for both `csrf` and `csrf_token`.
- Recommended session cookies: `buvid3`, `buvid4`, and `DedeUserID`.
- Basic form fields: `roomid`, `msg`, `mode=1`, `bubble=0`, `rnd` (Unix seconds), `color=16777215`, `fontsize=25`, `csrf`, and `csrf_token`.
- Modes: scrolling `1`, bottom `4`, and top `5`. Colour and font permissions can depend on the account or room.

rLive already retains the real room ID in `LiveRoomDetail.room_id` and has Bilibili cookie, shared HTTP-client, and error-model paths. A send flow therefore does not need a fresh room-detail request for each message.

## Current supported implementation

1. A separate device-local sending permission defaults to off; the composer additionally requires a saved Cookie containing both `SESSDATA` and `bili_jct`.
2. It appears in the centre of the player control bar only in a Bilibili room, submits directly on Enter/click, and visibly reports success, failure, or permission state.
3. Backend rechecks that permission, numeric room ID, text/controls/current official-web default of 20 UTF-16 code units, Cookie credentials, and a conservative 3-second per-room cooldown. The official client receives this as an account/server-supplied `danmakuLengthLimit`; rLive currently enforces the observed default because it has no supported read contract for the policy.
4. Rate codes 10030 / 10031 / 10039 and HTTP 429 produce a clear cooldown message. Timeout/network failures are never retried and report unknown delivery.
5. No optimistic local event is inserted; only normal WebSocket echo enters the list.
6. The write request uses a no-redirect HTTP client, so a redirect target cannot receive its Cookie. Cookie, CSRF, message content, and raw upstream errors never enter logs or frontend responses.

Tests cover Cookie/text validation, the sender cooldown, and a local HTTP contract for form fields, Cookie/CSRF headers, success, and HTTP rate limiting. Release validation still requires a controlled account and permitted room to verify a real echo; never automate public-room sends.

## Security prerequisite

`tauri-plugin-mcp-bridge` is now debug-only. Release builds therefore do not expose a local automation bridge that could bypass local sending permission or the user-operated UI entry. The backend still independently enforces the device-local sending permission, credential, text, room, and cooldown checks; frontend disabling is only a UX layer.

## References

- `bilibili-api-python` v17.4.2: live `LiveRoom.send_danmaku` and its API definition.
- rLive: Bilibili real-room-ID parsing, cookie storage, and the `LiveRoomDetail.room_id` data flow.
