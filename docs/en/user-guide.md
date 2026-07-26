# rLive User Guide

Chinese is the primary UI language. This English guide mirrors [用户指南](../zh/用户指南.md).

## 1. Overview

rLive is a desktop live-stream aggregator for browsing, searching, and watching multi-platform streams with danmaku (chat). Inspired by Simple Live; not an official client.

| Site | Lists / search | Playback | Danmaku |
|------|----------------|----------|---------|
| Bilibili | Yes | Yes | Yes (single-message sending requires the local shared send switch and a valid Cookie) |
| Huya | Yes | Yes | Yes (single-message sending requires the local shared send switch and a valid Cookie) |
| Douyu | Yes | Yes | Yes (single-message sending requires the local shared send switch and a valid Cookie) |
| Douyin | First-page recommendations/categories; search needs a logged-in cookie | Yes | Yes (fixed local signer) |
| Kuaishou | Recommendations / categories / game-category search | Yes | Not yet supported |
| Twitch | First-page lists / categories / search | HLS | Yes (anonymous IRC) |

Douyin's public server-rendered list is currently reliable only for its first page. rLive deliberately does not offer fake pagination that would repeat rooms. Live search becomes available after you save a complete logged-in browser cookie through QR login or manual input.

Douyin's WSS endpoint requires a short-lived signed URL. rLive does not ship a reverse-engineered signer and always calls the fixed local `http://127.0.0.1:18080/sign` endpoint. Start a compatible signer on that loopback address before entering a chat-enabled room; there is no remote signer setting. See [signing-service integration](douyin-danmaku-signing-service.md).

Kuaishou uses public recommendation/category data and the room's initial state. Search intentionally matches game-category names only and returns that category's rooms; no match produces an empty list rather than pretending to search creators. The first version prefers H.264 playback URLs and has no real-time danmaku.

Twitch supports live lists, categories, search, rooms, HLS playback, and anonymous IRC chat. Its public browse interface reliably yields only the first result page, so rLive deliberately provides no pagination rather than repeat or bypass the interface's integrity checks.

## 2. Install & run

### Windows

Use `D:\dev\rLive\src-tauri\target\release\rlive.exe` or build with `scripts\build-windows.ps1`.  
**No mpv required** — playback is Web MSE (`mpegts.js` + local proxy).

### From source

See the root [English README](../../README.en.md): `bun install` → `bun run tauri dev`.

## 3. UI map

| Area | Role |
|------|------|
| Sidebar | Home, follows, categories, history, statistics, IPTV, settings |
| Header | Site switcher, search (user / room ID / title); platform changes use a short content transition; the Follows page uses the same centred selector with an extra All platforms option |
| Room | Icon-only Back control, room title, player, host information, and side tabs in the order Danmaku / SC / Follows / Settings |

## 4. Watching

1. A first launch opens Bilibili by default; pick another site in the header when needed.
2. Selecting a category opens its own room-list page; search can target **all**, **user**, **room ID**, or **title**.
3. The room header has an icon-only Back control on the left and keeps the title centred. It returns to the source page for in-app navigation, or Home for a directly opened room URL. The side-header shows the host avatar, name, platform, and current heat.
4. The player controls are a transparent overlay at the bottom of the video. They hide after a short idle period during playback and reappear on pointer, click, or keyboard activity. They remain visible while a volume, quality, or line menu is open; with the picture focused, `Space` / `K` play or pause, `M` mutes, and `F` toggles fullscreen.
5. The refresh control sits left of pause and refreshes stream metadata before rebuilding the playback session; the volume icon opens a vertical slider.
6. **Quality** and **line** are separate selectors on the right and show only the active selection.
7. The right sidebar, floating danmaku, and fullscreen use compact icon controls. Reopening the sidebar preserves chat and SC lists. Click a normal danmaku message to choose **Copy** or **+1**: Copy writes it to the clipboard; in a Bilibili, Douyu, or Huya room whose sending prerequisites are ready, **+1** sends the exact same text once and never appends a literal `+1`.
8. Default quality preference: **Settings → Playback**.
9. Douyin supports anonymous first-page browse and playback; search requires a saved logged-in browser cookie, acquired through QR login or manual input under **Settings → Account**. Live chat uses the fixed local `http://127.0.0.1:18080/sign` signer and decodes normal/emoji chat, gifts, likes, entries, and common social notices. Kuaishou supports recommendations, categories, game categories, rooms, and playback; its search is limited to game-category names. Twitch supports live lists, categories, search, rooms, HLS playback, and anonymous IRC chat; public-interface limits make only the first browse page reliable, so pagination is not offered.
10. **IPTV** opens a channel-discovery homepage, not a player: entering it never starts the first stream. Choose an official daily-updated IPTV-org scope for Chinese-language, mainland-China, East-Asian, or general public channels. To use a custom source, save an authorised HTTP(S) M3U URL under **Settings → Network**; it then appears as **Custom source** on the IPTV page. Search by multiple name/group keywords, use the popular-group shortcuts, and expand the channel list only as needed. Selecting a channel opens a separate immersive `/iptv/play` page, where HLS, MPEG-TS, and FLV sources use their appropriate playback path; Back returns to the same filtered list. The custom URL remains device-local and is omitted from routes, history, and profile import/export. Availability, territory, and rights are determined by the source.

