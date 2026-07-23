# Windows delivery after every change

When a task **finishes modifying** rLive application code or build config:

1. Run `./scripts/sync-to-windows.sh` (or rely on step 2 which syncs first).
2. Run `./scripts/build-windows-from-wsl.sh` and wait for a green build.
3. Report the EXE path: `D:\dev\rLive\src-tauri\target\release\rlive.exe`.

Skip only if the user says so, or the turn is docs/plan-only with no runtime impact.

Do not end the turn with “fixed” / “done” for app changes without this pipeline succeeding (or a clear external blocker).
