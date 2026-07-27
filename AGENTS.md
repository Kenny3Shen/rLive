# rLive — Agent Instructions

## Mandatory post-change delivery (Windows)

This project is developed under **WSL/Linux** (`/home/shenss/python/rLive`) and **shipped/run on Windows** (`D:\dev\rLive`).

**After every completed modification** (feature, fix, UI change, dependency, script, or config that affects the app), you **must** run the Windows delivery pipeline before ending the turn—unless the user explicitly says to skip build, or the change is docs-only with no runtime impact.

### Required commands (from the repo root)

```bash
# 1) Sync WSL workspace → D:\dev\rLive
./scripts/sync-to-windows.sh

# 2) Build on Windows (MSVC + vcvars + tauri)
./scripts/build-windows-from-wsl.sh
```

Prefer the combined script when available:

```bash
./scripts/build-windows-from-wsl.sh
```

(`build-windows-from-wsl.sh` already runs `sync-to-windows.sh` first.)

### Success criteria

- Sync exits 0 and reports `OK: synced to D:\dev\rLive`
- Build exits 0 and produces  
  `D:\dev\rLive\src-tauri\target\release\rlive.exe`
- On failure: fix the error, then re-run sync + build until green (or report a blocked external cause)

### Implementation notes

- Use `/init` + Windows PowerShell when interop needs elevated path resolution (same pattern as prior successful builds).
- Do **not** claim “done” after only a Linux `tsc`/`vite` check if the change is meant to run as the Tauri desktop app.
- Docs-only / pure plan-mode turns: skip Windows build; mention that delivery was skipped.

### Paths

| Role | Path |
|------|------|
| Source (WSL) | `/home/shenss/python/rLive` |
| Windows mirror | `D:\dev\rLive` (`/mnt/d/dev/rLive`) |
| Sync | `scripts/sync-to-windows.sh` |
| Windows build | `scripts/build-windows.ps1` |
| WSL orchestrator | `scripts/build-windows-from-wsl.sh` |

## Product context (short)

- Tauri 2 + React + Tailwind + shadcn-style UI
- Desktop live client: **web MSE player** (`mpegts.js` + `stream_proxy`), not mpv
- Sites ready: **Bilibili / Huya / Douyu** (lists + play + danmaku); **Douyin** (SSR 首屏浏览 + 房间/播放 + 本地签名实时弹幕，登录 Cookie 搜索); Kuaishou stub
- Danmaku: settings (opacity / size / speed / shield), list + canvas + SC panel
- UI language: **Chinese primary** chrome (Simple Live–style); docs: `docs/zh/*` first, `docs/en/*` secondary
- User-facing docs: `README.md`, `docs/README.md`
