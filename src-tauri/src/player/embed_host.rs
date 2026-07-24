//! Native child window used as mpv `--wid` embed target.
//! Bounds are **client-relative** to the main app window (physical pixels).
//!
//! Win32 windows belong to the thread that created them.  Tauri commands do
//! not necessarily run on that thread, so all HWND work in this module is
//! dispatched through Tauri's main-thread queue.  In particular, never call
//! `DestroyWindow` from a player reaper or a window-close callback directly:
//! doing so can leave the mpv child surface visible above a newly-rendered
//! WebView page.

#[cfg(windows)]
use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::player::PlayerBounds;

/// Opaque embed host.  Its Win32 lifetime is explicitly released by
/// [`Self::dispose`] and is also guarded by [`Drop`].
pub struct EmbedHost {
    #[cfg(windows)]
    hwnd: isize,
    #[cfg(windows)]
    app: tauri::AppHandle,
    #[cfg(windows)]
    disposed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(not(windows))]
    _pad: (),
}

impl EmbedHost {
    /// Create a child host under the given Tauri webview window.
    pub fn create(window: &tauri::WebviewWindow, bounds: PlayerBounds) -> AppResult<Self> {
        #[cfg(windows)]
        {
            return Self::create_windows(window, bounds);
        }
        #[cfg(not(windows))]
        {
            let _ = (window, bounds);
            Err(AppError::new(
                "embed_unsupported",
                "child-window embed is currently Windows-only; using geometry fallback",
            ))
        }
    }

    /// Queue a bounds update on the window-owning thread.
    ///
    /// This is intentionally asynchronous.  A resize must never delay a room
    /// exit, and the disposed flag prevents a delayed move from re-showing an
    /// old HWND after its player was detached.
    pub fn set_bounds(&self, bounds: PlayerBounds) -> AppResult<()> {
        if bounds.width == 0 || bounds.height == 0 {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;

            if self.disposed.load(Ordering::Acquire) {
                return Ok(());
            }

            let hwnd = self.hwnd;
            let disposed = self.disposed.clone();
            self.app
                .run_on_main_thread(move || {
                    if disposed.load(Ordering::Acquire) {
                        return;
                    }
                    Self::set_bounds_on_main(hwnd, bounds);
                })
                .map_err(|error| {
                    AppError::new(
                        "embed_main_thread_error",
                        format!("could not schedule embed bounds update: {error}"),
                    )
                })?;
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = bounds;
            Ok(())
        }
    }

