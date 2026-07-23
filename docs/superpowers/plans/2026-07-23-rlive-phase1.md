# rLive Phase-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Linux + Windows Tauri 2 desktop client that can browse Bilibili live, play via mpv, show danmaku, and persist follows/history/settings — with site trait stubs for the other four platforms.

**Architecture:** Single monorepo on existing `rLive` scaffold. React owns desktop UI; Rust owns `LiveSite` parsing, danmaku sockets, SQLite, cookies, profile I/O, and mpv process control. Frontend talks only through Tauri commands/events.

**Tech Stack:** Tauri 2, React 19, TypeScript, Vite, bun, React Router, Zustand, TanStack Query, Tailwind CSS, Rust (`reqwest`, `tokio`, `rusqlite`, `serde`, `tracing`, `tokio-tungstenite`), external mpv.

**Spec:** `docs/superpowers/specs/2026-07-23-rlive-tauri-design.md`

## Global Constraints

- Product id: `com.shenss.rlive`; name **rLive**
- Targets: Linux + Windows only (phase 1)
- Sites order: **Bilibili full loop first**; Huya/Douyu/Douyin/Kuaishou trait stubs then ports
- Playback: external **mpv** (sidecar preferred, PATH fallback)
- Core logic in **Rust**, not TypeScript
- UI: **desktop-first** sidebar (not mobile bottom tabs)
- Read-only aggregation only: no send-danmaku, gifts, payments, recording
- Cookies excluded from default profile export
- Out of scope: TV, multi-room, remote/LAN/WebDAV sync, subtitles
- Package manager: **bun** for frontend; **cargo** for Rust
- DB choice locked: **rusqlite** (sync, `Mutex` behind Tauri state)
- Upstream API reference: [June6699/dart_simple_live](https://github.com/June6699/dart_simple_live) `simple_live_core` — port behavior, do not copy license-incompatible assets blindly
- TDD: unit-test pure Rust logic; mark live network tests `#[ignore]`
- Commit after each task

---

## File map (target)

```text
src/
  main.tsx
  app/
    App.tsx                 # router + providers
    layout/Shell.tsx        # sidebar + outlet
    layout/Sidebar.tsx
    theme.ts
  features/
    home/HomePage.tsx
    category/CategoryPage.tsx
    search/SearchPage.tsx
    room/RoomPage.tsx
    room/DanmakuLayer.tsx
    room/PlayerPane.tsx
    follow/FollowPage.tsx
    history/HistoryPage.tsx
    settings/SettingsPage.tsx
  shared/
    types/live.ts
    api/tauri.ts
    stores/settingsStore.ts
    stores/playerStore.ts
    components/RoomCard.tsx
    components/SiteSwitcher.tsx
    components/ErrorState.tsx
  styles.css                # Tailwind entry
src-tauri/src/
  lib.rs
  error.rs
  state.rs
  models/mod.rs
  models/live.rs
  models/settings.rs
  models/profile.rs
  db/mod.rs
  db/schema.rs
  db/follow.rs
  db/history.rs
  settings/mod.rs
  account/mod.rs
  profile/mod.rs
  sites/mod.rs
  sites/traits.rs
  sites/registry.rs
  sites/bilibili/mod.rs
  sites/bilibili/api.rs
  sites/huya.rs             # stub
  sites/douyu.rs            # stub
  sites/douyin.rs           # stub
  sites/kuaishou.rs         # stub
  danmaku/mod.rs
  danmaku/bilibili.rs
  player/mod.rs
  commands/mod.rs
  commands/site.rs
  commands/follow.rs
  commands/history.rs
  commands/player.rs
  commands/settings.rs
  commands/account.rs
  commands/profile.rs
src-tauri/tests/            # integration / unit-adjacent
```

---

### Task 1: Frontend toolchain + desktop shell

**Files:**
- Create: `src/styles.css`, `src/app/App.tsx`, `src/app/layout/Shell.tsx`, `src/app/layout/Sidebar.tsx`, `src/app/theme.ts`, `src/features/home/HomePage.tsx`, `src/features/category/CategoryPage.tsx`, `src/features/search/SearchPage.tsx`, `src/features/follow/FollowPage.tsx`, `src/features/history/HistoryPage.tsx`, `src/features/settings/SettingsPage.tsx`, `src/features/room/RoomPage.tsx` (placeholder), `tailwind.config.js`, `postcss.config.js`
- Modify: `package.json`, `src/main.tsx`, `index.html`, `vite.config.ts` (if needed)
- Delete/replace: `src/App.tsx`, `src/App.css` (template greet UI)

**Interfaces:**
- Consumes: none
- Produces: routes `/`, `/category`, `/search`, `/follow`, `/history`, `/settings`, `/room/:siteId/:roomId`; theme class on `<html>`

- [ ] **Step 1: Install frontend deps**

```bash
cd /home/shenss/python/rLive
bun add react-router-dom @tanstack/react-query zustand clsx
bun add -d tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Configure Tailwind v4 via Vite plugin**

`vite.config.ts` — ensure `@tailwindcss/vite` is registered:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
```

`src/styles.css`:

```css
@import "tailwindcss";

:root {
  color-scheme: light dark;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  @apply bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100;
}
```

- [ ] **Step 3: Theme helper + settings store skeleton**

`src/shared/stores/settingsStore.ts`:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "system" | "light" | "dark";

type SettingsState = {
  theme: ThemeMode;
  siteId: string;
  setTheme: (theme: ThemeMode) => void;
  setSiteId: (siteId: string) => void;
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      siteId: "bilibili",
      setTheme: (theme) => set({ theme }),
      setSiteId: (siteId) => set({ siteId }),
    }),
    { name: "rlive-settings" },
  ),
);
```

`src/app/theme.ts`:

```ts
import type { ThemeMode } from "../shared/stores/settingsStore";

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
}
```

- [ ] **Step 4: Shell + routes**

`src/app/layout/Sidebar.tsx` — nav links: Home, Category, Search, Follow, History, Settings (use `NavLink` + Tailwind active styles).

`src/app/layout/Shell.tsx`:

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function Shell() {
  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}
```

