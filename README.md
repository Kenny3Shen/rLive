# rLive

**rLive** is a desktop live-stream aggregator built with **Tauri 2 + React + TypeScript + Rust**.  
It is an independent rewrite inspired by [Simple Live](https://github.com/June6699/dart_simple_live) / [xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live) — **not** an official client.

> 简简单单的看直播 — watch live streams simply.

## Phase-1 features

| Area | Status |
|------|--------|
| Desktop shell (Linux + Windows) | Done |
| Dark UI (Simple Live–style) + **shadcn/ui** | Done |
| Bilibili: categories, recommend, search, room detail, play URLs | Done |
| **mpv** embed (Windows child HWND / geometry fallback) | Done |
| Right chat panel + Bilibili danmaku (WS) | Done |
| Follows + tags + live refresh | Done |
| Watch history | Done |
| Settings, proxy, cookie paste, shield words | Done |
| Profile import/export (no cookies) | Done |
| Huya / Douyu / Douyin / Kuaishou | Registered stubs (coming later) |

**Not in phase 1:** TV apps, multi-room, remote/LAN/WebDAV sync, recording/download, sending danmaku or gifts.

## Requirements

- [Rust](https://www.rust-lang.org/) (stable)
- [bun](https://bun.sh/) (frontend package manager)
- Platform toolchain for [Tauri 2](https://v2.tauri.app/start/prerequisites/)
- **[mpv](https://mpv.io/)** installed and on `PATH` (or set absolute path in Settings)

### Windows toolchain (recommended layout)

| Component | Path |
|-----------|------|
| Project (Windows mirror) | `D:\dev\rLive` |
| Rust | `D:\dev\rust\{cargo,rustup}` |
| VS Build Tools | `D:\VS\BuildTools` (`vcvars64.bat`) |
| Temp | `D:\Temp\build` |

## Develop

```bash
bun install
bun run tauri dev
```

Frontend only (no Tauri commands):

```bash
bun run dev
```

Build (Linux / current platform):

```bash
bun run build
cd src-tauri && cargo test --lib
bun run tauri build
```

### Windows delivery (WSL → `D:\dev\rLive`)

Development often happens under WSL (`/home/.../rLive`); the runnable desktop app is built on Windows.

**After app code changes**, agents and humans should sync + build:

```bash
# From WSL repo root — syncs then runs PowerShell build
./scripts/build-windows-from-wsl.sh
```

Or step by step:

```bash
./scripts/sync-to-windows.sh
# On Windows PowerShell:
cd D:\dev\rLive
.\scripts\build-windows.ps1
# Optional NSIS installer:
.\scripts\build-windows.ps1 -BundleNsis
```

Success output:

```text
D:\dev\rLive\src-tauri\target\release\rlive.exe
```

Project rules for this pipeline: `AGENTS.md`, `.grok/rules/windows-delivery.md`.

## UI notes

- **Sidebar**: icon rail (首页 / 关注 / 分类 / 历史 / 设置)
- **Search**: top-right of the main header (not in the rail)
- **Room page**: top bar with back + LIVE; video embed; right chat list; bottom strip (刷新 / 关注 / 复制链接 / 复制直链)
- **Player controls** (under video, never over HWND): 播放 / 音量 / 弹幕 / **清晰度** / **线路** / **全屏**
- **mpv HWND**: native video sits on top of the webview — chrome must stay **outside** the embed host

## Playback v2 (fullscreen + lines + canvas danmaku)

| Mode | Video | Danmaku |
|------|-------|---------|
| Windowed | `--wid` child embed | Right chat list (+ optional OSD) |
| Fullscreen | mpv OS fullscreen (no wid) | Transparent always-on-top overlay + **Canvas** scrolling tracks |

Esc or control-bar 全屏 exits overlay and restores embed. Spec/plan:

- `docs/superpowers/specs/2026-07-24-room-playback-v2-design.md`
- `docs/superpowers/plans/2026-07-24-room-playback-v2.md`

## Danmaku (Bilibili)

1. Open **设置 → 哔哩哔哩 Cookie**, paste a valid browser cookie, save.
2. Enter a live room — chat should show connect status, then chat / enter / gift lines.
3. Fullscreen shows scrolling canvas danmaku over the picture.
4. WS join uses **viewer** `DedeUserID` (or `0` when anonymous), real `room_id`, and token from `getDanmuInfo`.

Never commit cookies. Profile export **excludes** cookies.

## Architecture

- **React + Tailwind v4 + shadcn/ui (base-nova)**: desktop chrome, lists, settings, room UI, canvas danmaku overlay
- **Rust (`src-tauri`)**: `LiveSite` trait, SQLite, cookies, mpv process/embed/fullscreen, overlay window, danmaku WebSocket
- **mpv**: external process; Windows prefers `--wid` child embed when available

Design & plan:

- `docs/superpowers/specs/2026-07-23-rlive-tauri-design.md`
- `docs/superpowers/plans/2026-07-23-rlive-phase1.md`
- `docs/superpowers/changelog-2026-07-24.md`

## Compliance

Read-only aggregation only:

- Lists, play URLs, receive danmaku
- Optional user-pasted cookies for read-only APIs
- **No** official login write flows, payments, gifts, send-chat, or stream recording

This project is for learning and personal use. Respect platform terms of service and local laws.

## License

See repository `LICENSE` if present. Upstream Simple Live ideas are referenced for educational reimplementation; do not assume identical licensing of their assets.
