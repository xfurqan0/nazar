//! What a session is called, from Claude Code's own files.
//!
//! Rung (b) of the jump ladder compares what a terminal is *displaying* with what a session
//! is *called*. The comparison is [`nazar_shell::tabs`]; this module is the other half —
//! the strings to compare against, read off disk at the moment of the jump and kept
//! nowhere.
//!
//! It answers the question twice. Once for the session that was double-clicked
//! ([`keys_for`]), and once for **every other session running on the machine**
//! ([`other_keys_for`]), because a window another session's name is on is not this one's —
//! which is the whole of the exclusion rule, and the thing that finds a terminal for a
//! session too young to have a name of its own.
//!
//! # Why this reads a transcript at all
//!
//! The obvious source is the session registry, `~/.claude/sessions/<pid>.json`, which
//! carries a `name`. It was measured on the maintainer's machine and it is **not** what a
//! terminal shows (the two strings are stand-ins; what was measured is that they differ,
//! and how):
//!
//! ```text
//!   registry name   "widgets-7f"     nameSource: "derived"
//!   terminal title  "◐ Repaint the harbour wall"
//! ```
//!
//! A session nobody renamed gets a name derived from its project directory, and that name
//! appears in no terminal title. What the terminal shows is the session's **generated
//! title**, and the only place that string exists on disk is an `ai-title` line in the
//! session's own transcript. So the transcript is read — the last megabyte of it, backwards,
//! for one line — and `docs/pinned-internal-formats.md` carries the row.
//!
//! # What this is careful about
//!
//! * **Only two fields leave this module**, both of them titles: `aiTitle` from the
//!   transcript and `name` from the registry. No prompt text, no response text, no tool
//!   input; the reverse scan stops at the first `ai-title` line it recognises and never
//!   parses another.
//! * **Nothing is written.** Every path here is opened for reading.
//! * **A session id is validated before it becomes a path.** The registry is a file another
//!   program writes, and a `sessionId` of `../../..` must not be able to name a file.
//! * **Every read is bounded.** Transcripts on this machine reach 76 MB; this reads at most
//!   [`TAIL_BYTES`] of one, and the registry file at most [`MAX_REGISTRY_BYTES`].
//! * **Every failure is silence.** A missing home directory, an unreadable file, a session
//!   that ended between the click and the read — each of them means one fewer key, which
//!   the matcher already treats as an ordinary answer. None of them is an error worth
//!   showing a person who double-clicked a card.
//! * **`CLAUDE_CONFIG_DIR` is honoured**, in the same order the TypeScript half uses
//!   ([`claude_home`]). It was not, until N-WP9, and the consequence was a jump that did
//!   nothing at all on a machine that had moved its configuration directory — while the
//!   canvas beside it drew every session perfectly.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use nazar_shell::tabs::{KeySource, TitleKey};

/// How much of the end of a transcript is read looking for the generated title.
///
/// Claude Code appends an `ai-title` line each time it re-titles a session — 190 of them in
/// a 9 MB transcript here, so roughly one per 48 KB — and the last one is the current
/// title. A megabyte is two decimal orders of margin over that spacing and costs about a
/// millisecond from the page cache, once, on a gesture the user made.
pub const TAIL_BYTES: u64 = 1024 * 1024;

/// How much of a session registry file is read. They are one line of 586 bytes here.
pub const MAX_REGISTRY_BYTES: u64 = 64 * 1024;

/// The marker a transcript line carries when it is a title. Minified JSON, no spaces.
const AI_TITLE_MARKER: &str = "\"type\":\"ai-title\"";

/// What the session registry says about one session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registered {
    /// The session's uuid, which is also its transcript's file name.
    pub session_id: Option<String>,
    /// Its working directory.
    pub cwd: Option<String>,
    /// The name Claude Code shows for it.
    pub name: Option<String>,
    /// Where that name came from. `derived` means nobody typed it.
    pub name_source: Option<String>,
}

