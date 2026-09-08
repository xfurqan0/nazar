//! What the jump ladder sees above one session, and — on request — what it does about it.
//!
//! ```text
//!   cargo run -p nazar-desktop --example jump_probe -- <pid>
//!   cargo run -p nazar-desktop --example jump_probe -- <pid> --jump
//! ```
//!
//! The first form **touches nothing**: it takes the same process snapshot and the same
//! window enumeration `src/jump.rs` takes, hands them to the same
//! [`nazar_shell::rank`] functions, and prints the chain, the candidate windows and the
//! decision — including [`nazar_shell::rank::tied_with`], which is what decides whether
//! rung (a) is allowed to raise anything at all. It is the answer to "why did the jump
//! land there", asked without moving a window.
//!
//! The second form calls [`crate::jump::jump`] — the shipped ladder itself, not a copy —
//! prints the `JumpOutcome`, and then reads `GetForegroundWindow` back to say which
//! window is actually in front now. Raising a window is a user gesture, so this half is
//! behind a flag rather than the default.
//!
//! An example rather than a binary or a test: `cargo build` does not build it, `cargo
//! test` cannot raise windows on a runner, and a diagnostic that only runs when a person
//! asks for it is the right shape for both.
//!
//! **What is copied and what is not.** The *collection* half — the snapshot, the window
//! enumeration and the eligibility rule — is a second, smaller copy, because those
//! helpers are private to `src/jump.rs` and prising them open for a diagnostic would be
//! the tail wagging the dog. The *decisions* are not copied: `pick`, `tied_with` and
//! `hosts_tabs` are the shipped ones, so a probe that disagrees with a jump is a bug in
//! the copy above and nowhere else.

#[cfg(windows)]
#[path = "../src/jump.rs"]
mod jump;

#[cfg(windows)]
#[path = "../src/titles.rs"]
mod titles;

#[cfg(windows)]
mod probe {
    use nazar_shell::proc::{ProcessRow, ProcessTable, ancestors};
    use nazar_shell::rank::{WindowCandidate, host_rank, pick, tied_with};
    use nazar_shell::tabs::hosts_tabs;

    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
        GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;

    use super::jump;

    /// What `EnumWindows` reads as "keep going".
    const CONTINUE: BOOL = BOOL(1);

    /// One top-level window, as the enumeration handed it over.
    struct RawWindow {
        handle: isize,
        pid: u32,
        title: String,
        eligible: bool,
        z: usize,
    }

    /// A `CreateToolhelp32Snapshot` handle that closes itself.
    struct Snapshot(HANDLE);

    impl Drop for Snapshot {
        fn drop(&mut self) {
            // SAFETY: the handle came from `CreateToolhelp32Snapshot` below and is closed
            // exactly once, here.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Every process on the machine, as one consistent picture.
    fn processes() -> ProcessTable {
        // SAFETY: a process snapshot with no target pid is the documented call; the handle
        // is owned by `Snapshot` from here on.
        let Ok(handle) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return ProcessTable::default();
        };
        let snapshot = Snapshot(handle);

        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or_default(),
            ..Default::default()
        };

