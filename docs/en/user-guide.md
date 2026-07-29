# rLive User Guide

Chinese is the primary UI language. This English guide mirrors [用户指南](../zh/用户指南.md).

## 1. Overview

rLive is a desktop live-stream aggregator for browsing, searching, and watching multi-platform streams with danmaku (chat). Inspired by Simple Live; not an official client.

| Site | Lists / search | Playback | Danmaku |
|------|----------------|----------|---------|
| Bilibili | Yes | Yes | Yes (single-message sending requires the local shared send switch and a valid Cookie) |
| Huya | Yes | Yes | Yes (single-message sending requires the local shared send switch and a valid Cookie) |
| Douyu | Yes | Yes | Yes (sending succeeded in a personal room; each send still uses the shared local switch, complete Cookie, `chatres`, and real-echo semantics) |
| Douyin | Anonymous first-page recommendations/categories; search needs login | Yes | Yes (local signature) |
| Kuaishou | Recommendations / categories / game-category search | Yes | Not yet supported |
| Twitch | First-page lists / categories / search | HLS | Yes (anonymous IRC) |

Douyin's public server-rendered list is currently reliable only for its first page. rLive never uses its SSR offset or a saved Cookie to fake pagination and repeat rooms: the follow-up web endpoint requires browser verification and a cursor, so **Load more** is not offered. A complete logged-in browser Cookie, saved through QR login or manual input, enables live search, although QR and search can still receive a browser-verification page.

Douyin's WSS endpoint requires a short-lived signed URL. rLive computes the MSSDK signature locally and connects directly; no external signer configuration is required. See [Douyin platform API documentation](douyin-platform-api.md).

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
| Sidebar | Home, follows, categories, history, IPTV, settings |
| Header | Home shows the site switcher and search (user / room ID / title); other pages do not show the search button. Platform changes use a short content transition; the Follows page uses the same centred selector with an extra All platforms option |
| Room | Icon-only Back control, room title, player, host information, and side tabs in the order Danmaku / SC / Follows / Settings |

## 4. Watching

1. A first launch opens Bilibili by default; pick another site in the header when needed.
2. Selecting a category opens its own room-list page; search can target **all**, **user**, **room ID**, or **title**.
3. The room header has an icon-only Back control on the left and keeps the title centred. It returns to the source page for in-app navigation, or Home for a directly opened room URL. The side-header shows the host avatar, name, platform, and current heat.
4. The player controls are a transparent overlay at the bottom of the video. They hide after a short idle period during playback and reappear on pointer, click, or keyboard activity. They remain visible while a volume, quality, or line menu is open; with the picture focused, `Space` / `K` play or pause, `M` mutes, and `F` toggles fullscreen.
5. The refresh control sits left of pause and refreshes stream metadata before rebuilding the playback session; the volume icon opens a vertical slider.
6. **Quality** and **line** are separate selectors on the right and show only the active selection.
7. The right sidebar, floating danmaku, and fullscreen use compact icon controls. Reopening the sidebar preserves chat and SC lists. Click a normal danmaku message to choose **Copy** or **+1**: Copy writes it to the clipboard; in a Bilibili, Douyu, or Huya room whose sending prerequisites are ready, **+1** submits the exact same text once and never appends a literal `+1`. Local submission is not delivery: the list and floating layer use only the platform's real echo.
8. Default quality preference: **Settings → Playback**.
9. Douyin supports anonymous first-page browse and playback; searching requires a saved logged-in browser Cookie, acquired through QR login or manual input under **Settings → Account**. Recommendations and categories do not offer **Load more**: rLive neither fakes SSR pagination nor bypasses Douyin browser verification. Room playback first resolves the internal room id from SSR and then uses the public reflow data. Live chat decodes normal/emoji chat, gifts, likes, entries, and common social notices Kuaishou supports recommendations, categories, game categories, rooms, and playback; its search is limited to game-category names. Twitch supports live lists, categories, search, rooms, HLS playback, and anonymous IRC chat; public-interface limits make only the first browse page reliable, so pagination is not offered.
10. **IPTV** opens a channel-discovery homepage, not a player: entering it never starts the first stream. Choose an official daily-updated IPTV-org scope for Chinese-language, mainland-China, East-Asian, or general public channels. To use a custom source, save an authorised HTTP(S) M3U URL under **Settings → Network**; it then appears as **Custom source** on the IPTV page. Search by multiple name/group keywords, use the popular-group shortcuts, and expand the channel list only as needed. Selecting a channel opens a separate immersive `/iptv/play` page, where HLS, MPEG-TS, and FLV sources use their appropriate playback path; Back returns to the same filtered list. The custom URL remains device-local and is omitted from routes, history, and profile import/export. Availability, territory, and rights are determined by the source.

