# Room Playback v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver manual quality/line switching under the video host, dual-mode windowed HWND vs fullscreen overlay, and Canvas scrolling danmaku in fullscreen.

**Architecture:** Keep mpv as the decoder. Windowed mode uses existing `--wid` embed; fullscreen leaves embed, runs mpv without wid (fullscreen/borderless), and shows a transparent always-on-top Tauri webview for Canvas danmaku + auto-hiding controls. Quality/line only call `player_load` and never flip mode.

**Tech Stack:** Tauri 2, React 19, TypeScript, Tailwind 4, shadcn/ui, Rust player/danmaku modules, mpv IPC.

**Spec:** `docs/superpowers/specs/2026-07-24-room-playback-v2-design.md`

## Global Constraints

- Windows is primary; Linux best-effort same command API.
- Playback controls live **below** `VideoHost`, never inside the embed rect (HWND covers HTML).
- Line switch is **manual only** (no auto-failover).
- Do not replace mpv with a web player this phase.
- Copy stream URL stays on room bottom strip.
- After app code changes: `./scripts/build-windows-from-wsl.sh` per `AGENTS.md`.
- Chinese UI chrome labels (清晰度 / 线路 / 全屏).

## File map

| Path | Responsibility |
|------|----------------|
| `src/lib/playUrl.ts` | Pure helpers: line label from URL, clamp index |
| `src/features/room/PlayerControls.tsx` | Control bar UI under video |
| `src/features/room/PlayerPane.tsx` | Host + controls + list; mode wiring |
| `src/features/room/RoomPage.tsx` | Quality/line state; pass props; drop quality from bottom strip if any |
| `src/features/room/canvas/CanvasDanmaku.tsx` | Track layout + rAF render |
| `src/features/room/canvas/danmakuEngine.ts` | Pure engine: insert, tick, cull |
| `src/features/room/FullscreenOverlay.tsx` | Overlay UI root (same bundle; shown via second window label or portal) |
| `src/shared/types/player.ts` | `PlayerUiMode`, extended `PlayerStatus` |
| `src-tauri/src/player/mod.rs` | `PlayerMode`, enter/exit fullscreen, status field |
| `src-tauri/src/commands/player.rs` | New commands registration |
| `src-tauri/src/lib.rs` | Register commands |
| `src-tauri/tauri.conf.json` | Optional predefine `overlay` window capabilities |
| `src-tauri/capabilities/default.json` | Allow overlay window create if needed |

---

### Task 1: Pure helpers + PlayerControls (quality + line UI)

**Files:**
- Create: `src/lib/playUrl.ts`
- Create: `src/features/room/PlayerControls.tsx`
- Modify: `src/features/room/PlayerPane.tsx`
- Modify: `src/features/room/RoomPage.tsx`
- Test: `src/lib/playUrl.test.ts` only if project has vitest; otherwise use `cargo`/`tsc` and a small node assert script, or colocate pure functions and run via `bun -e`

**Interfaces:**
- Consumes: `PlayUrl`, `LivePlayQuality` from `src/shared/types/live.ts`
- Produces:
  - `lineLabel(url: string, index: number): string`
  - `clampIndex(i: number, len: number): number`
  - `PlayerControls` props (see step 3)

- [ ] **Step 1: Add pure helpers**

Create `src/lib/playUrl.ts`:

```ts
/** Prefer short host for line label; fall back to 线路 n (1-based). */
export function lineLabel(url: string, index: number): string {
  try {
    const host = new URL(url).hostname;
    if (host) return host.replace(/^www\./, "");
  } catch {
    /* ignore */
  }
  return `线路${index + 1}`;
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}
```

- [ ] **Step 2: Smoke-test helpers**

Run:

```bash
cd /home/shenss/python/rLive
bun -e "
import { lineLabel, clampIndex } from './src/lib/playUrl.ts';
console.assert(lineLabel('https://cn-hbyc-dx-liveblive.bilivideo.com/live.m3u8', 0).includes('bilivideo'));
console.assert(lineLabel('not-a-url', 2) === '线路3');
console.assert(clampIndex(5, 3) === 2);
console.assert(clampIndex(-1, 3) === 0);
console.log('ok');
"
```

