//! Nazar's desktop shell.
//!
//! A window, a tray icon, and one thing a browser tab cannot do: jump from a session card
//! to the terminal running that session. Everything else — the canvas, the readers, the
//! history panel — is the same code `npx @xfurqan0/nazar` runs, started here as a child
//! process and reached over the loopback address.
//!
//! ```text
//!   nazar-desktop.exe
//!     ├─ tray icon (bead)  Open · Refresh · Quit
//!     ├─ window            boot page → http://127.0.0.1:<free>/  (the canvas)
//!     └─ node <resources>/server/bin/nazar.mjs --no-open --port <free>
//! ```
//!
//! **Why the canvas is served rather than embedded.** Browser mode is first-class and
//! stays that way: `npx @xfurqan0/nazar` is the install-free entry point and the one most
//! people will ever use. Embedding a copy of the canvas in the application would give two
//! builds of one page, and every fix would have to land twice. So there is one canvas,
//! served by one server, and the shell is a window around it. The seam costs one thing —
//! the canvas is a *remote* origin as far as Tauri is concerned, which is why
//! `capabilities/canvas.json` exists and says so at length.
//!
//! **Why there is no bundled Node.** Claude Code is a Node program. A machine with no Node
//! has no Claude Code sessions, and a monitor with nothing to monitor has no user. The
//! check in [`node`] is the whole contingency, and when it fails the window says what is
//! missing instead of staying empty. `README.md` makes the same argument to the reader.
//!
//! **What it writes.** One file, `%APPDATA%\nazar\desktop.json`, holding two settings: the
//! start-with-Windows switch, and the loopback port the canvas is served on. The promise
//! that Nazar writes nothing is about *your* machine's Claude Code data — no hooks, no
//! settings edits, no copies of transcripts — and `test/no-writes.test.ts` still gates the
//! whole of the shipped JavaScript. A desktop application that could not remember whether
//! you asked it to start with Windows would be a worse application, and one that forgot
//! your canvas every launch was a worse application, which is what the port is for
//! (N-WP9; `config.rs` has the reasoning).

// A shell with a tray icon has no console. Kept in debug builds so `--jump` and `--version`
// can print, which is what the live check on a development machine uses.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod boot;
mod config;
mod i18n;
mod icon;
mod jump;
mod node;
mod server;
mod titles;
mod tray;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use boot::{BootState, phase};
use config::Config;
use jump::JumpOutcome;
use server::ServerHandle;

/// Version of this build, from `Cargo.toml`.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The label of the one window, matching `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// The event the boot page listens for.
const BOOT_EVENT: &str = "boot-state";

/// What the startup entry passes back, and what a user can pass by hand: open no window.
const HIDDEN_FLAG: &str = "--hidden";

const HELP: &str = "nazar-desktop - the Nazar canvas in a window and in the tray

Usage:
  nazar-desktop [--hidden]
  nazar-desktop --jump <pid>
  nazar-desktop --version

Options:
  --hidden         Start in the tray without opening the window. This is what the
                   \"start with Windows\" entry passes.
  --jump <pid>     Run the jump ladder against one process id, print what it found as
                   JSON, and exit. No window, no tray, no server.
  -h, --help       Show this help
  -v, --version    Print the version

The canvas itself is the same one \"npx @xfurqan0/nazar\" serves. This application starts
it on a free port on 127.0.0.1 and shows it; it installs nothing into Claude Code.
";

/// Everything the application shares between the boot thread, the commands and the tray.
struct Shell {
    boot: Mutex<BootState>,
    server: Mutex<Option<ServerHandle>>,
    config: Mutex<Config>,
}

/// What the canvas asks for, once, to decide whether to offer the jump.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    /// Always true when this answers at all: the canvas is running inside the shell.
    shell: bool,
    /// The shell's version, which is the package's version.
    version: String,
    /// `windows`, `macos` or `linux`.
    platform: String,
    /// Whether [`jump`] can do anything on this platform.
    jump_supported: bool,
}

