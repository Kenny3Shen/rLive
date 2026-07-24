# rLive Design: Playback + Danmaku v3 (Simple Live alignment)

**Date:** 2026-07-24  
**Status:** Implementing  
**Workspace:** rLive (Tauri 2 + React + Rust + libmpv)  
**Reference:** [June6699/dart_simple_live](https://github.com/June6699/dart_simple_live) live room controller / player / canvas_danmaku

## 1. Goal

Align room **playback recovery**, **quality/line control**, and **danmaku** with Simple Live desktop behavior, while keeping Windows **in-process libmpv** and the transparent companion overlay (HWND cannot host HTML above video).

## 2. Locked decisions

| Topic | Choice |
|-------|--------|
| Decoder | libmpv (no MSE rewrite) |
| Floating danmaku | Companion `danmaku-overlay` webview over host / fullscreen |
| Failover | Retry current line ≤2, then next line (Simple Live `mediaError`/`mediaEnd`) |
| Default quality | Settings `quality_level`: high / mid / low |
| Floating text | Message only (no `user:`) on canvas; list keeps username |
| Controls | Bar under host in windowed mode (clickable); auto-hide on fullscreen overlay |

## 3. State machines

### Playback

```
Idle → LoadingQualities → LoadingUrls → Opening → Playing
                              │            │         │
                              └────────────┴─ error ─┘
                                          │
                               retry / next line / Failed
```

### Danmaku surface

```
None → BoundToHost(bounds) ⇄ Fullscreen
```

One overlay epoch per room session when possible; re-bind bounds instead of destroy/create on every resize.

### Session tokens

- Rust `PlayerLifecycle` epoch + open generation (existing)
- Rust `OverlayLifecycle` epoch (existing)
- Frontend hooks must use these as single orchestrators (no parallel open races)

## 4. Events

### `player_event` (Rust → all webviews)

```ts
type PlayerEvent = {
  epoch: number;          // player lifecycle epoch
  generation: number;     // open generation
  kind: "playing" | "paused" | "idle" | "eof" | "error";
  message?: string | null;
};
```

### Failover policy

| Event | Action |
|-------|--------|
| `error` / `eof` | if `retryCount < 2` → reload current URL (delay 0 then 1s); else next line; else surface 播放失败 |
| Manual quality change | `retryCount=0`, `lineIndex=0`, refetch urls, load |
| Manual line change | `retryCount=0`, load selected url |

## 5. Module map

```
src/features/room/
  playback/usePlaybackController.ts
  playback/quality.ts          # pickDefaultQualityIndex
  playback/failover.ts         # nextFailoverAction pure
  player/usePlayerSession.ts
  danmaku/useDanmakuConnection.ts
  danmaku/useDanmakuSurface.ts
  danmaku/filter.ts
  PlayerPane.tsx               # composition
  PlayerStage.tsx              # host + controls + side layout
  canvas/danmakuEngine.ts
  FullscreenOverlayRoot.tsx    # both presentations

src-tauri/src/player/
  events.rs                    # PlayerEvent payload
  libmpv.rs                    # wait_event thread
```

## 6. Definition of Done

See plan: Windows release EXE plays Bilibili, quality/line switch, failover, windowed+FS danmaku, clean leave-room teardown.
