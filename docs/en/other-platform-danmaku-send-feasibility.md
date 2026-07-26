# Other-platform danmaku sending feasibility

Updated 2026-07-27. This review concerns a viewer sending one ordinary text chat message with their own account. It excludes gifts, payments, automated replies, and bulk or scheduled messages.

## Summary

| Platform | Current conclusion | rLive decision |
|----------|--------------------|----------------|
| Bilibili | **Implemented; controlled-account acceptance pending** | The only direct send path with an end-to-end code implementation and local HTTP-contract tests. Release still needs a permitted-room echo check with a controlled account. |
| Douyu | **Implemented with local Cookie authentication** | A user can send one ordinary text message after saving their own local account Cookie through QR login or manual input. This is not a claim that Douyu provides rLive a public write API; real-service acceptance and terms compliance remain the user's responsibility. |
| Huya | **Implemented with local Cookie authentication** | A user can send one ordinary text message after manually saving their own local account Cookie. This is not a claim that Huya provides rLive a public write API; real-service acceptance and terms compliance remain the user's responsibility. |
| Douyin | **Official authorisation required** | The signing service is for receiving live messages only and does not imply send permission. Any route must use an authorised live-SDK/interaction capability and first establish desktop suitability. |
| Kuaishou | **Not recommended** | rLive has no Kuaishou real-time receive path yet. A send-only feature has no verifiable product or technical loop until an official bidirectional interaction contract is available. Reclassify it as “Official authorisation required” if that contract is obtained. |

**Implemented; controlled-account acceptance pending** means that rLive has completed code and local HTTP-contract validation, but still needs a real-service echo check in a permitted room. **Implemented with local Cookie authentication** means that rLive has a local, user-operated send flow which validates the saved account Cookie, text, and a short cooldown; it does **not** establish that a platform has granted rLive a public application write scope or that any particular account or room will accept a message. **Official authorisation required** means that corresponding write scope must be granted in a contract or developer console before implementation can be scheduled. **Not recommended** is the current project decision, not a claim that the capability is impossible under every condition.

The Bilibili, Douyu, and Huya senders are deliberately narrow local-account features, not a general packet-replay or automation facility: all three share the default-off device-local `danmaku_send_enabled` switch while still validating their own Cookie and platform prerequisites; the switch is omitted from profile export/import. rLive never uploads the saved Cookie, accepts arbitrary packet/fingerprint input, batch-sends, schedules, auto-replies, or retries ambiguous writes. Once a send command resolves locally, the current frontend session shows an amber pending-platform-echo marker, but it is not a platform echo and is never automatically merged with or removed by an identical real echo. A successful local write still needs normal room-chat echo and real-service verification. Users must independently confirm that their own account, room, and use comply with the platform terms and applicable law.

## Evidence and viable routes

### Bilibili: Implemented; controlled-account acceptance pending

rLive already has a real-room-ID path, local cookie storage, backend send validation, and ordinary-chat echo flow. Alongside Bilibili's own login prerequisites, sending requires the shared default-off device-local `danmaku_send_enabled` switch used by Douyu and Huya too. Its local HTTP contract verifies form fields, Cookie/CSRF headers, success, and rate-limit mapping. See [Bilibili danmaku sending research](bilibili-danmaku-send-research.md) for the request shape, login prerequisites, and safety boundary. Release still needs a real-service echo check with a controlled account in a permitted room.

This implementation does not turn into automation: it remains user-initiated ordinary text, with server-side validation and rate limits, no blind retries, and no gifts or payments.

### Douyu: Implemented with local Cookie authentication

The user-operated Douyu composer now opens a short-lived authenticated danmaku session and submits one ordinary text message. Users must also first enable the shared **启用发送功能** switch at the top of **Settings → Account**. Under **Settings → Account → 斗鱼**, they can obtain the local account Cookie with QR login or enter it manually. The sender requires `acf_username`, `acf_stk`, and `acf_ltkid` (the legacy `_acf_ltkid_` spelling is also accepted). Cookie data remains in the device-local account store and is never shown in logs or sent to a third-party signer.