/// The variable that moves Claude Code's configuration directory.
///
/// Honoured by Claude Code itself, by `packages/core/src/paths.ts`, and by nazar-tray's
/// status-line wrapper. It is an absolute path to the directory *itself* — not to a
/// parent of `.claude` — which is why the `.claude` segment is only appended on the
/// fallback branch.
pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";

/// Claude Code's home, or `None` on a machine that has no such thing.
///
/// **`CLAUDE_CONFIG_DIR` first, then the home directory.** N-WP9: the TypeScript half has
/// honoured that variable since WP1 (`claudeConfigDir` in `packages/core/src/paths.ts`)
/// and this half did not, so on a machine that had moved its configuration directory the
/// canvas drew every session correctly and the jump found none of them — it looked for a
/// session registry in a directory Claude Code had stopped writing to. Two halves of one
/// product resolving one path differently is a bug even when both are defensible, and
/// this one produced a feature that silently did nothing.
#[must_use]
pub fn claude_home() -> Option<PathBuf> {
    claude_home_from(&|name| std::env::var_os(name))
}

/// [`claude_home`], against a stated environment rather than this process's.
///
/// The indirection exists for the tests. Setting a process-wide environment variable from
/// one test while others run in parallel threads is a data race — and `set_var` is
/// `unsafe` in this edition for exactly that reason — so the resolution order is a
/// function of a lookup, and the lookup is what a test replaces.
#[must_use]
pub fn claude_home_from(lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    if let Some(configured) = lookup(CONFIG_DIR_VAR).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(configured));
    }
    let home = lookup("USERPROFILE")
        .or_else(|| lookup("HOME"))
        .filter(|value| !value.is_empty())?;
    Some(PathBuf::from(home).join(".claude"))
}

/// Whether a string is safe to use as a file name, and shaped like a session id.
///
/// Hexadecimal and dashes, 8-4-4-4-12. The point is not to validate a uuid — it is that a
/// value read out of another program's file becomes a path, and this is the gate that stops
/// `..` and a drive letter from ever getting there.
#[must_use]
pub fn is_session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Read `~/.claude/sessions/<pid>.json`, or `None` when there is nothing to read.
#[must_use]
pub fn registered(home: &Path, pid: u32) -> Option<Registered> {
    let path = home.join("sessions").join(format!("{pid}.json"));
    let text = read_head(&path, MAX_REGISTRY_BYTES)?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;

    let field = |key: &str| {
        parsed
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };

    Some(Registered {
        session_id: field("sessionId").filter(|value| is_session_id(value)),
        cwd: field("cwd"),
        name: field("name"),
        name_source: field("nameSource"),
    })
}

