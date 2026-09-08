//! Is the Node on this machine new enough to run the packaged server?
//!
//! **Why the shell does not bundle a Node runtime.** Nazar watches Claude Code, and
//! [Claude Code is itself distributed as a Node package that requires Node 18 or
//! newer][claude-requirements]; the maintainer's own machine runs 22. A user who has
//! nothing for Nazar to watch has no reason to install Nazar, so on every machine where
//! this application is useful a Node runtime is already present and already on `PATH`.
//! Bundling one would add roughly 50 MB to a 6 MB installer to insure against a case that
//! cannot arise while the product has a purpose. The check below is the whole of the
//! contingency: if the assumption is wrong on somebody's machine, they are told exactly
//! what is wrong instead of watching a window that never fills.
//!
//! [claude-requirements]: https://docs.claude.com/en/docs/claude-code/setup
//!
//! **Why 22 and not 18.** `package.json` says `"engines": { "node": ">=22" }` and the
//! bundle is built with esbuild's `node22` target. The floor is one constant,
//! [`MINIMUM_MAJOR`], and the test at the bottom of this file reads `package.json` so the
//! two cannot drift apart in silence.
//!
//! Parsing is deliberately lenient about everything except the number. `node --version`
//! prints `v22.23.2\n`; a distribution that prints `v22.23.2 (nvm)` or drops the `v` is
//! still telling us the same thing, and refusing to start over a decoration would be
//! absurd. What is *not* lenient: output with no recognisable version in it is
//! [`NodeCheck::Unreadable`], never "probably fine".

/// Major version the packaged server needs. Kept in step with `package.json`'s
/// `engines.node` by the test at the bottom of this file.
pub const MINIMUM_MAJOR: u32 = 22;

/// Where a user is sent when Node is missing.
pub const NODE_DOWNLOAD_URL: &str = "https://nodejs.org/en/download";

/// A version as far as this file cares: three numbers, no pre-release, no build metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    /// The major component — the only one the gate actually tests.
    pub major: u32,
    /// The minor component, kept so the shell can report what it found.
    pub minor: u32,
    /// The patch component, same reason.
    pub patch: u32,
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// What asking this machine for its Node version told us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeCheck {
    /// Node answered and is new enough.
    Ok(Version),
    /// Node answered and is too old. Carries what it said, so the message can name it.
    TooOld(Version),
    /// `node` could not be run at all: not on `PATH`, or it failed to start.
    Missing,
    /// `node` ran but printed something with no version in it. Treated as a failure on
    /// purpose: a runtime that cannot say what it is will not be trusted with the server.
    Unreadable(String),
}

impl NodeCheck {
    /// Whether the packaged server may be started.
    #[must_use]
    pub fn is_usable(&self) -> bool {
        matches!(self, NodeCheck::Ok(_))
    }
}

/// Read a version out of whatever `node --version` printed.
///
/// Scans for the first digit run that looks like a version rather than anchoring on `v`,
/// so a `v` prefix, a leading blank line and trailing decoration all parse the same.
#[must_use]
pub fn parse_version(output: &str) -> Option<Version> {
    let bytes = output.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        // A digit run that is preceded by a letter other than `v` is part of a word
        // (`node20foo`), not a version. `v` is the one prefix Node itself prints.
        let preceded_by_word = index > 0
            && bytes[index - 1].is_ascii_alphabetic()
            && !bytes[index - 1].eq_ignore_ascii_case(&b'v');
        if preceded_by_word {
            while index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
                index += 1;
            }
            continue;
        }
        match take_version(bytes, index) {
            Some(version) => return Some(version),
            // Not a version after all — step past this digit run and keep looking, so
            // `build 7, v22.23.2` still finds the second one.
            None => index = skip_run(bytes, index),
        }
    }
    None
}

/// Consume `major.minor.patch` starting at `at`, if that is what is there.
fn take_version(bytes: &[u8], at: usize) -> Option<Version> {
    let (major, after_major) = take_number(bytes, at)?;
    let after_dot = expect(bytes, after_major, b'.')?;
    let (minor, after_minor) = take_number(bytes, after_dot)?;
    let after_second_dot = expect(bytes, after_minor, b'.')?;
    let (patch, _) = take_number(bytes, after_second_dot)?;
    Some(Version {
        major,
        minor,
        patch,
    })
}

