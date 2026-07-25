# Bilibili danmaku sending research

Updated 2026-07-25. This records the safety boundary of rLive's gated implementation.

## Conclusion

Sending a single Bilibili live-chat message is technically feasible, but it relies on a logged-in, non-public write endpoint. rLive now offers a **default-off experimental path** for one ordinary scrolling text message, with a per-message confirmation. It never sends gifts or supports bulk, loops, schedules, auto-replies, styling controls, or automatic retry.

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

## Current gated implementation

1. A separate settings opt-in defaults to off; the composer additionally requires a saved Cookie containing both `SESSDATA` and `bili_jct`.
2. It appears only in a Bilibili room and requests a second confirmation for every Enter/click submission.
3. Backend rechecks opt-in, numeric room ID, text/controls/80-character limit, Cookie credentials, and a conservative 3-second per-room cooldown.
4. Rate codes 10030 / 10031 / 10039 produce a clear cooldown message. Timeout/network failures are never retried and report unknown delivery.
5. No optimistic local event is inserted; only normal WebSocket echo enters the list.
6. Cookie, CSRF, message content, and raw upstream errors never enter logs or frontend responses.

Tests cover pure Cookie/text validation and the sender cooldown; live validation must use a controlled account/room and never automate public-room sends.

## Security prerequisite

`tauri-plugin-mcp-bridge` is now debug-only. Release builds therefore do not expose a local automation bridge that could bypass UI confirmation. The backend still independently enforces opt-in, credential, text, room, and cooldown checks; frontend disabling is only a UX layer.

## References

- `bilibili-api-python` v17.4.2: live `LiveRoom.send_danmaku` and its API definition.
- rLive: Bilibili real-room-ID parsing, cookie storage, and the `LiveRoomDetail.room_id` data flow.