`src/app/App.tsx` — `BrowserRouter` + routes listed above; placeholder page bodies with page titles only.

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { applyTheme } from "./app/theme";
import { useSettingsStore } from "./shared/stores/settingsStore";
import "./styles.css";

const queryClient = new QueryClient();
applyTheme(useSettingsStore.getState().theme);
useSettingsStore.subscribe((s) => applyTheme(s.theme));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 5: Verify UI shell**

```bash
bun run dev
```

Expected: browser/Vite serves app; sidebar navigates between placeholder pages; theme toggle on Settings page flips `dark` class.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock vite.config.ts src index.html
git commit -m "feat(ui): add desktop shell, router, and Tailwind"
```

---

### Task 2: Shared TS types + Tauri API wrapper + AppError contract

**Files:**
- Create: `src/shared/types/live.ts`, `src/shared/types/error.ts`, `src/shared/api/tauri.ts`
- Create: `src-tauri/src/error.rs`, `src-tauri/src/models/mod.rs`, `src-tauri/src/models/live.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: none
- Produces:
  - Rust `AppError { code, message, site, retryable }` with `Serialize` + `From` for common errors
  - TS `SiteId`, `LiveRoomItem`, `LiveRoomDetail`, `LivePlayQuality`, `PlayUrl`, `DanmakuEvent`, `FollowUser`, `HistoryItem`, `AppSettings`
  - `invokeCmd<T>(cmd, args?)` wrapper that surfaces `AppError`

- [ ] **Step 1: Write Rust models + error**

