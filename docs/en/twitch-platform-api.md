# Twitch platform API documentation

Updated 2026-07-27. This page documents rLive's Twitch web-browse, HLS-playback, and anonymous-IRC-chat adapter. It is not Twitch Developer Console documentation.

## Capability matrix

| Capability | Status | rLive behaviour |
| --- | --- | --- |
| Categories, recommendations, search | Supported, first page | Uses public web context and GraphQL queries; no browse pagination to avoid repeated results. |
| Room details | Supported | Resolves stream title, game, viewers, cover, and live status by channel login. |
| HLS playback and qualities | Supported | Retrieves short-lived playback access and parses the HLS master playlist. |
| Real-time chat receive | Supported | Uses anonymous IRC WebSocket for ordinary channel chat. |
| Account/login | Not integrated | No Twitch Cookie/OAuth account operation. |
| Chat sending | Not supported | Anonymous IRC is receive-only in rLive. |

## Adapter surface

Twitch implements the shared category, room-list, search, room-detail, quality, and playback-URL methods. It obtains required browse context from the public web bootstrap before issuing the site's GraphQL queries. Because that access only reliably yields a first result page, `page > 1` intentionally returns empty rather than bypassing integrity controls or synthesising pagination.

For playback, rLive requests a short-lived HLS access token by channel login and immediately parses the master playlist. Signed URLs are not retained in frontend caches; playback and quality switches refresh them to avoid stale-token reuse.

## Chat and boundaries

`danmaku_connect` joins the channel through anonymous IRC WebSocket and receives chat. Anonymous identity provides no write permission, so rLive has no Twitch chat sender, subscriptions, gifts, payments, or channel-management flow.

Availability, region, channel status, and web interfaces can change. Follow Twitch terms and local law.

- Site and playback: `src-tauri/src/sites/twitch.rs`
- Anonymous IRC chat: `src-tauri/src/danmaku/twitch.rs`