        let mut rows = Vec::new();
        // SAFETY: `entry` has its `dwSize` set as the API requires and outlives the call.
        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
            return ProcessTable::default();
        }
        loop {
            rows.push(ProcessRow::new(
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                widestring(&entry.szExeFile),
            ));
            // SAFETY: same handle, same correctly sized structure.
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                break;
            }
        }
        ProcessTable::from_rows(rows)
    }

    /// A `[u16; N]` the API filled and NUL-terminated.
    fn widestring(buffer: &[u16]) -> String {
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    /// Every top-level window, with the process that owns it.
    fn windows() -> Vec<RawWindow> {
        let mut found: Vec<RawWindow> = Vec::new();
        // SAFETY: the callback is a plain `extern "system"` function and the pointer handed
        // through `LPARAM` outlives the call, because `EnumWindows` is synchronous.
        let _ = unsafe {
            EnumWindows(
                Some(collect),
                LPARAM(std::ptr::from_mut(&mut found) as isize),
            )
        };
        found
    }

    unsafe extern "system" fn collect(handle: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the pointer `windows()` passed, and nothing else calls this.
        let found = unsafe { &mut *(lparam.0 as *mut Vec<RawWindow>) };

        let mut pid = 0u32;
        // SAFETY: `handle` came from the enumeration and `pid` is a live local.
        unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) };
        if pid == 0 {
            return CONTINUE;
        }

        // SAFETY: all three read properties of a handle the enumeration just produced.
        let visible = unsafe { IsWindowVisible(handle) }.as_bool();
        let owned = unsafe { GetWindow(handle, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid());
        let extended = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        let tool = extended & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap_or_default() != 0;

        let title = text_of(handle);
        found.push(RawWindow {
            handle: handle.0 as isize,
            pid,
            // The same rule `src/jump.rs` applies: on screen, not owned by another window,
            // not a tool palette, and with a name.
            eligible: visible && !owned && !tool && !title.is_empty(),
            title,
            z: found.len(),
        });
        CONTINUE
    }

    /// A window's title, or the empty string.
    fn text_of(handle: HWND) -> String {
        let mut text = [0u16; 512];
        // SAFETY: the buffer is a live local and its length is passed correctly.
        let length = unsafe { GetWindowTextW(handle, &mut text) };
        if length <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&text[..usize::try_from(length).unwrap_or_default()])
    }

    /// Which window holds the foreground right now, named by its process.
    fn foreground(table: &ProcessTable) -> String {
        // SAFETY: an argument-free read of this desktop's own state.
        let handle = unsafe { GetForegroundWindow() };
        if handle.is_invalid() {
            return "nothing holds the foreground".to_owned();
        }
        let mut pid = 0u32;
        // SAFETY: `handle` is the live foreground window and `pid` is a live local.
        unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) };
        let name = table
            .get(pid)
            .map_or_else(|| format!("pid {pid}"), |row| row.name.clone());
        format!(
            "{name} (pid {pid}, hwnd 0x{:x}) — {:?}",
            handle.0 as isize,
            text_of(handle)
        )
    }

    /// The probe.
    pub fn run() {
        let mut pid: Option<u32> = None;
        let mut raise = false;
        for argument in std::env::args().skip(1) {
            if argument == "--jump" {
                raise = true;
            } else if let Ok(value) = argument.parse::<u32>() {
                pid = Some(value);
            } else {
                eprintln!("jump_probe: ignoring {argument}");
            }
        }
        let Some(pid) = pid else {
            eprintln!(
                "usage: jump_probe <pid> [--jump]\n  \
                 without --jump nothing is raised and no window is touched"
            );
            return;
        };

        println!("jump is supported on this build: {}", jump::supported());
        let table = processes();
        let chain = ancestors(&table, pid);
        if chain.is_empty() {
            println!("no process {pid} in the snapshot — nothing to walk");
            return;
        }

        println!("chain, session first:");
        for step in &chain {
            println!(
                "  depth {}  {:<24} pid {}",
                step.depth, step.row.name, step.row.pid
            );
        }

        let all = windows();
        let mut candidates: Vec<WindowCandidate> = Vec::new();
        for step in &chain {
            for window in &all {
                if window.pid != step.row.pid {
                    continue;
                }
                candidates.push(WindowCandidate {
                    handle: window.handle,
                    pid: window.pid,
                    executable: step.row.name.clone(),
                    depth: step.depth,
                    eligible: window.eligible,
                    title: window.title.clone(),
                });
                println!(
                    "  window  {:<24} depth {} hwnd 0x{:<10x} z {:<4} eligible {:<5} host_rank {:?} {:?}",
                    step.row.name,
                    step.depth,
                    window.handle,
                    window.z,
                    window.eligible,
                    host_rank(&step.row.name),
                    window.title
                );
            }
        }
        if candidates.is_empty() {
            println!("no process in the chain owns a top-level window");
        }

        let Some(chosen) = pick(&candidates) else {
            println!("rank: nothing eligible to choose from, so a jump would raise nothing");
            return;
        };
        let tied = tied_with(&candidates, chosen);
        println!(
            "rank: {} at depth {}, hwnd 0x{:x} — {:?}",
            chosen.executable, chosen.depth, chosen.handle, chosen.title
        );
        println!(
            "      tied_with = {tied}, so rung (a) {}",
            if tied == 1 {
                "may raise it: there was only one window it could be"
            } else {
                "declines: several windows could be this session"
            }
        );
        println!(
            "      tab host: {}",
            if hosts_tabs(&chosen.executable) {
                "yes — rung (b) reads the tabs and may pick a different window"
            } else {
                "no — the window is as far as the ladder goes for this host"
            }
        );

        if !raise {
            println!("\nnothing was touched. Pass --jump to run the real ladder.");
            return;
        }

        println!("\nforeground before: {}", foreground(&table));
        println!("running the shipped ladder:");
        match jump::jump(pid) {
            Ok(outcome) => println!(
                "{}",
                serde_json::to_string_pretty(&outcome).unwrap_or_else(|_| outcome.message.clone())
            ),
            Err(error) => eprintln!("jump_probe: {error}"),
        }
        println!("foreground now: {}", foreground(&processes()));
    }
}

fn main() {
    #[cfg(windows)]
    probe::run();

    #[cfg(not(windows))]
    eprintln!(
        "the jump probe reads Windows process and window tables; there are none to read here"
    );
}