`src-tauri/src/error.rs`:

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub site: Option<String>,
    pub retryable: bool,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            site: None,
            retryable: false,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_site(mut self, site: impl Into<String>) -> Self {
        self.site = Some(site.into());
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;
```

`src-tauri/src/models/live.rs` — define serde structs matching:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteId {
    Bilibili,
    Huya,
    Douyu,
    Douyin,
    Kuaishou,
}

impl SiteId {
    pub fn as_str(&self) -> &'static str {
        match self {
            SiteId::Bilibili => "bilibili",
            SiteId::Huya => "huya",
            SiteId::Douyu => "douyu",
            SiteId::Douyin => "douyin",
            SiteId::Kuaishou => "kuaishou",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveCategory {
    pub id: String,
    pub name: String,
    pub children: Vec<LiveSubCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveSubCategory {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub pic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveRoomItem {
    pub site_id: SiteId,
    pub room_id: String,
    pub title: String,
    pub cover: String,
    pub user_name: String,
    pub online: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveRoomDetail {
    pub site_id: SiteId,
    pub room_id: String,
    pub title: String,
    pub cover: String,
    pub user_name: String,
    pub user_avatar: String,
    pub online: i64,
    pub status: bool,
    pub notice: String,
    pub url: String,
    /// Opaque site-specific payload needed for play-url requests (JSON string ok).
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayUrl {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePlayQuality {
    pub quality: String,
    /// Data needed later for get_play_urls (site-specific); also list of ready urls if known.
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomListPage {
    pub has_more: bool,
    pub items: Vec<LiveRoomItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DanmakuKind {
    Chat,
    Gift,
    Enter,
    SuperChat,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanmakuEvent {
    pub kind: DanmakuKind,
    pub user: String,
    pub content: String,
    pub color: Option<String>,
    pub ts: i64,
}
```

- [ ] **Step 2: Unit test SiteId + error serde**

Create `src-tauri/src/models/live.rs` tests (or `src-tauri/tests/models_test.rs`):

```rust
#[test]
fn site_id_serializes_snake() {
    let s = serde_json::to_string(&SiteId::Bilibili).unwrap();
    assert_eq!(s, "\"bilibili\"");
}
```

Run:

```bash
cd src-tauri && cargo test site_id_serializes_snake -q
```

Expected: PASS

- [ ] **Step 3: Mirror types in TS + invoke wrapper**

`src/shared/types/live.ts` — mirror the Rust shapes using `site_id: 'bilibili' | ...` string unions (serde snake_case enum values).

`src/shared/api/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "../types/error";

export async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as AppError | string;
    if (typeof err === "object" && err && "code" in err) throw err;
    throw { code: "invoke_failed", message: String(e), site: null, retryable: true } satisfies AppError;
  }
}
```

- [ ] **Step 4: Wire modules in `lib.rs` (no new commands yet)**

```rust
mod error;
mod models;
```

- [ ] **Step 5: Commit**

```bash
git add src/shared src-tauri/src
git commit -m "feat: add shared live models and AppError contract"
```

---

### Task 3: App state, SQLite schema, follow/history repositories

**Files:**
- Create: `src-tauri/src/state.rs`, `src-tauri/src/db/mod.rs`, `src-tauri/src/db/schema.rs`, `src-tauri/src/db/follow.rs`, `src-tauri/src/db/history.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `models::live::{SiteId, Follow-related shapes}`
- Produces:
  - `AppState { db: Mutex<Connection>, ... }`
  - `Db::open(path) -> AppResult<Connection>`
  - `follow::{list, upsert, remove, set_tags, list_tags, upsert_tag}`
  - `history::{list, upsert, clear}`

- [ ] **Step 1: Add deps**

`Cargo.toml` dependencies:

```toml
rusqlite = { version = "0.32", features = ["bundled"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
dirs = "6"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "process"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "cookies", "rustls-tls", "gzip", "brotli"] }
url = "2"
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: Schema + migrations**

`db/schema.rs` SQL:

```sql
CREATE TABLE IF NOT EXISTS follows (
  site_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  face TEXT NOT NULL DEFAULT '',
  tag_ids TEXT NOT NULL DEFAULT '[]',
  live_status INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS history (
  site_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  user_name TEXT NOT NULL,
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);

CREATE TABLE IF NOT EXISTS settings_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cookies (
  site_id TEXT PRIMARY KEY,
  cookie TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Open DB under `dirs::data_dir()/rlive/rlive.db` (fallback `./rlive.db` in tests).

- [ ] **Step 3: Failing tests for follow upsert/list**

In `src-tauri/src/db/follow.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    #[test]
    fn upsert_and_list_follow() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, FollowRecord {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "u".into(),
            face: "".into(),
            tag_ids: vec![],
            live_status: None,
            updated_at: 1,
        }).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].room_id, "1");
    }
}
```

Run `cargo test upsert_and_list_follow` — fail until implemented.

- [ ] **Step 4: Implement follow/history repos + `AppState`**

`history::upsert` replaces row and keeps latest `watched_at`. `list` orders by `watched_at DESC` limit 200.

- [ ] **Step 5: Init DB in `lib.rs` setup hook**

```rust
.setup(|app| {
    let state = AppState::init()?;
    app.manage(state);
    Ok(())
})
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri
git commit -m "feat(db): sqlite schema for follows, history, settings, cookies"
```

---

### Task 4: Settings + cookie storage commands

**Files:**
- Create: `src-tauri/src/models/settings.rs`, `src-tauri/src/settings/mod.rs`, `src-tauri/src/account/mod.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/commands/account.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `lib.rs`, `src/features/settings/SettingsPage.tsx`, `src/shared/stores/settingsStore.ts`

