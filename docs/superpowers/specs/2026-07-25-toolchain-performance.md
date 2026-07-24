# Toolchain performance guide (rLive)

**Date:** 2026-07-25  
**Status:** Applied baseline (Vite 8 + Rust release profile)

## Current baseline (this repo)

| Layer | Choice | Why |
|-------|--------|-----|
| Package manager | **Bun** | Fast install + lockfile; scripts use `bun` |
| Bundler / dev server | **Vite 8** (Rolldown-backed) | Vite 8 ships Rolldown; faster prod builds than Vite 7/esbuild stack |
| React transform | **@vitejs/plugin-react 6** | Peer of Vite 8; sufficient for this app size |
| CSS | **Tailwind 4 + @tailwindcss/vite** | Native Vite plugin, no PostCSS chain |
| Lint / format | **oxlint + oxfmt** | Much faster than ESLint/Prettier for TS |
| Typecheck | **TypeScript 5.9** (`tsc --noEmit`) | Stable; avoid TS 6/7 until ecosystem settles |
| Runtime target | **Chrome 120** (WebView2) | Smaller modern JS without legacy polyfills |
| Desktop shell | **Tauri 2** | Thin native host; media is MSE in WebView |
| Rust | **stable + edition 2024** | Current compiler on this machine is 1.97 |
| Release profile | `lto=thin`, `codegen-units=1`, `strip` | Smaller/faster `rlive.exe` |
| Windows link | **rust-lld** (`.cargo/config.toml`) | Faster link than default MSVC link.exe when available |

## Recommended upgrades (performance-first)

### Frontend (priority order)

1. **Stay on Vite 8 stable** (`^8.1.5`). Prefer stable over `8.2.0-beta` for shipping.
2. **Keep Bun** as the only package manager (`packageManager` field set). Avoid mixing npm/yarn lockfiles.
3. **Optional: React Compiler** when ready  
   - `@vitejs/plugin-react` 6 optional peer: `babel-plugin-react-compiler`  
   - Gains: fewer re-renders in room UI; cost: babel path (measure before enabling).
4. **Optional: `@vitejs/plugin-react-swc`** if HMR transform time becomes a bottleneck  
   - Peer supports Vite 8; trade-off: no React Compiler path.
5. **oxlint as the only linter** (already). Do not reintroduce ESLint unless a rule is missing.
6. **Typecheck strategy**  
   - Dev: `oxlint` only (fast feedback).  
   - CI/release: `tsc --noEmit && vite build`.  
   - Future: evaluate `tsgo` / TypeScript native preview once stable for this repo.
7. **Code-splitting** room player (`mpegts` is already loaded via script tag — good). Avoid bundling large UMD into the main chunk.
8. **Image/font**  
   - Geist variable font is fine; avoid adding more webfont weights.  
   - Prefer `loading="lazy"` on room cards (already pattern-friendly).

### Backend / Rust

1. **Keep release LTO thin** (default in `Cargo.toml`). Full LTO is slower to build with little gain for this binary size.
2. **rust-lld on Windows** (configured). If link fails in a minimal MSVC env, remove the linker override in `src-tauri/.cargo/config.toml`.
3. **Linux**: install **mold** and uncomment mold flags in `.cargo/config.toml` for much faster incremental links.
4. **Do not reintroduce libmpv** into the default path; web MSE + localhost proxy is the lighter runtime dependency surface.
5. **reqwest / rustls** stay; avoid OpenSSL-sys on Windows.
6. **Boa** is heavy (Douyu sign). Longer-term: cache signed play args per room TTL, or isolate Douyu sign behind a feature flag to shrink non-Douyu builds (`--no-default-features`).
7. **Clippy in CI**: `cargo clippy -- -D warnings` once warning debt is low.

### Tauri / desktop

1. Keep `beforeBuildCommand` as `bun run build` (typecheck + Vite).
2. Prefer **WebView2 Evergreen** on user machines (Windows); no need to ship a browser.
3. CSP: currently `null` for media proxy flexibility; tighten later with `connect-src` allowing `http://127.0.0.1:*` only.

## Commands (after upgrade)

```bash
bun install
bun run check          # oxlint + tsc
bun run build          # production frontend
cargo check --manifest-path src-tauri/Cargo.toml
./scripts/build-windows-from-wsl.sh   # full desktop release
```

## What we deliberately did *not* do

| Idea | Reason |
|------|--------|
| TypeScript 6/7 | Too new for many `@types/*` / tooling; 5.9 is the safe high-perf line |
| Rolldown-vite separate package | Vite 8 already depends on Rolldown |
| Replacing Bun with pnpm | No win for this monorepo size |
| Full LTO | Build time cost for desktop iteration |
| Webpack / Rspack | Vite 8 is the maintained Tauri path |