- Current rLive integration: `src-tauri/src/danmaku/douyu.rs` implements room login, group join, heartbeat, inbound `chatmsg` events, and the authenticated one-message sender. Before a network write it rechecks the shared local switch, a numeric room ID, a non-empty single-line message of at most 100 UTF-16 code units, and a conservative 3-second per-room cooldown. It does not retry. Once the write command resolves locally, the frontend shows only a **you / submitted locally, awaiting platform echo** marker; normal room chat remains the independent delivery signal.
- Public-material limitation: [Douyu's Open Platform API directory](https://open.douyu.com/source/) labels room chat as “pull danmaku” and “connect danmaku”; the reviewed directory does not document a public ordinary-viewer write API. The implementation must therefore not be described as an officially granted API integration.
- User responsibility: a socket write or later room echo is not a substitute for real-service verification. Test only with an account and room where you are permitted to speak, follow server-side moderation/rate limits, and comply with Douyu's current terms.

The implementation sends only when the user presses Send. It does not add gifts, payments, bulk/scheduled sending, auto-replies, automatic retries, or Cookie export.

### Huya: Implemented with local Cookie authentication

rLive now resolves the current Huya room and uses the user's manually stored Cookie to establish an authenticated send session for one ordinary text message. Users must also first enable the shared **启用发送功能** switch at the top of **Settings → Account**. Under **Settings → Account → 虎牙**, paste a Cookie with a numeric account ID (`yyuid` or `udb_uid`) and opaque login proof (`udb_n` or `udb_cred`). Huya QR login is not currently offered, so manual Cookie input is required. The Cookie stays in the device-local account store and is never logged or uploaded to another service.

- Current rLive integration: `src-tauri/src/danmaku/huya.rs` handles TARS/WebSocket room traffic and the authenticated one-message sender. The sender rechecks the shared local switch, room metadata, Cookie fields, a non-empty single-line message of at most 30 UTF-16 code units, and a short local cooldown before sending. It does not retry ambiguous writes. Once the write command resolves locally, the frontend shows only a **you / submitted locally, awaiting platform echo** marker; normal room chat remains the independent delivery signal.
- Public-material limitation: [Huya Open Platform](https://open.huya.com/) and its [game-distribution SDK documentation](https://dev.huya.com/docs/live-sdk/) describe partner/SDK capabilities, but this review did not confirm a public ordinary-text writer API suitable for a Tauri desktop client. The local-Cookie sender is not an assertion of a platform-issued application write contract.
- User responsibility: real-service verification, moderation/rate limits, room eligibility, and compliance with Huya's terms remain with the user. A local send result alone does not guarantee that Huya accepted or displayed the message.

The feature remains strictly user initiated. It does not support gifts, payments, batch/scheduled sends, auto-replies, automatic retries, or Cookie export.

### Douyin: Official authorisation required

The current Douyin live-chat flow first obtains a temporary signed WSS URL and then consumes push events. A signing result proves only that a receive connection can be created; it does not grant authority to write chat as a user.

- Evidence: [Douyin SDK live-capability solution](https://developer.open-douyin.com/docs/resource/zh-CN/dop/ability/douyin-live-sdk/solution). The official material describes a complete live-interaction experience in a third-party app after user authorisation. That is an authorised SDK product, not a standalone desktop send API that can be inferred from rLive's receiving connection.
- Current rLive integration: `src-tauri/src/danmaku/douyin.rs` calls the fixed local signer at `http://127.0.0.1:18080/sign`, establishes WSS, sends heartbeats/acks, and decodes inbound messages only. See [Douyin danmaku signing-service integration](douyin-danmaku-signing-service.md).
- Preconditions: confirmation of a desktop-compatible product form, application and user interaction-write permission, plus moderation, enforcement, rate-limit, and error-handling requirements.

Do not treat a browser Cookie, temporary signed URL, or web behavioural parameter as portable send credentials.

### Kuaishou: Not recommended

rLive's Kuaishou adapter currently uses public recommendation, category, and room-initial-state data; it has no real-time danmaku receiver. The essential loop of send → receive echo therefore cannot be validated in the application.

- Evidence: `src-tauri/src/sites/kuaishou.rs` and the [current capability table in the user guide](user-guide.md) both state that real-time Kuaishou danmaku is not supported. [Kuaishou Open Platform](https://open.kuaishou.cn/) provides a developer entry, but the publicly accessible material reviewed here did not confirm an unauthorised ordinary-live-text contract.
- Current decision: do not reverse engineer web requests, login state, or message signatures, and do not add a sender-only UI before receiving chat works.
- Reassessment: obtain an official real-time interaction/write capability first, then complete receiving, identity state, sending, echo, rate limiting, and failure recovery as one flow.

## Safety and responsibility boundary

The implemented Bilibili, Douyu, and Huya flows, and any future sender, must retain all of the following:

1. A composer is available only when the default-off shared local send switch and the platform's own authenticated-account prerequisites are both met; the switch is not exported or imported. It only sends a single ordinary live-room text message after a direct user action. There is no bulk, loop, schedule, auto-reply, automatic retry, gift, or payment capability.
2. Cookie values remain in the local SQLite account store. They must not be logged, exported in a profile, displayed back to the user, or transmitted to an unrelated service.
3. Backend code validates account readiness, room identity, text, and a conservative local cooldown before attempting a network write. The platform's own moderation and rate limits remain authoritative.
4. Once a write command resolves locally, the application creates only a current-session local pending marker (the list says **you / submitted locally, awaiting platform echo**; floating chat is amber `【我·待平台回显】`). It never impersonates platform chat and matching text never automatically merges, confirms, or removes it. Users should still wait for the normal room connection to echo a message and treat an ambiguous network result as unknown rather than resending automatically.
5. Each user is responsible for real-service verification with an account and room where they are allowed to speak, and for complying with the current platform terms, moderation rules, and local law. A browser Cookie is not proof of an official application write entitlement.
6. If a platform publishes an official OAuth/SDK/write contract, changes its rules, rejects the flow, or revokes access, reassess and disable the feature as appropriate before representing it as supported.

## Scope of this review

Public documentation can change, and some platform material is available only to enrolled partners. This page records the intersection of material publicly accessible on 2026-07-27 and rLive's existing integrations. Not finding an endpoint in a public directory does not prove that one cannot exist, and implementing a local-Cookie flow does not prove official application authorisation or durable real-service acceptance. Update this page and repeat controlled validation when a new official agreement, permission page, SDK document, or platform behaviour change becomes available.