Streams are fetched via a localhost proxy so the web player can attach with correct headers.

## 5. Danmaku

### Connection

Entering a Bilibili, Huya, Douyu, Douyin, or Twitch room connects that site's danmaku service. Chat appears in the side list; optional floating tracks overlay the video.

- **Bilibili:** under Settings → Account → 哔哩哔哩, either scan the official QR code in the mobile app or paste a browser cookie manually. A QR confirmation saves the Cookie locally only. After an unexpected disconnect, rLive rotates gateways, refreshes the short-lived token, and reconnects; progress appears as a system message.
- **Huya / Douyu:** receiving danmaku usually does not need a Cookie. A one-message path additionally needs the shared **启用发送功能** switch at the top of **Settings → Account** and the platform's local account Cookie. Douyu supports QR/manual complete Cookie storage; its current-web sender has successfully been verified in a personal room. For every send, `chatres(res=0)` remains the platform-acceptance signal and the normal receiver's real echo remains the display condition; see [Douyu platform API documentation](douyu-platform-api.md). Douyu uses system TLS (`native-tls`) because its servers only offer RSA-AES-GCM suites.
- **Douyin:** under Settings → Account → 抖音, either scan the QR code in the Douyin app or paste a browser cookie manually. A complete saved Cookie is required for search, but it does not bypass browser verification or enable list pagination. If QR login receives a browser-verification page, check the explicit app proxy and retry, or copy a complete Cookie after completing verification in the official browser. In the same page's **Douyin real-time danmaku** section, save the complete endpoint of a signer you operate or trust. It accepts HTTPS or loopback HTTP (`localhost`, `127.0.0.1`, `::1`), never follows redirects, and bypasses the app proxy for loopback HTTP.
- **Twitch:** chat uses an anonymous IRC WebSocket connection.
- **Kuaishou:** the room explicitly reports that real-time danmaku is not supported instead of repeatedly attempting a failed connection.

### Bilibili, Douyu, and Huya danmaku sending

This device-local permission is off by default to prevent accidental writes. At the top of **Settings → Account**, turn on **启用发送功能** to enable the manual send path and room-side auto-send control for Bilibili, Douyu, and Huya together. The permission switch is stored only on this device and is omitted from profile export/import; the auto-send switch itself is room-session-only, off by default, and is never saved. The permission is not a login state: each platform still needs its own valid Cookie and must independently pass room, text, cooldown, and upstream validation. A platform's composer and auto-send control stay disabled until all of their prerequisites are ready. Douyu's legacy sender was replaced with the current web authentication and result-confirmation state machine and has successfully been verified in a personal room; each message still waits for platform confirmation and real echo before display.

The compact composer in the centre of the player control bar remains a one-message-per-action control. Pressing Enter, clicking Send, or using **+1** on a message submits that exact text. There is no bulk send, auto-reply, gift/payment, or automatic retry for an ambiguous write. Neither local submission nor platform `chatres` replaces the real room echo.

In the room's right-side **Settings** tab, **Auto-send danmaku** is available only for Bilibili, Douyu, and Huya. When the shared permission, Cookie/send status, and text validation are ready, turning it on waits 10 seconds before the first send. The text collapses line breaks and consecutive whitespace to one space, then splits by grapheme: each fragment has at most 15 user-visible characters and also fits that platform's UTF-16 limit. Fragments are sent in order and start over after the last one; requests never overlap and their start times are at least 10 seconds apart. A single grapheme that cannot fit the platform limit is a validation error. Editing the text, changing rooms (which also clears the session text), leaving the page, closing the app, or any send failure immediately disables the session and reports the reason; a failed fragment is never retried automatically.

