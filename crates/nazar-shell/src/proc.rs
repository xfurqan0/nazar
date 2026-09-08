//! Walking from a Claude Code process up to the thing that owns its terminal.
//!
//! A Claude Code session knows its own pid — `~/.claude/sessions/<pid>.json` is named
//! after it — and that process has no window. The terminal is somewhere above it:
//!
//! ```text
//!   WindowsTerminal.exe   ← the window. Depth 2 from claude.exe.
//!     powershell.exe      ← no window of its own; it draws into the console above
//!       claude.exe        ← the session. This is the pid Nazar starts from.
//! ```
//!
//! The shape differs by host — Git Bash puts `mintty.exe` at depth 1, VS Code puts
//! `Code.exe` three or four levels up behind a helper or two — so the walk is a walk and
//! not a fixed number of steps. The VS Code shape measured on 2026-09-08 was
//! `claude.exe → powershell.exe → Code.exe → Code.exe`: the helper is the terminal's pty
//! host, which is Electron running as node and therefore reports itself as `Code.exe`
//! rather than the `node.exe` older builds put there. It owns no window, so the walk has
//! to reach depth 3 before it finds one.
//!
//! **Three things make it safe to run against a live machine.** A pid is not a stable
//! identifier: it is reused, and a snapshot taken while processes are exiting can contain
//! a parent that has already been replaced by something younger.
//!
//! 1. **A depth bound.** [`MAX_DEPTH`] steps and no further. A terminal more than eight
//!    processes above the session is not a terminal this can reason about.
//! 2. **A cycle guard.** Pid reuse can produce A → B → A in a single snapshot. Every pid
//!    is visited once.
//! 3. **A stop at the roots.** Pid 0 and pid 4 are the idle process and the Windows
//!    kernel; a chain that reaches them has left the user's session behind, and
//!    everything above it belongs to the machine rather than to this user.
//!
//! Nothing here calls the operating system. [`ProcessTable`] is filled in on Windows from
//! `CreateToolhelp32Snapshot`, and in the tests from a hand-written list, which is what
//! makes the walk testable on a Linux runner.

use std::collections::HashSet;

/// How far above the session the walk will look. Eight is roughly twice the deepest real
/// chain observed (VS Code's integrated terminal reaches four).
pub const MAX_DEPTH: usize = 8;

/// One row of a process snapshot: everything the walk needs and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
    /// The process identifier.
    pub pid: u32,
    /// Its parent's identifier, as the snapshot reported it.
    pub parent_pid: u32,
    /// The executable's file name, with no directory: `WindowsTerminal.exe`.
    pub name: String,
}

impl ProcessRow {
    /// A row, for a snapshot builder or a test.
    #[must_use]
    pub fn new(pid: u32, parent_pid: u32, name: impl Into<String>) -> Self {
        ProcessRow {
            pid,
            parent_pid,
            name: name.into(),
        }
    }
}

/// A snapshot of the machine's processes, indexed by pid.
///
/// Built once per jump. A jump that read the table lazily, one `OpenProcess` at a time,
/// would be walking a tree that moves underneath it; one snapshot is a consistent picture
/// of a single moment, which is what makes the cycle guard meaningful.
#[derive(Debug, Clone, Default)]
pub struct ProcessTable {
    rows: std::collections::HashMap<u32, ProcessRow>,
}

impl ProcessTable {
    /// Build a table from rows. A duplicate pid keeps the first row seen, which is what a
    /// `Process32Next` walk hands over anyway.
    #[must_use]
    pub fn from_rows(rows: impl IntoIterator<Item = ProcessRow>) -> Self {
        let mut table = ProcessTable::default();
        for row in rows {
            table.rows.entry(row.pid).or_insert(row);
        }
        table
    }

    /// One process, if the snapshot saw it.
    #[must_use]
    pub fn get(&self, pid: u32) -> Option<&ProcessRow> {
        self.rows.get(&pid)
    }

    /// How many processes the snapshot holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether the snapshot is empty, which means the walk can say nothing at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Every pid in the snapshot, in no particular order.
    ///
    /// The jump itself never needs this — it walks one chain from one pid. Comparing two
    /// snapshots does, and that comparison is how "the jump starts no process" stopped
    /// being a claim and became a test (WP4e, `apps/desktop/src/jump.rs`).
    pub fn pids(&self) -> impl Iterator<Item = u32> + '_ {
        self.rows.keys().copied()
    }
}

/// One step of the chain: a process and how far above the session it sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ancestor {
    /// Steps above the starting process. The session itself is depth 0.
    pub depth: usize,
    /// The process at that depth.
    pub row: ProcessRow,
}

/// Pids that are the machine's rather than the user's. A chain that reaches one has gone
/// too far, and the process above it is `wininit`, `services` or the kernel.
const ROOT_PIDS: [u32; 2] = [0, 4];

