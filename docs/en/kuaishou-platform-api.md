# Kuaishou platform API documentation

Updated 2026-07-27. This page documents rLive's Kuaishou public-browse and playback adapter.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Recommendations and categories | Supported | Uses public recommendation/game-category data; only the verifiable first home page is exposed. |
| Category browse and search | Supported, scoped | Search finds game-category names and then shows that category's rooms; it is not creator/full-text search. |
| Room details and playback | Supported | Parses the live-room initial state for host, status, qualities, and stream URLs. |
| Account | Not integrated | No Kuaishou Cookie login or account action. |
| Real-time chat receive | Not supported | The room explicitly reports no support instead of retrying failed connections. |
| Chat sending | Not supported | No sender or web-packet replay feature. |

## Adapter surface and boundaries

The adapter implements the shared category, recommendation, category-room, search, room-detail, quality, and playback-URL methods. An anonymous home request has no stable reusable pagination cursor, so a second page deliberately returns empty instead of relabelling a fresh first page as page two. Category search behaves similarly honestly: no matched game means no result.

Playback prefers usable H.264 addresses and passes the required Referer/User-Agent through the local proxy. Actual qualities and URLs remain dependent on room state and upstream policy.

With no real-time receive path, rLive does not add a send-only feature. A future official desktop interaction capability should first establish receive, account state, errors, rate limits, and real echo before any user-operated sender is evaluated.

- Site and playback: `src-tauri/src/sites/kuaishou.rs`
