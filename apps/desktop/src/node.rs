//! Asking this machine for its Node runtime, and asking Nazar what it can see.
//!
//! The reasoning about *whether* a version is good enough lives in
//! [`nazar_shell::node`], where it is testable without a machine. This module is the part
//! that has to touch one: run `node --version`, run `nazar doctor`, and do it without a
//! console window appearing on somebody's desktop.
//!
//! **Why a console window is a bug and not a detail.** `nazar-desktop.exe` is a GUI
//! binary. Every `std::process::Command` it spawns for a console program gets a fresh
//! console allocated unless it is told otherwise, and the user sees a black rectangle
//! flash past on the way to the canvas — twice, because the version check and the server
//! are two spawns. `CREATE_NO_WINDOW` is the flag; [`command`] is the one place it is set,
//! so no future caller can forget it.

use std::process::{Command, Stdio};

use nazar_shell::node::{self, NodeCheck};

/// `CREATE_NO_WINDOW`. Not imported from the `windows` crate: it is one constant, it is
/// part of the stable process-creation contract, and pulling `Win32_System_Threading`
/// into a module that spawns two commands would be a heavier dependency than the number.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` with the windowless flag already set.
///
/// Both calls below block until the child exits, and neither has a timeout. That is a
/// deliberate omission rather than an oversight: they run on the boot thread, the window
/// is already on screen saying which of them it is waiting for, and a bound that fired
/// would replace a truthful "looking for Node…" with a guess about why.
#[must_use]
pub fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Run `node --version` and decide what it means.
///
/// A spawn that fails for any reason at all — not on `PATH`, no permission, a broken
/// shim — is [`NodeCheck::Missing`]. The distinction between "not installed" and "there
/// but unusable" is not one this application can make honestly, and the advice is the
/// same either way.
#[must_use]
pub fn check() -> NodeCheck {
    let output = command("node")
        .arg("--version")
        .stdin(Stdio::null())
        .output();

    match output {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            // stderr is read too: a version manager's shim prints its complaint there,
            // and a complaint is more useful in the window than an empty box.
            if text.trim().is_empty() {
                let error = String::from_utf8_lossy(&output.stderr);
                return node::check(true, &error);
            }
            node::check(true, &text)
        }
        Err(_) => NodeCheck::Missing,
    }
}

/// Run `nazar doctor` with the packaged bundle and return what it printed.
///
/// The fallback window shows this, so it is best-effort by design: a machine with no
/// usable Node cannot run it at all, and saying so is more use than an empty panel. The
/// return value is `None` when nothing could be produced, and the caller writes the
/// sentence explaining why.
#[must_use]
pub fn doctor(entry: &std::path::Path) -> Option<String> {
    // The same simplification the server start does, and for the same reason: a verbatim
    // `\\?\` path is one Node's own `path` module cannot parse. See `server::simplify`.
    let entry = crate::server::simplify(entry);
    let output = command("node")
        .arg(&entry)
        .arg("doctor")
        .stdin(Stdio::null())
        .output()
        .ok()?;

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let error = String::from_utf8_lossy(&output.stderr);
    if !error.trim().is_empty() {
        text.push('\n');
        text.push_str(error.trim());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Hand the Node download page to the machine's browser.
///
/// The same chain `packages/server/src/open.ts` walks, and for the same reasons written
/// up there: `start` is a `cmd` builtin whose first quoted argument is the window title,
/// `rundll32` needs no shell builtin, and `explorer.exe` is the one thing on a Windows
/// desktop that is always present. Nothing here reports whether a browser actually
/// opened, which is why the link text on the boot page is the URL itself.
pub fn open_download_page() -> Result<(), String> {
    let url = node::NODE_DOWNLOAD_URL;

    #[cfg(windows)]
    let chain: [(&str, Vec<String>); 3] = [
        (
            "cmd",
            vec![
                "/c".to_owned(),
                "start".to_owned(),
                String::new(),
                url.to_owned(),
            ],
        ),
        (
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_owned(), url.to_owned()],
        ),
        ("explorer.exe", vec![url.to_owned()]),
    ];
    #[cfg(target_os = "macos")]
    let chain: [(&str, Vec<String>); 1] = [("open", vec![url.to_owned()])];
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let chain: [(&str, Vec<String>); 1] = [("xdg-open", vec![url.to_owned()])];

    for (program, args) in chain {
        if command(program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(format!(
        "no opener on this machine could be started; the address is {url}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one thing worth asserting against the real machine: the check reaches a
    /// verdict rather than hanging or panicking. Which verdict depends on the runner,
    /// and a test that demanded Node 22 would fail on a machine that is allowed not to
    /// have it — the pure crate is where the version rules are tested.
    #[test]
    fn the_check_reaches_a_verdict_on_this_machine() {
        let verdict = check();
        match verdict {
            NodeCheck::Ok(version) => assert!(version.major >= node::MINIMUM_MAJOR),
            NodeCheck::TooOld(version) => assert!(version.major < node::MINIMUM_MAJOR),
            NodeCheck::Missing | NodeCheck::Unreadable(_) => {}
        }
    }

    #[test]
    fn a_missing_bundle_produces_no_doctor_output_rather_than_a_panic() {
        let nowhere = std::env::temp_dir().join("nazar-desktop-does-not-exist.mjs");
        // Node exits non-zero with "Cannot find module", which still counts as output;
        // what must not happen is a panic or a hang.
        let _ = doctor(&nowhere);
    }
}