fn main() {
    // Handled before anything is built: neither of these may open a window, touch the
    // tray, or leave a process behind.
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if handled_on_the_command_line(&arguments) {
        return;
    }
    let hidden = arguments.iter().any(|argument| argument == HIDDEN_FLAG);

    let application = tauri::Builder::default()
        // First, as the plugin requires. A second launch does not start a second server:
        // it shows the first one's window and leaves.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // What Windows passes back when it starts us at login. It means "the tray,
            // and no window", and it is the difference between a shell that starts
            // quietly and one that greets you with a canvas every time you log in.
            Some(vec![HIDDEN_FLAG]),
        ))
        .invoke_handler(tauri::generate_handler![
            boot_state,
            shell_info,
            jump_to_session,
            get_autostart,
            set_autostart,
            get_task_text_off,
            set_task_text_off,
            open_download_page
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            app.manage(Shell {
                boot: Mutex::new(BootState::starting(VERSION)),
                server: Mutex::new(None),
                config: Mutex::new(Config::load()),
            });

            tray::install(app.handle())?;
            reconcile_autostart(app.handle());

            if !hidden {
                show_main_window(app.handle());
            }

            // Everything slow happens here rather than on the main thread: the version
            // check spawns a process, the server takes a moment to bind, and a window
            // that is not painting while it waits is a window that looks broken.
            std::thread::spawn(move || boot_up(&handle));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The close button hides. The way out is Quit, in the tray menu, and the
            // module note in `tray.rs` is the argument for that trade.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The bead is drawn for one scale factor; moving to a display with another
            // one makes that drawing wrong.
            WindowEvent::ScaleFactorChanged { .. } => tray::refresh_icon(window.app_handle()),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("nazar-desktop could not start");

    application.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            // The child server goes before this process does. On Windows the job object
            // in `server.rs` would take it anyway, but a shell that relied on that would
            // be relying on a safety net for its ordinary path.
            stop_server(app);
        }
    });
}

/// `--help`, `--version` and `--jump`, none of which starts an application.
///
/// Returns whether the command line was handled here. In a release build the binary is a
/// GUI subsystem executable with no console, so these print into the void unless their
/// output is redirected — which is exactly what `docs/PROJECT.md` records, and why the
/// live check uses the debug build.
fn handled_on_the_command_line(arguments: &[String]) -> bool {
    if arguments.iter().any(|a| a == "-h" || a == "--help") {
        print!("{HELP}");
        return true;
    }
    if arguments.iter().any(|a| a == "-v" || a == "--version") {
        println!("{VERSION}");
        return true;
    }

    let Some(index) = arguments.iter().position(|a| a == "--jump") else {
        return false;
    };
    let target = arguments
        .get(index + 1)
        .and_then(|raw| raw.parse::<u32>().ok());
    let Some(pid) = target else {
        eprintln!("nazar-desktop: --jump needs a process id, for example --jump 15592");
        return true;
    };

    match jump::jump(pid) {
        Ok(outcome) => println!(
            "{}",
            serde_json::to_string_pretty(&outcome).unwrap_or_else(|_| outcome.message.clone())
        ),
        Err(error) => eprintln!("nazar-desktop: {error}"),
    }
    true
}

/* ------------------------------------------------------------------ *
 * Starting up
 * ------------------------------------------------------------------ */

/// Check Node, start the server, and send the window to the canvas.
///
/// Runs on its own thread. Every step publishes what it is doing, so the window is never
/// silent about what it is waiting for.
fn boot_up(app: &AppHandle) {
    let entry = server::resolve_entry(app.path().resource_dir().ok().as_deref());

    publish(app, |state| {
        state.moved_to(
            phase::CHECKING_NODE,
            "looking for a Node runtime on this machine",
        )
    });

    let check = node::check();
    if !check.is_usable() {
        // Best effort, and it usually produces nothing: a machine with no usable Node
        // cannot run `nazar doctor` either. Trying costs one failed spawn and sometimes
        // answers, because "too old" is not the same as "absent".
        let report = entry.as_deref().and_then(node::doctor);
        let (phase, detail) = describe(&check);
        publish(app, |state| {
            state
                .moved_to(phase, detail.clone())
                .with_doctor(report.clone())
        });
        show_main_window(app);
        return;
    }

    let Some(entry) = entry else {
        publish(app, |state| {
            state.moved_to(
                phase::SERVER_FAILED,
                "the packaged canvas server is missing from this installation",
            )
        });
        show_main_window(app);
        return;
    };

    // The path is in the sentence on purpose. A server that will not start is nearly
    // always a server that was looked for in the wrong place, and "starting the canvas"
    // on its own leaves the one fact that would explain it out of the only screen the
    // user has.
    let entry_shown = entry.display().to_string();
    publish(app, |state| {
        state.moved_to(
            phase::STARTING_SERVER,
            format!("starting {entry_shown} on 127.0.0.1"),
        )
    });

    // N-WP9: the port the canvas came up on last time. Reusing it is what keeps the
    // arrangement, the tabs, the notes and the card names, all of which the browser
    // stores per origin and an origin includes the port. `config.rs` argues it in full.
    let stored = app
        .try_state::<Shell>()
        .and_then(|shell| shell.config.lock().ok().and_then(|config| config.port));

    // N-WP15a: recording mode, read from the same file and passed to the child as
    // `--no-task-text`. Absent settings mean "the browser decides", which is what
    // every machine that has never touched the switch gets.
    let task_text = app
        .try_state::<Shell>()
        .and_then(|shell| {
            shell
                .config
                .lock()
                .ok()
                .map(|config| config.task_text_allowed())
        })
        .unwrap_or(true);

    match server::start(&entry, stored, task_text) {
        Ok(handle) => {
            let url = handle.url.clone();
            let port = handle.port;
            let adopted = handle.adopted;
            if let Some(shell) = app.try_state::<Shell>() {
                if let Ok(mut slot) = shell.server.lock() {
                    *slot = Some(handle);
                }
                // Written only when the number actually changed, so the settings file's
                // modification time keeps meaning "a setting changed".
                if let Ok(mut config) = shell.config.lock() {
                    let _ = config.remember_port(port);
                }
            }
            publish(app, |state| {
                state
                    .moved_to(
                        phase::READY,
                        if adopted {
                            format!("the canvas was already up on 127.0.0.1:{port}")
                        } else {
                            format!("the canvas is up on 127.0.0.1:{port}")
                        },
                    )
                    .with_url(&url)
            });
            go_to_canvas(app, &url);
        }
        Err(error) => {
            let report = node::doctor(&entry);
            publish(app, |state| {
                state
                    .moved_to(phase::SERVER_FAILED, error.clone())
                    .with_doctor(report.clone())
            });
            show_main_window(app);
        }
    }
}