/// The transcript of one session, found by name rather than by recomputing its slug.
///
/// `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is a transform of the
/// working directory that `packages/core` already implements and pins with a table of 68
/// real directories. Implementing it a second time here, in another language, would be two
/// implementations of one rule and one of them would drift. So the directory is listed and
/// the file is looked for by name instead: 68 directories on this machine, one `metadata`
/// call each, well under a millisecond, and no second copy of the rule.
#[must_use]
pub fn transcript(home: &Path, session_id: &str) -> Option<PathBuf> {
    if !is_session_id(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    let projects = std::fs::read_dir(home.join("projects")).ok()?;
    for entry in projects.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The generated title from the end of a transcript, or `None` when there is not one.
///
/// The scan is backwards over [`TAIL_BYTES`] and stops at the first `ai-title` line, so a
/// transcript is never read whole and no other line type is ever parsed.
#[must_use]
pub fn generated_title(path: &Path) -> Option<String> {
    let tail = read_tail(path, TAIL_BYTES)?;
    for line in tail.lines().rev() {
        if !line.contains(AI_TITLE_MARKER) {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            // A truncated first line, or a line still being written. Keep looking.
            continue;
        };
        if parsed.get("type").and_then(serde_json::Value::as_str) != Some("ai-title") {
            continue;
        }
        if let Some(title) = parsed
            .get("aiTitle")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
        {
            return Some(title.to_owned());
        }
    }
    None
}

/// Every string this session might be showing in a terminal, strongest evidence first.
///
/// An empty answer is ordinary: a session that ended, a machine with no `~/.claude`, a
/// transcript that has not been titled yet. The matcher treats no keys and no match the
/// same way, and the jump falls back to raising the ranked window.
#[must_use]
pub fn keys_for(pid: u32) -> Vec<TitleKey> {
    claude_home().map_or_else(Vec::new, |home| keys_from(&home, pid))
}

/// [`keys_for`], against a stated Claude Code home rather than this machine's.
#[must_use]
pub fn keys_from(home: &Path, pid: u32) -> Vec<TitleKey> {
    let Some(session) = registered(home, pid) else {
        return Vec::new();
    };

    let mut keys = Vec::new();

    if let Some(id) = session.session_id.as_deref()
        && let Some(path) = transcript(home, id)
        && let Some(title) = generated_title(&path)
    {
        keys.push(TitleKey::new(KeySource::AiTitle, title));
    }

    if let Some(name) = session.name {
        // `derived` is Claude Code's word for "nobody typed this". Anything else — and a
        // missing `nameSource` is anything else — is treated as a name a person chose.
        let derived = session.name_source.as_deref() == Some("derived");
        let source = if derived {
            KeySource::DerivedName
        } else {
            KeySource::RenamedName
        };
        keys.push(TitleKey::new(source, name));
    }

    if let Some(basename) = session.cwd.as_deref().and_then(last_segment) {
        keys.push(TitleKey::new(KeySource::CwdBasename, basename));
    }

    keys.sort_by_key(|key| key.source);
    keys
}

/* ------------------------------------------------------------------ *
 * The other sessions, for the exclusion pass
 * ------------------------------------------------------------------ */

/// Every pid the session registry has a file for, ascending.
///
/// The registry is one file per session named `<pid>.json`, and a file outlives the session
/// that wrote it — so this is "sessions Claude Code has registered on this machine and not
/// cleaned up", not "sessions running now". Turning the first into the second is
/// [`other_keys_from`]'s job and it needs a process table to do it.
#[must_use]
pub fn registered_pids(home: &Path) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir(home.join("sessions")) else {
        return Vec::new();
    };
    let mut pids: Vec<u32> = entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_suffix(".json")?
                .parse::<u32>()
                .ok()
        })
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// The keys of every *other* live session, for [`nazar_shell::tabs::resolve`] to exclude by.
///
/// `alive` is asked about each registered pid and is expected to be a lookup in the process
/// snapshot the jump already took. **It is not an optimisation.** A session that has ended
/// still has a registry file and still has a transcript with a title in it, and handing
/// those keys over would claim a tab nobody is sitting in — which can leave the *wrong* tab
/// as the only one unaccounted for. `nazar_shell::tabs::MAX_OTHERS` carries the argument in
/// full, and `tabs.rs` has the test that fails if this filter is ever dropped.
///
/// The list is capped at `MAX_OTHERS`, lowest pid first, because each entry costs a registry
/// read and a transcript tail and this runs on a double-click. Truncating is the safe
/// direction: fewer claims means more tabs left over, which means a refusal rather than a
/// wrong answer.
#[must_use]
pub fn other_keys_for(pid: u32, alive: &dyn Fn(u32) -> bool) -> Vec<Vec<TitleKey>> {
    claude_home().map_or_else(Vec::new, |home| other_keys_from(&home, pid, alive))
}

/// [`other_keys_for`], against a stated Claude Code home rather than this machine's.
#[must_use]
pub fn other_keys_from(home: &Path, pid: u32, alive: &dyn Fn(u32) -> bool) -> Vec<Vec<TitleKey>> {
    registered_pids(home)
        .into_iter()
        .filter(|other| *other != pid && alive(*other))
        .take(nazar_shell::tabs::MAX_OTHERS)
        .map(|other| keys_from(home, other))
        .filter(|keys| !keys.is_empty())
        .collect()
}

