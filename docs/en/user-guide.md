# rLive User Guide

Chinese is the primary UI language. This English guide mirrors [用户指南](../zh/用户指南.md).

## 1. Overview

rLive is a desktop live-stream aggregator for browsing, searching, and watching multi-platform streams with danmaku (chat). Inspired by Simple Live; not an official client.

| Site | Lists / search | Playback | Danmaku |
|------|----------------|----------|---------|
| Bilibili | Yes | Yes | Yes (cookie recommended) |
| Huya | Yes | Yes | Yes |
| Douyu | Yes | Yes | Yes |
| Douyin | First-page recommendations/categories; search needs a logged-in cookie | Yes | Not yet supported |
| Kuaishou | Stub | Stub | Stub |

Douyin's public server-rendered list is currently reliable only for its first page. rLive deliberately does not offer fake pagination that would repeat rooms. Live search becomes available after you save a complete logged-in browser cookie.

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
| Header | Site switcher, search (user / room ID / title) |
| Room | Player, refresh / play, quality / line, chat / SC / danmaku settings / follows side tabs |

## 4. Watching

1. Pick a site in the header.  
2. Selecting a category opens its own room-list page; search can target **all**, **user**, **room ID**, or **title**.
3. The refresh control sits left of pause and refreshes stream metadata before rebuilding the playback session.
4. **Quality** and **line** are separate selectors on the right; the volume icon opens a vertical slider.
5. The right sidebar, floating danmaku, and fullscreen use compact icon controls. Reopening the sidebar preserves chat and SC lists.
6. Default quality preference: **Settings → Playback**.
7. Back from a room always returns to home instead of the previously switched room.
8. Douyin supports anonymous first-page browse and playback; search requires a saved logged-in browser cookie.

Streams are fetched via a localhost proxy so the web player can attach with correct headers.

## 5. Danmaku

### Connection

Entering a Bilibili, Huya, or Douyu room connects that site's danmaku WebSocket. Chat appears in the side list; optional floating tracks overlay the video.

- **Bilibili:** paste a browser cookie under Settings → 哔哩哔哩 Cookie.  
- **Huya / Douyu:** usually no cookie. Douyu uses system TLS (`native-tls`) because its servers only offer RSA-AES-GCM suites.
- **Douyin / Kuaishou:** the room explicitly reports that real-time danmaku is not supported instead of repeatedly attempting a failed connection. Douyin browsing and playback remain available.

### Room-side settings

Open any room and select the **弹幕设置** tab on the right. Values are saved locally and apply to later rooms too.

| Control | Effect |
|---------|--------|
| Display area | Portion of video height used by floating tracks (10%–100%) |
| Visible lines | Automatic lanes, or a fixed 1–20 lane cap |
| Opacity | Floating text alpha (live preview on drag) |
| Font size / weight | Canvas + list base size; weight improves readability over bright video |
| Speed | Scroll speed (logical 1–10) |
| Repeat filter | Hides consecutive identical chat lines from one user within 5 seconds |
| Gift filter | Hides gift notices from Douyu and similar sites without affecting SC |
| Shield words | One word per line; filtering applies while typing, shared by chat, SC, and canvas, and auto-saves |

Every display control applies live: sliders preview while dragged and persist on release, while toggles and font weight persist immediately. For busy rooms, chat and SC updates are batched per animation frame with bounded queues; inactive chat / SC tabs retain a bounded backlog without continuously reconciling hidden rows, so tab changes do not reset the lists. The canvas stops requesting frames while it has no active floating messages, then resumes for new messages, setting changes, or resizes to reduce CPU use; tracks are allocated from top to bottom. Douyu drops high-volume join packets and text-shaped `xxx entered the room` notices in Rust, while all sites consistently hide enter events in the frontend.

### Super Chat (SC)

Room side panel tab **SC** shows only Bilibili `super_chat` events. When the platform provides them, cards show the amount, currency, highlight duration, and safely validated colour gradient. Shield words apply to SC too; floating tracks emphasize it as a top-style message.

## 6. Follows & history

Follow anchors (with tags) from the room page; refresh live status on the follow list. The room-side **关注** tab places live rooms first and switches directly to a selected followed room without leaving the room page. Visited rooms are stored in history.

## 7. Settings summary

Theme, default quality, HTTP proxy, Bilibili cookie, optional Douyin cookie, profile import/export (**cookies excluded**). Danmaku settings live in each room's **弹幕设置** tab rather than the global settings page.

For Douyin, anonymous browsing creates a transient `ttwid` session automatically. A complete logged-in browser cookie is required for live search and can improve room parsing; it is stored only in local SQLite.

## 8. FAQ

| Issue | Hint |
|-------|------|
| Douyu `HandshakeFailure` | Upgrade to the `native-tls` build |
| Bilibili no chat | Valid cookie / token required for many rooms |
| Huya crash on open | Use build with UTF-8-safe HTML parse |
| Douyin search requests login | Save a complete logged-in browser cookie under 设置 → 抖音 Cookie; first-page browse and playback do not require it |
| Douyin has no chat | Real-time Douyin danmaku is not implemented yet; this does not prevent browsing or playback |
| Black screen | Try another line/quality; re-enter room |

## 9. Compliance

Read-only aggregation only. No send-chat, gifts, payments, recording, or official login write flows. Personal / educational use; respect platform ToS and local law.