/// Turn a failed Node check into a phase and a sentence.
fn describe(check: &nazar_shell::node::NodeCheck) -> (&'static str, String) {
    use nazar_shell::node::{MINIMUM_MAJOR, NodeCheck};
    match check {
        NodeCheck::Missing => (
            phase::NODE_MISSING,
            "\"node --version\" could not be run at all".to_owned(),
        ),
        NodeCheck::TooOld(version) => (
            phase::NODE_TOO_OLD,
            format!(
                "this machine has Node {version}; Nazar's server needs {MINIMUM_MAJOR} or newer"
            ),
        ),
        NodeCheck::Unreadable(text) => (
            phase::NODE_UNREADABLE,
            if text.is_empty() {
                "\"node --version\" printed nothing".to_owned()
            } else {
                format!("\"node --version\" printed: {text}")
            },
        ),
        // Never reached: the caller checks `is_usable` first. A wrong phase here would be
        // a lie on screen, so it says the honest thing rather than a plausible one.
        NodeCheck::Ok(_) => (phase::CHECKING_NODE, String::new()),
    }
}

/// Replace the boot state and tell the page.
fn publish(app: &AppHandle, change: impl FnOnce(&BootState) -> BootState) {
    let Some(shell) = app.try_state::<Shell>() else {
        return;
    };
    let next = {
        let Ok(mut state) = shell.boot.lock() else {
            return;
        };
        *state = change(&state);
        state.clone()
    };
    let _ = app.emit(BOOT_EVENT, next);
}

/// Point the webview at the canvas.
///
/// Done here rather than from the boot page: the URL is already known on this side, and a
/// page that navigated itself would be trusting an address that arrived over IPC.
fn go_to_canvas(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match tauri::Url::parse(url) {
        Ok(parsed) => {
            let _ = window.navigate(parsed);
        }
        Err(error) => {
            publish(app, |state| {
                state.moved_to(
                    phase::SERVER_FAILED,
                    format!("the server announced an address that cannot be opened: {error}"),
                )
            });
        }
    }
}

/* ------------------------------------------------------------------ *
 * Window and lifetime
 * ------------------------------------------------------------------ */

/// Show the window, un-minimise it, and put it in front.
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.show();
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

/// Reload whatever the window is showing.
pub fn reload_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // The canvas is a remote page, so `location.reload()` is the reload that keeps the
    // address. Re-navigating would work too and would lose the scroll position.
    let _ = window.eval("window.location.reload()");
    show_main_window(app);
}

/// Stop the child server, if one is running.
fn stop_server(app: &AppHandle) {
    if let Some(shell) = app.try_state::<Shell>()
        && let Ok(mut slot) = shell.server.lock()
        && let Some(mut handle) = slot.take()
    {
        handle.stop();
    }
}

/// N-WP15a: stop the child server and start another one with the current settings.
///
/// The one thing in this application that changes the *server's* command line while it is
/// running, and it exists because recording mode has to be a flag rather than a filter —
/// see `set_task_text_off`. Everything it needs is already here: `boot_up` resolves the
/// entry, `server::start` picks the port, and the stored port is reused when it is free,
/// so the webview usually comes back to the same origin and the user's arrangement with
/// it.
///
/// An **adopted** server is not ours to stop, and `server::start` will not adopt one while
/// recording mode is on, so the pair is consistent: turning the mode on always ends with
/// a server this shell started and knows the flags of.
fn restart_server(app: &AppHandle) -> Result<(), String> {
    let entry = server::resolve_entry(app.path().resource_dir().ok().as_deref())
        .ok_or_else(|| "the packaged canvas server is missing from this installation".to_owned())?;

    stop_server(app);

    let Some(shell) = app.try_state::<Shell>() else {
        return Err("the shell is not ready".to_owned());
    };
    let (stored, task_text) = {
        let config = shell
            .config
            .lock()
            .map_err(|_| "the settings are locked".to_owned())?;
        (config.port, config.task_text_allowed())
    };

    let handle = server::start(&entry, stored, task_text)?;
    let url = handle.url.clone();
    let port = handle.port;
    if let Ok(mut slot) = shell.server.lock() {
        *slot = Some(handle);
    }
    if let Ok(mut config) = shell.config.lock() {
        let _ = config.remember_port(port);
    }
    go_to_canvas(app, &url);
    Ok(())
}

