# rLive Design: Room Playback v2 (Danmaku Overlay, Lines, Fullscreen)

**Date:** 2026-07-24  
**Status:** Draft for user review (brainstorming approved)  
**Workspace:** rLive (Tauri 2 + React + Rust + mpv)  
**Related:** `docs/superpowers/specs/2026-07-23-rlive-tauri-design.md`, phase-1 player embed

## 1. Goal

Deliver a **Bilibili-live-like room playback experience** on top of the existing desktop shell:

1. **Manual quality + line (CDN URL) switching** from the player control bar.
2. **Dual-mode playback**: windowed HWND embed vs fullscreen overlay-capable mode.
3. **Canvas scrolling danmaku** on the video surface in fullscreen (Bilibili-style tracks).
4. **All playback controls under the video host** (not covered by the mpv child HWND).

### 1.1 Product decisions (locked)

| Decision | Choice |
|----------|--------|
| Scope package | Single phase: danmaku + lines + fullscreen |
| Danmaku style | A — on-video scrolling (Canvas) |
| Embed strategy | A — dual mode (HWND windowed / overlay fullscreen) |
| Line switching | Manual only (no auto-failover on stall) |
| Control placement | Player chrome **below** video host |
| Copy stream URL | Remain on room bottom action strip (not required on control bar) |

### 1.2 In scope

- Control bar under `VideoHost`: play/pause, volume, danmaku toggle, **quality**, **line**, **fullscreen**.
- `PlayUrl[]` for current quality → user-selectable lines (label: `线路 n` or short host).
- Fullscreen enter/exit state machine with recovery to HWND embed.
- Fullscreen transparent overlay: Canvas danmaku + auto-hiding controls.
- Windowed mode: keep right chat list; optional mpv OSD; no HTML over HWND.
- Reuse existing danmaku WS events and settings (`opacity`, `font_size`, `speed`, shield words).

### 1.3 Out of scope

- Auto line switch on buffer/stall  
- Sending danmaku / gifts  
- Replacing mpv with MSE/HLS web player  
- Multi-room, PiP (may stay disabled)  
- New site backends beyond existing Bilibili play URL pipeline  

### 1.4 Definition of Done

On **Windows** (primary; Linux best-effort same API):

1. User can switch **quality** and **line** from the bar under the video; playback resumes with short interrupt via `player_load`.
2. User can enter **fullscreen**; scrolling danmaku is visible over the picture; Esc or control exits and restores embed.
3. Right-side chat list still works in windowed mode.
4. Controls remain clickable (never under HWND).
5. Failures surface in UI (load/fullscreen errors); no silent stuck state.

## 2. Architecture

### 2.1 Approach

**Dual-mode mpv + transparent overlay window for fullscreen danmaku** (Approach 1 from brainstorming).

```
WindowedEmbed:
  Main webview chrome
  + child HWND mpv (--wid) in VideoHost rect
  + PlayerControls BELOW host
  + DanmakuPanel (right list)

FullscreenOverlay:
  mpv without wid (fullscreen / borderless on monitor)
  + transparent always-on-top overlay webview
      CanvasDanmaku + auto-hide PlayerControls
```

### 2.2 State machine

```
                  open(url)
     Idle ──────────────────► WindowedEmbed
                                │         ▲
                     enter_fs   │         │ exit_fs
                                ▼         │
                           FullscreenOverlay
                                │
                     error/stop ▼
                              Idle
```

| Mode | mpv | WebView | Danmaku |
|------|-----|---------|---------|
| WindowedEmbed | `--wid` child | Main window; no HTML over video | Right list + optional OSD |
| FullscreenOverlay | Independent / FS (no wid) | Transparent overlay on same display | Canvas tracks + optional thin chrome |

**Rules**

- Quality/line change: `player_load` only; **do not** change mode.
- Enter fullscreen: leave embed → open/load current URL in FS form → show overlay → feed Canvas from `danmaku` events.
- Exit fullscreen: destroy/hide overlay → re-embed with current bounds → focus main window.
- Single source of truth: Rust `PlayerMode` + `player_status` mirrors to React.

### 2.3 Module map

```
React
  features/room/PlayerPane.tsx
    VideoHost (ref → bounds)
    PlayerControls.tsx      # quality, line, fs, transport
    DanmakuPanel.tsx        # list (windowed)
  features/room/canvas/CanvasDanmaku.tsx
  features/room/FullscreenOverlayApp.tsx  # if second webview entry

Rust
  player/mod.rs             # mode, enter/exit fullscreen, load
  player/embed_host.rs      # existing HWND host
  commands/player.rs
  sites/*                   # existing get_play_qualities / get_play_urls
  danmaku/*                 # existing emit "danmaku"
```

### 2.4 Alternatives considered

| Option | Summary | Decision |
|--------|---------|----------|
| 1. Dual mode HWND + FS overlay | Best hard-decode + real overlay FS | **Chosen** |
| 2. Always geometry + overlay | One path; worse windowed UX | Rejected |
| 3. Web MSE player | Natural DOM stack; rewrites stream stack | Rejected this phase |

## 3. Data flow: quality and lines

