# Player performance research

Updated 2026-07-25. This is the English companion to [播放器性能调研](../zh/播放器性能调研.md).

## Decision

Keep the Web MSE architecture. rLive already uses Rust for a localhost header-injecting proxy, `mpegts.js` 1.8 for FLV/TS → fMP4 transmuxing, and WebView2/Chromium `<video>` for hardware decode. Replacing that with a “Rust player” does not automatically make decode faster; it would add native-window/D3D composition, transparent control/canvas overlay, DLL distribution, and codec-license work.

The recommended order is: **measure → A/B-test the mpegts worker → strengthen protocol-specific proxy paths → consider a Rust transmux proof of concept only when profiling proves it is needed.**

## Current path and gaps

```text
stream URL + headers → Rust stream_proxy → mpegts.js → MSE/<video> hardware decode
                                      ↘ React controls + Canvas danmaku
```

The player already uses stash buffering, latency chasing (2.5s / 0.4s), SourceBuffer cleanup, and fresh video/MediaSource replacement on room re-entry. The proxy reuses a reqwest client and connection pool for a continuous HTTP-FLV stream.

It explicitly keeps `enableWorker: false`, and currently collects no first-frame, `getVideoPlaybackQuality()`, `STATISTICS_INFO`, live-edge, rebuffer, or long-task telemetry. Do not attribute a stutter to JS, decode, network, MSE, or Canvas before adding those measurements.

## Practical roadmap

1. Add per-session telemetry: start-to-playing, decoded/dropped frames, buffered/live-edge distance, `waiting`/`stalled`, mpegts statistics, and main-thread/Canvas budget. Compare P50/P95 first-frame time, rebuffer per minute, dropped-frame ratio, latency, and CPU across platform/quality/protocol/WebView2 version.
2. Run a feature-gated Windows WebView2 A/B test of `enableWorker: true`; keep the current main-thread fallback. Investigate Worker MSE only where `MediaSource.canConstructInDedicatedWorker` is available. Test 1080p/60, busy danmaku, and network jitter before rollout.
3. Do not globally disable stash buffering. It can lower latency for stable networks, but mpegts documents that it becomes more fragile under jitter.
4. Treat HLS separately. The current proxy follows one continuous upstream URL; it is not playlist/segment/Range-aware, and mpegts.js is not a complete HLS player. A real HLS path needs safe playlist/segment rewriting plus `hls.js` or verified native Edge HLS.
5. Only profile-driven Rust PoC: [`transmux`](https://crates.io/crates/transmux) and [`scuffle-flv`](https://crates.io/crates/scuffle-flv) are reasonable container-layer research starting points, but still require codec config, timestamps, recovery, backpressure, and MSE handoff. They do not replace browser decode.

Native FFmpeg/libmpv/GStreamer/VLC embedding and a WebCodecs rewrite are not near-term performance fixes. `ffmpeg-next` is an FFmpeg FFI wrapper, while WebCodecs still requires demux plus custom A/V sync/render/fallback logic.

## Sources

- [mpegts.js](https://github.com/xqq/mpegts.js)
- [Media Source Extensions](https://w3c.github.io/media-source/)
- [MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [`transmux`](https://crates.io/crates/transmux), [`scuffle-flv`](https://crates.io/crates/scuffle-flv)
- [`ffmpeg-next`](https://github.com/zmwangx/rust-ffmpeg)
