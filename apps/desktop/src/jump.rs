//! Jump to the terminal a session is running in.
//!
//! Double-click a session card and the window hosting that Claude Code process comes to
//! the front. That is the whole feature, and it is the one thing the shell does that a
//! browser tab cannot — so it is also the only place in Nazar that reaches out and changes
//! something outside its own window.
//!
//! # The ladder
//!
//! The plan describes this as a ladder, each rung tried in turn and each recorded. Here is
//! where each one stands.
//!
//! ## (a) Find the window, raise the window — **implemented, and gated**
//!
//! A session knows its own pid; that process has no window. So:
//!
//! 1. Take one process snapshot with `CreateToolhelp32Snapshot`. One snapshot, not a walk
//!    of live handles: the tree moves while you read it, and a consistent picture is what
//!    makes the cycle guard in [`nazar_shell::proc`] mean anything.
//! 2. Walk the parent chain upward, bounded and cycle-guarded.
//! 3. Enumerate top-level windows with `EnumWindows` and attribute each to its process
//!    with `GetWindowThreadProcessId`.
//! 4. Score the ones belonging to the chain ([`nazar_shell::rank`]) and pick.
//! 5. Restore it if minimised, then bring it to the front.
//!
//! **Step 5 now asks permission first**, and the reason is the second bug the maintainer
//! reported. The ranking's last tie-break is the window handle, which is stable and carries
//! no information; when a host owns several windows that tie, "the lowest handle" is a coin
//! toss dressed as an answer, and two sessions in a row landed on a *third* session's
//! terminal. So rung (a) may raise the window it chose only when
//! [`nazar_shell::rank::tied_with`] says there was exactly one it could have been — a
//! `conhost.exe` console, a `mintty`, a single VS Code window, which is most machines most
//! of the time. With more than one, it defers to the rungs below and, if they cannot answer
//! either, **raises nothing and says how many windows it could not choose between.** Two
//! sessions being sent to a stranger's terminal is worse than one honest sentence.
//!
//! ## (b) Select the right *tab* in Windows Terminal — **implemented, by title**
//!
//! An earlier note here recorded this rung as unavailable, and it also recorded the reason
//! rung (a) is enough on its own: *"all tabs of one Windows Terminal window belong to one
//! `WindowsTerminal.exe`, so rung (a) always raises the correct window"*. **The second half
//! of that sentence is false, and it is the bug the maintainer reported.** One process does
//! not mean one window: Windows Terminal hosts *every* window it has in a single process,
//! so four windows on four monitors are one pid, the parent-chain walk cannot tell them
//! apart, and the ranking then falls through to its stable tie-break and raises the same
//! window for all four sessions. "It always opens the same one" was the ranking working
//! exactly as designed on evidence that could not distinguish the answers.
//!
//! So the missing piece was never a tab index. It was a **key** — something Nazar knows
//! about a session that a person can also see on the terminal. There is one, and it was
//! hiding in plain sight: Claude Code writes the session's own generated title into the
//! terminal title, with a status mark in front of it. The three strings below are
//! stand-ins for the ones that were on screen; their *shapes* are what was measured.
//!
//! ```text
//!   window / tab title   "◐ Repaint the harbour wall"
//!   session's ai-title   "Repaint the harbour wall"
//!   registry name        "widgets-7f"   ← derived from the directory; matches nothing
//! ```
//!
//! The rung is therefore three steps, and none of them guesses at a command line:
//!
//! 1. **Read the keys** ([`crate::titles`]): the generated title out of the tail of the
//!    session's transcript, the registry name, the working directory's last segment.
//! 2. **Read the tabs.** UI Automation, the same interface `inspect.exe` uses: every
//!    `TabItem` under every window the chosen host owns, with its accessible name — which
//!    for Windows Terminal is the tab's title — and its position.
//! 3. **Match, then select** ([`nazar_shell::tabs`]), then raise **the window holding the
//!    matched tab** rather than the one the ranking happened to pick.
//!
//! `wt.exe` is never invoked. It has a `focus-tab --target <index>` subcommand and the
//! index is now obtainable, but a `SelectionItemPattern.Select()` on the element already in
//! hand does the same thing without spawning a process, without a command line to get
//! wrong, and without the usage dialog a wrong one puts on the user's screen.
//!
//! ### When no title matches: the two subtractive rules, and the refusal
//!
//! A title match needs the session to *have* a title, and a session Claude Code has not got
//! round to titling yet does not. Measured on the maintainer's machine: five sessions, five
//! Windows Terminal windows, three matched — and the two that did not had **no `ai-title`
//! line anywhere in their transcripts**, so what their terminals were showing was Claude
//! Code's own default title. Both fell through to rung (a) and both raised the lowest-handle
//! window, which belonged to a session that was working.
//!
//! So when no key matches, two more rules run in [`nazar_shell::tabs::resolve`], and neither
//! guesses — both *subtract* until one candidate is left:
//!
//! 1. **Exclusion by ownership.** Every other **live** session's keys are read by the same
//!    [`crate::titles`] code path and matched against the same tabs by the same matcher. A
//!    tab another session demonstrably owns is not this one's. Exactly one tab left over is
//!    the answer (`rung: "b-exclusion"`), because it is the only window on the machine that
//!    is not somebody else's.
//! 2. **The default title, once.** If several are still left and this session is *known* to
//!    have no title of its own, a single remaining tab still reading "Claude Code" is that
//!    session's (`rung: "b-default"`). Two of them and the rule declines: two untitled
//!    sessions look exactly alike and no amount of cleverness changes that.
//!
//! Liveness in (1) is load-bearing rather than an optimisation. A session that has ended
//! leaves its registry file and its transcript behind, and letting a ghost claim a tab can
//! leave the *wrong* one as the only tab over — so the list is filtered against the process
//! snapshot this function already took, and `nazar_shell::tabs` has the test that fails if
//! the filter is ever dropped.
//!
//! **And when neither answers, nothing is raised.** `rung: "none"`, `raised: false`, and a
//! sentence saying how many windows could have been this session — which the canvas pairs
//! with `TAB_NEEDS_A_NAME` from `packages/ui/web/shell.ts`, because `/rename` is the one
//! action that fixes it from where the user is sitting. A wrong tab is worse than no tab,
//! because the user cannot tell it from a right one.
//!
//! Two bounds worth stating. The whole of rung (b) runs on **its own thread** with a
//! [`platform::uia::BUDGET`] deadline, because a cross-process accessibility call is a
//! blocking call into another program's UI thread and the shell's own message loop must not
//! wait on it. And it runs **only for hosts on [`nazar_shell::tabs::TAB_HOSTS`]** — VS Code
//! and Cursor publish `TabItem` elements too, for editor tabs, and selecting one of those
//! would be confidently wrong.
//!
//! ## (c) VS Code and Cursor — **window only, by the same rung**
//!
//! `Code.exe` and `cursor.exe` are on the preference list, so the editor window comes
//! forward. Which panel and which integrated terminal it then shows is the editor's
//! business and there is no supported way to ask it from outside.
//!
//! One window is the common case and it works. **Two editor windows in the chain now get
//! the refusal** rather than the lower handle: they are not a tab host, so nothing below
//! rung (a) can separate them, and the gate on rung (a) applies to every host equally. That
//! is a deliberate trade — a sentence naming the problem, in exchange for never sending
//! somebody to the wrong project.
//!
//! ## macOS and Linux — **not supported yet**
//!
//! [`jump`] compiles to a stub that says so. The parts that are pure arithmetic are in
//! `nazar-shell` and already build and test on both, which is what makes a later port a
//! step rather than a rewrite.
//!
//! # The Windows foreground rules
//!
//! `SetForegroundWindow` fails silently for a process that has not earned the right, and
//! that is not a bug to work around — it is what stops background programs from stealing
//! your keystrokes. A process may set the foreground window when, among other conditions,
//! **it is itself the foreground process**, or when it is processing input the user just
//! gave it. A double-click on our own canvas satisfies both: the shell's window has the
//! foreground, and the click is the input. That is why the jump is a user gesture and
//! never a timer, an event from the server, or anything else that could raise a window
//! nobody asked for.
//!
//! Two more pieces, both of which have to be there for the raise to be reliable:
//!
//! * **`AttachThreadInput`.** Foreground state is per input queue. Attaching the shell's
//!   thread to the current foreground window's thread puts them on one queue for the
//!   duration of the call, which is what makes `SetForegroundWindow` take effect instead
//!   of merely flashing the taskbar button. It is skipped when the two threads are the
//!   same, because attaching a thread to itself fails.
//! * **`SwitchToThisWindow` as the fallback.** When the dance still does not take —
//!   another process holds a foreground lock, or the shell lost focus between the click
//!   and the call — this is the shell's own "alt-tab to that window", and it is checked
//!   afterwards by reading `GetForegroundWindow` back rather than assumed.
//!
//! `AllowSetForegroundWindow(ASFW_ANY)` is called first. It does not give *us* anything —
//! it gives the *target* permission to raise itself, which is what a terminal that
//! responds to being poked needs, and it is a no-op when nothing uses it.