Streams are fetched via a localhost proxy so the web player can attach with correct headers.

## 5. Danmaku

### Connection

Entering a Bilibili, Huya, Douyu, Douyin room with its local signer running, or Twitch room connects that site's danmaku service. Chat appears in the side list; optional floating tracks overlay the video.

- **Bilibili:** under Settings → Account → 哔哩哔哩, either scan the official QR code in the mobile app or paste a browser cookie manually. A QR confirmation saves the Cookie locally only. After an unexpected disconnect, rLive rotates gateways, refreshes the short-lived token, and reconnects; progress appears as a system message.
- **Huya / Douyu:** receiving danmaku usually does not need a Cookie. To send one ordinary message, first turn on the shared **启用发送功能** switch at the top of **Settings → Account**, then save the local account Cookie for that platform. Douyu supports QR login or manual input; Huya currently requires manual input. Douyu uses system TLS (`native-tls`) because its servers only offer RSA-AES-GCM suites.
- **Douyin:** under Settings → Account → 抖音, either scan the QR code in the Douyin app or paste a browser cookie manually. A complete saved Cookie is required for search and can improve room/signing reliability. For live chat, rLive supplies the transient room session to the fixed local `http://127.0.0.1:18080/sign` service, which returns a temporary WSS URL; the request bypasses the global proxy and never follows redirects.
- **Twitch:** chat uses an anonymous IRC WebSocket connection.
- **Kuaishou:** the room explicitly reports that real-time danmaku is not supported instead of repeatedly attempting a failed connection.

### Bilibili, Douyu, and Huya danmaku sending

This device-local feature is off by default to prevent accidental writes. At the top of **Settings → Account**, turn on **启用发送功能** to enable one ordinary text-message send path for Bilibili, Douyu, and Huya together. The switch is stored only on this device and is omitted from profile export/import. It is not a login state: each platform still needs its own valid Cookie and must independently pass room, text, cooldown, and upstream validation. A platform's composer stays disabled until all of its prerequisites are ready.

The compact composer in the centre of the player control bar submits one ordinary text message per action. Pressing Enter, clicking Send, or using **+1** on a message submits that exact text; there is no bulk, loop, schedule, auto-reply, gift/payment, or automatic retry for an ambiguous write.

- **Bilibili:** requires a valid Cookie containing `SESSDATA` and `bili_jct`. It sends only ordinary scrolling white text; the backend validates the Cookie, room, control characters, the current official-web default of 20 UTF-16 code units, and a 3-second per-room cooldown. The official client receives that limit per account/server; rLive enforces the researched default until a supported policy-read contract exists. The Cookie-bearing request never follows redirects.
- **Douyu:** under **Settings → Account → 斗鱼**, use QR login or manually save a Cookie containing `acf_username`, `acf_stk`, and `acf_ltkid` (the older `_acf_ltkid_` spelling is accepted). The sender validates a numeric room ID and a non-empty, single-line message of at most 100 UTF-16 code units, with a conservative 3-second per-room cooldown.
- **Huya:** under **Settings → Account → 虎牙**, manually save a Cookie with a numeric account ID (`yyuid` or `udb_uid`) and an opaque login proof (`udb_n` or `udb_cred`); QR login is not currently available. The sender validates the resolved room, a non-empty, single-line message of at most 30 UTF-16 code units, and a short local cooldown.