- **Bilibili:** requires a valid Cookie containing `SESSDATA` and `bili_jct`. It sends only ordinary scrolling white text; the backend validates the Cookie, room, control characters, the current official-web default of 20 UTF-16 code units, and a 3-second per-room cooldown. The official client receives that limit per account/server; rLive enforces the researched default until a supported policy-read contract exists. The Cookie-bearing request never follows redirects.
- **Douyu:** under **Settings → Account → 斗鱼**, use QR login or manually save a complete Cookie. The sender validates a numeric room ID, a non-empty single-line message, and a conservative three-second per-room cooldown. It uses the current web post-login encryption negotiation, stable device identity, shared proxy policy, and `chatres` / `error` parsing, and has successfully been verified in a personal room. A complete Cookie must include the required account, device, and danmaku-session fields; missing data is rejected rather than replaced with a random device ID or a normal JWT. Treat only `chatres(res=0)` plus a real room echo as success; see [Douyu platform API documentation](douyu-platform-api.md).
- **Huya:** under **Settings → Account → 虎牙**, manually save a Cookie with a numeric account ID (`yyuid` or `udb_uid`) and an opaque login proof (`udb_n` or `udb_cred`); QR login is not currently available. The sender validates the resolved room, a non-empty, single-line message of at most 30 UTF-16 code units, and a short local cooldown.

These three send paths use only device-local Cookies and do not state that a platform has granted rLive a public application write API. Cookies stay local and are not logged, exported, or uploaded to another service. All local results still need a real echo; Douyu additionally reports `chatres` as platform acceptance separately from local submission and room display. Verify only in an account and room where you are allowed to speak, and comply with current platform terms, moderation rules, and local law.

### Platform confirmation

A locally resolved send command does not add a synthetic row or floating message. The right-side list and floating layer show the message only after the normal room connection receives the platform's real echo, with its original platform appearance. Treat a timeout or failure according to the live platform's real state. Douyu distinguishes local submission, `chatres(res=0)`, and a real echo as separate stages and does not retry unknown delivery.

### Room-side settings

Open any room and select the **Settings** tab on the right; the tabs are ordered **Danmaku / SC / Follows / Settings**. Display values are saved locally and apply to later rooms; the auto-send control is the exception and belongs only to the current room session.

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
| Auto-send danmaku (Bilibili / Douyu / Huya) | Default-off, current-session-only text and switch; requires the shared send permission and current platform readiness, then sends validated 15-grapheme-or-less fragments every 10 seconds as described above |

Every display control applies live: sliders preview while dragged and persist on release, while toggles and font weight persist immediately. For busy rooms, chat and SC updates are batched per animation frame with bounded queues; inactive chat / SC tabs retain a bounded backlog without continuously reconciling hidden rows, so tab changes do not reset the lists. The canvas stops requesting frames while it has no active floating messages, then resumes for new messages, setting changes, or resizes to reduce CPU use; tracks are allocated from top to bottom. Douyu drops high-volume join packets and text-shaped `xxx entered the room` notices in Rust, while all sites consistently hide enter events in the frontend.

### Super Chat (SC)

Room side panel tab **SC** shows only Bilibili `super_chat` events. A compact paid-message card places the sender avatar, name, highlight duration, and amount in a light identity deck; the full message remains readable in the safely validated Bilibili tier-colour band below. Missing, blocked, or failed faces fall back to the sender initial, and the app does not fetch a user profile. Shield words apply to SC too; floating tracks emphasize it as a top-style message. Bilibili rooms without entries say that no Super Chats have arrived, while other platforms explicitly report that SC is not yet available.

Bilibili image emotes in normal chat are delivered with the message itself. rLive loads only validated Bilibili CDN image URLs and preserves the original text/image order in the side list and floating tracks. Floating danmaku retains the original text as a fallback while a CDN image is loading or unavailable.

## 6. IPTV

`/iptv` is a channel-discovery homepage. It reads IPTV-org's official daily-updated Chinese-language, mainland-China, East-Asian, and general public playlists, and deliberately does not mount a player or start a stream on entry. A custom HTTP(S) M3U URL is saved only under **Settings → Network**; once configured, the homepage shows it as **Custom source** rather than providing a free-form address field. The address remains device-local and is omitted from routes, history, and profile import/export. It avoids the provider's oversized global index so every built-in source stays within rLive's bounded playlist loader. Multi-keyword search ranks exact and prefix channel matches first, popular groups are immediately available, and long results are expanded in pages. Selecting a channel opens the separate immersive `/iptv/play` page; its Back control returns to the source, category, and search-filtered list. The localhost proxy rewrites nested HLS manifests, segments, and keys for HLS playback; MPEG-TS and FLV use the existing MSE path. rLive hosts no programme content, bypasses no region restriction, and does not guarantee any third-party source. Only load channels you are allowed to watch.

## 7. Follows & history

