# rLive Architecture

Companion to [架构说明](../zh/架构说明.md). Chinese docs are preferred for product wording; this page is for English readers and contributors.

## 1. Stack

| Layer | Tech |
|-------|------|
| UI | React, Tailwind v4, shadcn/ui (Chinese chrome) |
| Shell | Tauri 2 |
| Backend | Rust: sites, SQLite, stream proxy, danmaku WS |
| Playback | Live: `mpegts.js`; IPTV: `hls.js` / `mpegts.js`, all through localhost `stream_proxy` |

```
React (room / IPTV / settings / lists)
        │ invoke / events
Rust LiveSite + danmaku + proxy + DB
```

## 2. Playback flow

1. Site returns play URLs + headers.  
2. `stream_proxy_start` binds `127.0.0.1`.  
3. Frontend plays live FLV through MSE; IPTV selects `hls.js` for HLS and `mpegts.js` for MPEG-TS / FLV. The proxy rewrites HLS child playlists, keys, and segments to registered localhost resources.
4. Leave room: stop player + proxy.

Each player session owns a unique proxy session ID, so a delayed cleanup from a room that was just left cannot stop the newer proxy after a rapid re-entry. The room player renders controls as a transparent bottom overlay. They auto-hide after playback is idle and reappear on pointer, click, or keyboard activity.

The independent IPTV command loads a configured device-local or IPTV-org M3U list in Rust (bounded to 8 MB), parses HTTP(S) channel metadata, and returns it to the browser UI without depending on remote CORS headers. A custom HTTP(S) M3U address is saved only in **Settings → Network** and resolved from local settings when the homepage selects `source=custom`; the address itself is never written to route URLs, history, or profile packages. The `/iptv` frontend route is discovery-only (source, category, search, and channel list), so it never creates a player or proxy session on entry. Selecting a channel navigates to the separate immersive `/iptv/play` route, which creates the playback session; its Back action restores the filtered discovery-list route.

## 3. Sites

| Path | Role |
|------|------|
| `sites/bilibili/` | Full loop + danmaku token |
| `sites/huya/` | Mobile init JSON, anticode FLV |
| `sites/douyu/` | H5 enc sign (Boa + CryptoJS), H5 play |
| `sites/douyin.rs` | SSR categories/list fallback, cookie session, verified pagination, room/playback, logged-in search |
| `sites/kuaishou.rs` | Public recommendations/categories/game categories, room SSR initial state, H.264-first playback; no real-time danmaku |
| `sites/twitch.rs` | Public first-page lists/categories/search, room detail, and HLS playback token |
| `sites/registry.rs` | Meta + `is_ready` |

Douyu sign needs browser polyfills in Boa (`escape` / `unescape` / `substr`) and CryptoJS on `globalThis`.  
Huya HTML stripping must not slice mid UTF-8 character (`panic = "abort"` in release).

`DouyinSite` receives the saved account cookie and opens the live home once for each site instance to refresh a transient `ttwid` session. Anonymous categories and recommendations use the live page's SSR/RSC first page. The follow-up web endpoint requires a browser signature and cursor that `RoomListPage` does not carry, so browse results deliberately keep `has_more = false`: rLive neither fabricates pagination from SSR offsets nor uses a saved Cookie to bypass web verification. For a short room id, room detail first parses the SSR page for its internal `id_str`, then queries the public reflow endpoint without replaying a `.douyin.com` Cookie or `msToken` to another domain; this avoids the browser-signed web-enter path that can return code 101. Signed stream URLs remain temporary room `raw` data. The official live-search endpoint requires a complete logged-in cookie, which users can save through QR login or manual input, but QR and search may still receive a browser-verification page; rLive does not attempt to solve it. `danmaku/douyin.rs` obtains a short-lived WSS URL from a local MSSDK signature and handles PushFrame/gzip/protobuf/ack; it passes the saved Cookie plus transient `ttwid` / `msToken` without serialising or persisting those transient values. Only HTTPS or loopback HTTP signer endpoints are accepted, redirects are disabled, and loopback HTTP bypasses the global proxy.

`TwitchSite` uses the public GraphQL surface for live lists, categories, search, room detail, and HLS playback tokens. Cursor pagination triggers public integrity checks, so every browse result deliberately exposes only its reliable first page with `has_more = false` instead of simulating pagination.

## 4. Danmaku

| Module | Protocol |
|--------|----------|
| `danmaku/bilibili.rs` | Packet + zlib/brotli + JSON |
| `danmaku/douyin.rs` | local MSSDK signature → WSS; PushFrame/gzip/minimal protobuf/ack |
| `danmaku/douyu.rs` | STT framing; multi-port; `native-tls`; borrowed per-packet parsing and early join suppression; current-web-aligned local-Cookie ordinary-message sender |
| `danmaku/huya.rs` | TARS join; chat uri 1400; local-Cookie authenticated ordinary-message sender |
| `danmaku/twitch.rs` | Anonymous IRC WebSocket chat |
| `danmaku/tars.rs` | Minimal TARS |

`DanmakuEvent` has optional `SuperChatInfo` and ordered `DanmakuContentSpan` fragments. The Bilibili `SUPER_CHAT_MESSAGE` parser validates and forwards its ID, price, currency, duration, colour metadata, and sender avatar URL. The frontend validates the avatar URL again, loads only trusted Bilibili CDN images without a Referer, and neither fetches nor persists profile data. The card puts the avatar, sender, amount, and duration in a light identity deck, while a validated primary/bottom tier-colour band keeps the full message readable below. Normal Bilibili chat reads image-emote metadata from `info[0][13].url` and `info[0][15].extra.emots`; only HTTPS Bilibili CDN URLs reach the frontend and text/image order is retained.

