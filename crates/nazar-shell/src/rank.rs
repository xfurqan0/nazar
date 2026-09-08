//! Choosing which window to raise.
//!
//! The walk in [`crate::proc`] hands over a chain of ancestors. Several of them may own
//! top-level windows, and the closest one is not always the right one, so "first hit
//! wins" is wrong in a way that is easy to miss:
//!
//! * A console application on Windows shares its window with `conhost.exe`, whose place in
//!   the tree depends on how the console was created. Under a ConPTY host such as Windows
//!   Terminal, `conhost.exe` / `OpenConsole.exe` runs headless and its window — when it has
//!   one at all — is not the window the user is looking at.
//! * Node processes hold invisible message-only windows. `IsWindowVisible` filters most of
//!   them; a zero-size or untitled window gets past it.
//! * VS Code's integrated terminal puts one or two helper processes between the shell and
//!   the `Code.exe` that owns the window, and that one is unambiguously the right answer
//!   even though it is further away. The helper is a `node.exe` on older builds and a
//!   windowless second `Code.exe` — Electron running as node — on the build measured on
//!   2026-09-08, which is why the rule is about windows and depth and not about a name.
//!
//! So the rule is: **a known terminal host beats an unknown process, and among equals the
//! closest to the session wins.** [`HOSTS`] is the list, in the order the plan gives, and
//! its order is also the tie-break for the case where two known hosts are the same
//! distance away.
//!
//! Everything here is arithmetic over a list somebody else collected. `apps/desktop` fills
//! [`WindowCandidate`] in from `EnumWindows` + `GetWindowThreadProcessId`; the tests fill
//! it in by hand.

/// Executables known to host a terminal, best first.
///
/// Matched case-insensitively against the file name, and `.exe` is optional so the same
/// list can name `alacritty` (which ships as `alacritty.exe` on Windows) without three
/// spellings. Order matters twice: it is the preference between two hosts at the same
/// depth, and it is what a reader checks when a jump lands somewhere surprising.
pub const HOSTS: &[&str] = &[
    "WindowsTerminal",
    "conhost",
    "OpenConsole",
    "Code",
    "cursor",
    "mintty",
    "alacritty",
    "wezterm-gui",
    // Shells rather than terminals, and last on purpose. On Windows the console window
    // belongs to `conhost.exe`, not to the shell drawing into it, so these three almost
    // never own one — but a shell that does is still a better answer than nothing.
    "powershell",
    "pwsh",
    "cmd",
];

/// An executable's file name with no directory and no `.exe`: `WindowsTerminal`.
///
/// Public because [`crate::tabs`] asks the same question of the same strings, and two
/// spellings of "which program is this" is how a host ends up on one list and off the
/// other.
#[must_use]
pub fn stem(executable: &str) -> &str {
    executable
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(executable)
        .strip_suffix_ignore_case(".exe")
}

/// Where an executable sits in [`HOSTS`], or `None` when it is not a known host.
#[must_use]
pub fn host_rank(executable: &str) -> Option<usize> {
    let stem = stem(executable);
    HOSTS
        .iter()
        .position(|host| host.eq_ignore_ascii_case(stem))
}

/// `str::strip_suffix`, case-insensitively, returning the whole string when it does not
/// match. A free function would read worse at the one call site above.
trait StripSuffixIgnoreCase {
    fn strip_suffix_ignore_case<'a>(&'a self, suffix: &str) -> &'a str;
}

impl StripSuffixIgnoreCase for str {
    fn strip_suffix_ignore_case<'a>(&'a self, suffix: &str) -> &'a str {
        if self.len() >= suffix.len() {
            let (head, tail) = self.split_at(self.len() - suffix.len());
            if tail.eq_ignore_ascii_case(suffix) {
                return head;
            }
        }
        self
    }
}

/// One top-level window found above a session, as far as the choice cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowCandidate {
    /// The window handle, carried opaquely so this crate needs no platform types.
    pub handle: isize,
    /// The process that owns it.
    pub pid: u32,
    /// That process's executable file name.
    pub executable: String,
    /// Steps above the session, from [`crate::proc::ancestors`].
    pub depth: usize,
    /// Whether the shell would draw it: visible, not a tool window, and with a title.
    pub eligible: bool,
    /// The window's title, for the diagnostics line the shell reports.
    pub title: String,
}

/// Everything the ranking has to go on about one window, *except* its handle.
///
/// Split out because the handle is not evidence — it is the tie-break of last resort — and
/// the difference between "the ranking chose" and "the ranking gave up and sorted by
/// handle" is the difference [`tied_with`] measures.
fn evidence(candidate: &WindowCandidate) -> (usize, usize, usize) {
    let rank = host_rank(&candidate.executable);
    (
        // Known hosts first. `None` sorts after `Some(_)` on its own, but making the
        // group explicit keeps the intent readable.
        usize::from(rank.is_none()),
        rank.unwrap_or(usize::MAX),
        candidate.depth,
    )
}