/// The chain from `pid` upwards, starting with `pid` itself.
///
/// Returns an empty vector when the snapshot has never heard of `pid` — a session whose
/// process has already exited, which is the common case on a canvas left open overnight.
#[must_use]
pub fn ancestors(table: &ProcessTable, pid: u32) -> Vec<Ancestor> {
    let mut chain = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut current = pid;

    for depth in 0..=MAX_DEPTH {
        if ROOT_PIDS.contains(&current) || !seen.insert(current) {
            break;
        }
        let Some(row) = table.get(current) else {
            break;
        };
        chain.push(Ancestor {
            depth,
            row: row.clone(),
        });
        current = row.parent_pid;
    }

    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The chain measured on the maintainer's machine on 2026-09-07, written down rather
    /// than described: `claude agents --json` reported pid 15592, and `Win32_Process`
    /// walked to `WindowsTerminal.exe` in two steps.
    fn windows_terminal_machine() -> ProcessTable {
        ProcessTable::from_rows([
            ProcessRow::new(15592, 8548, "claude.exe"),
            ProcessRow::new(8548, 4040, "powershell.exe"),
            ProcessRow::new(4040, 16188, "WindowsTerminal.exe"),
            ProcessRow::new(16188, 1234, "svchost.exe"),
            ProcessRow::new(1234, 4, "services.exe"),
        ])
    }

    #[test]
    fn the_walk_reaches_the_terminal_and_keeps_going() {
        let chain = ancestors(&windows_terminal_machine(), 15592);
        let names: Vec<&str> = chain.iter().map(|step| step.row.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "claude.exe",
                "powershell.exe",
                "WindowsTerminal.exe",
                "svchost.exe",
                "services.exe"
            ],
            "the walk does not stop at the terminal; ranking decides which step wins"
        );
        assert_eq!(chain[0].depth, 0, "the session itself is depth 0");
        assert_eq!(chain[2].depth, 2, "the terminal is two steps up");
    }

    #[test]
    fn the_walk_stops_where_the_machine_starts() {
        // `services.exe` has parent 4, the kernel. Nothing above it is the user's.
        let chain = ancestors(&windows_terminal_machine(), 1234);
        assert_eq!(chain.len(), 1, "the kernel is not an ancestor worth having");
    }

    #[test]
    fn a_pid_that_is_not_in_the_snapshot_produces_nothing() {
        assert!(ancestors(&windows_terminal_machine(), 999_999).is_empty());
    }

    #[test]
    fn pid_reuse_cannot_make_the_walk_spin() {
        // A snapshot taken mid-exit really can contain this: B's parent slot still names
        // A, and A's parent slot has already been reused for B.
        let table = ProcessTable::from_rows([
            ProcessRow::new(10, 20, "a.exe"),
            ProcessRow::new(20, 10, "b.exe"),
        ]);
        let chain = ancestors(&table, 10);
        assert_eq!(
            chain.len(),
            2,
            "each pid is visited once and then the walk ends"
        );
    }

    #[test]
    fn a_process_that_is_its_own_parent_ends_the_walk() {
        let table = ProcessTable::from_rows([ProcessRow::new(7, 7, "loop.exe")]);
        assert_eq!(ancestors(&table, 7).len(), 1);
    }

    #[test]
    fn the_depth_bound_holds_on_a_long_chain() {
        // Twenty processes stacked on each other. The walk takes MAX_DEPTH steps and
        // stops, rather than reporting a terminal twenty levels away from the session.
        // The numbering starts at 100 to stay clear of pid 4, which is a stopping point
        // in its own right and would end this chain after three steps.
        let rows = (100..=120u32).map(|pid| ProcessRow::new(pid, pid + 1, format!("p{pid}.exe")));
        let chain = ancestors(&ProcessTable::from_rows(rows), 100);
        assert_eq!(
            chain.len(),
            MAX_DEPTH + 1,
            "depth 0 through MAX_DEPTH inclusive"
        );
        assert_eq!(chain.last().expect("non-empty").depth, MAX_DEPTH);
    }

    #[test]
    fn a_duplicate_pid_in_the_snapshot_does_not_change_the_walk() {
        let table = ProcessTable::from_rows([
            ProcessRow::new(1, 2, "first.exe"),
            ProcessRow::new(1, 3, "second.exe"),
            ProcessRow::new(2, 0, "parent.exe"),
        ]);
        assert_eq!(table.len(), 2);
        assert_eq!(ancestors(&table, 1)[1].row.name, "parent.exe");
    }

    /// WP4e: two snapshots can be compared, which is what proves a jump started
    /// nothing. Every pid the table holds comes back, exactly once.
    #[test]
    fn every_pid_in_the_snapshot_can_be_listed() {
        let table = ProcessTable::from_rows([
            ProcessRow::new(1, 0, "a.exe"),
            ProcessRow::new(2, 1, "b.exe"),
            ProcessRow::new(3, 1, "c.exe"),
        ]);
        let mut pids: Vec<u32> = table.pids().collect();
        pids.sort_unstable();
        assert_eq!(pids, vec![1, 2, 3]);
        assert_eq!(pids.len(), table.len());
    }
}