These three device-local Cookie-authenticated paths do not state that a platform has granted rLive a public application write API. Cookies stay local and are not logged, exported, or uploaded to another service. A local send result is not a guarantee of platform acceptance: verify the result only in an account and room where you are allowed to speak, and comply with the current platform terms, moderation rules, and local law.

### Local pending-platform-echo marker

After a Bilibili, Douyu, or Huya send command succeeds locally, the right-side list adds a distinct local-colour row marked as **you** and **submitted locally, awaiting platform echo**. Floating danmaku uses an amber `【我·待平台回显】` prefix. This front-end-only marker exists only for the current session: it means the request reached the local sending path, **not that the platform accepted the chat**.

A real platform echo retains its original platform appearance. rLive does not match identical text to merge, confirm, or remove the pending marker, so a local marker and an actual echo of the same content may coexist briefly. Treat a timeout or failure according to the live platform's real state.

### Room-side settings

Open any room and select the **Settings** tab on the right; the tabs are ordered **Danmaku / SC / Follows / Settings**. Values are saved locally and apply to later rooms too.

| Control | Effect |
|---------|--------|
| Display area | Portion of video height used by floating tracks (10%–100%) |
| Visible lines | Automatic lanes, or a fixed 1–20 lane cap |
| Opacity | Floating text alpha (live preview on drag) |
| Font size / weight | Canvas + list base size; weight improves readability over bright video |
| Speed | Scroll speed (logical 1–10) |
| Same-content grouping | In floating tracks only, combines matching normal-chat content from every sender for 5 seconds and shows a count, such as `加油 ×100`; the right-side list keeps every message |
| Gift filter | Hides gift notices from Douyu and similar sites without affecting SC |
| Shield words | One word per line; filtering applies while typing, shared by chat, SC, and canvas, and auto-saves |

Every display control applies live: sliders preview while dragged and persist on release, while toggles and font weight persist immediately. For busy rooms, chat and SC updates are batched per animation frame with bounded queues; inactive chat / SC tabs retain a bounded backlog without continuously reconciling hidden rows, so tab changes do not reset the lists. The canvas stops requesting frames while it has no active floating messages, then resumes for new messages, setting changes, or resizes to reduce CPU use; tracks are allocated from top to bottom. Douyu drops high-volume join packets and text-shaped `xxx entered the room` notices in Rust, while all sites consistently hide enter events in the frontend.

### Super Chat (SC)

Room side panel tab **SC** shows only Bilibili `super_chat` events. A compact paid-message card places the sender avatar, name, highlight duration, and amount in a light identity deck; the full message remains readable in the safely validated Bilibili tier-colour band below. Missing, blocked, or failed faces fall back to the sender initial, and the app does not fetch a user profile. Shield words apply to SC too; floating tracks emphasize it as a top-style message. Bilibili rooms without entries say that no Super Chats have arrived, while other platforms explicitly report that SC is not yet available.

Bilibili image emotes in normal chat are delivered with the message itself. rLive loads only validated Bilibili CDN image URLs and preserves the original text/image order in the side list and floating tracks. Floating danmaku retains the original text as a fallback while a CDN image is loading or unavailable.

## 6. IPTV

`/iptv` is a channel-discovery homepage. It reads IPTV-org's official daily-updated Chinese-language, mainland-China, East-Asian, and general public playlists, and deliberately does not mount a player or start a stream on entry. A custom HTTP(S) M3U URL is saved only under **Settings → Network**; once configured, the homepage shows it as **Custom source** rather than providing a free-form address field. The address remains device-local and is omitted from routes, history, and profile import/export. It avoids the provider's oversized global index so every built-in source stays within rLive's bounded playlist loader. Multi-keyword search ranks exact and prefix channel matches first, popular groups are immediately available, and long results are expanded in pages. Selecting a channel opens the separate immersive `/iptv/play` page; its Back control returns to the source, category, and search-filtered list. The localhost proxy rewrites nested HLS manifests, segments, and keys for HLS playback; MPEG-TS and FLV use the existing MSE path. rLive hosts no programme content, bypasses no region restriction, and does not guarantee any third-party source. Only load channels you are allowed to watch.