Expected: prints `ok`.

- [ ] **Step 3: Create `PlayerControls`**

Create `src/features/room/PlayerControls.tsx` with shadcn `Button` and native `<select>` (or existing patterns):

```tsx
// Props (exact names for later tasks)
export type PlayerControlsProps = {
  paused: boolean;
  volume: number;
  muted?: boolean;
  danmakuOn: boolean;
  osdOn?: boolean;
  qualities: { quality: string }[];
  qualityIndex: number;
  lines: { url: string }[];
  lineIndex: number;
  fullscreen?: boolean;
  disabled?: boolean;
  loadError?: string | null;
  onTogglePause: () => void;
  onVolume: (v: number) => void;
  onToggleMute?: () => void;
  onToggleDanmaku: () => void;
  onToggleOsd?: () => void;
  onQualityChange: (index: number) => void;
  onLineChange: (index: number) => void;
  onToggleFullscreen: () => void;
};
```

Layout (single row, under video, Chinese labels):

- Play/Pause, Mute, volume range
- 弹幕 toggle, 飘屏 toggle (if `onToggleOsd`)
- `<select>` 清晰度 from `qualities`
- `<select>` 线路 from `lines.map((u,i) => lineLabel(u.url, i))`, disabled when `lines.length <= 1`
- Fullscreen button (`Maximize2` / `Minimize2`)
- Optional red text for `loadError`

Do **not** put this inside the black embed host div.

- [ ] **Step 4: Wire RoomPage state for lines**

In `RoomPage.tsx`:

- Add `const [lineIndex, setLineIndex] = useState(0)`
- When `qualitiesQuery` / selected quality changes, `setLineIndex(0)`
- Keep `playUrlQuery` as today; after success treat `playUrlQuery.data ?? []` as lines
- `const playUrls = playUrlQuery.data ?? []`
- `const playUrl = playUrls[clampIndex(lineIndex, playUrls.length)] ?? null`
- Pass into `PlayerPane`:

```tsx
qualities={qualitiesQuery.data ?? []}
qualityIndex={qualityIndex}
onQualityChange={(i) => { setQualityIndex(i); setLineIndex(0); }}
lines={playUrls}
lineIndex={lineIndex}
onLineChange={setLineIndex}
```

Remove quality `<select>` from `bottomExtras` if still injected into the old control area — quality/line must only live in `PlayerControls`.

- [ ] **Step 5: Refactor PlayerPane to use PlayerControls**

- Render structure:

```tsx
<div className="flex flex-col flex-1 min-h-0">
  <div ref={hostRef} className="flex-1 min-h-0 bg-black" />
  <PlayerControls ... />
</div>
<aside>{/* danmaku list */}</aside>
```

- On `lineIndex` / `playUrl?.url` change, existing `player_open` effect should re-open/load (already keys on `playUrl?.url`). Prefer calling `player_load` when status.running (optional micro-opt in Task 2).
- Remove duplicate quality select from bottomExtras usage.

- [ ] **Step 6: Typecheck**

```bash
cd /home/shenss/python/rLive && bunx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/playUrl.ts src/features/room/PlayerControls.tsx \
  src/features/room/PlayerPane.tsx src/features/room/RoomPage.tsx
git commit -m "feat(player): control bar with quality and line selectors under video"
```

---

### Task 2: Extend PlayerStatus + harden load / headers on line switch

**Files:**
- Modify: `src-tauri/src/player/mod.rs`
- Modify: `src-tauri/src/commands/player.rs`
- Modify: `src/shared/types/player.ts` (create if missing)
- Modify: `src/features/room/PlayerPane.tsx`
- Test: unit test on pure Rust if extractable; else manual `cargo test --lib`

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerMode {
    Windowed,
    Fullscreen,
}

