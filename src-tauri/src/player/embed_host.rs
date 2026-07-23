//! Native child window used as mpv `--wid` embed target.
//! Bounds are **client-relative** to the main app window (physical pixels).
//!
//! Primary implementation: Windows (Win32 child HWND).
//! Other platforms return `embed_unsupported` so the player can fall back to geometry.

use crate::error::{AppError, AppResult};
use crate::player::PlayerBounds;

/// Opaque embed host; destroyed on drop.
pub struct EmbedHost {
    #[cfg(windows)]
    hwnd: windows::Win32::Foundation::HWND,
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

    pub fn set_bounds(&self, bounds: PlayerBounds) -> AppResult<()> {
        if bounds.width == 0 || bounds.height == 0 {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW,
            };
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOP),
                    bounds.x,
                    bounds.y,
                    bounds.width as i32,
                    bounds.height as i32,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                )
                .map_err(|e| {
                    AppError::new("embed_bounds_error", format!("SetWindowPos: {e}"))
                })?;
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = bounds;
            Ok(())
        }
    }

    /// Value for mpv `--wid=`.
    pub fn wid_arg(&self) -> String {
        #[cfg(windows)]
        {
            format!("{}", self.hwnd.0 as isize)
        }
        #[cfg(not(windows))]
        {
            "0".into()
        }
    }

    #[cfg(windows)]
    fn create_windows(window: &tauri::WebviewWindow, bounds: PlayerBounds) -> AppResult<Self> {
        use windows::Win32::Graphics::Gdi::HBRUSH;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, LoadCursorW, RegisterClassW, SetWindowPos, CS_HREDRAW, CS_OWNDC,
            CS_VREDRAW, HWND_TOP, IDC_ARROW, SWP_NOACTIVATE, SWP_SHOWWINDOW, WINDOW_EX_STYLE,
            WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
        };

        let parent = window
            .hwnd()
            .map_err(|e| AppError::new("embed_parent_error", format!("hwnd: {e}")))?;

        unsafe {
            let class_name = windows::core::w!("RLIVE_MPV_HOST");
            let hinstance = GetModuleHandleW(None).map_err(|e| {
                AppError::new("embed_create_error", format!("GetModuleHandle: {e}"))
            })?;

            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
                lpfnWndProc: Some(host_wnd_proc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                hbrBackground: HBRUSH(std::ptr::null_mut()),
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);

            let x = bounds.x;
            let y = bounds.y;
            let w = bounds.width.max(16) as i32;
            let h = bounds.height.max(16) as i32;

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                windows::core::w!("rlive-mpv-host"),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                x,
                y,
                w,
                h,
                Some(parent),
                None,
                Some(hinstance.into()),
                None,
            )
            .map_err(|e| AppError::new("embed_create_error", format!("CreateWindowEx: {e}")))?;

            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                x,
                y,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );

            Ok(Self { hwnd })
        }
    }
}

impl Drop for EmbedHost {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn host_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, PAINTSTRUCT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, WM_DESTROY, WM_ERASEBKGND, WM_PAINT,
    };

    match msg {
        WM_ERASEBKGND => windows::Win32::Foundation::LRESULT(1),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            // Black fill while mpv attaches.
            let brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x000000));
            let _ = FillRect(hdc, &ps.rcPaint, brush);
            let _ = DeleteObject(brush);
            let _ = EndPaint(hwnd, &ps);
            windows::Win32::Foundation::LRESULT(0)
        }
        WM_DESTROY => windows::Win32::Foundation::LRESULT(0),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
