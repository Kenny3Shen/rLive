# rLive

**rLive** is a desktop live-stream aggregator built with **Tauri 2 + React + TypeScript + Rust**.  
It is an independent rewrite inspired by [Simple Live](https://github.com/June6699/dart_simple_live) / [xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live) — **not** an official client.

> 简简单单的看直播 — watch live streams simply.

## Phase-1 features

| Area | Status |
|------|--------|
| Desktop shell (Linux + Windows) | Done |
| Bilibili: categories, recommend, search, room detail, play URLs | Done |
| External **mpv** playback | Done (system/sidecar binary) |
| Bilibili danmaku overlay | Done |
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

## Develop

```bash
bun install
bun run tauri dev
```

Frontend only (no Tauri commands):

```bash
bun run dev
```

Build:

```bash
bun run build
cd src-tauri && cargo test --lib
bun run tauri build
```

## Architecture

- **React**: desktop UI, lists, settings, danmaku overlay
- **Rust (`src-tauri`)**: site parsers (`LiveSite` trait), SQLite, cookies, mpv process, danmaku WebSocket
- **mpv**: external player process (separate window in phase 1)

Design & plan:

- `docs/superpowers/specs/2026-07-23-rlive-tauri-design.md`
- `docs/superpowers/plans/2026-07-23-rlive-phase1.md`

## Compliance

Read-only aggregation only:

- Lists, play URLs, receive danmaku
- Optional user-pasted cookies for read-only APIs
- **No** official login write flows, payments, gifts, send-chat, or stream recording

This project is for learning and personal use. Respect platform terms of service and local laws.

## License

See repository `LICENSE` if present. Upstream Simple Live ideas are referenced for educational reimplementation; do not assume identical licensing of their assets.
