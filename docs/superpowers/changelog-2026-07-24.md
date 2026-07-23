# Changelog — 2026-07-24

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

## Danmaku

- Fix Bilibili WS auth: join `uid` is **viewer** mid (`DedeUserID`), not streamer uid.
- `room_id` stored as number in room `raw` for correct join.
- Decompress + nested packet parsing (zlib/brotli); support `DANMU_MSG:…` cmds.
- Surface connect / disconnect system lines; enter / gift events.
- `getDanmuInfo` with `type=0`, plain request then WBI fallback.

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