Follow anchors (with tags) from the room page; the centred selector on the Follows page filters by **All platforms** or one site, while its only status filters are **All / Live / Offline**. Its floating refresh button updates live status. The room-side **Follows** tab places live rooms first and switches directly to a selected followed room without leaving the room page; its Back action then returns home rather than a previous room. It also provides a floating refresh button. Visited rooms are stored in history.

## 8. Settings summary

Use the single sun / moon button above **设置** in the sidebar for the app theme; each click alternates between light and dark mode. At the top of **Settings → Account**, the default-off device-local **启用发送功能** switch jointly controls Bilibili, Douyu, and Huya sending; each platform still keeps its own Cookie and validation rules. Douyu's legacy sender has been replaced with the current web authentication/confirmation flow, and still requires real-service validation. The global settings page also contains default quality, HTTP proxy, a device-local custom IPTV M3U address, Bilibili/Douyin/Douyu QR/manual Cookie login, Huya manual Cookie input, and an About tab with the project GitHub link and disclaimer. Profiles exclude all cookies, the custom M3U URL, and the shared sending permission; importing never overwrites those local-only choices. Danmaku settings live in each room's **设置 (Settings)** tab rather than the global settings page. Windows release builds keep sanitized failure diagnostics in `%APPDATA%\rlive\logs\rlive.log`, rotating after 2 MiB; successful progress is not written, and neither are Cookie values, tokens, or outgoing chat text.

For Douyin, anonymous browsing creates a transient `ttwid` session automatically. A complete logged-in browser cookie, saved by QR login or manual input, is required for live search and is stored only in local SQLite; it does not grant a way to bypass browser verification or paginate the SSR list. The configured chat signer receives the effective connection session (the saved Cookie plus transient `ttwid` / `msToken`) only while it creates a signed WSS connection; transient values and the signer endpoint are never exported.

## 9. FAQ

| Issue | Hint |
|-------|------|
| Douyu `HandshakeFailure` | Upgrade to the `native-tls` build |
| Bilibili no chat | Valid cookie / token required for many rooms |
| Bilibili QR expires / does not finish | Refresh the QR, scan and confirm in the Bilibili app, or switch to manual Cookie input |
| Huya crash on open | Use build with UTF-8-safe HTML parse |
| Douyin search requests login or QR shows browser verification | Save a complete logged-in browser Cookie under Settings → Account → 抖音; check the explicit app proxy and retry QR, or copy the Cookie after completing verification in the official browser. First-page browse and playback do not require it. |
| Douyin chat cannot connect | Re-enter the room to refresh the local signature and web session. Check the Douyin Cookie under Settings → Account if you are logged in. Proxy, region, or platform risk controls can still block the connection. |
| Bilibili composer is disabled | At the top of Settings → Account, enable **启用发送功能**, then save a Cookie containing `SESSDATA` and `bili_jct` |
| Douyu composer is disabled or nothing appears after sending | Check the shared **启用发送功能** switch and the complete local login state, including account, stable-device, and danmaku-session fields. The sender distinguishes local submission, rejection, and unconfirmed delivery; only `chatres(res=0)` plus a real echo is success. Do not repeat an unknown send; see [Douyu platform API documentation](douyu-platform-api.md). |
| Douyu send needs diagnosis | Inspect only sanitised failure stage/error-code records in `%APPDATA%\rlive\logs\rlive.log`, use the platform's real echo as the result, and do not share Cookies, tokens, signatures, or chat text; see [Douyu platform API documentation](douyu-platform-api.md). |
| Huya composer is disabled | At the top of Settings → Account, enable **启用发送功能**, then under 虎牙 manually save a valid Cookie with `yyuid` or `udb_uid`, plus `udb_n` or `udb_cred` |
| Black screen | Try another line/quality; re-enter room |

## 10. Compliance

The app is primarily a read-only aggregator. Bilibili, Douyin, and Douyu QR/manual logins, plus Huya manual Cookie input, are user initiated and store Cookie data locally. With the shared local send switch enabled, Bilibili, Douyu, and Huya allow manual ordinary messages and a user-enabled, default-off room-session auto-send control. Douyu's legacy protocol has been replaced with the current web authentication/confirmation flow and successfully verified in a personal room; runtime sends still use platform-result and real-room-echo semantics. A local write result is not platform authorisation; the list and floating layer rely on the platform's real room echo. No Cookie-authenticated entry establishes a public platform API grant or guarantees delivery; users remain responsible for platform terms. There are no gifts, payments, batch sends, auto-replies, automatic retry of an unknown result, or recording. Personal / educational use; respect platform ToS and local law.
