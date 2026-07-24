# Web player (no mpv) — design note

**Date:** 2026-07-25  
**Status:** Default room path  

## Why

libmpv + HWND / force-window left orphan top-level windows after leave-room.  
Tauri WebView cannot stack HTML over a child HWND.

## Approach

```
site_get_play_urls → PlayUrl{url, headers}
        ↓
stream_proxy_start → http://127.0.0.1:{port}/live  (inject Referer/UA)
        ↓
mpegts.js (MSE) + <video> in main WebView
        ↓
CanvasDanmaku stacked in the same DOM (Simple Live–like)
```

Leave room = React unmount → destroy MSE + `stream_proxy_stop` → **no native video HWND**.

## Commands

| Command | Role |
|---------|------|
| `stream_proxy_start` | Bind localhost, return local URL |
| `stream_proxy_stop` | Abort proxy task |

## Assets

- `public/mpegts.js` — vendored UMD (no npm github deps on Windows)

## Legacy

Rust `player/*` (libmpv) remains for optional recovery; room UI no longer opens it by default.
