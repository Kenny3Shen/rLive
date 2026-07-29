# Bilibili platform API documentation

Updated 2026-07-27. This page documents rLive's Bilibili adapter, its upstream API categories, and its device-local account boundary.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories, recommendations, category rooms, search | Supported | Uses web-accessible live and search data; pagination follows upstream results. |
| Room details | Supported | Resolves the real room ID, host, cover, heat, status, and notice. |
| Playback and qualities | Supported | Resolves available protocol/format/codec/quality options for the local web player. |
| Real-time chat and Super Chat | Supported | Connects the room WebSocket and renders normal messages, image emotes, and SC. |
| Account | Supported | QR login or manual Cookie storage, kept on the device only. |
| Normal chat sending and room-session auto-send | Supported | Both require the local send switch and a valid logged-in session; auto-send is session-only. |

## Adapter surface

Like every rLive site adapter, Bilibili implements `get_categories`, `get_recommend_rooms`, `get_category_rooms`, `search_rooms`, `get_room_detail`, `get_play_qualities`, and `get_play_urls`. The frontend reaches those through `site_*` Tauri commands and never receives durable upstream credentials or playback signatures.

`danmaku_connect` opens the receiving connection and refreshes its short-lived data after a reconnect. `bilibili_danmaku_send_status` and `bilibili_danmaku_send` are deliberately narrow internal commands for one ordinary-message fragment; both the manual composer and the room-session auto sender reuse them. Super Chat is display-only; rLive has no payment or gift write flow.

## Upstream data and playback

The adapter uses the website's live-category, room-list, search, room-info, danmaku-info, and playback-info API families. Some reads use browser context fields or WBI signing; these are implementation details, not a stable third-party application contract. Short-lived stream URLs and signatures are re-fetched when needed rather than stored in frontend query state.

Room resolution preserves Bilibili's real `room_id`, so display IDs and send IDs are not accidentally mixed. Available qualities and lines remain subject to live status, account, region, and upstream policy.

## Account, chat, and sending

Receiving ordinary chat normally works anonymously. Logged-in Cookie storage improves web-session compatibility. Image emotes are fetched only from validated Bilibili CDN origins.

The local sender uses the logged-in web endpoint:

```text
POST https://api.live.bilibili.com/msg/send
```

It requires all of the following:

1. The default-off device-local `danmaku_send_enabled` switch in **Settings → Account**.
2. A Cookie containing `SESSDATA` and `bili_jct`; `bili_jct` is used as the CSRF value.
3. A real numeric room ID, a non-empty single-line message, and current conservative length/cooldown validation.

The manual composer sends one ordinary text message per action. Bilibili, Douyu, and Huya rooms also offer a session-only **Auto-send danmaku** control in the right-side **Settings** tab. It is off by default, is not persisted, and can turn on only when the shared local permission, current Cookie/send status, and text validation are valid. After it is enabled, it waits 20 seconds before the first send, collapses line breaks and repeated whitespace to one space, and splits by grapheme into fragments of at most 15 user-visible characters while respecting Bilibili's UTF-16 limit. It sends fragments in order and loops back after the last; requests do not overlap and their start times are at least 20 seconds apart. Editing text, changing rooms, leaving the page, closing the app, or any send failure disables it, and failed sends are never retried automatically. A single grapheme that cannot fit the platform UTF-16 limit is a validation error. rLive does not support bulk sending, auto-replies, gifts, payments, or automatic retry of an ambiguous result. A resolved write command never synthesises chat locally: the list and floating layer render the message only after the normal room connection receives the platform's real echo.

## Data handling and source locations

Cookies, CSRF values, message text, short-lived tokens, and raw upstream errors are not logged, exported, or returned to the frontend. The sender does not follow redirects, preventing a redirected target from receiving the logged-in session.

- Site and playback: `src-tauri/src/sites/bilibili/`
- Chat receive/send: `src-tauri/src/danmaku/bilibili.rs`
- Commands and cooldown: `src-tauri/src/commands/danmaku.rs`
