# rLive User Guide

Chinese is the primary UI language. This English guide mirrors [用户指南](../zh/用户指南.md).

## 1. Overview

rLive is a desktop live-stream aggregator for browsing, searching, and watching multi-platform streams with danmaku (chat). Inspired by Simple Live; not an official client.

| Site | Lists / search | Playback | Danmaku |
|------|----------------|----------|---------|
| Bilibili | Yes | Yes | Yes (cookie recommended; single-message sending is opt-in) |
| Huya | Yes | Yes | Yes |
| Douyu | Yes | Yes | Yes |
| Douyin | First-page recommendations/categories; search needs a logged-in cookie | Yes | Yes (requires a signing service) |
| Kuaishou | Recommendations / categories / game-category search | Yes | Not yet supported |

Douyin's public server-rendered list is currently reliable only for its first page. rLive deliberately does not offer fake pagination that would repeat rooms. Live search becomes available after you save a complete logged-in browser cookie.

Douyin's WSS endpoint requires a short-lived signed URL. rLive does not ship a reverse-engineered signer; configure the full endpoint of a service you operate or trust under **Settings → Account**. To protect the saved Cookie, the endpoint must be HTTPS or loopback HTTP. See [signing-service integration](douyin-danmaku-signing-service.md).

Kuaishou uses public recommendation/category data and the room's initial state. Search intentionally matches game-category names only and returns that category's rooms; no match produces an empty list rather than pretending to search creators. The first version prefers H.264 playback URLs and has no real-time danmaku.

## 2. Install & run

### Windows

Use `D:\dev\rLive\src-tauri\target\release\rlive.exe` or build with `scripts\build-windows.ps1`.  
**No mpv required** — playback is Web MSE (`mpegts.js` + local proxy).

### From source

See root `README.md`: `bun install` → `bun run tauri dev`.

## 3. UI map

| Area | Role |
|------|------|
| Sidebar | Home, follows, categories, history, settings |
| Header | Site switcher, search (user / room ID / title); platform changes use a short content transition; the Follows page uses the same centred selector with an extra All platforms option |
| Room | Icon-only Back control, room title, player, host information, and side tabs in the order Danmaku / SC / Follows / Settings |

## 4. Watching

1. A first launch opens Bilibili by default; pick another site in the header when needed.
2. Selecting a category opens its own room-list page; search can target **all**, **user**, **room ID**, or **title**.
3. The room header has an icon-only Back control on the left and keeps the title centred. It returns to the source page for in-app navigation, or Home for a directly opened room URL. The side-header shows the host avatar, name, platform, and current heat.
4. The player controls are a transparent overlay at the bottom of the video. They hide after a short idle period during playback and reappear on pointer, click, or keyboard activity. They remain visible while a volume, quality, or line menu is open; with the picture focused, `Space` / `K` play or pause, `M` mutes, and `F` toggles fullscreen.
5. The refresh control sits left of pause and refreshes stream metadata before rebuilding the playback session; the volume icon opens a vertical slider.
6. **Quality** and **line** are separate selectors on the right and show only the active selection.
7. The right sidebar, floating danmaku, and fullscreen use compact icon controls. Reopening the sidebar preserves chat and SC lists.
8. Default quality preference: **Settings → Playback**.
9. Douyin supports anonymous first-page browse and playback; search requires a saved logged-in browser cookie. For live chat, configure a signing-service endpoint as well; it decodes normal/emoji chat, gifts, likes, entries, and common social notices. Kuaishou supports recommendations, categories, game categories, rooms, and playback; its search is limited to game-category names.

Streams are fetched via a localhost proxy so the web player can attach with correct headers.

## 5. Danmaku

### Connection

Entering a Bilibili, Huya, Douyu, or properly configured Douyin room connects that site's danmaku WebSocket. Chat appears in the side list; optional floating tracks overlay the video.

- **Bilibili:** paste a browser cookie under Settings → 哔哩哔哩 Cookie. After an unexpected disconnect, rLive rotates gateways, refreshes the short-lived token, and reconnects; progress appears as a system message.
- **Huya / Douyu:** usually no cookie. Douyu uses system TLS (`native-tls`) because its servers only offer RSA-AES-GCM suites.
- **Douyin:** configure a full signing endpoint under Settings → Account for live chat. rLive supplies the transient session established while entering the room; a complete saved Cookie is still required for search and can improve room/signing reliability. The service returns a temporary WSS URL; use only an endpoint you operate or explicitly trust.
- **Kuaishou:** the room explicitly reports that real-time danmaku is not supported instead of repeatedly attempting a failed connection.

### Experimental Bilibili sending