```
site_get_play_qualities(detail) → LivePlayQuality[]
user picks qualityIndex
site_get_play_urls(detail, quality) → PlayUrl[]
user picks lineIndex (default 0)
player_open / player_load(playUrls[lineIndex])
```

| Event | Behavior |
|-------|----------|
| Quality change | Reset `lineIndex = 0`, refetch urls, `player_load` first (or selected) url |
| Line change | Same quality, `player_load(playUrls[lineIndex])` |
| Empty lines | Disable line control; show error if open fails |
| Label | Prefer short host from URL; else `线路 {n}` |

## 4. UI

### 4.1 Windowed layout

```
┌─────────────────────────────────────┬──────────┐
│  VideoHost (mpv wid)                │  Chat    │
│                                     │  list    │
├─────────────────────────────────────┤          │
│ [▶][🔊] 弹幕  清晰度▾  线路▾  [全屏]  │          │
└─────────────────────────────────────┴──────────┘
 Room top bar: back + LIVE
 Room bottom strip: 刷新 / 关注 / 复制链接 / 复制直链
```

- **PlayerControls** is a sibling **below** `VideoHost`, never inside the embed host rect.
- Quality/line/fullscreen live **only** on this bar (removed from ad-hoc elsewhere if duplicated).

### 4.2 Fullscreen overlay

- Auto-hide controls (~3s idle); show on mouse move.
- Esc → exit fullscreen.
- Canvas full-bleed under controls layer.
- Right chat list not required in FS (optional later).

### 4.3 Canvas danmaku (FullscreenOverlay)

- Subscribe to Tauri event `danmaku`.
- Drop `system` from tracks (may show as toast once).
- Map: `chat` → scroll tracks; `super_chat` → top/emphasized; `gift` / `enter` → low priority or filterable.
- Settings: `danmaku_opacity`, `danmaku_font_size`, `danmaku_speed`, shield words.
- Optional later: `danmaku_area` (viewport fraction); not required for MVP if defaults work.

## 5. Rust command surface

| Command | Role |
|---------|------|
| `player_open` | Start with URL + optional bounds + prefer_child |
| `player_load` | Replace media URL (quality/line) without full teardown if possible |
| `player_stop` | Stop process |
| `player_set_pause` / `player_set_volume` | Transport |
| `player_set_bounds` | Embed geometry |
| `player_show_danmaku` | Optional OSD in windowed mode |
| `player_enter_fullscreen` | Mode → FullscreenOverlay; return ok / monitor info |
| `player_exit_fullscreen` | Mode → WindowedEmbed with bounds |
| `player_status` | Extend: `mode: "windowed" \| "fullscreen"`, `running`, `volume`, `paused`, `embed_mode` |

Platform notes:

- **Windows:** exit wid, set mpv window fullscreen or maximize to monitor containing app; overlay `WebviewWindow` transparent + alwaysOnTop matching work area.
- **Linux:** best-effort geometry + fullscreen IPC; overlay if transparent windows work.

## 6. Frontend state (Room / Player)

```ts
type PlayerUiMode = "windowed" | "fullscreen";

qualityIndex: number;
lineIndex: number;
playUrls: PlayUrl[];
mode: PlayerUiMode;
// existing: playUrl derived from playUrls[lineIndex]
```

Handlers:

- `onQualityChange(i)` → reset line → fetch urls → load  
- `onLineChange(i)` → load urls[i]  
- `onToggleFullscreen()` → enter/exit commands + overlay lifecycle  

## 7. Error handling

| Case | UX |
|------|-----|
| Load failure after line/quality change | Inline error on control bar; retry keeps indices |
| Fullscreen enter fails | Stay windowed; message |
| Overlay closed unexpectedly | Treat as exit FS; re-embed |
| mpv died | Idle + error; user refresh room |
| Token/danmaku disconnect | System lines in list; Canvas stops new inserts |

## 8. Testing

| Layer | Cases |
|-------|-------|
| Unit (Rust) | Mode flags in status; load does not panic without process |
| Unit (TS) | quality change resets lineIndex; line labels |
| Manual Windows | Multi quality; multi line; FS danmaku; Esc restore embed; controls clickable under video |
| Regression | Cookie-less room still plays; embed create failure message |

## 9. Implementation slices (for writing-plans)

1. **PlayerControls + lines** — UI under video; wire quality/line to `player_load`.  
2. **Status/mode plumbing** — extend `player_status`; harden load.  
3. **Fullscreen enter/exit** — no Canvas yet; black/FS video works.  
4. **Overlay + CanvasDanmaku** — scroll tracks from events.  
5. **Polish** — auto-hide controls, errors, docs, Windows delivery build.

## 10. Risks

| Risk | Mitigation |
|------|------------|
| FS switch black flash | Accept short interrupt; reuse same URL load |
| Transparent overlay multi-GPU | Pin overlay to same monitor as video |
| HWND vs overlay race | Serialize mode transitions with mutex in player |
| Canvas perf | Cap concurrent tracks; drop when overloaded |

## 11. Non-goals recap

No auto line failover, no send chat, no web player rewrite, no PiP requirement.