Bilibili reconnects after close, read failure, rejected authentication, or inbound-idle timeout. Retries rotate gateways, refresh short-lived token/host information, and report a reconnecting system message rather than leaving the room permanently disconnected.

`danmaku/bilibili.rs` also owns the supported single-message Bilibili sender. The command first rechecks the shared, default-off device-local `danmaku_send_enabled` permission used by Bilibili, Douyu, and Huya, then validates `SESSDATA` / `bili_jct`, room/text data, and a conservative per-room cooldown; its Cookie-bearing client never follows redirects and has no automatic retry. The MCP bridge is debug-only so release automation cannot bypass the local sending permission or user-operated UI entry.

`danmaku/douyu.rs` owns the user-initiated Douyu sender and rechecks `danmaku_send_enabled`, room/text constraints, and the conservative three-second per-room cooldown using a complete device-local session. The controlled 2026-07-27 diagnosis found that its old sender used legacy login/chat payloads, skipped the current web client's post-login negotiation, and returned after a socket write without waiting for `chatres` / `error`. The current implementation replaces it with the aligned authentication state machine, stable device identity, shared WSS proxy policy, and platform-result parsing, and has successfully been verified in a personal room. At runtime, local submission, `chatres(res=0)` platform acceptance, and normal-receiver real echo remain distinct; see [Douyu platform API documentation](douyu-platform-api.md). `danmaku/huya.rs` similarly rechecks the shared permission and sends one user-initiated message from a manually entered device-local Cookie with a numeric account ID (`yyuid` or `udb_uid`) and opaque login proof (`udb_n` or `udb_cred`); it resolves room metadata and validates one single-line message (at most 30 UTF-16 code units) before writing. No path logs, exports, or uploads its Cookie or retries an ambiguous write.

The frontend must not synthesize chat from a locally resolved send command. Its list and canvas render a sent message only when the room connection receives the platform's real `DanmakuEvent` echo, retaining the platform's original appearance. A local write is not platform confirmation. For Douyu, local submission, `chatres`, and a real echo respectively mean submission, platform acceptance, and room display; they remain distinct.

Those local-Cookie send entries are deliberately narrow user features, not an assertion that Douyu or Huya has issued rLive a public application write API. Douyu's legacy protocol has been replaced and successfully verified in a personal room; users remain responsible for platform terms, moderation, and local-law compliance.

Frontend consumes Tauri event `danmaku` through a high-throughput path:

- `useDanmakuConnection` connects Bilibili, Huya, Douyu, Douyin, and Twitch; frontend and backend epochs prevent stale connect/disconnect work from taking over after a direct room switch. Local Douyin signature or WSS failures produce retryable errors; Twitch joins chat through anonymous IRC, while Kuaishou remains unsupported.
- `DanmakuPanel` and `SuperChatPanel` batch incoming events per animation frame with bounded queues; chat hides join notices and optional gifts while retaining every accepted room message in the right-side list, and SC has bounded deduplication. Bilibili, Douyu, and Huya rooms can mount the one-message composer in the centre of the player control bar: all require the shared local permission plus their own account prerequisites, and all display sent content only after the platform's real echo.
- `CanvasDanmaku` and `danmakuEngine` allocate tracks from top to bottom, apply the same five-second content grouping to floating normal chat, render ordered Bilibili image emotes through bounded image/bitmap caches with a text fallback while loading, stop requesting frames while no floating item is active, and resume on a message, setting change, or resize; area, line cap, and font weight apply live.
- `DanmakuSettingsPanel` provides Simple Live-style room-side controls; `FollowPanel` ranks live follows first and replaces the room route, so its Back action returns home instead of a previous live room.
- `superChat.ts` formats safe amounts/durations, validates SC avatar URLs again before rendering, and turns only validated hexadecimal colours into the lower SC message-band gradient; `danmaku/filter` precompiles shield matchers and maintains bounded content aggregators.

Persisted: `danmaku_area`, `danmaku_line_count`, `danmaku_opacity`, `danmaku_font_size`, `danmaku_font_weight`, `danmaku_speed`, `danmaku_filter_repeats`, `danmaku_filter_gifts`, `danmaku_shield_words`, `danmaku_send_enabled`, `iptv_custom_m3u_url`, . `danmaku_send_enabled` defaults to `false` and, at the top of Account settings, jointly controls Bilibili, Douyu, and Huya sending. Cookies stay in the separate local `cookies` table. Profile export omits `danmaku_send_enabled`, `iptv_custom_m3u_url`; import preserves their local values so an untrusted profile cannot enable sending, replace a private playlist address, .

## 5. Delivery

- Source: WSL `/home/.../rLive`  
- Ship: `D:\dev\rLive` → `src-tauri\target\release\rlive.exe`  
- Script: `./scripts/build-windows-from-wsl.sh`  

See `AGENTS.md` for agent delivery rules.

## 6. Extension points

- **Douyin pagination:** currently remains SSR-first-page-only. Supporting later pages would require a user-visible real browser/WebView session and a cursor model; never generate a signature, bypass verification, or fake pagination from SSR offsets.
- **Douyin danmaku:** uses a local MSSDK signature and direct WSS; extend the minimal field decoder in `danmaku/douyin.rs` for further message types.
- **Kuaishou danmaku:** requires separate public-protocol research; no real-time connection is opened today.
- **Richer SC:** extend `DanmakuEvent` + Bilibili SUPER_CHAT fields.