**Interfaces:**
- Consumes: `db::settings_kv`, `db::cookies`
- Produces commands:
  - `settings_get() -> AppSettings`
  - `settings_set(settings: AppSettings) -> ()`
  - `account_get_cookie(site_id: SiteId) -> Option<String>`
  - `account_set_cookie(site_id: SiteId, cookie: String) -> ()`
  - `account_clear_cookie(site_id: SiteId) -> ()`

`AppSettings` fields (minimum):

```rust
pub struct AppSettings {
    pub theme: String,              // system|light|dark
    pub default_site: String,
    pub proxy: Option<String>,      // e.g. http://127.0.0.1:7890
    pub danmaku_opacity: f32,       // 0..1
    pub danmaku_font_size: u32,
    pub danmaku_speed: u32,
    pub danmaku_shield_words: Vec<String>,
    pub mpv_path: Option<String>,
}
```

Defaults: theme=system, default_site=bilibili, opacity=1.0, font=18, speed=8, empty shields.

- [ ] **Step 1: Unit test defaults + roundtrip JSON**

```rust
#[test]
fn settings_default_roundtrip() {
    let s = AppSettings::default();
    let v = serde_json::to_string(&s).unwrap();
    let back: AppSettings = serde_json::from_str(&v).unwrap();
    assert_eq!(back.default_site, "bilibili");
}
```

- [ ] **Step 2: Implement persistence in `settings_kv` key `app_settings`**

- [ ] **Step 3: Cookie store in `cookies` table; never log full cookie**

- [ ] **Step 4: Wire Settings page**

- Theme select bound to store + `settings_set`
- Bilibili cookie textarea + Save
- Proxy input

- [ ] **Step 5: Manual check**

```bash
bun run tauri dev
```

Set theme + cookie, restart app, values still present (cookie from Rust; theme may dual-write localStorage + backend — prefer backend as source of truth after load).

- [ ] **Step 6: Commit**

```bash
git commit -am "feat: settings and cookie commands with settings UI"
```

---

### Task 5: `LiveSite` trait, registry, and stub sites

**Files:**
- Create: `src-tauri/src/sites/traits.rs`, `sites/registry.rs`, `sites/mod.rs`, `sites/bilibili/mod.rs` (empty impl returning errors), `sites/huya.rs`, `sites/douyu.rs`, `sites/douyin.rs`, `sites/kuaishou.rs`
- Create: `src-tauri/src/commands/site.rs`

**Interfaces:**
- Consumes: `models::live::*`, `AppError`
- Produces:

```rust
#[async_trait::async_trait]
pub trait LiveSite: Send + Sync {
    fn id(&self) -> SiteId;
    fn name(&self) -> &'static str;
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>>;
    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage>;
    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage>;
    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage>;
    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail>;
    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>>;
    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>>;
    async fn get_live_status(&self, room_id: &str) -> AppResult<bool>;
}
```

Registry: `fn site(id: &SiteId) -> AppResult<&'static dyn LiveSite>` or `Arc` map on `AppState`.

Commands:

- `site_list() -> Vec<{id,name,ready:bool}>`
- `site_get_categories(site_id)`
- `site_get_recommend(site_id, page)`
- `site_get_category_rooms(site_id, category, page)`
- `site_search_rooms(site_id, keyword, page)`
- `site_get_room_detail(site_id, room_id)`
- `site_get_play_qualities(site_id, detail)`
- `site_get_play_urls(site_id, detail, quality)`