## 7. Follows, history & statistics

Follow anchors (with tags) from the room page; the centred selector on the Follows page filters by **All platforms** or one site, while its only status filters are **All / Live / Offline**. Its floating refresh button updates live status. The room-side **Follows** tab places live rooms first and switches directly to a selected followed room without leaving the room page; its Back action then returns home rather than a previous room. It also provides a floating refresh button. Visited rooms are stored in history. The sidebar **Statistics** page summarizes the currently stored room-entry records with a seven-day trend, platform distribution, and totals. A record keeps the latest entry time for one platform/room pair; it is not watch-duration data.

## 8. Settings summary

Use the single sun / moon button above **设置** in the sidebar for the app theme; each click alternates between light and dark mode. At the top of **Settings → Account**, the default-off device-local **启用发送功能** switch jointly controls Bilibili, Douyu, and Huya sending; each platform still keeps its own Cookie and validation rules. The global settings page also contains default quality, HTTP proxy, a device-local custom IPTV M3U address, Bilibili/Douyin/Douyu QR/manual Cookie login, Huya manual Cookie input, and profile import/export. Profiles exclude all cookies, the custom M3U URL, and the shared sending permission; importing never overwrites those local-only choices. The Douyin signer endpoint is fixed in code and has no setting. Danmaku settings live in each room's **设置 (Settings)** tab rather than the global settings page. Windows release builds keep sanitized failure diagnostics in `%APPDATA%\rlive\logs\rlive.log`, rotating after 2 MiB; successful progress is not written, and neither are Cookie values, tokens, or outgoing chat text.

For Douyin, anonymous browsing creates a transient `ttwid` session automatically. A complete logged-in browser cookie, saved by QR login or manual input, is required for live search and can improve room parsing; it is stored only in local SQLite. The fixed local chat signer receives the effective connection session (the saved Cookie plus transient `ttwid` / `msToken`) only while it creates a signed WSS connection; transient values are never persisted.

## 9. FAQ

| Issue | Hint |
|-------|------|
| Douyu `HandshakeFailure` | Upgrade to the `native-tls` build |
| Bilibili no chat | Valid cookie / token required for many rooms |
| Bilibili QR expires / does not finish | Refresh the QR, scan and confirm in the Bilibili app, or switch to manual Cookie input |
| Huya crash on open | Use build with UTF-8-safe HTML parse |
| Douyin search requests login | Scan the QR code or save a complete logged-in browser cookie under Settings → Account → 抖音; first-page browse and playback do not require it |
| Douyin chat cannot reach the signer | Start the compatible local signer at `http://127.0.0.1:18080/sign`; its address cannot be changed in Settings |
| Bilibili composer is disabled | At the top of Settings → Account, enable **启用发送功能**, then save a Cookie containing `SESSDATA` and `bili_jct` |
| Douyu composer is disabled | At the top of Settings → Account, enable **启用发送功能**, then under 斗鱼 scan the QR or save a valid Cookie containing `acf_username`, `acf_stk`, and `acf_ltkid` |
| Douyu send needs diagnosis | Check `%APPDATA%\rlive\logs\rlive.log` for the failure entry and correlate safe stage/error-code records by `attempt_id`; Cookie values, tokens, chat text, and successful progress are not logged |
| Huya composer is disabled | At the top of Settings → Account, enable **启用发送功能**, then under 虎牙 manually save a valid Cookie with `yyuid` or `udb_uid`, plus `udb_n` or `udb_cred` |
| Black screen | Try another line/quality; re-enter room |

## 10. Compliance

The app is primarily a read-only aggregator. Bilibili, Douyin, and Douyu QR/manual logins, plus Huya manual Cookie input, are user initiated and store Cookie data locally. With the shared local send switch enabled, the supported Bilibili, Douyu, and Huya composers allow one ordinary text message for each direct user action. A local pending-platform-echo marker is not delivery or platform authorisation. Douyu and Huya Cookie-authenticated sending does not establish a public platform API grant or guarantee delivery; users remain responsible for real-service verification and compliance with platform terms. There are no gifts, payments, batch/scheduled/automatic sends, or recording. Personal / educational use; respect platform ToS and local law.