/// The last segment of a path, whichever way its separators lean.
fn last_segment(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['\\', '/']);
    let segment = trimmed.rsplit(['\\', '/']).next()?.trim();
    (!segment.is_empty()).then(|| segment.to_owned())
}

/// The first `limit` bytes of a file, as text.
fn read_head(path: &Path, limit: u64) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(limit).read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// The last `limit` bytes of a file, as text, with a partial first line dropped.
fn read_tail(path: &Path, limit: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let from = length.saturating_sub(limit);
    if from > 0 {
        file.seek(SeekFrom::Start(from)).ok()?;
    }

    let mut buffer = Vec::new();
    file.take(limit).read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer).into_owned();

    if from == 0 {
        return Some(text);
    }
    // The window almost certainly opened in the middle of a line. That fragment is not
    // parseable JSON and would only ever be skipped, but dropping it keeps the scan honest.
    Some(match text.find('\n') {
        Some(at) => text[at + 1..].to_owned(),
        None => String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory that removes itself, so the tests need no crate for it.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "nazar-titles-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("a scratch directory");
            Scratch(path)
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("a parent directory");
            }
            std::fs::write(&path, contents).expect("a written file");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// One registry file in the shape the maintainer's machine writes, minified as it is
    /// on disk. The keys not on the "fields used" list are here on purpose: the reader has
    /// to skip them rather than trip over them.
    fn registry_line(session_id: &str, name: &str, name_source: &str) -> String {
        format!(
            concat!(
                r#"{{"pid":15592,"sessionId":"{}","cwd":"C:\\work\\nazar","startedAt":1,"#,
                r#""procStart":2,"version":"2.1.263","peerProtocol":1,"peerFeatures":[],"#,
                r#""kind":"interactive","entrypoint":"cli","pidDomain":"win32:x","#,
                r#""messagingSocketPath":"\\\\.\\pipe\\x","name":"{}","nameSource":"{}","#,
                r#""nameSince":3,"status":"busy","updatedAt":4,"statusUpdatedAt":5}}"#
            ),
            session_id, name, name_source
        )
    }

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn a_session_id_has_to_look_like_one_before_it_becomes_a_path() {
        assert!(is_session_id(SESSION));
        assert!(is_session_id("00000000-0000-0000-0000-000000000000"));
        assert!(!is_session_id(""));
        assert!(!is_session_id("../../../etc/passwd"));
        assert!(!is_session_id("..\\..\\windows\\system32"));
        assert!(
            !is_session_id("000000000000400080000000000000001"),
            "no dashes"
        );
        assert!(
            !is_session_id("00000000-0000-4000-8000-00000000000"),
            "short"
        );
        assert!(
            !is_session_id("00000000-0000-4000-8000-0000000000010"),
            "long"
        );
        assert!(
            !is_session_id("g0000000-0000-4000-8000-000000000001"),
            "not hex"
        );
        assert!(
            !is_session_id("00000000/0000-4000-8000-000000000001"),
            "separator"
        );
    }

    #[test]
    fn a_registry_file_gives_up_four_fields_and_ignores_the_other_fifteen() {
        let scratch = Scratch::new("registry");
        scratch.write(
            "sessions/15592.json",
            &registry_line(SESSION, "widgets-7f", "derived"),
        );
        let found = registered(&scratch.0, 15592).expect("the file parses");
        assert_eq!(found.session_id.as_deref(), Some(SESSION));
        assert_eq!(found.cwd.as_deref(), Some("C:\\work\\nazar"));
        assert_eq!(found.name.as_deref(), Some("widgets-7f"));
        assert_eq!(found.name_source.as_deref(), Some("derived"));
    }

    #[test]
    fn a_missing_or_broken_registry_file_is_no_answer_rather_than_an_error() {
        let scratch = Scratch::new("broken");
        assert_eq!(registered(&scratch.0, 4242), None);
        scratch.write("sessions/1.json", "not json at all");
        assert_eq!(registered(&scratch.0, 1), None);
        scratch.write("sessions/2.json", "{}");
        assert_eq!(registered(&scratch.0, 2), Some(Registered::default()));
    }

    #[test]
    fn a_registry_session_id_that_is_not_a_session_id_is_dropped_before_it_is_a_path() {
        let scratch = Scratch::new("traversal");
        scratch.write(
            "sessions/3.json",
            &registry_line("../../../secrets", "widgets-7f", "derived"),
        );
        let found = registered(&scratch.0, 3).expect("the file parses");
        assert_eq!(found.session_id, None, "the traversal never becomes a path");
        assert_eq!(
            found.name.as_deref(),
            Some("widgets-7f"),
            "the rest survives"
        );
    }

    #[test]
    fn a_transcript_is_found_by_name_under_whichever_project_holds_it() {
        let scratch = Scratch::new("transcript");
        scratch.write(
            "projects/C--other/aaaaaaaa-0000-0000-0000-000000000000.jsonl",
            "",
        );
        scratch.write(
            "projects/C--work-nazar/{SESSION}.jsonl"
                .replace("{SESSION}", SESSION)
                .as_str(),
            "",
        );
        let found = transcript(&scratch.0, SESSION).expect("found by name");
        assert!(found.ends_with(format!("{SESSION}.jsonl")));
        assert_eq!(
            transcript(&scratch.0, "00000000-0000-0000-0000-000000000000"),
            None
        );
        assert_eq!(transcript(&scratch.0, "../../etc"), None, "never a path");
    }

    #[test]
    fn the_last_generated_title_wins_and_nothing_else_in_the_file_is_parsed() {
        let scratch = Scratch::new("aititle");
        let path = scratch.write(
            "t.jsonl",
            &[
                r#"{"type":"ai-title","aiTitle":"An older title","sessionId":"x"}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"SENTINEL"}]}}"#,
                r#"{"type":"ai-title","aiTitle":"Repaint the harbour wall","sessionId":"x"}"#,
                r#"{"type":"user","toolUseResult":{"prompt":"SENTINEL"}}"#,
                "",
            ]
            .join("\n"),
        );
        let title = generated_title(&path).expect("the last title");
        assert_eq!(title, "Repaint the harbour wall");
        assert!(!title.contains("SENTINEL"));
    }

    #[test]
    fn a_transcript_with_no_title_line_and_an_unparseable_one_are_both_no_answer() {
        let scratch = Scratch::new("notitle");
        let none = scratch.write("a.jsonl", "{\"type\":\"assistant\"}\n");
        assert_eq!(generated_title(&none), None);

        // The marker is there and the line is not JSON: a partial write, mid-flush.
        let broken = scratch.write("b.jsonl", "{\"type\":\"ai-title\",\"aiTitl\n");
        assert_eq!(generated_title(&broken), None);

        // The marker is there and the title is empty, which is not a title.
        let empty = scratch.write("c.jsonl", "{\"type\":\"ai-title\",\"aiTitle\":\"  \"}\n");
        assert_eq!(generated_title(&empty), None);

        assert_eq!(generated_title(&scratch.0.join("nothing.jsonl")), None);
    }

    #[test]
    fn only_the_tail_of_a_long_transcript_is_read() {
        // A title further back than the window is out of reach, and that is the deliberate
        // bound rather than a bug: the file is not read whole, ever.
        let scratch = Scratch::new("tail");
        let filler = format!(
            "{{\"type\":\"assistant\",\"pad\":\"{}\"}}\n",
            "x".repeat(4096)
        );
        let mut contents = String::new();
        contents.push_str(r#"{"type":"ai-title","aiTitle":"Out of reach","sessionId":"x"}"#);
        contents.push('\n');
        while contents.len() < (TAIL_BYTES as usize) + 4096 {
            contents.push_str(&filler);
        }
        let path = scratch.write("long.jsonl", &contents);
        assert!(std::fs::metadata(&path).expect("a file").len() > TAIL_BYTES);
        assert_eq!(
            generated_title(&path),
            None,
            "the old title is past the window"
        );

        // The same file with a recent title finds it immediately.
        contents.push_str(r#"{"type":"ai-title","aiTitle":"Within reach","sessionId":"x"}"#);
        contents.push('\n');
        let path = scratch.write("long2.jsonl", &contents);
        assert_eq!(generated_title(&path).as_deref(), Some("Within reach"));
    }

    #[test]
    fn a_partial_first_line_in_the_tail_window_is_dropped() {
        let scratch = Scratch::new("partial");
        let mut contents = String::from("{\"type\":\"ai-title\",\"aiTitle\":\"first\"}\n");
        contents.push_str(&"{\"type\":\"assistant\"}\n".repeat(4));
        let path = scratch.write("p.jsonl", &contents);
        // A window of 30 bytes opens inside the first line; the fragment is discarded and
        // the scan finds nothing rather than half a title.
        let tail = read_tail(&path, 30).expect("a tail");
        assert!(
            !tail.contains("aiTitle"),
            "the fragment was dropped, got {tail:?}"
        );
    }

    #[test]
    fn a_whole_session_becomes_three_keys_strongest_first() {
        let scratch = Scratch::new("keys");
        scratch.write(
            "sessions/15592.json",
            &registry_line(SESSION, "widgets-7f", "derived"),
        );
        scratch.write(
            &format!("projects/C--work-nazar/{SESSION}.jsonl"),
            &format!(
                "{}\n",
                r#"{"type":"ai-title","aiTitle":"Harbour wall","sessionId":"x"}"#
            ),
        );

        let keys = keys_from(&scratch.0, 15592);
        assert_eq!(
            keys,
            vec![
                TitleKey::new(KeySource::AiTitle, "Harbour wall"),
                TitleKey::new(KeySource::DerivedName, "widgets-7f"),
                TitleKey::new(KeySource::CwdBasename, "nazar"),
            ]
        );
    }

    #[test]
    fn a_name_nobody_derived_is_treated_as_one_a_person_typed() {
        let scratch = Scratch::new("renamed");
        scratch.write(
            "sessions/9.json",
            &registry_line(SESSION, "harbour crew", "user"),
        );
        let keys = keys_from(&scratch.0, 9);
        assert_eq!(
            keys[0].source,
            KeySource::RenamedName,
            "no transcript exists"
        );
        assert_eq!(keys[0].text, "harbour crew");
    }

    #[test]
    fn a_session_with_nothing_behind_it_produces_no_keys_and_no_panic() {
        let scratch = Scratch::new("empty");
        assert!(keys_from(&scratch.0, 1).is_empty());
        scratch.write("sessions/2.json", "{}");
        assert!(
            keys_from(&scratch.0, 2).is_empty(),
            "a registry file with no fields is no keys, not empty keys"
        );
    }

    /* ---- the other sessions ------------------------------------------ */

    #[test]
    fn a_session_claude_code_has_not_titled_yet_falls_back_to_the_two_weak_keys() {
        // The measured miss, as a file on disk: pid 22712 had seven assistant turns and
        // **no `ai-title` line anywhere in its transcript** — not past the tail window,
        // not in a different spelling, not at all. So the strongest key it has is the
        // derived slug, which appears in no terminal title, and the matcher has to fall
        // through to the narrowing rules in `nazar_shell::tabs::resolve`.
        let scratch = Scratch::new("untitled");
        scratch.write(
            "sessions/22712.json",
            &registry_line(SESSION, "widgets-9f", "derived"),
        );
        scratch.write(
            &format!("projects/C--work-nazar/{SESSION}.jsonl"),
            &[
                r#"{"type":"user","message":{"role":"user"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant"}}"#,
                r#"{"type":"attachment","attachment":{}}"#,
                "",
            ]
            .join("\n"),
        );

        let keys = keys_from(&scratch.0, 22712);
        assert_eq!(
            keys,
            vec![
                TitleKey::new(KeySource::DerivedName, "widgets-9f"),
                TitleKey::new(KeySource::CwdBasename, "nazar"),
            ],
            "no generated title means the list starts one rung lower"
        );
        assert!(
            !keys.iter().any(|key| key.source == KeySource::AiTitle),
            "and `resolve` reads exactly this to decide the default-title rule may run"
        );
    }

    #[test]
    fn the_registry_is_read_as_a_list_of_pids_and_nothing_else_is_taken_for_one() {
        let scratch = Scratch::new("pids");
        for name in ["15592.json", "22712.json", "4040.json"] {
            scratch.write(&format!("sessions/{name}"), "{}");
        }
        // The neighbours a session directory really has: key files, a stray lock, a
        // directory. None of them is a pid.
        scratch.write("sessions/15592.abcdef.key", "");
        scratch.write("sessions/notes.json", "{}");
        scratch.write("sessions/-1.json", "{}");
        scratch.write("sessions/15592.json.tmp", "{}");
        scratch.write("sessions/nested/9999.json", "{}");

        assert_eq!(registered_pids(&scratch.0), vec![4040, 15592, 22712]);
        assert!(
            registered_pids(&scratch.0.join("nowhere")).is_empty(),
            "a machine with no registry is an empty list, not a panic"
        );
    }

    #[test]
    fn the_others_list_drops_this_session_and_every_dead_one() {
        let scratch = Scratch::new("others");
        let sessions = [
            (15592, "aaaaaaaa-0000-0000-0000-000000000001", "widgets-db"),
            (22140, "aaaaaaaa-0000-0000-0000-000000000002", "widgets-14"),
            (18128, "aaaaaaaa-0000-0000-0000-000000000003", "widgets-17"),
            (11624, "aaaaaaaa-0000-0000-0000-000000000004", "widgets-ff"),
        ];
        for (pid, id, name) in sessions {
            scratch.write(
                &format!("sessions/{pid}.json"),
                &registry_line(id, name, "derived"),
            );
            scratch.write(
                &format!("projects/C--work-nazar/{id}.jsonl"),
                &format!(
                    "{{\"type\":\"ai-title\",\"aiTitle\":\"Title of {pid}\",\"sessionId\":\"x\"}}\n"
                ),
            );
        }

        // 11624 has ended: its registry file and its transcript are both still there, and
        // it must not claim a window all the same.
        let alive = |pid: u32| pid != 11624;
        let others = other_keys_from(&scratch.0, 15592, &alive);
        let titles: Vec<&str> = others.iter().map(|keys| keys[0].text.as_str()).collect();
        assert_eq!(
            titles,
            vec!["Title of 18128", "Title of 22140"],
            "this session is not one of the others, and neither is a dead one"
        );
        for keys in &others {
            assert_eq!(
                keys[0].source,
                KeySource::AiTitle,
                "same code path as our own"
            );
        }

        // Nothing alive but us is an empty list rather than an empty entry.
        assert!(other_keys_from(&scratch.0, 15592, &|_| false).is_empty());
    }

    #[test]
    fn the_others_list_is_bounded_so_one_double_click_cannot_read_a_hundred_transcripts() {
        let scratch = Scratch::new("bounded");
        for pid in 1..=(nazar_shell::tabs::MAX_OTHERS as u32 + 20) {
            scratch.write(
                &format!("sessions/{pid}.json"),
                &registry_line(SESSION, "s", "user"),
            );
        }
        let others = other_keys_from(&scratch.0, 99999, &|_| true);
        assert_eq!(others.len(), nazar_shell::tabs::MAX_OTHERS);
    }

    #[test]
    fn a_registered_session_with_no_keys_at_all_is_left_out_of_the_others_list() {
        // An empty entry would exclude nothing and cost a `pick_tab` pass. It is dropped
        // rather than carried, so the count in the report means what it says.
        let scratch = Scratch::new("emptyother");
        scratch.write("sessions/1.json", "{}");
        scratch.write("sessions/2.json", &registry_line(SESSION, "named", "user"));
        let others = other_keys_from(&scratch.0, 99, &|_| true);
        assert_eq!(others.len(), 1);
        assert_eq!(others[0][0].text, "named");
    }

    /* ---- N-WP9: CLAUDE_CONFIG_DIR ------------------------------------- */

    /// An environment of the test's own, so nothing here touches the process's.
    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> + use<> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |name: &str| {
            owned
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| std::ffi::OsString::from(value))
        }
    }

    #[test]
    fn claude_config_dir_wins_over_the_home_directory() {
        // The order `packages/core/src/paths.ts` has used since WP1, which this half did
        // not follow until N-WP9 — and the consequence was a jump that answered "no
        // session" for every card on a machine that had moved its configuration.
        let moved = env_of(&[
            ("CLAUDE_CONFIG_DIR", "D:\\elsewhere\\claude"),
            ("USERPROFILE", "C:\\Users\\someone"),
            ("HOME", "/home/someone"),
        ]);
        assert_eq!(
            claude_home_from(&moved),
            Some(PathBuf::from("D:\\elsewhere\\claude")),
            "the variable names the directory itself, not a parent of .claude"
        );
    }

    #[test]
    fn without_the_variable_it_is_the_home_directory_and_userprofile_comes_first() {
        let windows = env_of(&[
            ("USERPROFILE", "C:\\Users\\someone"),
            ("HOME", "/home/someone"),
        ]);
        assert_eq!(
            claude_home_from(&windows),
            Some(PathBuf::from("C:\\Users\\someone").join(".claude"))
        );

        let unix = env_of(&[("HOME", "/home/someone")]);
        assert_eq!(
            claude_home_from(&unix),
            Some(PathBuf::from("/home/someone").join(".claude"))
        );

        assert_eq!(claude_home_from(&env_of(&[])), None, "no home, no answer");
    }

    #[test]
    fn an_empty_config_dir_variable_is_treated_as_unset() {
        // An exported-but-empty variable is what a shell script leaves behind, and it is
        // not a request to read the filesystem root.
        let empty = env_of(&[("CLAUDE_CONFIG_DIR", ""), ("HOME", "/home/someone")]);
        assert_eq!(
            claude_home_from(&empty),
            Some(PathBuf::from("/home/someone").join(".claude"))
        );
    }

    #[test]
    fn a_moved_configuration_directory_still_yields_a_sessions_keys() {
        // End to end against a real directory: the variable points somewhere that is not
        // under any home directory, and the keys come back exactly as they would have.
        let scratch = Scratch::new("moved-config");
        scratch.write(
            "sessions/15592.json",
            &registry_line(SESSION, "widgets-7f", "derived"),
        );
        scratch.write(
            &format!("projects/C--work-nazar/{SESSION}.jsonl"),
            &format!(
                "{}\n",
                r#"{"type":"ai-title","aiTitle":"Repaint the harbour wall","sessionId":"x"}"#
            ),
        );

        let moved = env_of(&[(
            "CLAUDE_CONFIG_DIR",
            scratch.0.to_str().expect("a printable scratch path"),
        )]);
        let home = claude_home_from(&moved).expect("the variable answers");
        assert_eq!(home, scratch.0);

        let keys = keys_from(&home, 15592);
        assert_eq!(
            keys,
            vec![
                TitleKey::new(KeySource::AiTitle, "Repaint the harbour wall"),
                TitleKey::new(KeySource::DerivedName, "widgets-7f"),
                TitleKey::new(KeySource::CwdBasename, "nazar"),
            ]
        );
    }

    #[test]
    fn the_last_path_segment_survives_either_separator() {
        assert_eq!(last_segment("C:\\work\\nazar").as_deref(), Some("nazar"));
        assert_eq!(last_segment("/home/x/nazar").as_deref(), Some("nazar"));
        assert_eq!(last_segment("C:\\work\\nazar\\").as_deref(), Some("nazar"));
        assert_eq!(last_segment("nazar").as_deref(), Some("nazar"));
        assert_eq!(last_segment(""), None);
        assert_eq!(last_segment("\\\\"), None);
    }
}
