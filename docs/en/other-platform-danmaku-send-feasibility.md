# Other-platform danmaku sending feasibility

Updated 2026-07-26. This review concerns a viewer sending one ordinary text chat message with their own authorised account. It excludes gifts, payments, automated replies, and bulk or scheduled messages.

## Summary

| Platform | Current conclusion | rLive decision |
|----------|--------------------|----------------|
| Bilibili | **Implemented; controlled-account acceptance pending** | The only direct send path with an end-to-end code implementation and local HTTP-contract tests. Release still needs a permitted-room echo check with a controlled account. |
| Douyu | **Official authorisation required** | Public material supports receiving chat; rLive will not treat undocumented browser or persistent-connection packets as a sending API. Schedule work only after an explicit ordinary-viewer-chat write permission, documentation, and test environment are provided. |
| Huya | **Official authorisation required** | The current receive connection is an anonymous subscription path. Publicly visible material centres on partner SDKs; no ordinary-text contract suitable for a direct desktop client was confirmed. |
| Douyin | **Official authorisation required** | The signing service is for receiving live messages only and does not imply send permission. Any route must use an authorised live-SDK/interaction capability and first establish desktop suitability. |
| Kuaishou | **Not recommended** | rLive has no Kuaishou real-time receive path yet. A send-only feature has no verifiable product or technical loop until an official bidirectional interaction contract is available. Reclassify it as “Official authorisation required” if that contract is obtained. |

**Implemented; controlled-account acceptance pending** means that rLive has completed code and local HTTP-contract validation, but still needs a real-service echo check in a permitted room. **Official authorisation required** means that corresponding write scope must be granted in a contract or developer console before implementation can be scheduled. **Not recommended** is the current project decision, not a claim that the capability is impossible under every condition.

There is one shared conclusion for every platform: **replaying private web endpoints, WebSocket packets, browser fingerprints, or bypassing signing is not recommended.** Those paths have no stable contract, risk account enforcement, and must not become an rLive implementation promise.

## Evidence and viable routes

### Bilibili: Implemented; controlled-account acceptance pending

rLive already has a real-room-ID path, local cookie storage, backend send validation, and ordinary-chat echo flow. Its local HTTP contract verifies form fields, Cookie/CSRF headers, success, and rate-limit mapping. See [Bilibili danmaku sending research](bilibili-danmaku-send-research.md) for the request shape, login prerequisites, and safety boundary. Release still needs a real-service echo check with a controlled account in a permitted room.

This implementation does not turn into automation: it remains user-initiated ordinary text, with server-side validation and rate limits, no blind retries, and no gifts or payments.

### Douyu: Official authorisation required

Douyu's public Open Platform API directory labels room chat as “pull danmaku” and “connect danmaku”, and manages “obtain danmaku information for a specified room” as an application permission. The reviewed directory does not list an ordinary viewer live-text send API.

- Evidence: [Douyu Open Platform API directory](https://open.douyu.com/source/). Detailed endpoint contents can require a developer login.
- Current rLive integration: `src-tauri/src/danmaku/douyu.rs` implements room login, group join, heartbeat, and inbound events such as `chatmsg`; it has no authorised speaking identity or send capability.
- Preconditions: an explicit write scope, OAuth/application-credential flow, rate/error documentation, and a controlled room or account supplied for testing.

Until then, message types visible in a receive protocol or historical community packets must not be treated as a write API.

### Huya: Official authorisation required

rLive's Huya connection is an anonymous TARS/WebSocket push subscription. It carries neither an auditable user authorisation identity nor a product contract for ordinary text chat.

- Evidence: [Huya Open Platform](https://open.huya.com/) and [Huya game-distribution SDK documentation](https://dev.huya.com/docs/live-sdk/). The publicly visible material describes partner integration and SDK capabilities such as account, payment, watching, and starting a stream; the entry also includes Android integration material. This review did not confirm a plain-text writer API that a Tauri desktop client can directly use.
- Current rLive integration: `src-tauri/src/danmaku/huya.rs` constructs join/heartbeat packets and consumes push messages only.
- Preconditions: a Huya-confirmed desktop-capable SDK or API, authorisation method, write scope, moderation/rate limits, and shipping approval.

Even when a partner SDK can render native interaction, that does not imply that rLive may replace it with a custom HTTP or WebSocket composer.

### Douyin: Official authorisation required

The current Douyin live-chat flow first obtains a temporary signed WSS URL and then consumes push events. A signing result proves only that a receive connection can be created; it does not grant authority to write chat as a user.

- Evidence: [Douyin SDK live-capability solution](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/douyin-live-sdk/solution). The official material describes a complete live-interaction experience in a third-party app after user authorisation. That is an authorised SDK product, not a standalone desktop send API that can be inferred from rLive's receiving connection.
- Current rLive integration: `src-tauri/src/danmaku/douyin.rs` requests a trusted signer, establishes WSS, sends heartbeats/acks, and decodes inbound messages only. See [Douyin danmaku signing-service integration](douyin-danmaku-signing-service.md).
- Preconditions: confirmation of a desktop-compatible product form, application and user interaction-write permission, plus moderation, enforcement, rate-limit, and error-handling requirements.

Do not treat a browser Cookie, temporary signed URL, or web behavioural parameter as portable send credentials.

### Kuaishou: Not recommended

rLive's Kuaishou adapter currently uses public recommendation, category, and room-initial-state data; it has no real-time danmaku receiver. The essential loop of send → receive echo therefore cannot be validated in the application.

- Evidence: `src-tauri/src/sites/kuaishou.rs` and the [current capability table in the user guide](user-guide.md) both state that real-time Kuaishou danmaku is not supported. [Kuaishou Open Platform](https://open.kuaishou.cn/) provides a developer entry, but the publicly accessible material reviewed here did not confirm an unauthorised ordinary-live-text contract.
- Current decision: do not reverse engineer web requests, login state, or message signatures, and do not add a sender-only UI before receiving chat works.
- Reassessment: obtain an official real-time interaction/write capability first, then complete receiving, identity state, sending, echo, rate limiting, and failure recovery as one flow.

## Shared admission bar

Before any platform changes from “Official authorisation required” to “Implemented; controlled-account acceptance pending”, all of the following must be true:

1. A formal platform agreement, developer-console scope, or official document explicitly permits an app to send **ordinary live-room chat** for a user. Read-only chat, gifts, direct messages, host tools, or an embedded native page are not enough.
2. The platform-approved OAuth, SDK, or application credentials are used. The flow must not require copying browser cookies, tokens, or fingerprint values, nor give credentials to an unknown third party.
3. Backend support exists for testable identity state, room identity, text validation, deduplication/cooldown, rate limits, readable error codes, and authorisation revocation.
4. A composer is shown only after the permission is ready. Every transmission is user-initiated; there is no bulk, loop, schedule, auto-reply, automatic retry, gift, or payment capability.
5. Sending, echo, rejection, expired authorisation, network loss, and rate limiting have been tested with controlled accounts and permitted rooms. Logs and UI errors must not expose cookies, signatures, content, or raw upstream responses.
6. Product, legal, and platform-terms review has passed, and the feature can be disabled immediately if permission is revoked, an API is retired, or enforcement changes.

## Scope of this review

Public documentation can change, and some platform material is available only to enrolled partners. This page records the intersection of material publicly accessible on 2026-07-26 and rLive's existing integrations. Not finding an endpoint in a public directory does not prove that one cannot exist; it means rLive must not promise or build an unauthorised sending feature from that absence. Update this page and repeat controlled validation when a new official agreement, permission page, or SDK document becomes available.