Stub sites return `AppError::new("not_implemented", ...)` with `retryable: false`.

Bilibili module for this task may still return `not_implemented` — real HTTP is Task 6.

- [ ] **Step 1: Add `async-trait` dependency**

- [ ] **Step 2: Implement trait + registry unit test**

```rust
#[test]
fn registry_has_five_sites() {
    assert_eq!(registry::all().len(), 5);
}
```

- [ ] **Step 3: Register commands in `lib.rs`**

- [ ] **Step 4: Frontend `SiteSwitcher` + call `site_list`**

Show five sites; mark `ready` only for bilibili once Task 6 lands (for now all false or bilibili true after Task 6).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sites): LiveSite trait, registry, and Tauri site commands"
```

---

### Task 6: Bilibili HTTP client — categories, recommend, search, detail, play URLs

**Files:**
- Create/Modify: `src-tauri/src/sites/bilibili/mod.rs`, `api.rs`, shared HTTP helper if needed (`src-tauri/src/http_client.rs`)
- Reference (read-only): upstream `simple_live_core/lib/src/bilibili_site.dart`

**Interfaces:**
- Consumes: cookie from `account` table via `AppState` or injected `BilibiliSite { cookie, client }`
- Produces: working Bilibili `LiveSite` impl for list/search/detail/qualities/urls

**Port these endpoints from upstream (verify if API drifts):**

| Method | Endpoint idea |
|---|---|
| headers | UA + `https://live.bilibili.com/` referer + cookie/buvid |
| categories | `GET https://api.live.bilibili.com/room/v1/Area/getList` |
| category rooms | `GET .../room/v1/Area/getRoomList` |
| recommend | `GET https://api.live.bilibili.com/xlive/web-interface/v1/second/getList` or upstream equivalent for recommend |
| search rooms | upstream `searchRooms` URL in dart file |
| room detail | room init/info APIs used in dart `getRoomDetail` |
| play info | playurl API used in dart `_getRoomPlayInfo` / `getPlayQualites` / `getPlayUrls` |

Implementation notes:

1. Create `reqwest::Client` with rustls, gzip, cookie jar optional.
2. `get_buvid` if no user cookie (upstream `getBuvid`).
3. Parse defensively: missing fields → empty string / 0, not panic.
4. Map all rooms with `site_id: Bilibili`.
5. Store needed play context in `LiveRoomDetail.raw` (e.g. room_id, qn maps).

- [ ] **Step 1: Fetch and read current upstream bilibili_site.dart fully before coding**

```bash
curl -sL "https://raw.githubusercontent.com/June6699/dart_simple_live/master/simple_live_core/lib/src/bilibili_site.dart" -o /tmp/bilibili_site.dart
wc -l /tmp/bilibili_site.dart
```

- [ ] **Step 2: Unit tests with fixture JSON**

Save minimal response fixtures under `src-tauri/tests/fixtures/bilibili_area_list.json` etc.

```rust
#[test]
fn parse_categories_fixture() {
    let raw = include_str!("../../tests/fixtures/bilibili_area_list.json");
    let cats = bilibili::parse_categories(raw).unwrap();
    assert!(!cats.is_empty());
    assert!(!cats[0].children.is_empty());
}
```

- [ ] **Step 3: Implement pure parse functions + HTTP methods**

- [ ] **Step 4: Ignored live smoke test**

```rust
#[tokio::test]
#[ignore]
async fn live_recommend_smoke() {
    let site = BilibiliSite::new(reqwest::Client::new(), String::new());
    let page = site.get_recommend_rooms(1).await.unwrap();
    assert!(!page.items.is_empty());
}
```

Run online only when desired:

```bash
cd src-tauri && cargo test live_recommend_smoke -- --ignored --nocapture
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(bilibili): implement site list/search/detail/play URL APIs"
```

---

### Task 7: Frontend browse UX (home, category, search) + room entry

**Files:**
- Modify: `features/home/HomePage.tsx`, `category/CategoryPage.tsx`, `search/SearchPage.tsx`
- Create: `shared/components/RoomCard.tsx`, `shared/components/SiteSwitcher.tsx`, `shared/components/ErrorState.tsx`, `shared/hooks/useSiteQuery.ts`

