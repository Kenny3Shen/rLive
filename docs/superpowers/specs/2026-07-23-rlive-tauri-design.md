# rLive Design: Tauri 2 + React Rewrite of Simple Live

**Date:** 2026-07-23  
**Status:** Approved for implementation planning  
**Workspace:** `/home/shenss/python/rLive`  
**Source reference:** [June6699/dart_simple_live](https://github.com/June6699/dart_simple_live) (fork of xiaoyaocz/dart_simple_live)

## 1. Goal

Rewrite the Simple Live desktop experience as a **Tauri 2 + React + TypeScript** application named **rLive**, with live-site parsing and danmaku in **Rust**, playback via **external mpv**, and a **desktop-first** UI (not a phone Flutter clone).

### 1.1 Phase-1 product scope (“主 App 桌面核心”)

**In scope**

- Desktop shell: Linux + Windows
- Sites: full Bilibili end-to-end first; other four sites (Huya, Douyu, Douyin, Kuaishou) after Bilibili closes the loop
- Browse: home/recommend, categories, search
- Room: detail, multi-quality play URLs, mpv playback, live danmaku display
- Local data: follows, tags, watch history
- Settings: player, danmaku, theme, proxy
- Cookie paste for sites that need it for read-only APIs (Bilibili first)
- Local profile export/import (non-sensitive fields)

**Out of scope (phase 1)**

- Android / iOS / Android TV / TV-Windows
- Multi-room / multi-window multi-instance
- Remote WebSocket sync, LAN sync, WebDAV
- Live subtitles (ASR)
- Offline cache / stream recording / batch download
- Sending danmaku, gifts, official account write operations, payments
- Console package as a required deliverable (optional later)

### 1.2 Success criteria (Definition of Done)

On **Linux and Windows**:

1. App launches with sidebar navigation and light/dark theme.
2. **Bilibili**: recommend/category lists, search, enter room, multi-quality mpv play, visible chat danmaku.
3. Follows, tags, and history persist across restarts.
4. Bilibili cookie can be configured for read-only endpoints that need it.
5. Profile export/import works for non-sensitive fields.
6. Other four sites: registered in `LiveSite` trait + UI entry points; implementations may be WIP.

## 2. Architecture

**Chosen approach: A — single Tauri monorepo** on the existing `rLive` scaffold. Keep clear Rust module boundaries (`sites/`, `danmaku/`, `player/`, `db/`, …) without extracting a separate crate in phase 1.

```
┌─────────────────────────────────────────────────────────┐
│  React (Vite)                                           │
│  Sidebar · lists/search · room · settings · Zustand     │
│         │ invoke / events                               │
├─────────▼───────────────────────────────────────────────┤
│  Tauri 2 commands + events                             │
│  site_* · follow_* · history_* · player_* · settings_*  │
├─────────▼───────────────────────────────────────────────┤
│  src-tauri (Rust modules)                               │
│  sites/  danmaku/  player(mpv)  db  settings  profile   │
└─────────┬───────────────────────────┬───────────────────┘
          │ HTTP/WS                   │ process/IPC
          ▼                           ▼
   Platform live APIs              mpv sidecar
```

### 2.1 Layer responsibilities

| Layer | Owns | Does not own |
|---|---|---|
| React | Layout, lists, settings forms, danmaku overlay UI, shortcuts | Site signing, cookie jar, play-URL resolution |
| Rust | `LiveSite` trait, Bilibili impl first, danmaku sockets, SQLite, cookies, profile I/O, mpv process control | Pixel UI |
| mpv | Decode/render | Business state |

### 2.2 Alternatives considered

| Option | Summary | Decision |
|---|---|---|
| A. Monolithic Tauri app | Fastest path on current scaffold | **Chosen** |
| B. Separate `rlive-core` crate first | Better CLI/test isolation; slower first UI | Deferred; may extract after Bilibili loop |
| C. Mirror Dart package layout 1:1 | Easy file mapping; fights desktop redesign | Rejected |

## 3. Modules and data model

### 3.1 Frontend (`src/`)

| Module | Responsibility |
|---|---|
| `app/` | Shell: sidebar, router, theme, toasts |
| `features/home` | Per-site recommend/hot lists |
| `features/category` | Category tree + room lists |
| `features/search` | Room/anchor search (Bilibili first) |
| `features/room` | Player region, quality picker, danmaku layer, follow |
| `features/follow` | Follow list, tag filter, live-status refresh |
| `features/history` | Watch history |
| `features/settings` | Player/danmaku/appearance/proxy/cookie/profile |
| `shared/` | Types, hooks, UI primitives |

**State:** Zustand slices for `player` / `follow` / `settings`. Server-driven lists use TanStack Query (or equivalent), not a global dump of all pages.

### 3.2 Backend (`src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `sites/traits` | `LiveSite` trait: categories, lists, search, room detail, play URLs |
| `sites/bilibili` | Phase-1 complete implementation |
| `sites/{huya,douyu,douyin,kuaishou}` | Stubs then full ports |
| `danmaku/` | Per-site protocols → unified `DanmakuEvent` → Tauri events |
| `player/` | Spawn/control mpv, load URL/headers, stop/cleanup |
| `db/` | SQLite: follows, tags, history |
| `settings/` | App settings + sensitive cookie storage policy |
| `profile/` | Import/export profile JSON |
| `commands/` | Thin Tauri command wrappers |

### 3.3 Domain models (Rust ↔ TypeScript mirrored)

Field shapes align with `simple_live_core` Dart models as the reference.

```text
SiteId          = "bilibili" | "huya" | "douyu" | "douyin" | "kuaishou"

LiveCategory    { id, name, children? }
LiveRoomItem    { site_id, room_id, title, cover, user_name, online, ... }
LiveRoomDetail  { room item fields, status, notice, user_avatar, ... }
LivePlayQuality { quality, urls: [PlayUrl] }  // PlayUrl: url + optional headers
DanmakuEvent    { kind: Chat|Gift|Enter|SuperChat|System, user, content, color?, ts }
FollowUser      { site_id, room_id, user_name, face, tag_ids, live_status?, ... }
History         { site_id, room_id, title, user_name, watched_at }
AppSettings     { theme, player, danmaku, proxy, ... }
```

### 3.4 Local storage

| Data | Storage |
|---|---|
| Follows / tags / history | SQLite under Tauri app data directory |
| Normal settings | JSON or SQLite `settings` table |
| Cookies / secrets | Separate store; **excluded** from default profile export |
| Profile package | User-chosen JSON path |

### 3.5 Desktop navigation

Desktop-first sidebar (not mobile bottom tabs):

```text
┌────────┬──────────────────────────────────────┐
│ Home   │  Content (lists / search / settings) │
│ Cats   │                                      │
│ Follow │  Room is a full-page route           │
│ History│                                      │
│ Settings│                                     │
└────────┴──────────────────────────────────────┘
```

Site switcher in content header. Non-implemented sites may show as disabled or “coming soon”.

## 4. Data flows

### 4.1 Browse → room

```text
Select site → site_get_categories / site_get_recommend / site_search
           → render LiveRoomItem cards
           → open /room/:site/:roomId
           → site_get_room_detail
           → site_get_play_urls
           → player_open(url, headers, …)
           → danmaku_connect(site, room)
           → history_add(...)
```

Partial failure: room metadata can show even if play URL fails; player region shows error + retry/quality switch.

### 4.2 Playback (mpv)

| UI action | Backend |
|---|---|
| Enter room | Spawn/attach mpv, load URL (+ headers/referer) |
| Change quality | Re-fetch URLs → `player_load`; keep danmaku connection |
| Pause/volume/fullscreen | Forward to mpv; prefer window-level fullscreen |
| Leave room / quit | `player_stop` + `danmaku_disconnect` |

**Embed policy (phase 1):** Prefer embedding mpv into a designated region (Linux `wid` / Windows equivalent). If embed is unstable on a platform, fall back to a borderless mpv window docked to the app, still behind the same `player_*` API.

**Distribution:** Prefer bundled mpv sidecar (Linux x64 + Windows x64); fall back to system `mpv` on PATH. Settings show active mpv path/version.

### 4.3 Danmaku

```text
Rust danmaku task --event "danmaku"--> frontend ring buffer
                                    --> render (CSS/Canvas)
                                    --> optional keyword filter
```

- Lifecycle tied to room: disconnect before reconnect on room change.
- Unknown message kinds: drop or debug-log.
- Frontend rate-limits under load (queue cap / drop oldest).
- Phase 1: keyword shield may run on the frontend to reduce IPC; can move to Rust later.

### 4.4 Follows and live status

```text
follow_add / remove / list / update_tags
follow_refresh → concurrent room status with timeout/rate limits
              → progress or final list payload
```

Bilibili implements real refresh first. Unimplemented sites show unknown status without blocking the follow list UI.

### 4.5 Settings, cookies, profile

```text
settings_set → persist → apply hot options (theme, danmaku size)
account_set_cookie(site, raw) → parse/store → attach on that site’s HTTP
profile_export(path) → JSON without cookies/secrets
profile_import(path) → merge follows/tags/history/shield words/settings
```

Profile field design should be **compatible in spirit** with Simple Live’s `simple_live_profile.json` where practical, without requiring bit-identical parity on day one. Document any intentional divergences in the profile module.

### 4.6 Errors

Unified error shape: `{ code, message, site?, retryable }`.  
UI: toast + section error states.  
Rust: `tracing` logs; optional “open log directory” in settings.  
Distinguish network vs parse failures.

## 5. Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (existing project) |
| Frontend | React 19 + TypeScript + Vite |
| Routing | React Router |
| State | Zustand + TanStack Query |
| UI | Tailwind + lightweight primitives (shadcn-style acceptable) |
| HTTP | `reqwest` + cookie store |
| Async | `tokio` |
| DB | SQLite via `rusqlite` or `sqlx` |
| Serde | `serde` / `serde_json` |
| Player | mpv sidecar / system mpv |
| JS package manager | bun (matches current `tauri.conf.json`) |

## 6. Compliance boundary

Aligned with upstream “do not touch account money / write ops” spirit:

- Read-only aggregation: lists, play, receive danmaku.
- No sending chat, gifts, official OAuth write flows, payments, recording/download of streams.
- Cookies only via user paste for read-only improvement.
- README must state educational use; not an official client.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Platform API churn | Isolate per-site modules; fix without cross-site breakage |
| Douyin signing/cookie complexity | Defer full Douyin until after Bilibili loop |
| mpv embed differences | Shared `player_*` API; independent-window fallback |
| Danmaku protocol complexity | Port against `simple_live_core`; prioritize Chat events |
| Scope creep | Hard phase-1 cuts (no TV/sync/multi-room) |
| Legal/ToS gray area | Clear disclaimer; no monetization features |

## 8. Implementation order

1. App shell: sidebar, router, theme, settings store skeleton  
2. SQLite + follow/history/settings persistence  
3. `LiveSite` trait + Bilibili: categories, recommend, search, room detail, play URLs  
4. mpv player integration  
5. Bilibili danmaku → UI overlay  
6. Follow/tags/history UX + live refresh (Bilibili)  
7. Cookie + profile import/export  
8. Port remaining sites one by one (suggested: Huya → Douyu → Kuaishou → Douyin)

## 9. Testing strategy

| Layer | Focus |
|---|---|
| Rust unit | URL/model parse helpers, profile merge, shield words |
| Rust integration (optional) | Live network smoke tests `#[ignore]` by default |
| Frontend | Components + stores with mocked `invoke` |
| Manual | Bilibili: list → room → play → danmaku → follow → restart |

## 10. Documentation and naming

- Product name: **rLive** (`com.shenss.rlive`)
- Design doc path: `docs/superpowers/specs/2026-07-23-rlive-tauri-design.md`
- Implementation plan: to be written via writing-plans after this spec is accepted on disk
- README should credit Simple Live / upstream ideas and state this is an independent rewrite

## 11. Explicit non-goals reminder

Do not implement in phase 1: TV apps, multi-room, remote/LAN/WebDAV sync, subtitles, recording, send-danmaku, full five-site parity before Bilibili is solid.