// PlayerStatus gains:
pub mode: PlayerMode,
```

- `player_load` must apply **http headers** on replace when possible (mpv `loadfile` alone drops headers). If IPC cannot set headers, document fallback: `stop` + `open` with same mode/bounds.

- [ ] **Step 1: Add `PlayerMode` and field on `PlayerStatus`**

In `player/mod.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlayerMode {
    #[default]
    Windowed,
    Fullscreen,
}

// PlayerStatus
pub mode: PlayerMode,

// PlayerInner
mode: PlayerMode,
```

Initialize `mode: PlayerMode::Windowed` in `Default`. Include in `status()`.

- [ ] **Step 2: Improve `load` for header-bearing streams**

Bilibili URLs often need Referer. Implement:

```rust
pub fn load(...) -> AppResult<()> {
    // If running: stop_locked then open(...) with same prefer_child/bounds
    // Rationale: loadfile replace does not re-apply --http-header-fields.
    self.open(window, mpv_path, url, headers, title, bounds, prefer_child)
}
```

(If later IPC supports `http-header-fields` property, optimize; for this plan, open-after-stop is correct and simple.)

Keep public signature of `player_load` command unchanged.

- [ ] **Step 3: Frontend status type**

Create `src/shared/types/player.ts`:

```ts
export type PlayerUiMode = "windowed" | "fullscreen";
export type EmbedMode = "child" | "geometry" | "window";

export type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed_mode: EmbedMode;
  mode: PlayerUiMode;
};
```

Use this type in `PlayerPane` instead of local duplicate.

- [ ] **Step 4: cargo test + tsc**

```bash
cd /home/shenss/python/rLive/src-tauri && cargo test --lib 2>&1 | tail -20
cd /home/shenss/python/rLive && bunx tsc --noEmit
```

Expected: tests pass (or only pre-existing warnings); tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/player/mod.rs src-tauri/src/commands/player.rs \
  src/shared/types/player.ts src/features/room/PlayerPane.tsx
git commit -m "fix(player): track windowed/fullscreen mode and reload with headers"
```

---

### Task 3: Fullscreen enter/exit (video only, no Canvas yet)

**Files:**
- Modify: `src-tauri/src/player/mod.rs`
- Modify: `src-tauri/src/commands/player.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/features/room/PlayerPane.tsx`
- Modify: `src/features/room/PlayerControls.tsx`

**Interfaces:**
- Produces commands:

```rust
// commands/player.rs
#[tauri::command]
pub fn player_enter_fullscreen(
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
) -> AppResult<()>

#[tauri::command]
pub fn player_exit_fullscreen(
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
) -> AppResult<()>
```

- PlayerManager methods:

```rust
pub fn enter_fullscreen(&self, mpv_path: &Path, url: &str, headers: &HashMap<String, String>, title: Option<&str>) -> AppResult<()>
pub fn exit_fullscreen(&self, window: Option<&WebviewWindow>, mpv_path: &Path, url: &str, headers: &HashMap<String, String>, title: Option<&str>, bounds: Option<PlayerBounds>) -> AppResult<()>
```

- [ ] **Step 1: Implement `enter_fullscreen` on PlayerManager**

Logic:

1. Lock; if already `PlayerMode::Fullscreen` and running, return Ok.
2. `stop_locked` (drops EmbedHost).
3. Spawn mpv **without** `--wid`:
   - args: `--force-window=yes`, `--fullscreen=yes` (or `--fs`), keep ipc/volume/headers/url
   - `prefer_child` false path
4. Set `inner.mode = PlayerMode::Fullscreen`, `embed_mode = EmbedMode::Window`.

- [ ] **Step 2: Implement `exit_fullscreen`**

1. `stop_locked`
2. `open(window, ..., bounds, prefer_child: true)` to restore embed
3. `inner.mode = PlayerMode::Windowed`

- [ ] **Step 3: Register commands in `lib.rs`**

Add `player_enter_fullscreen`, `player_exit_fullscreen` to `generate_handler!`.

- [ ] **Step 4: Wire UI toggle**

In `PlayerPane`:

```ts
async function toggleFullscreen() {
  if (mode === "fullscreen") {
    await invokeCmd("player_exit_fullscreen", {
      url: playUrl.url,
      headers: playUrl.headers,
      title: title ?? null,
      bounds: await measureClientBounds(hostRef.current!),
    });
    setMode("windowed");
  } else {
    await invokeCmd("player_enter_fullscreen", {
      url: playUrl.url,
      headers: playUrl.headers,
      title: title ?? null,
    });
    setMode("fullscreen");
  }
}
```

Listen for `Escape` when `mode === "fullscreen"` to exit.

Show `loadError` on failure; keep prior mode.

- [ ] **Step 5: Manual check notes (document in commit body)**

On Windows after build: enter room → 全屏 → mpv fills screen → Esc → embed returns under host.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/player/mod.rs src-tauri/src/commands/player.rs \
  src-tauri/src/lib.rs src/features/room/PlayerPane.tsx src/features/room/PlayerControls.tsx
git commit -m "feat(player): enter/exit fullscreen dual-mode without danmaku overlay yet"
```

---

### Task 4: Canvas danmaku engine + fullscreen overlay window

**Files:**
- Create: `src/features/room/canvas/danmakuEngine.ts`
- Create: `src/features/room/canvas/CanvasDanmaku.tsx`
- Create: `src/features/room/FullscreenOverlayRoot.tsx`
- Modify: `src/app/App.tsx` (route or bootstrap by query `?overlay=1`)
- Modify: `src-tauri/src/commands/player.rs` or new `commands/overlay.rs` to create/show/hide overlay window
- Modify: `src-tauri/capabilities/default.json` / `tauri.conf.json` as needed for multi-window
- Modify: `src/features/room/PlayerPane.tsx` to create overlay on enter FS and close on exit

**Interfaces:**
- Engine API:

```ts
export type TrackItem = {
  id: string;
  text: string;
  color: string;
  y: number;
  x: number;
  width: number;
  speed: number; // px/sec
  kind: "scroll" | "top";
};

export function createEngine(opts: {
  fontSize: number;
  speed: number; // logical 1–10 from settings
  opacity: number;
}): DanmakuEngine;

// methods: push(ev), tick(dt, width, height), visibleItems(): TrackItem[]
```

- Overlay window label: `"danmaku-overlay"`
- Events: reuse `danmaku`; optional `player://fullscreen-state` if needed

- [ ] **Step 1: Implement pure engine with tests via bun**

`danmakuEngine.ts`:

- Maintain lanes for scroll (greedy first free lane).
- `push` ignores `system`; `super_chat` → top fixed 3s; `chat` → scroll.
- Cap 80 active items; drop oldest scroll when over cap.
- `tick` moves `x -= speed * dt`.

Smoke:

```bash
bun -e "
import { createEngine } from './src/features/room/canvas/danmakuEngine.ts';
const e = createEngine({ fontSize: 18, speed: 8, opacity: 1 });
e.push({ kind: 'chat', user: 'a', content: 'hello', color: null, ts: 1 });
e.tick(0.016, 1280, 720);
console.assert(e.visibleItems().length === 1);
console.log('engine ok');
"
```

- [ ] **Step 2: `CanvasDanmaku` component**

- Full size canvas, `resize` observer
- `listen('danmaku')` while mounted
- rAF loop calling `engine.tick`
- Draw text with `globalAlpha = opacity`, `fillStyle = color || '#fff'`, shadow for readability
- Read shield/font/speed/opacity from `useSettingsStore`

- [ ] **Step 3: Overlay window lifecycle (Rust)**

Add command `overlay_open` / `overlay_close` **or** handle in `player_enter_fullscreen` / `player_exit_fullscreen`:

```rust
// Pseudocode using tauri 2
let overlay = WebviewWindowBuilder::new(app, "danmaku-overlay", WebviewUrl::App("index.html?overlay=1".into()))
  .transparent(true)
  .decorations(false)
  .always_on_top(true)
  .skip_taskbar(true)
  .build()?;
// set size to monitor of main window
```

On exit: `overlay.close()`.

Capability: allow `core:webview:allow-create-webview-window` if required by Tauri 2 ACL.

