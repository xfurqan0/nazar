//! The decisions the desktop shell has to make, with no platform API in sight.
//!
//! Three questions, and none of them needs a window handle, a process handle or a running
//! Tauri application to answer:
//!
//! 1. **Is the Node on this machine new enough?** [`node`] parses what `node --version`
//!    printed and compares it with what the packaged server needs.
//! 2. **Which ancestor of a Claude Code process hosts its terminal?** [`proc`] walks a
//!    parent chain over a snapshot somebody else took, with a cycle guard and a depth
//!    bound, so a lying or recycled pid cannot spin.
//! 3. **Which of that process's windows should be raised?** [`rank`] scores the candidates
//!    by how the terminal emulators on Windows actually behave.
//! 4. **Which tab of that window is the session actually in?** [`tabs`] matches what the
//!    terminal is displaying against what Claude Code knows the session is called. It is
//!    also what disambiguates *windows*, because every Windows Terminal window on a
//!    machine belongs to one process and the walk in [`proc`] therefore cannot tell them
//!    apart.
//!
//! Keeping them here rather than in `apps/desktop` is not tidiness. It is what lets the
//! whole of the jump ladder's reasoning be tested with fake data — a hand-written process
//! table, a hand-written window list — on Windows, Ubuntu and macOS, on a runner with no
//! WebView2, no GTK and no display. `apps/desktop` is then the thin layer that fills those
//! structures in from `CreateToolhelp32Snapshot` and `EnumWindows` and does the one thing
//! that genuinely needs the operating system: raising the window.

#![forbid(unsafe_code)]

pub mod node;
pub mod proc;
pub mod rank;
pub mod tabs;