use serde::Serialize;

/// What a jump did, in enough detail to put in a report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpOutcome {
    /// Whether a window is now in the foreground because of this call.
    pub raised: bool,
    /// Which rung answered:
    ///
    /// * `"b"` — a tab title matched one of the session's own names.
    /// * `"b-exclusion"` — no name matched, but every other live session's tab was
    ///   accounted for and exactly one window was left over.
    /// * `"b-default"` — several were left over, this session has no title yet, and exactly
    ///   one of them was still showing Claude Code's default title.
    /// * `"a"` — the tab could not be identified and the host owns exactly one window, so
    ///   there was only ever one window it could be.
    /// * `"none"` — nothing was raised. Either there was no window above the session at
    ///   all, or **several windows could have been this session and raising an arbitrary
    ///   one is worse than raising none.**
    pub rung: &'static str,
    /// The executable owning the window, when one was found.
    pub host: Option<String>,
    /// Its distance above the session process, in parent-chain steps.
    pub depth: Option<usize>,
    /// The window's title, which is what the user recognises it by.
    pub title: Option<String>,
    /// What rung (b) found, or `None` on a host with no tabs to look at.
    pub tab: Option<TabOutcome>,
    /// One sentence for a human: what happened, or why nothing did.
    pub message: String,
}

/// What rung (b) did, including — especially — when it declined to do anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabOutcome {
    /// Whether a tab was identified as this session's.
    pub matched: bool,
    /// Its title, as the terminal is displaying it, status mark and all.
    pub title: Option<String>,
    /// Its position among its window's tabs, left to right from zero.
    pub index: Option<usize>,
    /// The handle of the window holding it — which is the window that was raised, and not
    /// necessarily the one the ranking would have picked. It is in the outcome because
    /// "the same window every time" is the failure this rung exists to fix, and a title is
    /// harder to compare across four jumps than a number is.
    pub window: Option<isize>,
    /// Which reasoning found it: `title`, `exclusion` or `defaultTitle`. `None` when
    /// nothing did.
    pub route: Option<&'static str>,
    /// Which key matched: `aiTitle`, `renamedName`, `derivedName` or `cwdBasename`. Only
    /// the `title` route has one — the other two answer without any key matching, which is
    /// the reason they exist.
    pub source: Option<&'static str>,
    /// How hard the matcher had to look: `exact`, `contains` or `normalised`.
    pub tier: Option<&'static str>,
    /// Whether more than one tab matched and the front one was taken.
    pub ambiguous: bool,
    /// Whether the selection call actually went through. A tab that was already the
    /// selected one still reports `true`: selecting it is what was asked for and it is
    /// what is now selected.
    pub selected: bool,
    /// How many tabs were on offer across the host's windows. Zero means the accessibility
    /// tree had nothing to say, which is not the same as nothing matching.
    pub candidates: usize,
    /// How many other live sessions were consulted for the exclusion pass.
    pub others: usize,
    /// How many of the tabs one of them demonstrably owns.
    pub owned: usize,
    /// How many were left over for this session. One is an answer; more is the refusal.
    pub unclaimed: usize,
    /// Why this tab and not another, or why none of them.
    pub reason: Option<String>,
}

impl TabOutcome {
    /// A rung (b) that ran and did not find its tab.
    fn missed(candidates: usize, reason: impl Into<String>) -> Self {
        TabOutcome {
            matched: false,
            title: None,
            index: None,
            window: None,
            route: None,
            source: None,
            tier: None,
            ambiguous: false,
            selected: false,
            candidates,
            others: 0,
            owned: 0,
            unclaimed: 0,
            reason: Some(reason.into()),
        }
    }
}

impl JumpOutcome {
    fn nothing(message: impl Into<String>) -> Self {
        JumpOutcome {
            raised: false,
            rung: "none",
            host: None,
            depth: None,
            title: None,
            tab: None,
            message: message.into(),
        }
    }
}

