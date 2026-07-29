# rLive — Agent Instructions

## Post-change validation

This project is developed under **WSL/Linux** (`/home/shenss/python/rLive`) and run on Windows when needed.

After a feature, fix, UI change, dependency, script, or runtime configuration change:

- Do **not** automatically sync to Windows or run a Windows/Tauri build. Run those steps only when the user explicitly requests them.
- Run the focused functional checks that best cover the change, using the project's existing test, type-check, lint, or local runtime tools as appropriate.
- If a check exposes an error caused by the change, investigate and fix it, then rerun the relevant check until it passes or an external blocker is clearly reported.
- For docs-only or planning-only changes, runtime testing is not required.

Before handing off, report the functional checks performed and any known limitation or external blocker.

## Product context (short)

- Tauri 2 + React + Tailwind + shadcn-style UI
- Desktop live client: **web MSE player** (`mpegts.js` + `stream_proxy`), not mpv
- Sites ready: **Bilibili / Huya / Douyu** (lists + play + danmaku); **Douyin** (SSR 首屏浏览 + 房间/播放 + 本地签名实时弹幕，登录 Cookie 搜索); Kuaishou stub
- Danmaku: settings (opacity / size / speed / shield), list + canvas + SC panel
- UI language: **Chinese primary** chrome (Simple Live–style); docs: `docs/zh/*` first, `docs/en/*` secondary
- User-facing docs: `README.md`, `docs/README.md`