    /// Retire this host without calling `DestroyWindow`.
    ///
    /// Windows + mpv `--wid` makes `DestroyWindow` unsafe on the UI thread: a
    /// live (or recently killed) foreign renderer can block the message pump
    /// indefinitely ("未响应").  We only hide + park the HWND off-screen, mark
    /// it disposed so late `set_bounds` cannot re-show it, and let process
    /// exit reclaim the window handle.
    pub fn dispose(&self) {
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;

            if self.disposed.swap(true, Ordering::AcqRel) {
                return;
            }

            let hwnd = self.hwnd;
            if let Err(error) = self
                .app
                .run_on_main_thread(move || Self::retire_on_main(hwnd))
            {
                tracing::warn!(%error, hwnd, "could not schedule mpv embed host retire");
            }
        }
        #[cfg(not(windows))]
        {}
    }

    /// Value for mpv `--wid=`.
    pub fn wid_arg(&self) -> String {
        #[cfg(windows)]
        {
            format!("{}", self.hwnd)
        }
        #[cfg(not(windows))]
        {
            "0".into()
        }
    }

    #[cfg(windows)]
    fn create_windows(window: &tauri::WebviewWindow, bounds: PlayerBounds) -> AppResult<Self> {
        use std::sync::mpsc::{self, RecvTimeoutError};
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        // A sync command can be invoked while the Tauri event loop is busy.
        // Bound the caller-side wait, but retain a shared hand-off state so a
        // task that runs after the timeout destroys the HWND instead of
        // orphaning it.  The mutex makes timeout/callback ownership atomic.
        const CREATE_REPLY_TIMEOUT: Duration = Duration::from_millis(250);

        enum CreateState {
            Pending,
            Ready(AppResult<isize>),
            Cancelled,
        }

        fn take_or_cancel(state: &Mutex<CreateState>) -> Option<AppResult<isize>> {
            let mut state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match std::mem::replace(&mut *state, CreateState::Cancelled) {
                CreateState::Ready(result) => Some(result),
                CreateState::Pending | CreateState::Cancelled => None,
            }
        }

        // `WebviewWindow::hwnd()` uses Tauri's synchronous window-dispatch
        // getter. Obtain it from the worker command thread before scheduling
        // our UI task; calling it *inside* `run_on_main_thread` would make the
        // event loop wait on itself.
        let parent = window
            .hwnd()
            .map_err(|error| AppError::new("embed_parent_error", format!("hwnd: {error}")))?
            .0 as isize;
        let app = window.app_handle().clone();
        let state = Arc::new(Mutex::new(CreateState::Pending));
        let task_state = state.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<()>(1);

        window
            .run_on_main_thread(move || {
                let cancelled = {
                    let state = task_state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    matches!(&*state, CreateState::Cancelled)
                };
                if cancelled {
                    // The waiting command has already timed out or its
                    // window is closing.  Avoid creating a transient HWND at
                    // all; the cancellation token is the ownership guard.
                    return;
                }

                let result = Self::create_on_main(parent, bounds);
                let cleanup_hwnd = result.as_ref().ok().copied();

                let notify = {
                    let mut state = task_state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match &*state {
                        CreateState::Pending => {
                            *state = CreateState::Ready(result);
                            true
                        }
                        CreateState::Cancelled => false,
                        CreateState::Ready(_) => {
                            tracing::error!("mpv embed host creation callback completed twice");
                            false
                        }
                    }
                };

                if notify {
                    let _ = ready_tx.send(());
                } else if let Some(hwnd) = cleanup_hwnd {
                    // The caller timed out or its window was already closed.
                    // Retire only — never DestroyWindow on this path.
                    Self::retire_on_main(hwnd);
                }
            })
            .map_err(|error| {
                // Claim the shared state so a queued task (if the runtime
                // races an error return) knows it must clean up its own HWND.
                let _ = take_or_cancel(&state);
                AppError::new(
                    "embed_main_thread_error",
                    format!("could not schedule embed host creation: {error}"),
                )
            })?;

        let result = match ready_rx.recv_timeout(CREATE_REPLY_TIMEOUT) {
            Ok(()) => take_or_cancel(&state),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                take_or_cancel(&state)
            }
        }
        .ok_or_else(|| {
            AppError::new(
                "embed_main_thread_timeout",
                "timed out waiting for the main thread to create mpv embed host",
            )
            .retryable()
        })??;

        Ok(Self {
            hwnd: result,
            app,
            disposed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Must run on Tauri's window-owning thread.
    #[cfg(windows)]
    fn create_on_main(parent: isize, bounds: PlayerBounds) -> AppResult<isize> {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{HINSTANCE, HWND};
        use windows::Win32::Graphics::Gdi::HBRUSH;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, LoadCursorW, RegisterClassExW, CS_HREDRAW, CS_OWNDC, CS_VREDRAW,
            IDC_ARROW, WINDOW_EX_STYLE, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN,
            WS_CLIPSIBLINGS, WS_VISIBLE,
        };

        let parent = HWND(parent as *mut core::ffi::c_void);

        unsafe {
            let class_name: PCWSTR = windows::core::w!("RLIVE_MPV_HOST");
            let module = GetModuleHandleW(None).map_err(|error| {
                AppError::new("embed_create_error", format!("GetModuleHandle: {error}"))
            })?;
            // HMODULE and HINSTANCE share the same representation.
            let hinstance = HINSTANCE(module.0);

            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
                lpfnWndProc: Some(host_wnd_proc),
                hInstance: hinstance,
                lpszClassName: class_name,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                hbrBackground: HBRUSH(std::ptr::null_mut()),
                ..Default::default()
            };
            // Re-registering a process-global class returns ERROR_CLASS_ALREADY_EXISTS.
            // That is safe because every host uses the same window procedure.
            let _ = RegisterClassExW(&wc);

            let x = bounds.x;
            let y = bounds.y;
            let width = bounds.width.max(16) as i32;
            let height = bounds.height.max(16) as i32;
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                windows::core::w!("rlive-mpv-host"),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                x,
                y,
                width,
                height,
                Some(parent),
                None,
                Some(hinstance),
                None,
            )
            .map_err(|error| {
                AppError::new("embed_create_error", format!("CreateWindowEx: {error}"))
            })?;

            Self::set_bounds_on_main(hwnd.0 as isize, bounds);
            Ok(hwnd.0 as isize)
        }
    }

    /// Must run on the HWND-owning thread.
    #[cfg(windows)]
    fn set_bounds_on_main(hwnd: isize, bounds: PlayerBounds) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW,
        };

        let hwnd = HWND(hwnd as *mut core::ffi::c_void);
        unsafe {
            if let Err(error) = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                bounds.x,
                bounds.y,
                bounds.width.max(16) as i32,
                bounds.height.max(16) as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ) {
                tracing::warn!(%error, hwnd = ?hwnd, "could not position mpv embed host");
            }
        }
    }

    /// Must run on the HWND-owning thread.
    ///
    /// Intentionally does **not** call `DestroyWindow`.  Hiding and parking
    /// off-screen is enough for the WebView to paint; the OS reclaims the
    /// HWND when the process exits.
    #[cfg(windows)]
    fn retire_on_main(hwnd: isize) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            IsWindow, SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOSIZE,
            SWP_NOZORDER, SW_HIDE,
        };

        let hwnd = HWND(hwnd as *mut core::ffi::c_void);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return;
            }
            let _ = ShowWindow(hwnd, SW_HIDE);
            // Park far off-screen so a compositor glitch cannot cover the UI.
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_BOTTOM),
                -32_000,
                -32_000,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

impl Drop for EmbedHost {
    fn drop(&mut self) {
        // Idempotent and non-blocking.  This also covers a failed mpv spawn
        // and status polling that discovers the child process has exited.
        self.dispose();
    }
}

#[cfg(windows)]
unsafe extern "system" fn host_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, HGDIOBJ, PAINTSTRUCT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, WM_DESTROY, WM_ERASEBKGND, WM_PAINT,
    };

    match msg {
        WM_ERASEBKGND => windows::Win32::Foundation::LRESULT(1),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let brush = CreateSolidBrush(COLORREF(0x0000_0000));
            let _ = FillRect(hdc, &ps.rcPaint, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
            let _ = EndPaint(hwnd, &ps);
            windows::Win32::Foundation::LRESULT(0)
        }
        WM_DESTROY => windows::Win32::Foundation::LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