This is off by default. The room-side composer only enables when all of the following are true: the user explicitly enabled **实验性：发送 B 站弹幕**, the saved Bilibili Cookie includes `SESSDATA` and `bili_jct`, and the current room is Bilibili.

It can send only one normal scrolling text message at a time. Every message receives a second confirmation; the backend validates text/room/Cookie, enforces an 80-character limit and a 3-second room cooldown, and never batch-sends, auto-retries, inserts an optimistic local message, or sends gifts.

### Room-side settings

Open any room and select the **Settings** tab on the right; the tabs are ordered **Danmaku / SC / Follows / Settings**. Values are saved locally and apply to later rooms too.

| Control | Effect |
|---------|--------|
| Display area | Portion of video height used by floating tracks (10%–100%) |
| Visible lines | Automatic lanes, or a fixed 1–20 lane cap |
| Opacity | Floating text alpha (live preview on drag) |
| Font size / weight | Canvas + list base size; weight improves readability over bright video |
| Speed | Scroll speed (logical 1–10) |
| Same-content grouping | Combines matching normal-chat content from every sender for 5 seconds and shows a count, such as `加油 ×100` |
| Gift filter | Hides gift notices from Douyu and similar sites without affecting SC |
| Shield words | One word per line; filtering applies while typing, shared by chat, SC, and canvas, and auto-saves |

Every display control applies live: sliders preview while dragged and persist on release, while toggles and font weight persist immediately. For busy rooms, chat and SC updates are batched per animation frame with bounded queues; inactive chat / SC tabs retain a bounded backlog without continuously reconciling hidden rows, so tab changes do not reset the lists. The canvas stops requesting frames while it has no active floating messages, then resumes for new messages, setting changes, or resizes to reduce CPU use; tracks are allocated from top to bottom. Douyu drops high-volume join packets and text-shaped `xxx entered the room` notices in Rust, while all sites consistently hide enter events in the frontend.

### Super Chat (SC)

Room side panel tab **SC** shows only Bilibili `super_chat` events. It uses compact neutral cards with no full-card border, colour treatment, or left stripe; the safely validated Bilibili amount-tier colour appears on the sender-label background, while amount, currency, and highlight duration remain visible. Shield words apply to SC too; floating tracks emphasize it as a top-style message.

Bilibili image emotes in normal chat are delivered with the message itself. rLive loads only validated Bilibili CDN image URLs and preserves the original text/image order in the side list and floating tracks. Floating danmaku retains the original text as a fallback while a CDN image is loading or unavailable.

## 6. Follows & history

Follow anchors (with tags) from the room page; the centred selector on the Follows page filters by **All platforms** or one site, while its only status filters are **All / Live / Offline**. Its floating refresh button updates live status. The room-side **Follows** tab places live rooms first and switches directly to a selected followed room without leaving the room page; its Back action then returns home rather than a previous room. It also provides a floating refresh button. Visited rooms are stored in history.

## 7. Settings summary

Use the single sun / moon button above **设置** in the sidebar for the app theme; each click alternates between light and dark mode. The global settings page contains default quality, HTTP proxy, Bilibili cookie + experimental sending opt-in, optional Douyin cookie + signing endpoint, and profile import/export. Profiles exclude cookies, the Douyin signing-service endpoint, and the experimental Bilibili sending opt-in; importing never overwrites the latter two local-only choices. Danmaku settings live in each room's **设置 (Settings)** tab rather than the global settings page.

For Douyin, anonymous browsing creates a transient `ttwid` session automatically. A complete logged-in browser cookie is required for live search and can improve room parsing; it is stored only in local SQLite. The configured chat signer receives the effective connection session (the saved Cookie plus transient `ttwid` / `msToken`) only while it creates a signed WSS connection; transient values are never persisted.

## 8. FAQ

| Issue | Hint |
|-------|------|
| Douyu `HandshakeFailure` | Upgrade to the `native-tls` build |
| Bilibili no chat | Valid cookie / token required for many rooms |
| Huya crash on open | Use build with UTF-8-safe HTML parse |
| Douyin search requests login | Save a complete logged-in browser cookie under 设置 → 抖音 Cookie; first-page browse and playback do not require it |
| Douyin chat asks for a signer | Configure a full trusted signing-service endpoint under Settings → Account; rLive does not embed a signing algorithm |
| Bilibili composer is disabled | Enable the experimental setting and save a Cookie containing `SESSDATA` and `bili_jct` |
| Black screen | Try another line/quality; re-enter room |

## 9. Compliance

The app is primarily a read-only aggregator. Its Bilibili experiment allows only a user-confirmed single text message; there are no gifts, payments, batch/scheduled/automatic sends, recording, or official-login write flows. Personal / educational use; respect platform ToS and local law.