fn take_number(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let mut index = at;
    let mut value: u32 = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        // A number long enough to overflow is not a version number.
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(bytes[index] - b'0'))?;
        index += 1;
    }
    if index == at {
        None
    } else {
        Some((value, index))
    }
}

fn expect(bytes: &[u8], at: usize, byte: u8) -> Option<usize> {
    (bytes.get(at) == Some(&byte)).then_some(at + 1)
}

fn skip_run(bytes: &[u8], at: usize) -> usize {
    let mut index = at;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    index.max(at + 1)
}

/// Turn `node --version` output into a verdict.
///
/// `ran` is false when the process could not be started at all, which is the "not on
/// `PATH`" case and the one the fallback window is written for.
#[must_use]
pub fn check(ran: bool, output: &str) -> NodeCheck {
    if !ran {
        return NodeCheck::Missing;
    }
    match parse_version(output) {
        Some(version) if version.major >= MINIMUM_MAJOR => NodeCheck::Ok(version),
        Some(version) => NodeCheck::TooOld(version),
        None => NodeCheck::Unreadable(output.trim().to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shape_node_actually_prints_parses() {
        assert_eq!(
            parse_version("v22.23.2\n"),
            Some(Version {
                major: 22,
                minor: 23,
                patch: 2
            })
        );
    }

    #[test]
    fn decoration_around_the_number_does_not_matter() {
        // Three real shapes: no `v`, a trailing note from a version manager, and a
        // blank line first because a shell profile printed something.
        for text in ["22.23.2", "v22.23.2 (nvm)", "\nv22.23.2\r\n"] {
            assert_eq!(
                parse_version(text).map(|version| version.major),
                Some(22),
                "{text:?}"
            );
        }
    }

    #[test]
    fn a_digit_run_inside_a_word_is_not_a_version() {
        assert_eq!(parse_version("node20 is not installed"), None);
        assert_eq!(parse_version("error: spawn ENOENT"), None);
    }

    #[test]
    fn the_gate_is_the_major_number_and_nothing_else() {
        assert!(check(true, "v22.0.0").is_usable());
        assert!(check(true, "v24.1.3").is_usable());
        assert_eq!(
            check(true, "v20.19.0"),
            NodeCheck::TooOld(Version {
                major: 20,
                minor: 19,
                patch: 0
            })
        );
    }

    #[test]
    fn a_runtime_that_cannot_say_what_it_is_is_not_trusted() {
        // The point of the distinction: `Unreadable` names what was printed, so the
        // fallback window can show it, while `Missing` means the process never ran.
        assert_eq!(
            check(true, "  \n"),
            NodeCheck::Unreadable(String::new()),
            "empty output is unreadable, not usable"
        );
        assert_eq!(
            check(true, "'node' is not recognized"),
            NodeCheck::Unreadable("'node' is not recognized".to_owned())
        );
        assert_eq!(check(false, ""), NodeCheck::Missing);
        assert!(
            !check(false, "v22.23.2").is_usable(),
            "a version printed by a process that did not run is not a version"
        );
    }

    #[test]
    fn an_absurd_number_is_rejected_rather_than_wrapped() {
        assert_eq!(parse_version("v99999999999.0.0"), None);
    }

    /// The floor here and the floor in `package.json` are the same promise written twice.
    /// Drift only shows up when a user on Node 22 is told to upgrade, so it is checked.
    #[test]
    fn the_minimum_matches_the_published_package() {
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("package.json"),
        )
        .expect("package.json sits two directories above this crate");

        let engines = manifest
            .split("\"engines\"")
            .nth(1)
            .expect("package.json declares engines");
        let declared = engines
            .split("\"node\"")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .expect("engines.node is a string");

        assert_eq!(
            declared,
            format!(">={MINIMUM_MAJOR}"),
            "package.json says {declared}, this crate gates on {MINIMUM_MAJOR}"
        );
    }
}
