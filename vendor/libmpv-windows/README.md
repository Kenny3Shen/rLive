# Windows libmpv runtime

rLive loads `libmpv-2.dll` in-process on Windows (no `mpv.exe` child).

## Install

From the repo root:

```bash
./scripts/fetch-libmpv-windows.sh
```

This places `libmpv-2.dll` next to:

- `src-tauri/target/release/rlive.exe`
- `D:\dev\tools\mpv\` (search path used by the loader)
- this `vendor/libmpv-windows/` directory

Override the DLL path at runtime with:

```text
RLIVE_LIBMPV=D:\path\to\libmpv-2.dll
```

## Note

The DLL is large (~110 MB) and is **not** committed to git. Re-run the fetch script after a clean clone or Windows rebuild if playback reports `libmpv_load_error`.
