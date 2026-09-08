//! The tray icon: the bead, a tooltip, and three items.
//!
//! Nazar in the tray is a monitor you leave running, so the close button on the window
//! hides it rather than ending it (`main.rs`, `CloseRequested`). That trade only works if
//! there is an unmistakable way *out*, and on Windows the place people look for it is the
//! right button on the tray icon. Hence **Quit**, and hence a menu at all.
//!
//! The cost is the one nazar-tray wrote up: with a menu attached, the right button belongs
//! to the shell, so the left button is the one that opens the window and `Open` is the
//! menu's first entry for anybody who reaches for the other one.
//!
//! `Refresh` reloads the canvas in place. It is not a data refresh — the canvas already
//! updates itself over `/api/events` and has done since WP4 — but the way back from a
//! webview that has been asleep in a hibernated laptop and lost its `EventSource`.

use tauri::AppHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::i18n;
use crate::icon;

/// Identifier of the one tray icon this application owns.
pub const TRAY_ID: &str = "nazar";

const MENU_OPEN: &str = "nazar-open";
const MENU_REFRESH: &str = "nazar-refresh";
const MENU_QUIT: &str = "nazar-quit";

/// Create the tray icon, its menu and its mouse bindings.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // N-WP13: the four words here come from `packages/ui/locales/<lang>.json`, the same
    // files the canvas bundles. The language is the machine's, not the canvas's — the
    // menu is built before any page exists, and the page's choice lives in its own
    // `localStorage`. See `i18n.rs` for why that trade was taken.
    let strings = i18n::catalog(&i18n::resolve(i18n::system_language().as_deref()));
    let open = MenuItem::with_id(
        app,
        MENU_OPEN,
        strings.text("tray.open"),
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        MENU_REFRESH,
        strings.text("tray.refresh"),
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        MENU_QUIT,
        strings.text("tray.quit"),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &refresh, &separator, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(image(scale_factor(app)))
        // A template icon is one the host tints to suit its own bar, and macOS is the
        // only host here with the mechanism. It gets the monochrome variant of the mark —
        // rim and iris kept, band and pupil left as holes — because a coloured bead is
        // the one thing a macOS menu bar has no vocabulary for. Windows gets the colour
        // bead and `false`: there is no template there, and a white mark would vanish on
        // a light taskbar.
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(strings.text("tray.tooltip"))
        .menu(&menu)
        // The left button opens the window and must not wait for a menu to be dismissed.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_OPEN => crate::show_main_window(app),
            MENU_REFRESH => crate::reload_main_window(app),
            MENU_QUIT => crate::shut_down(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // On release, so a click that started somewhere else does not count. The
            // middle button is deliberately left alone.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Redraw the icon for the display's current scale factor.
pub fn refresh_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(image(scale_factor(app))));
    }
}

/// The scale factor to draw for: the primary monitor's, because that is where Windows
/// puts the taskbar unless the user has moved it. On a mixed-DPI desktop the shell
/// resamples whatever it is given, so a bead drawn for the other monitor is soft rather
/// than wrong.
fn scale_factor(app: &AppHandle) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor())
}

/// Rasterise the bead and hand it over as raw pixels. No PNG is encoded or decoded.
///
/// `cfg!` rather than `#[cfg]` on purpose: both variants then compile on every platform,
/// so the macOS branch cannot rot on a machine that only ever builds for Windows.
fn image(scale: f64) -> tauri::image::Image<'static> {
    let size = icon::size_for_scale(scale);
    let bitmap = if cfg!(target_os = "macos") {
        icon::render_template(size)
    } else {
        icon::render(size)
    };
    tauri::image::Image::new_owned(bitmap.rgba, bitmap.width, bitmap.height)
}