**Interfaces:**
- Consumes: `invokeCmd` site commands
- Produces: clickable cards navigating to `/room/bilibili/:roomId`

- [ ] **Step 1: RoomCard component**

Show cover, title, user_name, online; keyboard focusable; `onClick` → navigate.

- [ ] **Step 2: HomePage**

```tsx
// pseudo
const siteId = useSettingsStore(s => s.siteId);
const { data, error, isLoading, refetch } = useQuery({
  queryKey: ["recommend", siteId, page],
  queryFn: () => invokeCmd<RoomListPage>("site_get_recommend", { siteId, page }),
});
```

Pagination: "Load more" if `has_more`.

- [ ] **Step 3: CategoryPage**

Load categories → sidebar/chips of parent → child grid → rooms for selected sub-category.

- [ ] **Step 4: SearchPage**

Debounced input → `site_search_rooms`.

- [ ] **Step 5: Disable non-ready sites in SiteSwitcher**

- [ ] **Step 6: Manual test with `tauri dev` against real Bilibili**

Expected: recommend list renders; open a card routes to room page (still placeholder body ok if Task 8 not done).

- [ ] **Step 7: Commit**

```bash
git commit -am "feat(ui): home, category, and search browsing for live rooms"
```

---

### Task 8: Room page + history write on enter

**Files:**
- Create/Modify: `features/room/RoomPage.tsx`, `features/room/PlayerPane.tsx`, `commands/history.rs`, history list page
- Modify: `lib.rs` handler list

**Interfaces:**
- Consumes: `site_get_room_detail`, `site_get_play_qualities`, `site_get_play_urls`
- Produces:
  - Room header (title, anchor, online, live badge)
  - Quality selector
  - `history_add` command called on successful detail load
  - PlayerPane placeholder receiving `PlayUrl | null` and error state

Commands:

```rust
#[tauri::command]
async fn history_list(state: State<'_, AppState>) -> Result<Vec<HistoryItem>, AppError>;

#[tauri::command]
async fn history_add(state: State<'_, AppState>, item: HistoryItem) -> Result<(), AppError>;

#[tauri::command]
async fn history_clear(state: State<'_, AppState>) -> Result<(), AppError>;
```

- [ ] **Step 1: Implement history commands + HistoryPage list**

- [ ] **Step 2: RoomPage load pipeline**

1. Parse route params
2. `site_get_room_detail`
3. `history_add`
4. `site_get_play_qualities`
5. Select first quality → `site_get_play_urls`
6. Pass first url to PlayerPane

Show metadata even if play URL fails (`ErrorState` in player region + Retry).

- [ ] **Step 3: Manual test**

Enter room from home; history page shows entry after.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(room): room detail page, qualities, and watch history"
```

---

### Task 9: mpv player integration

**Files:**
- Create: `src-tauri/src/player/mod.rs`, `commands/player.rs`
- Modify: `PlayerPane.tsx`, `playerStore.ts`, `AppSettings.mpv_path`, capabilities if needed
- Optional assets: document sidecar layout `src-tauri/binaries/` (do not commit huge binaries unless user provides)

**Interfaces:**
- Consumes: `PlayUrl { url, headers }`
- Produces commands:
  - `player_open(url, headers, title?)`
  - `player_load(url, headers)` — reuse process if possible
  - `player_stop()`
  - `player_set_pause(paused: bool)`
  - `player_set_volume(volume: u8)` // 0-100
  - `player_status() -> { running: bool, mpv_path: String }`

**Phase-1 embed policy:** start with **separate mpv window** (reliable cross-platform), geometry optional. Document embed (`--wid`) as follow-up behind same API.

Resolve mpv path:

1. `settings.mpv_path` if set and executable
2. sidecar path if present
3. `which mpv` / `where mpv`

Launch example args:

```text
mpv --force-window=yes --keep-open=yes --title=rLive --user-agent=... --http-header-fields=Referer: ... <url>
```

Map headers to mpv `--http-header-fields` (comma-separated `Key: Value` pairs per mpv docs).

On app exit / `RunEvent::Exit`, call stop.

- [ ] **Step 1: Unit test header formatting**

```rust
#[test]
fn format_http_headers() {
    let mut h = HashMap::new();
    h.insert("Referer".into(), "https://live.bilibili.com/".into());
    let s = format_mpv_headers(&h);
    assert!(s.contains("Referer: https://live.bilibili.com/"));
}
```

- [ ] **Step 2: Implement PlayerManager in AppState (`Mutex<Option<Child>>`)**

- [ ] **Step 3: Wire RoomPage open/stop on mount/unmount**

```tsx
useEffect(() => {
  if (!playUrl) return;
  invokeCmd("player_open", { url: playUrl.url, headers: playUrl.headers, title });
  return () => { invokeCmd("player_stop"); };
}, [playUrl?.url]);
```

- [ ] **Step 4: Manual test**

Requires system `mpv` installed. Enter live room → mpv window plays; leave room → process exits (`pgrep mpv` empty).

- [ ] **Step 5: Settings shows resolved mpv path via `player_status`**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(player): control external mpv for live playback"
```