/// Quit: the server first, then the process.
pub fn shut_down(app: &AppHandle) {
    stop_server(app);
    app.exit(0);
}

/// Make the settings file agree with what Windows will actually do.
///
/// The registry entry is the truth — a user who removed it by hand has said something
/// louder than a JSON file has — so when the two disagree the file is corrected.
fn reconcile_autostart(app: &AppHandle) {
    let Ok(enabled) = app.autolaunch().is_enabled() else {
        return;
    };
    let Some(shell) = app.try_state::<Shell>() else {
        return;
    };
    let Ok(mut config) = shell.config.lock() else {
        return;
    };
    if config.autostart != enabled {
        config.autostart = enabled;
        let _ = config.save();
    }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/// The current boot state, for a page that loaded after the answer was known.
#[tauri::command]
fn boot_state(shell: tauri::State<'_, Shell>) -> BootState {
    shell
        .boot
        .lock()
        .map(|state| state.clone())
        .unwrap_or_else(|_| BootState::starting(VERSION))
}

/// What the canvas needs to know about the thing hosting it.
#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        shell: true,
        version: VERSION.to_owned(),
        platform: std::env::consts::OS.to_owned(),
        jump_supported: jump::supported(),
    }
}

/// Bring the terminal running the session with this pid to the front.
#[tauri::command]
fn jump_to_session(pid: u32) -> Result<JumpOutcome, String> {
    jump::jump(pid)
}

/// Whether Windows starts Nazar at login.
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

/// Turn the startup entry on or off, and remember the choice.
///
/// The registry write is what matters; the settings file is a record of intent, so a
/// failure to write it is reported but does not undo the switch.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|error| error.to_string())?;
    } else {
        launcher.disable().map_err(|error| error.to_string())?;
    }

    let now = launcher.is_enabled().map_err(|error| error.to_string())?;
    if let Some(shell) = app.try_state::<Shell>()
        && let Ok(mut config) = shell.config.lock()
    {
        config.autostart = now;
        let _ = config.save();
    }
    Ok(now)
}

/// N-WP15a: is this machine in recording mode?
///
/// `true` means the child server was started with `--no-task-text`. The canvas asks once,
/// when the settings panel is built, so the switch is painted from the machine's own
/// answer rather than from a value the page remembered.
#[tauri::command]
fn get_task_text_off(shell: tauri::State<'_, Shell>) -> bool {
    shell
        .config
        .lock()
        .map(|config| !config.task_text_allowed())
        .unwrap_or(false)
}

/// Turn recording mode on or off, and restart the canvas server so it takes effect.
///
/// Answers with the state it actually reached, not the one it was asked for — the same
/// contract [`set_autostart`] keeps, and here it matters more: a restart can fail, and a
/// switch claiming task text is off while a server that reads it is still running would
/// be the one lie this feature must never tell. So the setting is written, the server is
/// restarted, and **a failed restart puts the setting back** before answering.
///
/// The window is re-pointed at whatever URL came back. It is nearly always the same one —
/// `plan_port` reuses the stored port when it is free, which is what keeps the browser's
/// arrangement — but a restart that had to take a different port would otherwise leave
/// the webview showing a dead address.
#[tauri::command]
fn set_task_text_off(app: AppHandle, off: bool) -> Result<bool, String> {
    let Some(shell) = app.try_state::<Shell>() else {
        return Err("the shell is not ready".to_owned());
    };

    {
        let mut config = shell
            .config
            .lock()
            .map_err(|_| "the settings are locked".to_owned())?;
        config.set_task_text_allowed(!off)?;
    }

    match restart_server(&app) {
        Ok(()) => Ok(off),
        Err(error) => {
            // Put the file back, so the switch and the running server agree again.
            if let Ok(mut config) = shell.config.lock() {
                let _ = config.set_task_text_allowed(off);
            }
            Err(error)
        }
    }
}

/// Open the Node download page in the machine's browser.
#[tauri::command]
fn open_download_page() -> Result<(), String> {
    node::open_download_page()
}