/// Pick the window to raise, or `None` when nothing in the chain owns one.
///
/// The comparison, in order: eligible before not (an ineligible window is never picked at
/// all — see the filter), known host before unknown, closer before further, and earlier in
/// [`HOSTS`] before later. Handle order is the final tie-break so the answer is stable
/// across runs rather than depending on the order `EnumWindows` happened to return.
///
/// **Stable is not the same as right.** When two or more candidates tie on everything but
/// the handle this still returns one of them, and that choice carries no evidence at all —
/// see [`tied_with`], which is the question the caller asks before raising anything on this
/// answer alone. What the answer is always good for is naming the *host*: every candidate
/// in a tie agrees on the executable and the depth, and that is what decides whether the
/// tab rung in [`crate::tabs`] runs and whose windows it looks at.
#[must_use]
pub fn pick(candidates: &[WindowCandidate]) -> Option<&WindowCandidate> {
    candidates
        .iter()
        .filter(|candidate| candidate.eligible)
        .min_by_key(|candidate| (evidence(candidate), candidate.handle))
}

/// How many eligible candidates the ranking cannot tell apart from `chosen`.
///
/// One means [`pick`] had evidence for its answer and the window it named is *the* window.
/// More means it fell through to the handle, and raising that window is a coin toss with a
/// stable outcome — which reads to a person as "jump always goes to the same terminal",
/// because that is precisely what it does.
///
/// The measured shape: one `WindowsTerminal.exe` owning five windows produces five
/// candidates agreeing on host, on depth and on pid, so this answers five and the caller
/// knows not to raise on the ranking alone. A `conhost.exe` with one console window, a
/// `mintty`, a single VS Code window — each answers one, and rung (a) is still the whole
/// feature there.
#[must_use]
pub fn tied_with(candidates: &[WindowCandidate], chosen: &WindowCandidate) -> usize {
    let key = evidence(chosen);
    candidates
        .iter()
        .filter(|candidate| candidate.eligible && evidence(candidate) == key)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(handle: isize, pid: u32, exe: &str, depth: usize) -> WindowCandidate {
        WindowCandidate {
            handle,
            pid,
            executable: exe.to_owned(),
            depth,
            eligible: true,
            title: format!("{exe} window"),
        }
    }

    #[test]
    fn the_list_is_matched_by_stem_and_case() {
        assert_eq!(host_rank("WindowsTerminal.exe"), Some(0));
        assert_eq!(host_rank("windowsterminal.EXE"), Some(0));
        assert_eq!(host_rank("WindowsTerminal"), Some(0));
        assert_eq!(
            host_rank("C:\\Program Files\\WindowsApps\\WindowsTerminal.exe"),
            Some(0),
            "a full path is a file name with decoration in front of it"
        );
        assert_eq!(host_rank("explorer.exe"), None);
    }

    #[test]
    fn a_known_terminal_beats_a_nearer_stranger() {
        // The VS Code shape: a helper with a window sits between the session and Code.exe.
        let found = [
            candidate(10, 200, "node.exe", 1),
            candidate(20, 300, "Code.exe", 3),
        ];
        assert_eq!(
            pick(&found).expect("one of them wins").executable,
            "Code.exe"
        );
    }

    #[test]
    fn between_two_known_hosts_the_closer_one_wins() {
        // Both are on the list; distance decides. A Windows Terminal that launched a
        // second Windows Terminal must not steal a jump from the inner one.
        let found = [
            candidate(10, 200, "WindowsTerminal.exe", 5),
            candidate(20, 300, "WindowsTerminal.exe", 2),
        ];
        assert_eq!(pick(&found).expect("one of them wins").pid, 300);
    }

    #[test]
    fn the_list_order_breaks_a_tie_at_the_same_depth() {
        // conhost and WindowsTerminal both claiming depth 2 is the ConPTY case. The
        // terminal is the window the user sees; conhost is the console device behind it.
        let found = [
            candidate(10, 200, "conhost.exe", 2),
            candidate(20, 300, "WindowsTerminal.exe", 2),
        ];
        assert_eq!(
            pick(&found).expect("one of them wins").executable,
            "WindowsTerminal.exe"
        );
    }

    #[test]
    fn an_ineligible_window_is_never_picked_even_when_it_is_the_best_host() {
        let mut hidden = candidate(10, 200, "WindowsTerminal.exe", 1);
        hidden.eligible = false;
        let found = [hidden, candidate(20, 300, "node.exe", 2)];
        assert_eq!(
            pick(&found).expect("one wins").executable,
            "node.exe",
            "an invisible window cannot be raised, however good a host it is"
        );
    }

    #[test]
    fn nothing_eligible_is_no_answer_rather_than_a_wrong_one() {
        let mut hidden = candidate(10, 200, "WindowsTerminal.exe", 1);
        hidden.eligible = false;
        let found = [hidden];
        assert!(pick(&found).is_none());
        assert!(pick(&[]).is_none());
    }

    #[test]
    fn an_unknown_host_still_wins_when_it_is_the_only_window() {
        // The point of the fallback: a terminal nobody put on the list is still a
        // terminal, and raising its window is better than telling the user no.
        let found = [candidate(10, 200, "someterm.exe", 2)];
        assert_eq!(
            pick(&found).expect("the only one").executable,
            "someterm.exe"
        );
    }

    #[test]
    fn four_windows_of_one_process_are_indistinguishable_here_and_that_is_the_point() {
        // The measured shape of the bug rung (b) exists for. Windows Terminal hosts every
        // window it has in **one** process, so four sessions in four windows produce four
        // candidates that agree on host, on depth and on pid, and the only thing left to
        // separate them is the handle — a stable answer, and the same one every time.
        //
        // Nothing here is wrong: a tie-break that is arbitrary but stable is exactly what
        // this function promises. What it shows is that the *evidence* is exhausted, which
        // is why the answer has to come from somewhere else. See `crate::tabs`.
        let handles = [0x0037_08DA, 0x03EB_07B6, 0x0052_0966, 0x0079_0B28];
        let found: Vec<WindowCandidate> = handles
            .iter()
            .map(|handle| candidate(*handle, 4040, "WindowsTerminal.exe", 2))
            .collect();
        for _ in 0..4 {
            assert_eq!(
                pick(&found).expect("one of them wins").handle,
                0x0037_08DA,
                "every session in this terminal gets the lowest handle, whichever one asked"
            );
        }
    }

    /* ---- when the ranking is allowed to raise on its own ------------- */

    #[test]
    fn one_window_above_a_session_is_the_answer_and_says_so() {
        // The single-window hosts, which are most machines most of the time. Rung (a) is
        // the whole feature here and nothing below it has to run.
        for exe in ["conhost.exe", "mintty.exe", "Code.exe", "someterm.exe"] {
            let found = [candidate(0x1234, 200, exe, 2)];
            let chosen = pick(&found).expect("the only one");
            assert_eq!(tied_with(&found, chosen), 1, "{exe}");
        }
    }

    #[test]
    fn five_windows_of_one_terminal_tie_and_the_ranking_admits_it() {
        // The measured shape of the report: five Claude Code sessions, five Windows
        // Terminal windows, one `WindowsTerminal.exe`. `pick` still answers — the host is
        // real evidence — but the *window* it names is the lowest handle and nothing more.
        let handles = [
            0x0037_08DA,
            0x03EB_07B6,
            0x0052_0966,
            0x00ED_09BA,
            0x0079_0B28,
        ];
        let found: Vec<WindowCandidate> = handles
            .iter()
            .map(|handle| candidate(*handle, 4040, "WindowsTerminal.exe", 2))
            .collect();
        let chosen = pick(&found).expect("one of them");
        assert_eq!(chosen.handle, 0x0037_08DA);
        assert_eq!(
            tied_with(&found, chosen),
            5,
            "five windows the ranking cannot separate is five, not one"
        );
    }

    #[test]
    fn a_window_the_ranking_had_real_evidence_for_does_not_count_the_others() {
        // Two hosts at different depths: the closer one wins on evidence, so nothing ties
        // with it and rung (a) may raise it.
        let found = [
            candidate(10, 200, "WindowsTerminal.exe", 5),
            candidate(20, 300, "WindowsTerminal.exe", 2),
        ];
        let chosen = pick(&found).expect("the closer one");
        assert_eq!(chosen.pid, 300);
        assert_eq!(tied_with(&found, chosen), 1);

        // And the same across the host list rather than across depth.
        let found = [
            candidate(10, 200, "conhost.exe", 2),
            candidate(20, 300, "WindowsTerminal.exe", 2),
        ];
        let chosen = pick(&found).expect("the terminal");
        assert_eq!(tied_with(&found, chosen), 1);
    }

    #[test]
    fn an_ineligible_window_never_counts_towards_a_tie() {
        let mut hidden = candidate(10, 4040, "WindowsTerminal.exe", 2);
        hidden.eligible = false;
        let found = [hidden, candidate(20, 4040, "WindowsTerminal.exe", 2)];
        let chosen = pick(&found).expect("the visible one");
        assert_eq!(chosen.handle, 20);
        assert_eq!(
            tied_with(&found, chosen),
            1,
            "a window nobody can see is not a window this session might be in"
        );
    }

    #[test]
    fn the_tie_count_does_not_depend_on_enumeration_order() {
        let a = candidate(10, 4040, "WindowsTerminal.exe", 2);
        let b = candidate(20, 4040, "WindowsTerminal.exe", 2);
        let forward = [a.clone(), b.clone()];
        let backward = [b, a];
        assert_eq!(
            tied_with(&forward, pick(&forward).expect("one")),
            tied_with(&backward, pick(&backward).expect("one")),
        );
    }

    #[test]
    fn the_choice_does_not_depend_on_enumeration_order() {
        let a = candidate(10, 200, "mintty.exe", 2);
        let b = candidate(20, 300, "mintty.exe", 2);
        let forward_order = [a.clone(), b.clone()];
        let backward_order = [b, a];
        let forward = pick(&forward_order).expect("one wins").handle;
        let backward = pick(&backward_order).expect("one wins").handle;
        assert_eq!(forward, backward, "same input, same answer, either order");
    }
}
