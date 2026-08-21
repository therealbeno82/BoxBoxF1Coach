// ─── GAME OVERLAY WINDOW ────────────────────────────────────────────────────
// A second webview that sits on top of the game: transparent, undecorated,
// always-on-top and click-through. Everything that actually makes an overlay
// work on Windows is in the flags below, so they carry their reasoning:
//
//   transparent    — the window has no background; only painted pixels show.
//   decorations    — no title bar or border to cover the road with.
//   always_on_top  — WS_EX_TOPMOST, which is what puts it over the game.
//   skip_taskbar   — it is a HUD, not a window the driver alt-tabs to.
//   shadow         — Windows draws a drop shadow around undecorated windows too,
//                    and on a transparent one it reads as a grey smear.
//   focused(false) — CRITICAL. If the overlay takes focus while the game is in
//                    borderless fullscreen, the game drops to background: it can
//                    throttle its frame rate and, on some setups, stop reading
//                    the wheel. Never call set_focus() on this window.
//
// THE ONE CONSTRAINT THIS CANNOT SOLVE: exclusive fullscreen. There the game
// bypasses the desktop compositor entirely and nothing composites over it — the
// overlay is simply not drawn. The driver has to run borderless/windowed. That
// is the same requirement every sim overlay (SimHub, Z1, RaceLabs) carries; the
// only alternative is injecting a DLL to hook the game's Present call, which is
// a different project and an anti-cheat risk on an EA title.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Window label. The capability file (capabilities/overlay.json) grants event
/// permissions to exactly this label, so the two must stay in step — a mismatch
/// leaves the overlay unable to listen() and it renders "waiting" forever.
pub const OVERLAY_LABEL: &str = "overlay";

/// Show the overlay, creating it on first use. Idempotent: calling it while the
/// overlay is already up re-shows and re-asserts topmost, which is also the cheap
/// fix for the game having stolen the z-order.
#[tauri::command]
pub fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.show().map_err(|e| e.to_string())?;
        win.set_always_on_top(true).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        &app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("F1 Coach Overlay")
    .inner_size(340.0, 168.0)
    .position(28.0, 28.0)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .resizable(false)
    .build()
    .map_err(|e| e.to_string())?;

    // Click-through. This is ALL-OR-NOTHING for the whole window — there is no
    // per-pixel or per-widget hit testing, so an opaque readout passes clicks
    // through exactly like the transparent gaps around it. Anything the driver
    // needs to click has to go through set_overlay_interactive below.
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(())
}

/// Tear the overlay down. Closing rather than hiding frees the second WebView2
/// process, which is worth ~50-100 MB while the driver isn't using it.
#[tauri::command]
pub fn close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the overlay currently exists — the UI reads this once on mount so the
/// toggle shows the true state after a navigation rather than defaulting to off.
#[tauri::command]
pub fn is_overlay_open(app: tauri::AppHandle) -> bool {
    app.get_webview_window(OVERLAY_LABEL).is_some()
}

/// Flip click-through off so the overlay can be dragged into place, or back on
/// for driving. Interactive mode is a positioning aid only: while it is on, every
/// click that lands on the overlay is taken FROM the game.
#[tauri::command]
pub fn set_overlay_interactive(app: tauri::AppHandle, interactive: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.set_ignore_cursor_events(!interactive)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
