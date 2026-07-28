# rLive

> **Chinese version:** [README.md](README.md)

rLive is a desktop live-stream aggregator built with **Tauri 2, React, TypeScript, and Rust**. It is an independent, non-official rewrite inspired by [Simple Live](https://github.com/June6699/dart_simple_live) and [dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live).

> Watch live streams simply.

## Feature status

| Feature | Status |
| --- | --- |
| Desktop shell (Linux / Windows) | Done |
| Light / dark UI with shadcn/ui | Done; the Chinese-first UI uses one sidebar toggle |
| Bilibili browse / categories / search / playback / danmaku | Done; a shared local send switch plus a valid Cookie enable manual single messages and room-session auto-send |
| Huya browse / rooms / playback / danmaku | Done; a shared local send switch plus a manually saved local Cookie enable manual single messages and room-session auto-send |
| Douyu browse / rooms / playback / danmaku | Done; sending succeeded in a personal room; room-session auto-send still uses per-send platform confirmation/real-echo handling |
| Douyin browse / categories / rooms / playback | Done; recommendations/categories reliably expose only the SSR first page; rooms prefer SSR plus the public reflow endpoint, and search needs a complete logged-in Cookie (web verification can still apply) |
| Douyin real-time danmaku | Done; after configuring a signer, receives chat, gifts, likes, entries, and common social events |
| Kuaishou browse / categories / game-category search / rooms / playback | Done; search matches game categories only and real-time danmaku is not yet supported |
| Twitch browse / categories / search / rooms / HLS playback / anonymous IRC danmaku | Done; public browsing reliably exposes only the first page |
| Web playback | Done; `mpegts.js` with the local `stream_proxy` and auto-hiding transparent controls |
| Room sidebar and canvas danmaku | Done; host information plus Danmaku / SC / Follows / Settings tabs |
| Danmaku selection actions | Done; click a normal message to copy it or use `+1` to send the exact same text once on a supported platform |
| In-room danmaku settings | Done; area, lanes, opacity, size, weight, speed, repeat grouping, gift filter, shield words, and session-only auto-send |
| Bilibili Super Chat panel | Done; safe avatar handling, sender details, amount, and full message |
| Follows, tags, live refresh, and direct room switching | Done |
| Watch history and viewing statistics | Done; statistics summarizes stored room-entry records and does not infer watch duration |
| IPTV discovery and a separate player page | Done; public and device-private M3U sources plus HLS, MPEG-TS, and FLV playback |
| Settings | Done; shared Bilibili/Douyu/Huya send switch, theme, proxy, QR/manual Cookie login, Huya manual Cookie input, Douyin signer, custom IPTV M3U, quality preference, About, and profile import/export |

Not currently in scope: TV UI, multiple simultaneous rooms, recording/downloads, gifts/payments, batch sending, auto-replies, and automatic retry.

## Documentation

| Resource | Link |
| --- | --- |
| Documentation index, including Chinese counterparts | [docs/README.md](docs/README.md) |
| User guide | [docs/en/user-guide.md](docs/en/user-guide.md) |
| Architecture | [docs/en/architecture.md](docs/en/architecture.md) |
| Bilibili platform API | [docs/en/bilibili-platform-api.md](docs/en/bilibili-platform-api.md) |
| Douyu platform API | [docs/en/douyu-platform-api.md](docs/en/douyu-platform-api.md) |
| Huya platform API | [docs/en/huya-platform-api.md](docs/en/huya-platform-api.md) |
| Douyin platform API | [docs/en/douyin-platform-api.md](docs/en/douyin-platform-api.md) |
| Kuaishou platform API | [docs/en/kuaishou-platform-api.md](docs/en/kuaishou-platform-api.md) |
| Twitch platform API | [docs/en/twitch-platform-api.md](docs/en/twitch-platform-api.md) |
| Player performance research | [docs/en/player-performance-research.md](docs/en/player-performance-research.md) |

The primary product chrome is Chinese. Source comments and contribution material may use English or Chinese.

## Requirements

- [Rust](https://www.rust-lang.org/) stable
- [Bun](https://bun.sh/)
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

No external `mpv` installation is required. rLive uses Web MSE playback with `mpegts.js` and a Rust local proxy.

### Recommended Windows layout

| Component | Path |
| --- | --- |
| Project mirror | `D:\dev\rLive` |
| Rust | `D:\dev\rust\{cargo,rustup}` |
| Visual Studio Build Tools | `D:\VS\BuildTools` |
| Build temporary directory | `D:\Temp\build` |

## Development

Install dependencies and run the desktop app:

```bash
bun install
bun run tauri dev
```

Run the frontend only:

```bash
bun run dev
```

Build and test:

```bash
bun run build
bun run test:unit
cd src-tauri && cargo test --lib
bun run tauri build
```

### Windows delivery from WSL

The project is developed in WSL and shipped from the Windows mirror. From the repository root, sync and build with:

```bash
./scripts/build-windows-from-wsl.sh
```

The expected executable is:

```text
D:\dev\rLive\src-tauri\target\release\rlive.exe
```

See [AGENTS.md](AGENTS.md) for delivery rules.

## Quick start

1. rLive opens Bilibili by default. Use the header to switch among Bilibili, Douyu, Huya, Douyin, Kuaishou, and Twitch.
2. Open a room from Home, Categories, or Search. The icon-only Back control returns to the source page for in-app navigation, or Home for a directly opened room URL.
3. For **Bilibili danmaku**, open **Settings → Account** and use QR login or paste a Cookie manually. Normal chat preserves validated Bilibili CDN image emotes in order. After an unexpected disconnect, rLive rotates gateways, refreshes the short-lived token, and reconnects. To send on Bilibili, Douyu, or Huya, first enable **启用发送功能** at the top of **Settings → Account**. This default-off, device-local switch does not replace platform account requirements: Bilibili needs `SESSDATA` and `bili_jct`; Huya needs a manually saved Cookie with a numeric account ID (`yyuid` or `udb_uid`) and an opaque login proof (`udb_n` or `udb_cred`). Douyu supports QR/manual complete local Cookie storage; its current-web sender has successfully sent in a personal room. Each send still treats `chatres(res=0)` as platform acceptance and the normal receiver's real echo as the display condition; see the [Douyu platform API documentation](docs/en/douyu-platform-api.md). These are user-operated local-Cookie features, not claims of a public platform write API; use them only where you may speak and follow platform terms.
4. The room-side tabs are **Danmaku / SC / Follows / Settings**. In **Settings**, adjust display area, line count, opacity, font size and weight, speed, same-content grouping, gift filtering, and shield words. Bilibili, Douyu, and Huya also expose a room-session **Auto-send danmaku** control here: it is off by default and is not saved, and can turn on only when the shared send permission, that platform's Cookie/send status, and text validation are valid. It waits 10 seconds before its first send, collapses line breaks and repeated whitespace to one space, splits text into looping fragments of at most 15 user-visible characters without exceeding the platform UTF-16 limit, and starts sends at least 10 seconds apart. Editing text, switching rooms (which clears the session text), leaving the page, or any send failure immediately turns it off and shows the reason; failures are not retried automatically. Changes apply immediately and shield words are saved automatically. Click a normal message to choose the icon-and-text **Copy** or **+1** actions: Copy writes to the clipboard; `+1` submits the exact same text once (it never appends a literal `+1`). A local submission is not delivery; the list and floating layer display it only after the platform's real room echo.
5. The sidebar header shows the host avatar, name, platform, and current heat. **SC** currently shows Bilibili paid messages with a safe identity deck, prominent amount, and full text. Missing avatars fall back to the sender initial; rLive does not request a profile API. **Follows** can switch directly to any followed room. The Follows page provides **All / Live / Offline** status filters and live-status refresh.
6. Player controls overlay the bottom of the video and hide after idle playback. Pointer, click, or keyboard activity reveals them again; menus keep them open. With the picture focused, `Space` / `K` plays or pauses, `M` mutes, and `F` toggles fullscreen. Refresh is left of pause; quality and line selectors show only the current selection.
7. A single sun / moon button above **Settings** in the sidebar switches between light and dark mode.
8. **Douyin / Kuaishou / Twitch:** Douyin supports anonymous first-page browse and playback. Searching needs a complete web Cookie saved through QR login or manual input under **Settings → Account**. Recommendations and categories currently expose only the first page: rLive does not use a Cookie or SSR offset to fabricate **Load more**, and Douyin web verification can still limit QR login or search. Room playback first resolves the SSR internal room id and then uses the public reflow data. Before joining Douyin chat, enter the complete endpoint of a signer you operate or trust under **Settings → Account → Douyin real-time danmaku**. rLive permits HTTPS endpoints or HTTP endpoints on `localhost`, `127.0.0.1`, or `::1`; it never follows redirects, and loopback HTTP bypasses the app proxy. Kuaishou supports public browsing, categories, game-category search, rooms, and playback, but not real-time danmaku. Twitch supports lists, categories, search, rooms, HLS playback, and anonymous IRC chat; it intentionally has no browse pagination.
9. **IPTV:** the sidebar entry opens a discovery page and never starts the first stream automatically. Choose a daily-updated IPTV-org Chinese-language, mainland-China, East-Asian, or general public source. To load a source you are authorised to use, save an HTTP(S) M3U URL under **Settings → Network**; it appears as **Custom source** on the IPTV page. Search accepts multiple channel/group keywords, popular groups can be selected quickly, and long lists expand on demand. Selecting a channel opens the separate immersive `/iptv/play` page for HLS, MPEG-TS, or FLV playback. Back restores the selected source, category, and search filters. The custom URL remains device-local and is excluded from routes, history, and profile import/export.

## Architecture at a glance

| Layer | Technology |
| --- | --- |
| UI | React, Tailwind v4, shadcn/ui; Chinese-first chrome |
| App shell | Home, follows, categories, history, IPTV discovery/player, settings, and room pages |
| Playback | `mpegts.js` for live streams; `hls.js` / `mpegts.js` for IPTV; Rust `stream_proxy` for same-origin stream fetching |
| Sites | Rust `LiveSite` implementations for Bilibili, Huya, Douyu, Douyin, Kuaishou, and Twitch |
| Danmaku | Rust WebSocket transports → Tauri `danmaku` events → batched list, on-demand canvas, SC, settings, and follows panels |
| Storage | SQLite for follows, history, settings, and local Cookies |

For details, see the [English architecture guide](docs/en/architecture.md). The [documentation index](docs/README.md) links to its Chinese counterpart.

## Compliance

rLive focuses on public lists, playback metadata, and receiving danmaku. Bilibili, Douyin, and Douyu QR/manual Cookie login plus Huya manual Cookie input are user initiated and stored locally. Bilibili, Douyu, and Huya offer manual single-message sending plus a default-off, non-persistent room-session auto-send control operated from the room-side settings; it still uses the same permission, Cookie, text, and cooldown checks. Douyu's current web authentication/confirmation flow has successfully been verified in a personal room. A local write still is not display delivery: local submission, platform confirmation where available, and real room echo remain separate stages. No local-Cookie path establishes a public platform API grant or guarantees delivery; use it only in permitted rooms and comply with current platform terms.

rLive does not provide payments, gifts, batch sending, auto-replies, automatic retry of an unknown result, or recording. Use it for personal and educational purposes, and comply with platform terms and local law.

## License

See the repository `LICENSE` when present. Simple Live is a learning reference only; its assets are not implicitly reusable.
