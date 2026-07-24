# Changelog — 2026-07-24

## Playback + Danmaku v3 (Simple Live alignment)

- Room playback refactored into controllers: `usePlaybackController`, `usePlayerSession`, `useDanmakuSurface`, `useDanmakuConnection`.
- **Failover** like Simple Live: retry current line ≤2, then next line; surface 播放失败 when exhausted.
- **Default quality** preference (`high` / `mid` / `low`) in settings + room open.
- libmpv emits `player_event` (`playing` / `eof` / `error`) via wait_event observer.
- Floating danmaku: content-only text (no `user:`); shared shield filter; Super Chat tab lists SC events.
- Design: `docs/superpowers/specs/2026-07-24-playback-danmaku-v3-design.md`.

## UI / UX

- Simple Live–inspired dark shell: icon sidebar, centered site tabs, top-right search.
- Integrated **shadcn/ui** (base-nova): Button, Avatar, Tabs, ScrollArea, Badge, Spinner, etc.
- Room page:
  - Immersive layout with **top bar** (back + LIVE) outside mpv HWND.
  - Right panel: streamer header + 聊天 / SC tabs + danmaku list.
  - Bottom bar: 刷新 / 关注 / 复制链接 / **复制直链** (stream URL). Removed duplicate bottom “直播中” badge.

## Player

- Windows embed host aligned to **windows 0.61** (Tauri HWND types).
- Controls bar sits **below** the embed host so UI remains clickable under HWND.
- **Playback v2:** manual 清晰度 + 线路 under video; dual-mode fullscreen (`player_enter/exit_fullscreen`); `PlayerMode` on status; load re-applies HTTP headers.
- Fullscreen opens transparent **`danmaku-overlay`** webview for Canvas tracks + auto-hide controls (Esc exits).

## Danmaku

- Fix Bilibili WS auth: join `uid` is **viewer** mid (`DedeUserID`), not streamer uid.
- `room_id` stored as number in room `raw` for correct join.
- Decompress + nested packet parsing (zlib/brotli); support `DANMU_MSG:…` cmds.
- Surface connect / disconnect system lines; enter / gift events.
- `getDanmuInfo` with `type=0`, plain request then WBI fallback.
- Fullscreen **Canvas** engine (`danmakuEngine` + `CanvasDanmaku`) with lane layout, shield words, settings opacity/size/speed.


## Tooling

- `AGENTS.md` + `.grok/rules/windows-delivery.md`: after app changes, run  
  `./scripts/build-windows-from-wsl.sh` (sync + Windows release).
- Hardened `scripts/build-windows.ps1` against PowerShell treating bun stderr as fatal.
- `scripts/build-windows-from-wsl.sh` uses `/init` + PowerShell wrapper when needed.

## Paths

| Role | Path |
|------|------|
| WSL source | repo root |
| Windows mirror | `D:\dev\rLive` |
| Release EXE | `D:\dev\rLive\src-tauri\target\release\rlive.exe` |
