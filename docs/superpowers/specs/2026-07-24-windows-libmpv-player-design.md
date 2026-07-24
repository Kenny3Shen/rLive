# Windows in-process libmpv player

## Decision
Replace external `mpv.exe` child process with dynamically loaded `libmpv` on Windows.

## Architecture
- `player/session.rs` — pure epoch lifecycle (unit-tested without media I/O)
- `player/engine.rs` — `MediaEngine` trait + shipped `FakeEngine` for deterministic tests
- `player/libmpv.rs` — Windows `LibMpvEngine` (LoadLibrary `libmpv-2.dll` / `mpv-2.dll`)
- `player/embed_host.rs` — same-process child HWND for `wid`
- `player/mod.rs` — `PlayerManager` delegates to engine; no `std::process::Child`

## Teardown
- `stop` / `shutdown` call `mpv_terminate_destroy` and retire embed host
- CloseRequested: `destroy_player` then `process::exit(0)` (avoid WebView2 hang)

## Runtime requirement
`libmpv-2.dll` (or `mpv-2.dll`) must be discoverable next to the exe or via known install paths.