---

### Task 10: Bilibili danmaku → frontend overlay

**Files:**
- Create: `src-tauri/src/danmaku/mod.rs`, `danmaku/bilibili.rs`, `features/room/DanmakuLayer.tsx`
- Reference: upstream `simple_live_core/lib/src/danmaku/bilibili_danmaku.dart`
- Modify: room page, settings shield words (frontend filter)

**Interfaces:**
- Consumes: room detail (room id, danmaku tokens from `raw` if needed)
- Produces:
  - commands `danmaku_connect(site_id, room_id)` / `danmaku_disconnect`
  - event `danmaku` payload `DanmakuEvent`
  - UI overlay with scrolling chat lines (CSS is enough for phase 1)

Port Bilibili live WS:

1. Fetch danmaku host/token (same as upstream)
2. Connect WebSocket
3. Send auth + heartbeat
4. Decode packets; map `DANMU_MSG` → `DanmakuKind::Chat`
5. `app.emit("danmaku", event)`

Frontend:

```ts
import { listen } from "@tauri-apps/api/event";
// ring buffer max 200; filter shield words from settings
```

- [ ] **Step 1: Unit test packet parse with fixture bytes/hex if available**

- [ ] **Step 2: Implement connect loop as managed task (`JoinHandle` in AppState)**

Ensure disconnect aborts task; connect cancels previous.

- [ ] **Step 3: DanmakuLayer listens and renders**

- [ ] **Step 4: Manual test**

Live room with chat → overlay shows messages; shield word hides matches.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(danmaku): bilibili websocket chat overlay"
```

---

### Task 11: Follows, tags, live-status refresh

**Files:**
- Create: `commands/follow.rs`, enhance `db/follow.rs`, `features/follow/FollowPage.tsx`
- Modify: RoomPage follow button

**Interfaces:**
- Commands:
  - `follow_list() -> FollowUser[]`
  - `follow_add(user: FollowUser)`
  - `follow_remove(site_id, room_id)`
  - `follow_set_tags(site_id, room_id, tag_ids: string[])`
  - `tag_list() / tag_upsert(name) / tag_remove(id)`
  - `follow_refresh() -> FollowUser[]` (Bilibili: call `get_live_status` or lightweight detail; others leave `live_status: null`)

`FollowUser`:

```ts
{
  site_id: SiteId;
  room_id: string;
  user_name: string;
  face: string;
  tag_ids: string[];
  live_status: boolean | null;
  updated_at: number;
}
```

- [ ] **Step 1: DB tests for tags + follow tag_ids JSON**

- [ ] **Step 2: Commands + refresh with concurrency limit (e.g. 5)**

Use `tokio::sync::Semaphore`.

- [ ] **Step 3: FollowPage UI** — filter by tag, refresh button, open room, unfollow

- [ ] **Step 4: RoomPage toggle follow**

- [ ] **Step 5: Manual test** — follow, restart app, still there; refresh updates live badge for bilibili

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(follow): follows, tags, and bilibili live refresh"
```

---

### Task 12: Profile export/import + README

**Files:**
- Create: `src-tauri/src/profile/mod.rs`, `models/profile.rs`, `commands/profile.rs`
- Modify: Settings page import/export buttons (use `@tauri-apps/plugin-dialog` save/open)
- Modify: `README.md`
- Possibly add `tauri-plugin-dialog` / `tauri-plugin-fs` with capabilities

