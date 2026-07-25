# rLive Architecture

Companion to [架构说明](../zh/架构说明.md). Chinese docs are preferred for product wording; this page is for English readers and contributors.

## 1. Stack

| Layer | Tech |
|-------|------|
| UI | React, Tailwind v4, shadcn/ui (Chinese chrome) |
| Shell | Tauri 2 |
| Backend | Rust: sites, SQLite, stream proxy, danmaku WS |
| Playback | `mpegts.js` + localhost `stream_proxy` |

```
React (room / settings / lists)
        │ invoke / events
Rust LiveSite + danmaku + proxy + DB
```

## 2. Playback flow

1. Site returns play URLs + headers.  
2. `stream_proxy_start` binds `127.0.0.1`.  
3. Frontend plays proxied FLV via MSE.  
4. Leave room: stop player + proxy.

The room player renders controls as a transparent bottom overlay. They auto-hide after playback is idle and reappear on pointer, click, or keyboard activity.

## 3. Sites

| Path | Role |
|------|------|
| `sites/bilibili/` | Full loop + danmaku token |
| `sites/huya/` | Mobile init JSON, anticode FLV |
| `sites/douyu/` | H5 enc sign (Boa + CryptoJS), H5 play |
| `sites/douyin.rs` | SSR categories/first-page lists, cookie session, room/playback, logged-in search |
| `sites/kuaishou.rs` | Public recommendations/categories/game categories, room SSR initial state, H.264-first playback; no real-time danmaku |
| `sites/registry.rs` | Meta + `is_ready` |

Douyu sign needs browser polyfills in Boa (`escape` / `unescape` / `substr`) and CryptoJS on `globalThis`.  
Huya HTML stripping must not slice mid UTF-8 character (`panic = "abort"` in release).

`DouyinSite` receives the saved account cookie and opens the live home once to obtain a transient `ttwid` session when needed. Categories and recommendations come from the live page's SSR/RSC payload. Its public SSR offset is unreliable, so rLive intentionally exposes only the first page with `has_more = false` rather than repeat rooms. Room detail tries the web endpoint and falls back to SSR under challenge; signed stream URLs remain temporary room `raw` data. The official live-search endpoint requires a complete logged-in cookie. Douyin real-time WebSocket/protobuf danmaku is future work.

## 4. Danmaku

| Module | Protocol |
|--------|----------|
| `danmaku/bilibili.rs` | Packet + zlib/brotli + JSON |
| `danmaku/douyu.rs` | STT framing; multi-port; `native-tls`; borrowed per-packet parsing and early join suppression |
| `danmaku/huya.rs` | TARS join; chat uri 1400 |
| `danmaku/tars.rs` | Minimal TARS |

`DanmakuEvent` has optional `SuperChatInfo`. The Bilibili `SUPER_CHAT_MESSAGE` parser validates and forwards its ID, price, currency, primary/secondary card colours, and duration.

Frontend consumes Tauri event `danmaku` through a high-throughput path:

- `useDanmakuConnection` connects only Bilibili, Huya, and Douyu; frontend and backend epochs prevent stale connect/disconnect work from taking over after a direct room switch.
- `DanmakuPanel` and `SuperChatPanel` batch incoming events per animation frame with bounded queues; chat hides join notices, optional gifts, and consecutive repeats, while SC has bounded deduplication.
- `CanvasDanmaku` and `danmakuEngine` allocate tracks from top to bottom, stop requesting frames while no floating item is active, and resume on a message, setting change, or resize; area, line cap, and font weight apply live.
- `DanmakuSettingsPanel` provides Simple Live-style room-side controls; `FollowPanel` ranks live follows first and changes rooms through the current route.
- `superChat.ts` formats safe amounts/durations and only passes validated hexadecimal colours to inline styles; `danmaku/filter` precompiles shield/repeat matchers.

Persisted: `danmaku_area`, `danmaku_line_count`, `danmaku_opacity`, `danmaku_font_size`, `danmaku_font_weight`, `danmaku_speed`, `danmaku_filter_repeats`, `danmaku_filter_gifts`, `danmaku_shield_words`.

## 5. Delivery

- Source: WSL `/home/.../rLive`  
- Ship: `D:\dev\rLive` → `src-tauri\target\release\rlive.exe`  
- Script: `./scripts/build-windows-from-wsl.sh`  

See `AGENTS.md` for agent delivery rules.

## 6. Extension points

- **Douyin pagination:** only add the challenge-protected `partition/detail/room/v2` flow when a reliable, compliant browser-session/signing path exists; do not fake pagination with SSR offsets.  
- **Douyin danmaku:** protobuf `PushFrame` / `WebcastChatMessage`.  
- **Kuaishou danmaku:** requires separate public-protocol research; no real-time connection is opened today.
- **Richer SC:** extend `DanmakuEvent` + Bilibili SUPER_CHAT fields.
