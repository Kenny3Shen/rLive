# Bilibili danmaku sending research

Updated 2026-07-25. This is a feasibility note; rLive does not send danmaku.

## Conclusion

Sending a single Bilibili live-chat message is technically feasible, but it relies on a logged-in, non-public write endpoint. rLive is currently a read-only aggregator for lists, playback, and receiving chat. It **does not implement or automatically send danmaku or gifts**. Any future work must first meet the safety and UX constraints below.

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

## Constraints for a future implementation

The first version should be Bilibili-only, one explicitly user-triggered plain scrolling message at a time. It must not support batches, loops, schedules, auto-replies, privileged styles, or automatic retries.

1. Add a Bilibili-specific send method and Tauri command; pass the real room ID from an already-loaded detail only.
2. Validate blank/control characters, a conservative length, `SESSDATA`, and `bili_jct` in the backend; apply a short account-and-room cooldown.
3. Lock the send button while pending. Map rate-limit responses such as 10030 / 10031 to a clear “sending too fast” message.
4. Never retry after a timeout or network failure, because the service may already have accepted the message. Report that the delivery state is unknown.
5. Do not optimistically add a local chat row; wait for WebSocket echo to avoid duplicates.
6. Never expose cookies, CSRF values, or request fields in frontend logs, error text, or command responses.

Use mock HTTP tests and an explicitly controlled account/room for manual one-message verification. Do not automate messages to public rooms.

## Security prerequisite

The release build currently enables a localhost `tauri-plugin-mcp-bridge` unconditionally, while existing commands include a cookie-reading path. Adding a write command could let a local process that reaches that bridge invoke it without the UI confirmation flow.

Before exposing any write capability, restrict that bridge to debug builds or remove it from release builds, then review cookie-command exposure and logging. Sending chat must not be released before this prerequisite is addressed.

## References

- `bilibili-api-python` v17.4.2: live `LiveRoom.send_danmaku` and its API definition.
- rLive: Bilibili real-room-ID parsing, cookie storage, and the `LiveRoomDetail.room_id` data flow.