- [ ] **Step 4: Frontend bootstrap for overlay**

In `main.tsx` or `App.tsx`:

```tsx
const isOverlay = new URLSearchParams(window.location.search).get("overlay") === "1";
// if isOverlay render <FullscreenOverlayRoot /> else <App />
```

`FullscreenOverlayRoot`:

- black transparent body (`bg-transparent`)
- `CanvasDanmaku` full viewport
- `PlayerControls` auto-hide (mousemove → show 3s)
- Esc → `invokeCmd('player_exit_fullscreen', ...)` + close (or only invoke exit and let Rust close window)

Pass current url/headers via:

- sessionStorage set by main before enter FS, or
- Tauri event `overlay-init` with payload `{ url, headers, title, qualityIndex, ... }`

Recommended: main window `emit` to overlay after create; overlay `listen` once.

- [ ] **Step 5: Integrate enter/exit with overlay**

Sequence enter:

1. Measure bounds (for later exit)
2. `player_enter_fullscreen`
3. Create overlay window
4. Emit init payload

Sequence exit:

1. `player_exit_fullscreen` with bounds
2. Close overlay
3. `setMode('windowed')`

- [ ] **Step 6: Typecheck + cargo check**

```bash
bunx tsc --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 7: Commit**

```bash
git add src/features/room/canvas src/features/room/FullscreenOverlayRoot.tsx \
  src/main.tsx src/app/App.tsx src-tauri/src src-tauri/capabilities src-tauri/tauri.conf.json
git commit -m "feat(danmaku): fullscreen overlay window with canvas scrolling tracks"
```

---

### Task 5: Polish, docs, Windows delivery

**Files:**
- Modify: `src/features/room/PlayerControls.tsx` (auto-hide only in overlay; errors)
- Modify: `docs/superpowers/specs/2026-07-24-room-playback-v2-design.md` status → Implemented
- Modify: `docs/superpowers/changelog-2026-07-24.md` or new changelog section
- Modify: `README.md` short note on fullscreen/line controls

- [ ] **Step 1: UX polish**

- Overlay controls: opacity transition; hide cursor optional
- Disable 全屏 when `!playUrl`
- Surface `player_enter_fullscreen` errors in Chinese
- Ensure room bottom strip still has 复制直链, not duplicated quality selectors

- [ ] **Step 2: Update docs**

Spec status line: `Status: Implemented (playback v2)`  
README: mention 清晰度/线路 under video + fullscreen canvas danmaku.

- [ ] **Step 3: Windows build**

```bash
./scripts/build-windows-from-wsl.sh
```

Expected: `OK: D:\dev\rLive\src-tauri\target\release\rlive.exe`

- [ ] **Step 4: Manual QA checklist** (tick in commit message)

1. Windowed: switch 清晰度 and 线路 — stream continues  
2. Controls under video clickable with embed running  
3. Fullscreen: video FS + scrolling danmaku  
4. Esc restores embed  
5. Right chat still works windowed  

- [ ] **Step 5: Final commit**

```bash
git add README.md docs src
git commit -m "docs: mark room playback v2 complete and polish fullscreen UX"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Quality + line under video | Task 1 |
| Manual line only | Task 1 |
| player_load with headers | Task 2 |
| PlayerMode / status | Task 2 |
| Dual-mode FS enter/exit | Task 3 |
| Canvas danmaku FS | Task 4 |
| Overlay window | Task 4 |
| Clickable controls (not under HWND) | Task 1 layout |
| Errors surfaced | Task 3–5 |
| Windows delivery | Task 5 |
| Copy 直链 on room bottom | unchanged (verify Task 5) |

## Placeholder / consistency review

- Command names fixed: `player_enter_fullscreen`, `player_exit_fullscreen`.
- Mode serde: `windowed` | `fullscreen` (snake_case in Rust matches TS).
- No auto-failover tasks (YAGNI per spec).
- Engine + overlay are sequential after FS video works.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-room-playback-v2.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with executing-plans and checkpoints  

**Which approach?**