/// Whether this build can jump at all. The canvas asks before it offers the menu entry.
#[must_use]
pub const fn supported() -> bool {
    cfg!(windows)
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

#[cfg(windows)]
mod platform {
    use nazar_shell::proc::{ProcessRow, ProcessTable, ancestors};
    use nazar_shell::rank::{WindowCandidate, pick, tied_with};
    use nazar_shell::tabs::hosts_tabs;

    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        ASFW_ANY, AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GW_OWNER, GWL_EXSTYLE,
        GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE, SW_SHOW,
        SetForegroundWindow, ShowWindow, SwitchToThisWindow, WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;

    use super::{JumpOutcome, TabOutcome};

    /// What `EnumWindows` reads as "keep going".
    const CONTINUE: BOOL = BOOL(1);

    /// One window as `EnumWindows` handed it over.
    struct RawWindow {
        handle: HWND,
        pid: u32,
        title: String,
        eligible: bool,
        /// Its place in the enumeration, which is the z-order, front first. It is the only
        /// evidence available for "which of these did the user look at most recently", and
        /// rung (b) uses it to break a tie between two tabs with the same title.
        z: usize,
    }

    /// A `CreateToolhelp32Snapshot` handle that closes itself.
    struct Snapshot(HANDLE);

    impl Drop for Snapshot {
        fn drop(&mut self) {
            // SAFETY: the handle came from `CreateToolhelp32Snapshot` in `processes` and
            // is closed exactly once, here.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Every process on the machine, as one consistent picture.
    fn processes() -> Result<ProcessTable, String> {
        // SAFETY: a process snapshot with no target pid is the documented call; the
        // handle is owned by `Snapshot` from here on.
        let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| format!("could not read the process list: {error}"))?;
        let snapshot = Snapshot(handle);

        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or_default(),
            ..Default::default()
        };

        let mut rows = Vec::new();
        // SAFETY: `entry` has its `dwSize` set as the API requires and outlives the call.
        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
            return Ok(ProcessTable::default());
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
        Ok(ProcessTable::from_rows(rows))
    }

    /// A `[u16; N]` that the API filled and NUL-terminated.
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
        // SAFETY: the callback below is a plain `extern "system"` function, and the
        // pointer handed through `LPARAM` is a `&mut Vec<RawWindow>` that outlives the
        // call because `EnumWindows` is synchronous.
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

        // SAFETY: all four read properties of a handle the enumeration just produced.
        let visible = unsafe { IsWindowVisible(handle) }.as_bool();
        let owned = unsafe { GetWindow(handle, GW_OWNER) }.is_ok_and(|owner| !owner.is_invalid());
        let extended = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        let tool = extended & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap_or_default() != 0;

        let mut text = [0u16; 512];
        // SAFETY: the buffer is a live local and its length is passed correctly.
        let length = unsafe { GetWindowTextW(handle, &mut text) };
        let title = if length > 0 {
            String::from_utf16_lossy(&text[..usize::try_from(length).unwrap_or_default()])
        } else {
            String::new()
        };

        found.push(RawWindow {
            handle,
            pid,
            // A window worth raising is one a user could alt-tab to: on screen, not owned
            // by another window, not a tool palette, and with a name. Node and the shell
            // both hold message-only windows that pass the first test and fail the rest.
            eligible: visible && !owned && !tool && !title.is_empty(),
            title,
            // `EnumWindows` walks the z-order from the front, so the count so far is the
            // window's depth into it.
            z: found.len(),
        });
        CONTINUE
    }

    /// The ladder, start to finish: rung (a) to choose the host, rung (b) to choose the
    /// window and tab within it.
    pub fn jump(pid: u32) -> Result<JumpOutcome, String> {
        let table = processes()?;
        let chain = ancestors(&table, pid);
        if chain.is_empty() {
            return Ok(JumpOutcome::nothing(format!(
                "no process {pid} on this machine — the session has probably ended"
            )));
        }

        let all = windows();
        let mut candidates: Vec<WindowCandidate> = Vec::new();
        for step in &chain {
            for window in &all {
                if window.pid != step.row.pid {
                    continue;
                }
                candidates.push(WindowCandidate {
                    handle: window.handle.0 as isize,
                    pid: window.pid,
                    executable: step.row.name.clone(),
                    depth: step.depth,
                    eligible: window.eligible,
                    title: window.title.clone(),
                });
            }
        }

        let Some(chosen) = pick(&candidates) else {
            let names: Vec<&str> = chain.iter().map(|step| step.row.name.as_str()).collect();
            return Ok(JumpOutcome::nothing(format!(
                "no window above this session to raise (chain: {})",
                names.join(" → ")
            )));
        };

        // How many windows the ranking could not tell apart from the one it named. One
        // means it had evidence; more means it sorted by handle, and the handle is not
        // evidence. It decides whether rung (a) may raise anything on its own.
        let tied = tied_with(&candidates, chosen);

        // Rung (b). The windows it may look at are every eligible window of the *host
        // process* the ranking chose — which on Windows Terminal is every window the
        // machine has, because they all belong to one process. That fact is the whole
        // reason this rung exists.
        let mut target = chosen.handle;
        let mut title = chosen.title.clone();
        let tab = hosts_tabs(&chosen.executable).then(|| {
            let siblings: Vec<(isize, usize)> = all
                .iter()
                .filter(|window| window.pid == chosen.pid && window.eligible)
                .map(|window| (window.handle.0 as isize, window.z))
                .collect();
            // Read once per jump, on this thread, before the accessibility work starts:
            // this session's names and every other live session's. The liveness filter is
            // the process snapshot taken at the top of this function — a session that has
            // ended must not claim a window, and `nazar_shell::tabs::MAX_OTHERS` says why.
            let mine = crate::titles::keys_for(pid);
            let others = crate::titles::other_keys_for(pid, &|other| table.get(other).is_some());
            let outcome = uia::find_and_select(siblings, mine, others);
            if let Some((window, found)) = outcome.window_and_title() {
                target = window;
                title = found;
            }
            outcome
        });

        // What the ladder is allowed to raise. A tab that was identified names its own
        // window, whichever rung found it. Without one, rung (a) may raise the window the
        // ranking chose **only when there was exactly one it could be** — otherwise the
        // honest answer is that several windows could be this session, and Nazar says so
        // instead of raising one of them and hoping.
        let route = tab.as_ref().and_then(|tab| tab.route);
        let rung = match route {
            Some("title") => "b",
            Some("exclusion") => "b-exclusion",
            Some("defaultTitle") => "b-default",
            _ if tied == 1 => "a",
            _ => "none",
        };

        let raised = rung != "none" && raise(HWND(target as *mut std::ffi::c_void));

        Ok(JumpOutcome {
            raised,
            rung,
            host: Some(chosen.executable.clone()),
            depth: Some(chosen.depth),
            // The host is still worth naming on a refusal — it is what the process tree
            // found, and it is true. A *title* is not: nothing was chosen, and printing the
            // lowest-handle window's title next to "none was raised" would read as though
            // that window had been considered and rejected, which is the opposite of what
            // happened.
            title: (rung != "none").then_some(title),
            message: sentence(
                rung,
                raised,
                &chosen.executable,
                chosen.depth,
                tied,
                tab.as_ref(),
            ),
            tab,
        })
    }

    /// The one sentence the canvas puts in its hint.
    ///
    /// The refusal is the branch worth reading twice. It does not repeat the `/rename`
    /// advice that `TAB_NEEDS_A_NAME` in `packages/ui/web/shell.ts` appends to it — the
    /// hint is assembled from both halves and saying it twice reads like a stutter.
    fn sentence(
        rung: &str,
        raised: bool,
        host: &str,
        depth: usize,
        tied: usize,
        tab: Option<&TabOutcome>,
    ) -> String {
        if rung == "none" {
            // Nothing was raised, and it was on purpose. The count is the point: it is what
            // turns "jump is broken" into "Nazar cannot tell these two apart, and here is
            // how many there are".
            //
            // The count comes from whichever half actually counted something. Rung (b)
            // knows how many tabs were left unaccounted for, and that is the number that
            // means something to a person standing in front of five terminals; without it
            // — no tab host, no UI Automation, no answer inside the budget — all there is
            // is how many windows the ranking could not tell apart.
            let could_be = tab
                .map(|tab| tab.unclaimed)
                .filter(|unclaimed| *unclaimed > 0)
                .unwrap_or(tied);
            return format!(
                "{could_be} {host} windows could be this session, so none was raised — Nazar will not guess between them"
            );
        }
        if !raised {
            return format!(
                "found {host} but Windows refused the foreground; its taskbar button should be flashing"
            );
        }
        match tab {
            Some(tab) if tab.matched && tab.ambiguous => format!(
                "raised {host} and selected the session's tab — but another tab has the same title, so the front one was taken"
            ),
            Some(tab) if tab.route == Some("exclusion") => format!(
                "raised {host} and selected the one window of {} that no other session is in",
                tab.candidates
            ),
            Some(tab) if tab.route == Some("defaultTitle") => format!(
                "raised {host} and selected the one window still showing Claude Code's default title — this session has no title yet"
            ),
            Some(tab) if tab.matched => {
                format!("raised {host} and selected the tab this session is running in")
            }
            Some(tab) if tab.candidates > 1 => format!(
                "raised {host} ({} tabs open), and could not tell which one is this session",
                tab.candidates
            ),
            _ => format!("raised {host} ({depth} steps above the session)"),
        }
    }

    /* -------------------------------------------------------------- *
     * Rung (b): the tabs, through UI Automation
     * -------------------------------------------------------------- */

    /// Reading a terminal's tabs, and selecting one.
    ///
    /// UI Automation is a COM client library and every call in it is a call *into another
    /// process's UI thread*. Two consequences shape this module and neither is optional:
    ///
    /// * **It runs on its own thread**, initialised into the multi-threaded apartment,
    ///   because a client that blocks its own message loop on a provider that is waiting
    ///   on that same loop is the documented way to deadlock this API. The shell's thread
    ///   posts the work and waits on a channel with [`BUDGET`] on it; a terminal that does
    ///   not answer in time costs a fallback to rung (a) and nothing else.
    /// * **Nothing crosses the thread boundary but plain data.** An `IUIAutomationElement`
    ///   belongs to the apartment that made it, so the elements never leave: the match is
    ///   made there and the answer that comes back is a window handle, a title and an
    ///   index.
    pub mod uia {
        use std::ffi::c_void;
        use std::sync::mpsc;
        use std::time::Duration;

        use nazar_shell::tabs::{Claim, KeySource, TabCandidate, Tier, TitleKey, resolve};

        use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE};
        use windows::Win32::System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        };
        use windows::Win32::System::Variant::{VARIANT, VT_I4};
        use windows::Win32::UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationSelectionItemPattern,
            TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_SelectionItemPatternId,
            UIA_TabItemControlTypeId,
        };

        use super::super::TabOutcome;

        /// How long the shell's thread will wait for a terminal to describe its tabs.
        ///
        /// A jump is a gesture, so this is a responsiveness budget rather than a
        /// correctness one: overrunning it means the window is raised without the tab,
        /// which is the behaviour the feature had before this rung existed. Measured on
        /// the machine this was written on, four windows answer in well under a tenth of
        /// this.
        pub const BUDGET: Duration = Duration::from_millis(1500);

        /// What a miss says when the UI Automation client could not be created at all.
        ///
        /// The text is a constant rather than a literal because the live tests read it: a
        /// session with no desktop to read cannot answer the question those tests ask, and
        /// an environment that cannot answer is a skip, while a terminal that answers with
        /// no tabs is a failure. The two have to be told apart by something.
        pub const UNAVAILABLE: &str = "UI Automation is not available here";

        /// And what it says when the terminal did not answer inside [`BUDGET`], which is
        /// the same kind of silence for the same reason.
        pub const OVERRAN: &str = "the terminal did not describe its tabs within";

        impl TabOutcome {
            /// The window to raise and the title to report, when a tab was found.
            #[must_use]
            pub(super) fn window_and_title(&self) -> Option<(isize, String)> {
                let title = self.title.clone()?;
                self.matched.then_some((self.window?, title))
            }
        }

        /// Find this session's tab across a host's windows and select it.
        ///
        /// `keys` are the session's own names and `others` the same lists for every other
        /// live session — the second is what lets a session with no name of its own be
        /// found by what is left over once everybody else is accounted for. Both are read
        /// off disk by the caller before this is entered, once per jump, because the
        /// apartment thread below should be doing accessibility work and not file I/O.
        ///
        /// Always an answer, never an error: every way this can fail — no UI Automation,
        /// a terminal that will not describe itself, a deadline — is a reason the tab was
        /// not found, and the caller's response to all of them is the same.
        #[must_use]
        pub fn find_and_select(
            windows: Vec<(isize, usize)>,
            keys: Vec<TitleKey>,
            others: Vec<Vec<TitleKey>>,
        ) -> TabOutcome {
            if windows.is_empty() {
                return TabOutcome::missed(0, "the host owns no window to look in");
            }

            let (sender, receiver) = mpsc::channel();
            let spawned = std::thread::Builder::new()
                .name("nazar-uia".to_owned())
                .spawn(move || {
                    // A send that fails means the deadline passed and nobody is listening
                    // any more. The work is finished either way.
                    let _ = sender.send(run(&windows, &keys, &others));
                });
            if let Err(error) = spawned {
                return TabOutcome::missed(0, format!("no thread for the tab lookup: {error}"));
            }

            receiver.recv_timeout(BUDGET).unwrap_or_else(|_| {
                TabOutcome::missed(0, format!("{OVERRAN} {} ms", BUDGET.as_millis()))
            })
        }

        /// The whole of rung (b), on the thread that owns the apartment.
        fn run(
            windows: &[(isize, usize)],
            keys: &[TitleKey],
            others: &[Vec<TitleKey>],
        ) -> TabOutcome {
            let _apartment = match Apartment::enter() {
                Ok(apartment) => apartment,
                Err(reason) => return TabOutcome::missed(0, reason),
            };

            // SAFETY: the documented way to obtain the UI Automation client object. The
            // interface is reference counted by `windows` and released when it drops.
            let automation: IUIAutomation =
                match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                    Ok(automation) => automation,
                    Err(error) => {
                        return TabOutcome::missed(0, format!("{UNAVAILABLE}: {error}"));
                    }
                };

            let wanted = control_type(UIA_TabItemControlTypeId.0);
            // SAFETY: `wanted` is a VT_I4 variant that outlives the call, and the property
            // id is one of the library's own constants.
            let condition = match unsafe {
                automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &wanted)
            } {
                Ok(condition) => condition,
                Err(error) => {
                    return TabOutcome::missed(0, format!("could not ask for tabs: {error}"));
                }
            };

            let mut candidates: Vec<TabCandidate> = Vec::new();
            let mut elements: Vec<IUIAutomationElement> = Vec::new();
            for (handle, z) in windows {
                // SAFETY: the handle came from this process's own `EnumWindows` pass. A
                // window that has closed since produces an error, which is skipped.
                let Ok(root) =
                    (unsafe { automation.ElementFromHandle(HWND(*handle as *mut c_void)) })
                else {
                    continue;
                };
                // SAFETY: both arguments are live COM objects owned by this thread.
                let Ok(found) = (unsafe { root.FindAll(TreeScope_Descendants, &condition) }) else {
                    continue;
                };
                // SAFETY: reading the length of the array the search just returned.
                let length = unsafe { found.Length() }.unwrap_or_default();
                for index in 0..length {
                    // SAFETY: `index` is inside the length the array just reported.
                    let Ok(element) = (unsafe { found.GetElement(index) }) else {
                        continue;
                    };
                    // SAFETY: the element is live; `CurrentName` allocates a BSTR the
                    // wrapper frees.
                    let title = unsafe { element.CurrentName() }
                        .map(|name| name.to_string())
                        .unwrap_or_default();
                    candidates.push(TabCandidate {
                        window: *handle,
                        z: *z,
                        index: usize::try_from(index).unwrap_or_default(),
                        title,
                    });
                    elements.push(element);
                }
            }

            let total = candidates.len();

            // How much of the answer came from other people's windows, for the report. It
            // is recomputed rather than returned by `resolve` because it is diagnostics
            // and the matcher should not grow an output for the sake of a log line.
            let owned = others
                .iter()
                .filter_map(|other| {
                    nazar_shell::tabs::pick_tab(other, &candidates)
                        .map(|picked| (picked.tab.window, picked.tab.index))
                })
                .collect::<std::collections::HashSet<_>>()
                .len();
            let counted = |mut outcome: TabOutcome| -> TabOutcome {
                outcome.candidates = total;
                outcome.others = others.len();
                outcome.owned = owned;
                outcome
            };

            match resolve(keys, others, &candidates) {
                Claim::Found {
                    tab,
                    route,
                    source,
                    tier,
                    ambiguous,
                } => {
                    // `candidates` and `elements` were filled in the same order, one push
                    // each.
                    let at = candidates
                        .iter()
                        .position(|candidate| candidate == tab)
                        .unwrap_or_default();
                    counted(TabOutcome {
                        matched: true,
                        title: Some(tab.title.clone()),
                        index: Some(tab.index),
                        window: Some(tab.window),
                        route: Some(route.as_str()),
                        source: source.map(KeySource::as_str),
                        tier: tier.map(Tier::as_str),
                        ambiguous,
                        selected: elements.get(at).is_some_and(select),
                        candidates: total,
                        others: 0,
                        owned: 0,
                        unclaimed: total.saturating_sub(owned),
                        reason: Some(route.reason().to_owned()),
                    })
                }
                // The refusal. Nothing is selected and nothing is raised: the reason is
                // the answer, and `packages/ui/web/shell.ts` turns it into the `/rename`
                // hint the user can act on.
                Claim::Ambiguous { remaining } => {
                    let mut outcome = counted(TabOutcome::missed(
                        total,
                        format!(
                            "{remaining} windows could be this session; rename it with /rename"
                        ),
                    ));
                    outcome.unclaimed = remaining;
                    outcome
                }
                Claim::Nothing => counted(TabOutcome::missed(
                    total,
                    if total == 0 {
                        "this terminal does not publish its tabs".to_owned()
                    } else if keys.is_empty() {
                        "Claude Code records no title for this session".to_owned()
                    } else {
                        "no tab title matched this session, and every window here is \
                         another session's"
                            .to_owned()
                    },
                )),
            }
        }

        /// Ask a tab to become the selected one.
        fn select(element: &IUIAutomationElement) -> bool {
            // SAFETY: the element belongs to this thread's apartment and is still alive;
            // both calls are the documented pattern for selecting a selection item.
            unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .is_ok_and(|pattern| pattern.Select().is_ok())
            }
        }

        /// A `VT_I4` variant holding a control type id.
        ///
        /// `windows` models `VARIANT` as the nest of unions the header declares and offers
        /// no constructor for one, so this writes the two fields by hand. It is safe to
        /// leave un-cleared: a variant holding an `i32` owns nothing.
        fn control_type(id: i32) -> VARIANT {
            let mut value = VARIANT::default();
            // SAFETY: `value` is zeroed, and this writes the tag and the payload the tag
            // names — the one combination that makes the union's contents defined.
            unsafe {
                let inner = &mut *value.Anonymous.Anonymous;
                inner.vt = VT_I4;
                inner.Anonymous.lVal = id;
            }
            value
        }

        /// This thread's COM apartment, closed when it goes out of scope.
        struct Apartment {
            /// Whether this scope is the one that opened it, and so the one that closes it.
            ours: bool,
        }

        impl Apartment {
            fn enter() -> Result<Self, String> {
                // SAFETY: initialising the calling thread's apartment. The thread is one
                // this module just created, so in practice this always succeeds.
                let outcome = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                if outcome.is_ok() {
                    return Ok(Apartment { ours: true });
                }
                if outcome == RPC_E_CHANGED_MODE {
                    // Somebody else already made this a single-threaded apartment. UI
                    // Automation still works; we simply do not own the apartment.
                    return Ok(Apartment { ours: false });
                }
                Err(format!("could not enter a COM apartment: {outcome:?}"))
            }
        }

        impl Drop for Apartment {
            fn drop(&mut self) {
                if self.ours {
                    // SAFETY: balances the `CoInitializeEx` above, once, on the same
                    // thread.
                    unsafe { CoUninitialize() };
                }
            }
        }
    }

    /// Bring one window to the front, and read back whether it worked.
    fn raise(target: HWND) -> bool {
        // SAFETY: every call below takes a window handle the enumeration produced and
        // primitive values; none of them takes ownership of anything.
        unsafe {
            // Permission for the *target* to raise itself, which some terminals do in
            // response to being activated. Harmless when nothing uses it.
            let _ = AllowSetForegroundWindow(ASFW_ANY);

            if IsIconic(target).as_bool() {
                let _ = ShowWindow(target, SW_RESTORE);
            } else {
                let _ = ShowWindow(target, SW_SHOW);
            }

            let ours = GetCurrentThreadId();
            let foreground = GetForegroundWindow();
            let their_thread = if foreground.is_invalid() {
                0
            } else {
                GetWindowThreadProcessId(foreground, None)
            };

            // Attaching a thread to itself fails, and the whole point of the attach is
            // already satisfied when the foreground window is one of ours.
            let attached = their_thread != 0
                && their_thread != ours
                && AttachThreadInput(ours, their_thread, true).as_bool();

            let _ = SetForegroundWindow(target);
            let _ = BringWindowToTop(target);

            if attached {
                let _ = AttachThreadInput(ours, their_thread, false);
            }

            if GetForegroundWindow() == target {
                return true;
            }

            // The fallback: the shell's own alt-tab. `true` asks for the same treatment
            // alt-tab gives, rather than the minimise-others behaviour.
            SwitchToThisWindow(target, true);
            GetForegroundWindow() == target
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};

        /* ---------------------------------------------------------- *
         * The live half, and the machines that do not have one
         * ---------------------------------------------------------- */

        /// Set this to make a machine with a terminal on it behave like a CI runner.
        ///
        /// The tests below that need a desktop are the only ones that read it, and it is
        /// the only way to rehearse what a runner does without pushing to one.
        const NO_LIVE: &str = "NAZAR_TEST_NO_LIVE";

        /// What a live test needs: a tab host with windows, on a desktop this process can
        /// actually see.
        struct Live {
            /// Every eligible window of a tab-host process, with its z-order place —
            /// exactly the argument [`uia::find_and_select`] takes.
            windows: Vec<(isize, usize)>,
        }

        /// The live environment, or `None` on a machine that has none.
        ///
        /// Two tests below ask the same question, so it is asked in one place — the same
        /// shape the history-leak gate uses to skip on a machine with no transcripts.
        /// A GitHub runner is not reliably `None` on its own: a `windows-latest` image
        /// does hold the foreground and does run a Windows Terminal window, and UI
        /// Automation on that window has answered with zero tabs — which the test rightly
        /// calls a failure, because on a real desktop it would be one. So CI sets
        /// [`NO_LIVE`] and takes the skip. That costs nothing CI was checking: the rules —
        /// the matcher, the ranking, the parent-chain walk over fake snapshots, and the
        /// static gate that says this file cannot start a process — are all exercised with
        /// data the test makes up, on every runner, unconditionally.
        fn live_environment() -> Option<Live> {
            live_or_reason().ok()
        }

        /// Why there is no live environment — one sentence, for the skip line.
        fn no_live_reason() -> String {
            live_or_reason()
                .err()
                .unwrap_or_else(|| "the live path is available after all".to_owned())
        }

        /// The one place the question is answered, so the skip line and the skip cannot
        /// disagree about why.
        fn live_or_reason() -> Result<Live, String> {
            if std::env::var_os(NO_LIVE).is_some_and(|value| !value.is_empty() && value != "0") {
                return Err(format!("{NO_LIVE} is set"));
            }

            // SAFETY: both are argument-free reads of this session's own state, and
            // neither returns anything this scope has to release.
            let remote = unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0;
            let foreground = unsafe { GetForegroundWindow() };

            if remote {
                return Err(
                    "this is a remote session, whose desktop is not the one a terminal is on"
                        .to_owned(),
                );
            }
            if foreground.is_invalid() {
                return Err(
                    "no window holds the foreground, so this is not an interactive desktop session"
                        .to_owned(),
                );
            }

            let table = processes()?;
            let windows: Vec<(isize, usize)> = windows()
                .iter()
                .filter(|window| {
                    window.eligible
                        && table
                            .get(window.pid)
                            .is_some_and(|row| hosts_tabs(&row.name))
                })
                .map(|window| (window.handle.0 as isize, window.z))
                .collect();
            if windows.is_empty() {
                return Err(format!(
                    "no tab host is running here — nothing named {} owns a window",
                    nazar_shell::tabs::TAB_HOSTS.join(" or ")
                ));
            }

            Ok(Live { windows })
        }

        /// The snapshot reader, against the machine running the test. Deterministic
        /// enough to be a test: this process exists, by definition, and the chain from it
        /// reaches at least one ancestor on any Windows that can run a test at all.
        #[test]
        fn the_snapshot_contains_this_process_and_its_parent() {
            let table = processes().expect("a process snapshot");
            assert!(
                table.len() > 1,
                "a Windows machine has more than one process"
            );

            let me = std::process::id();
            let row = table.get(me).expect("this process is in its own snapshot");
            assert_eq!(row.pid, me);
            assert!(
                row.name.to_ascii_lowercase().ends_with(".exe"),
                "expected an executable name, got {}",
                row.name
            );

            let chain = ancestors(&table, me);
            assert!(
                chain.len() >= 2,
                "a test binary is started by something; chain was {chain:?}"
            );
            assert_eq!(chain[0].row.pid, me);
        }

        #[test]
        fn every_enumerated_window_has_a_handle_and_an_owner() {
            for window in windows() {
                assert!(!window.handle.is_invalid(), "a null window handle");
                assert!(window.pid != 0, "a window belonging to no process");
                if window.eligible {
                    assert!(!window.title.is_empty(), "an eligible window with no title");
                }
            }
        }

        /// Rung (b) against whatever terminal happens to be running here.
        ///
        /// What it proves is the half that cannot be proved with fake data — that UI
        /// Automation is reachable from this process, that a Windows Terminal window
        /// publishes its tabs as `TabItem` elements, and that they come back with names on
        /// them.
        ///
        /// **Whether it can touch anything**, with no keys and no other sessions handed
        /// over, comes down to one number and it is worth stating rather than assuming.
        /// Nothing can match by title, so the only route left is exclusion, and exclusion
        /// answers only when exactly one tab is unaccounted for — which here means the
        /// machine has exactly one tab in total. Selecting the only tab of the only window
        /// is selecting what is already selected. Every other machine gets the refusal and
        /// `Select` is not reached at all.
        ///
        /// So it needs a terminal to read and a desktop to read it on, and on a machine
        /// with neither it says which one is missing and stops. Two silences count as the
        /// environment rather than the code: no UI Automation client at all, and a
        /// terminal that did not answer inside the budget. Zero tabs from a client that
        /// worked is still a failure, which is the whole point of the test.
        #[test]
        fn tabs_are_readable_on_this_machine_when_a_tab_host_is_running() {
            let Some(live) = live_environment() else {
                eprintln!("skipped: {}", no_live_reason());
                return;
            };

            let outcome = uia::find_and_select(live.windows.clone(), Vec::new(), Vec::new());
            if let Some(reason) = outcome.reason.as_deref() {
                if reason.starts_with(uia::UNAVAILABLE) || reason.starts_with(uia::OVERRAN) {
                    eprintln!("skipped: {reason}");
                    return;
                }
            }

            assert!(
                outcome.candidates >= live.windows.len(),
                "{} tab-host windows should publish at least one tab each, saw {}",
                live.windows.len(),
                outcome.candidates
            );
            assert!(
                outcome.reason.is_some(),
                "every answer says why it is the answer"
            );
            if outcome.candidates == 1 {
                assert!(
                    outcome.matched && outcome.route == Some("exclusion"),
                    "one tab on the machine is the session's by elimination, {outcome:?}"
                );
            } else {
                assert!(
                    !outcome.matched,
                    "no key can match and more than one tab is unaccounted for, {outcome:?}"
                );
                assert_eq!(outcome.unclaimed, outcome.candidates, "nobody claimed any");
            }
        }

        #[test]
        fn a_host_with_no_windows_is_answered_without_starting_a_thread() {
            let outcome = uia::find_and_select(Vec::new(), Vec::new(), Vec::new());
            assert!(!outcome.matched);
            assert_eq!(outcome.candidates, 0);
            assert!(outcome.reason.is_some());
        }

        #[test]
        fn the_sentence_says_which_rung_answered_and_never_claims_more_than_it_did() {
            let refused = sentence("a", false, "WindowsTerminal.exe", 2, 1, None);
            assert!(refused.contains("refused the foreground"), "{refused}");

            let window_only = sentence("a", true, "WindowsTerminal.exe", 2, 1, None);
            assert!(window_only.contains("2 steps above"), "{window_only}");

            let mut found = TabOutcome::missed(4, "no tab title matched this session");
            let missed = sentence("a", true, "WindowsTerminal.exe", 2, 1, Some(&found));
            assert!(missed.contains("could not tell which one"), "{missed}");
            assert!(missed.contains("4 tabs"), "{missed}");

            found.matched = true;
            found.route = Some("title");
            let matched = sentence("b", true, "WindowsTerminal.exe", 2, 1, Some(&found));
            assert!(matched.contains("selected the tab"), "{matched}");
            assert!(!matched.contains("could not"), "{matched}");

            found.ambiguous = true;
            let guessed = sentence("b", true, "WindowsTerminal.exe", 2, 1, Some(&found));
            assert!(guessed.contains("same title"), "{guessed}");
        }

        /// The two sentences that exist because the ladder now declines to guess.
        #[test]
        fn the_refusal_says_how_many_windows_it_could_not_choose_between() {
            let mut ambiguous = TabOutcome::missed(5, "2 windows could be this session");
            ambiguous.unclaimed = 2;
            let refusal = sentence("none", false, "WindowsTerminal.exe", 2, 5, Some(&ambiguous));
            assert!(refusal.contains('2'), "{refusal}");
            assert!(refusal.contains("none was raised"), "{refusal}");
            assert!(
                !refusal.contains("refused the foreground"),
                "declining on purpose is not Windows saying no: {refusal}"
            );
            assert!(
                !refusal.contains("/rename"),
                "the /rename half is `TAB_NEEDS_A_NAME`, and saying it twice stutters: {refusal}"
            );

            // The same refusal on a host with no tabs at all to read: the count then comes
            // from the ranking, which is the only thing that counted anything.
            let blind = sentence("none", false, "WindowsTerminal.exe", 2, 4, None);
            assert!(blind.contains('4'), "{blind}");
            assert!(blind.contains("none was raised"), "{blind}");
        }

        #[test]
        fn the_two_subtractive_routes_each_say_which_one_answered() {
            let mut exclusion = TabOutcome::missed(5, "the only window not owned by another");
            exclusion.matched = true;
            exclusion.route = Some("exclusion");
            let one = sentence(
                "b-exclusion",
                true,
                "WindowsTerminal.exe",
                2,
                5,
                Some(&exclusion),
            );
            assert!(one.contains("no other session is in"), "{one}");
            assert!(one.contains('5'), "{one}");

            let mut default = TabOutcome::missed(5, "the only default title");
            default.matched = true;
            default.route = Some("defaultTitle");
            let other = sentence(
                "b-default",
                true,
                "WindowsTerminal.exe",
                2,
                5,
                Some(&default),
            );
            assert!(other.contains("default title"), "{other}");
            assert!(other.contains("no title yet"), "{other}");
        }

        /// A pid nobody has is answered rather than raised, and no window moves.
        #[test]
        fn a_pid_that_does_not_exist_is_a_sentence_rather_than_an_error() {
            let outcome = jump(0xFFFF_FFF0).expect("the ladder answers");
            assert!(!outcome.raised);
            assert_eq!(outcome.rung, "none");
            assert!(
                outcome.message.contains("no process"),
                "{}",
                outcome.message
            );
        }

        /* ---------------------------------------------------------- *
         * WP4e: the jump starts nothing
         * ---------------------------------------------------------- */

        /// Every process-creation API, spelled the way it would appear in this file.
        ///
        /// `wt.exe` is here as a **quoted** string: the module documentation names it
        /// several times in prose, explaining why it is not invoked, and forbidding the
        /// bare word would forbid the explanation.
        const PROCESS_CREATION: &[&str] = &[
            "Command::new",
            "process::Command",
            "CreateProcessW",
            "CreateProcessA",
            "CreateProcessAsUser",
            "ShellExecute",
            "WinExec",
            "\"wt.exe\"",
            "\"cmd.exe\"",
            "\"powershell",
        ];

        /**
         * The maintainer reported seeing "a terminal open" during a jump.
         *
         * It cannot have been a new one — every rung is a window handle and an
         * accessibility call, and the module documentation says at length why `wt.exe`
         * is never invoked even though its `focus-tab` subcommand would now work. But
         * "cannot" was a claim about code nobody was checking, so it is a test.
         *
         * A **static** gate, deliberately: a runtime test proves that one path did not
         * start a process, and this proves that none of them can. The one `spawn` in the
         * file is a *thread*, and that is asserted rather than excluded by a pattern,
         * because the difference between spawning a thread and spawning a process is
         * exactly what this test is about.
         */
        #[test]
        fn the_jump_path_contains_no_way_to_start_a_process() {
            // The shipped half of each file: everything before its test module. The
            // markers below have to be spelled out somewhere, and spelling them out in
            // a test that scans its own file would make the test fail on itself.
            let shipped = |source: &'static str| -> &'static str {
                source.split("#[cfg(test)]").next().unwrap_or(source)
            };

            for (name, whole) in [
                ("jump.rs", include_str!("jump.rs")),
                ("titles.rs", include_str!("titles.rs")),
            ] {
                let source = shipped(whole);
                assert!(
                    source.len() > 1000,
                    "{name}: the test-module split found nothing"
                );
                for marker in PROCESS_CREATION {
                    assert!(
                        !source.contains(marker),
                        "{name} contains `{marker}` — the jump raises windows and starts nothing"
                    );
                }
            }

            let source = shipped(include_str!("jump.rs"));
            assert_eq!(
                source.matches(".spawn(").count(),
                1,
                "jump.rs should have exactly one spawn, and it is a thread"
            );
            assert!(
                source.contains("std::thread::Builder::new()"),
                "the one spawn in jump.rs must be the UI Automation thread"
            );
        }

        /// Terminal emulators, spelled as the process table spells them, lowercased.
        ///
        /// Nothing else in this test binary starts one and Windows does not start one by
        /// itself, so a new one **anywhere on the machine** while the jump runs is
        /// evidence — including the `WindowsTerminal.exe` and `OpenConsole.exe` that a
        /// `wt.exe` invocation would leave behind after `wt.exe` itself had exited.
        const TERMINALS: &[&str] = &[
            "wt.exe",
            "windowsterminal.exe",
            "openconsole.exe",
            "mintty.exe",
            "alacritty.exe",
            "wezterm-gui.exe",
        ];

        /// Console hosts and shells, which come and go on their own all the time.
        ///
        /// Windows allocates a `conhost.exe` for every `CREATE_NO_WINDOW` child, and
        /// `node.rs`'s own tests run `node --version` and `nazar doctor` with that flag
        /// on a parallel thread — so a `conhost.exe` appearing between two snapshots
        /// is the test harness, not the jump. One of these counts only when **this
        /// process is its parent**, which is where `Command`, `CreateProcessW` and
        /// `ShellExecute` all put a process started from here.
        const CONSOLES: &[&str] = &["conhost.exe", "cmd.exe", "powershell.exe", "pwsh.exe"];

        /**
         * And the same claim, measured against the machine the test runs on.
         *
         * The process table is read before and after a jump, and nothing that looks like
         * a terminal may appear in between. Two halves, and only one of them needs a
         * machine with a desktop:
         *
         * * **Always**: the whole ladder against a pid nobody has. It walks, finds
         *   nothing, answers, and raises nothing — the no-op jump, which is exactly the
         *   path a runner can execute.
         * * **When there is a terminal here**: rung (b)'s reader against the real windows
         *   on this machine, which is the only part that talks to another program at all.
         *   Without one there is nothing to read and the half is skipped by name.
         *
         * It is corroboration rather than proof — the static gate above is the proof, and
         * this is the thing that would have caught a `wt.exe` invocation hidden behind an
         * indirection the gate did not spell out.
         */
        #[test]
        fn nothing_that_looks_like_a_terminal_appears_while_the_jump_runs() {
            let names = |table: &ProcessTable| -> std::collections::HashSet<(u32, String)> {
                let mut out = std::collections::HashSet::new();
                for pid in table.pids() {
                    if let Some(row) = table.get(pid) {
                        out.insert((pid, row.name.to_ascii_lowercase()));
                    }
                }
                out
            };

            // Asked before the first snapshot, because answering it enumerates windows
            // and processes and the window between the snapshots should hold the jump
            // and nothing else.
            let live = live_environment();
            let before = names(&processes().expect("a process snapshot"));

            let outcome = jump(0xFFFF_FFF0).expect("the ladder answers");
            match &live {
                Some(live) => {
                    let _ = uia::find_and_select(live.windows.clone(), Vec::new(), Vec::new());
                }
                None => eprintln!("skipped the live half: {}", no_live_reason()),
            }

            let table = processes().expect("a process snapshot");
            let after = names(&table);
            let me = std::process::id();

            assert!(!outcome.raised, "a pid nobody has raises no window");
            assert_eq!(outcome.rung, "none");

            for (pid, name) in after.difference(&before) {
                assert!(
                    !TERMINALS.contains(&name.as_str()),
                    "a jump that raises windows started {name} (pid {pid})"
                );
                let ours = table.get(*pid).is_some_and(|row| row.parent_pid == me);
                assert!(
                    !(ours && CONSOLES.contains(&name.as_str())),
                    "a jump that raises windows started {name} (pid {pid}) as this test's own child"
                );
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Everywhere else
 * ------------------------------------------------------------------ */

#[cfg(not(windows))]
mod platform {
    use super::JumpOutcome;

    /// The stub. It is a successful call that did nothing, not an error: the canvas asks
    /// [`super::supported`] before offering the entry, and a user who reaches this anyway
    /// deserves a sentence rather than a red box.
    ///
    /// The sentence names the platform rather than the port that is missing (N-WP19a).
    /// There is a macOS and a Linux build now, so "Windows-only" read as a statement about
    /// the *application* to somebody holding one of the other two; what is Windows-only is
    /// this one feature, and the honest form of that is the one below.
    pub fn jump(_pid: u32) -> Result<JumpOutcome, String> {
        Ok(JumpOutcome::nothing(
            "jumping to a terminal is not available on this platform yet",
        ))
    }
}

/// Bring the terminal hosting the Claude Code process `pid` to the front.
pub fn jump(pid: u32) -> Result<JumpOutcome, String> {
    platform::jump(pid)
}