**Interfaces:**
- Profile JSON shape:

```json
{
  "version": 1,
  "exported_at": 0,
  "settings": { "...AppSettings without secrets..." },
  "follows": [],
  "tags": [],
  "history": [],
  "danmaku_shield_words": []
}
```

Explicitly **omit** cookies.

Commands:

- `profile_export(path: string) -> ()`
- `profile_import(path: string) -> { follows: number, history: number, ... }`

Merge policy on import:

- follows: upsert by (site_id, room_id)
- tags: upsert by name
- history: upsert keeping newer `watched_at`
- settings: deep-merge non-null fields
- shield words: union unique

- [ ] **Step 1: Unit tests for merge + cookie exclusion**

```rust
#[test]
fn export_model_has_no_cookie_field() {
    let v = serde_json::to_value(ProfilePackage::sample()).unwrap();
    assert!(v.get("cookies").is_none());
}
```

- [ ] **Step 2: Implement I/O + commands**

- [ ] **Step 3: Settings UI buttons**

- [ ] **Step 4: Rewrite README**

Cover: what rLive is, relation to Simple Live, phase-1 scope, mpv dependency, dev commands (`bun install`, `bun run tauri dev`), educational disclaimer, no recording/send-chat.

- [ ] **Step 5: Manual export/import roundtrip**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(profile): import/export non-sensitive config; update README"
```

---

### Task 13: Phase-1 hardening + DoD checklist

**Files:**
- Modify as needed: error messages, loading states, `src-tauri/capabilities/default.json`
- Create: `docs/superpowers/plans/2026-07-23-rlive-phase1-dod.md` optional notes — prefer checklist only in commit message / PR

- [ ] **Step 1: Capabilities audit**

Ensure dialog/fs/http permissions required by Tauri 2 are declared; do not enable unused dangerous scopes.

- [ ] **Step 2: Remove template `greet` command**

- [ ] **Step 3: Run automated tests**

```bash
cd src-tauri && cargo test
cd .. && bun run build
```

Expected: all non-ignored tests pass; frontend typechecks/builds.

- [ ] **Step 4: Manual DoD walkthrough (Linux)**

1. Sidebar + theme works  
2. Bilibili recommend/category/search  
3. Enter room → mpv plays → danmaku visible  
4. Follow + history persist after restart  
5. Cookie save works  
6. Profile export/import  
7. Other sites visible as not ready / stub errors  

- [ ] **Step 5: Commit**

```bash
git commit -am "chore: phase-1 hardening and remove template greet"
```

---

## Later work (not in this plan)

- Full Huya / Douyu / Kuaishou / Douyin site + danmaku ports  
- mpv wid embedding  
- Multi-room, sync, WebDAV, TV  
- Auto-update, tray, packaging signed installers  

---

## Plan self-review

### Spec coverage

| Spec item | Task |
|---|---|
| Desktop shell, sidebar, theme | 1, 4 |
| Linux + Windows targets | Global + player path resolution (9) |
| Bilibili lists/search/room/play | 5–9 |
| mpv playback | 9 |
| Danmaku | 10 |
| Follows/tags/history | 3, 8, 11 |
| Settings/proxy | 4 |
| Cookie | 4 |
| Profile import/export | 12 |
| Other four sites registered | 5 |
| README / disclaimer | 12 |
| No TV/sync/multi-room | Out of plan |
| Unified AppError | 2 |
| SQLite local data | 3 |

### Placeholder scan

No TBD/TODO steps; Bilibili URLs explicitly “verify from upstream dart at implement time” with concrete fetch step in Task 6.

### Type consistency

- `SiteId` serde snake_case strings shared Rust/TS  
- Commands use `site_id` + snake_case fields  
- `DanmakuEvent` / `PlayUrl` / `RoomListPage` names stable across tasks 2–10  
- `AppSettings` fields introduced in Task 4 reused by 9–12  

### Locked choices (were open in spec)

- DB: **rusqlite**  
- mpv phase-1: **separate window**, same `player_*` API for future embed  
- Danmaku shield: **frontend filter** in Task 10  
