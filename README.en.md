# rLive

> **Chinese version:** [README.md](README.md)

rLive is a desktop live-stream aggregator built with **Tauri 2, React, TypeScript, and Rust**. It is an independent, non-official rewrite inspired by [Simple Live](https://github.com/June6699/dart_simple_live) and [dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live).

> Watch live streams simply.

## Feature status

| Feature | Status |
| --- | --- |
| Desktop shell (Linux / Windows) | Done |
| Light / dark UI with shadcn/ui | Done; the Chinese-first UI uses one sidebar toggle |
| Bilibili browse / categories / search / playback / danmaku | Done; supports one user-initiated normal chat message with local consent and Cookie |
| Huya browse / rooms / playback / danmaku | Done; supports a single user-initiated ordinary message per action with a manually saved local Cookie |
| Douyu browse / rooms / playback / danmaku | Done; supports a single user-initiated ordinary message per action with a QR/manual local Cookie |
| Douyin browse / categories / rooms / playback | Done; public SSR lists reliably expose only the first page; search needs a complete logged-in Cookie saved by QR login or manual input |
| Douyin real-time danmaku | Done; uses the fixed local `http://127.0.0.1:18080/sign` endpoint for chat, gifts, likes, entries, and common social events |
| Kuaishou browse / categories / game-category search / rooms / playback | Done; search matches game categories only and real-time danmaku is not yet supported |
| Twitch browse / categories / search / rooms / HLS playback / anonymous IRC danmaku | Done; public browsing reliably exposes only the first page |
| Web playback | Done; `mpegts.js` with the local `stream_proxy` and auto-hiding transparent controls |
| Room sidebar and canvas danmaku | Done; host information plus Danmaku / SC / Follows / Settings tabs |
| Danmaku selection actions | Done; click a normal message to copy it or use `+1` to send the exact same text once on a supported platform |
| In-room danmaku settings | Done; area, lanes, opacity, size, weight, speed, repeat grouping, gift filter, and shield words |
| Bilibili Super Chat panel | Done; safe avatar handling, sender details, amount, and full message |
| Follows, tags, live refresh, and direct room switching | Done |
| Watch history | Done |
| IPTV discovery and a separate player page | Done; public and device-private M3U sources plus HLS, MPEG-TS, and FLV playback |
| Settings | Done; theme, proxy, Bilibili/Douyin/Douyu QR or manual Cookie login, Huya manual Cookie input, custom IPTV M3U, quality preference, and profile import/export |

Not currently in scope: TV UI, multiple simultaneous rooms, recording/downloads, gifts/payments, and batch/scheduled/automatic sends.

## Documentation

| Resource | Link |
| --- | --- |
| Documentation index, including Chinese counterparts | [docs/README.md](docs/README.md) |
| User guide | [docs/en/user-guide.md](docs/en/user-guide.md) |
| Architecture | [docs/en/architecture.md](docs/en/architecture.md) |
| Bilibili danmaku sending research | [docs/en/bilibili-danmaku-send-research.md](docs/en/bilibili-danmaku-send-research.md) |
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
3. For **Bilibili danmaku**, open **Settings → Account** and use QR login or paste a Cookie manually. Normal chat preserves validated Bilibili CDN image emotes in order. After an unexpected disconnect, rLive rotates gateways, refreshes the short-lived token, and reconnects. To send one normal message, explicitly enable the Bilibili danmaku sending permission and save a Cookie containing `SESSDATA` and `bili_jct`; the composer appears in the middle of the player controls and submits on Enter or click. **Douyu** uses QR/manual local Cookie login and needs `acf_username`, `acf_stk`, and `acf_ltkid` to enable its one-message composer; **Huya** currently uses manual local Cookie input with a numeric account ID (`yyuid` or `udb_uid`) plus an opaque login proof (`udb_n` or `udb_cred`). The latter two are user-operated local-Cookie features, not claims of a public platform write API; verify acceptance in a permitted room and follow platform terms.
4. The room-side tabs are **Danmaku / SC / Follows / Settings**. In **Settings**, adjust display area, line count, opacity, font size and weight, speed, same-content grouping, gift filtering, and shield words. Changes apply immediately and shield words are saved automatically. Click a normal message to choose the icon-only **Copy** or **+1** actions: Copy writes to the clipboard; on Bilibili, Douyu, or Huya with sending prerequisites ready, **+1** submits the exact same text once (it never appends a literal `+1`).
5. The sidebar header shows the host avatar, name, platform, and current heat. **SC** currently shows Bilibili paid messages with a safe identity deck, prominent amount, and full text. Missing avatars fall back to the sender initial; rLive does not request a profile API. **Follows** can switch directly to any followed room. The Follows page provides **All / Live / Offline** status filters and live-status refresh.
6. Player controls overlay the bottom of the video and hide after idle playback. Pointer, click, or keyboard activity reveals them again; menus keep them open. With the picture focused, `Space` / `K` plays or pauses, `M` mutes, and `F` toggles fullscreen. Refresh is left of pause; quality and line selectors show only the current selection.
7. A single sun / moon button above **Settings** in the sidebar switches between light and dark mode.
8. **Douyin / Kuaishou / Twitch:** Douyin supports anonymous first-page browse and playback. For search, save a complete web Cookie through QR login or manual input under **Settings → Account**. Douyin danmaku always calls the local `http://127.0.0.1:18080/sign` companion service; start a compatible signer before entering the room. That request bypasses the global proxy and cannot redirect to a remote endpoint. Kuaishou supports public browsing, categories, game-category search, rooms, and playback, but not real-time danmaku. Twitch supports lists, categories, search, rooms, HLS playback, and anonymous IRC chat; it intentionally has no browse pagination.
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

rLive focuses on public lists, playback metadata, and receiving danmaku. Bilibili, Douyin, and Douyu QR/manual Cookie login plus Huya manual Cookie input are user initiated and stored locally. Bilibili, Douyu, and Huya support a single user-initiated ordinary text message per action. Douyu/Huya local-Cookie sends do not establish a public platform API grant or guarantee delivery; users must verify the real service result in a permitted room and comply with current platform terms.

rLive does not provide payments, gifts, batch/automatic/scheduled sends, or recording. Use it for personal and educational purposes, and comply with platform terms and local law.

## License

See the repository `LICENSE` when present. Simple Live is a learning reference only; its assets are not implicitly reusable.
