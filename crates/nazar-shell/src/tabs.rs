//! Choosing which *tab* of a terminal window belongs to a session.
//!
//! [`crate::rank`] answers "which window", and for one Windows Terminal window with one
//! session in it that is the whole answer. It stops being the whole answer the moment a
//! person opens a second session, because of a fact about Windows Terminal that is easy to
//! state and was misread once already:
//!
//! > **Every Windows Terminal window on the machine belongs to one `WindowsTerminal.exe`
//! > process.** Four windows, four tabs of one window, or any mixture — one process id.
//!
//! So a process-tree walk narrows a session down to *Windows Terminal* and no further. Two
//! sessions started from two different windows produce byte-identical evidence, and the
//! ranking then falls through to its stable tie-break and raises the same window every
//! time. That is not a tab problem; it is a **window** problem that looks like one, and the
//! matcher here fixes both at once because it works on `(window, tab)` pairs.
//!
//! # What can be matched against
//!
//! A terminal writes its title from an escape sequence the program inside it sent, and
//! Claude Code sends one. The title observed on a real machine is the session's generated
//! title with a one-character status mark in front of it (here and everywhere below, the
//! titles are made up; the mark and the relationship are what was observed):
//!
//! ```text
//!   tab title      "◐ Repaint the harbour wall"
//!   session title  "Repaint the harbour wall"
//! ```
//!
//! The mark changes as the session works, so an equality test on the raw strings fails on
//! a character that carries no meaning for us. That single observation is what the three
//! tiers below exist for — nothing more elaborate is warranted, and each extra tier is one
//! more way to match the *wrong* tab.
//!
//! # The rules, in one place
//!
//! 1. **Keys are tried strongest first** ([`KeySource`]), and a stronger key that matches
//!    ends the search. A generated title is evidence; a directory name is a guess.
//! 2. **Within one key the tiers are tried tightest first** ([`Tier`]): the raw strings,
//!    then the strings with leading and trailing marks removed, then a normalised form.
//! 3. **Containment needs [`MIN_CONTAINS`] characters** on the shorter side, so a
//!    three-letter key cannot match every tab on the machine.
//! 4. **Ambiguity is not always tolerable.** Two tabs matching a generated title means two
//!    sessions really are called the same thing, and the most recently active window is
//!    the best answer available — reported as ambiguous. Two tabs matching a *directory
//!    name* means the key was never specific enough, and the honest answer is to give up
//!    on that key rather than to raise a window by coin toss.
//!
//! # When no key matches, and the session is still in one of these windows
//!
//! [`pick_tab`] answers the question "which tab is displaying this session's name". It has
//! one blind spot, and it was measured rather than imagined: **a session Claude Code has
//! not titled yet has no name to display.** A young session's transcript carries no
//! `ai-title` line at all, its registry name is a slug derived from the directory
//! (`widgets-9f`) that appears in no terminal title on earth, and what its terminal is
//! actually showing is Claude Code's *default* title with a status mark in front of it:
//!
//! ```text
//!   tab title      "✳ Claude Code"
//!   ai-title       — the transcript has none
//!   registry name  "widgets-9f"   nameSource: "derived"
//! ```
//!
//! Before this, that session fell out of the bottom of the matcher into rung (a), which
//! raised the lowest-handle window of the host — somebody else's terminal, every time. Two
//! rules in [`resolve`] answer it without guessing, and both are *subtractive*: they narrow
//! the set of tabs this session could be in until one is left, and refuse when it is not.
//!
//! 5. **Exclusion by ownership.** Every *other* live session is matched against the same
//!    tabs by the same [`pick_tab`], and a tab another session demonstrably owns is not
//!    this one's. If exactly one unclaimed tab is left, that is the answer
//!    ([`Route::Exclusion`]) — the only window on the machine that is not somebody else's.
//! 6. **The default title, once.** If several are still left, and *this* session has no
//!    generated title of its own, and exactly one of the unclaimed tabs is still showing
//!    Claude Code's default title — then that is the untitled session's terminal
//!    ([`Route::DefaultTitle`]). Two of them and the rule declines, because two untitled
//!    sessions look exactly alike and always will.
//!
//! And when neither answers, [`Claim::Ambiguous`] is the whole answer: **N windows could be
//! this session, so raise none of them.** Raising an arbitrary one is worse than raising
//! none, because a person cannot tell a lucky guess from a right answer and will trust the
//! next wrong one.
//!
//! Everything here is arithmetic over strings somebody else collected: `apps/desktop`
//! fills [`TabCandidate`] in from UI Automation and [`TitleKey`] in from Claude Code's own
//! files, and the tests fill both in by hand, which is why this compiles and runs on a
//! Linux runner with no terminal anywhere near it.

use crate::rank::stem;

/// Executables whose windows are made of tabs this can address.
///
/// Deliberately one entry. Windows Terminal exposes its tabs as `TabItem` elements with the
/// tab's own title as the accessible name, which is exactly what the matcher needs. VS Code
/// and Cursor also publish `TabItem` elements — for *editor* tabs, which have nothing to do
/// with the integrated terminal, so selecting one would be confidently wrong. A host earns
/// a place here by being checked on a real machine, not by having tabs.
pub const TAB_HOSTS: &[&str] = &["WindowsTerminal"];

/// Whether this executable's windows should be searched for tabs at all.
#[must_use]
pub fn hosts_tabs(executable: &str) -> bool {
    let stem = stem(executable);
    TAB_HOSTS.iter().any(|host| host.eq_ignore_ascii_case(stem))
}

/// The shortest key worth trying. Two characters match too much to be evidence.
pub const MIN_KEY: usize = 3;

/// The shortest overlap that counts as containment, in characters of the shorter string.
///
/// Six, because the keys that reach the containment tiers are directory names and session
/// titles: `src`, `web` and `app` are real directory names and would each match half the
/// tabs on a developer's machine.
pub const MIN_CONTAINS: usize = 6;

/// Where a title key came from, strongest evidence first.
///
/// The order is the search order, and it is the order of how directly the source explains
/// the string a terminal is displaying — not how recently a human touched it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum KeySource {
    /// The session's generated title. **Observed to be exactly what Claude Code writes
    /// into the terminal title**, so this is the one key with direct evidence behind it.
    AiTitle,
    /// A title the user typed with `/rename`. Explicit intent, and Claude Code's session
    /// registry records it as a name whose source is not `derived` — but whether it
    /// reaches the terminal title has not been observed here, so it ranks below the one
    /// that has been.
    RenamedName,
    /// The name Claude Code derives for a session that was never renamed. On this machine
    /// it is the project slug and two characters (`widgets-7f`), and it appears in no
    /// terminal title — it is tried because it costs nothing and because a future Claude
    /// Code that titles terminals with it would then just work.
    DerivedName,
    /// The last segment of the session's working directory. A guess, kept last, and the
    /// one key that refuses to answer when more than one tab matches it.
    CwdBasename,
}

impl KeySource {
    /// The name this source goes by in the outcome JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            KeySource::AiTitle => "aiTitle",
            KeySource::RenamedName => "renamedName",
            KeySource::DerivedName => "derivedName",
            KeySource::CwdBasename => "cwdBasename",
        }
    }

    /// Whether two tabs matching this key may be resolved by picking the front one.
    ///
    /// True for the two title sources: two sessions genuinely titled the same thing is a
    /// real situation, and the window the user was in last is the best answer there is.
    /// False for the two weak sources, where a second match means the key was never
    /// specific enough to be evidence in the first place.
    #[must_use]
    pub const fn tolerates_ambiguity(self) -> bool {
        matches!(self, KeySource::AiTitle | KeySource::RenamedName)
    }
}

/// One string a session is known by, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleKey {
    /// The text itself.
    pub text: String,
    /// What produced it, which is what decides how far it is trusted.
    pub source: KeySource,
}

impl TitleKey {
    /// A key, for a caller that read one out of a file or a test that wrote one by hand.
    #[must_use]
    pub fn new(source: KeySource, text: impl Into<String>) -> Self {
        TitleKey {
            text: text.into(),
            source,
        }
    }
}

/// One tab of one window, as far as the choice cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabCandidate {
    /// The handle of the window holding it, carried opaquely so this crate needs no
    /// platform types. It is what the caller raises once a tab is chosen.
    pub window: isize,
    /// The window's place in the z-order, front first, as the enumeration produced it.
    /// Tabs of one window share it.
    pub z: usize,
    /// The tab's position among its window's tabs, left to right from zero.
    pub index: usize,
    /// The tab's title, as the terminal is displaying it — status mark and all.
    pub title: String,
}

/// How hard the matcher had to look. Tightest first, and the order is the search order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// The two strings are the same. A terminal with no status mark hits this.
    Exact,
    /// The same after leading and trailing non-alphanumerics are trimmed from both, or one
    /// containing the other once they are. This is the tier a Claude Code title lands on:
    /// the mark in front of it is the only difference.
    Contains,
    /// The same after case, punctuation and spacing are flattened, or one containing the
    /// other. The tier that survives a terminal deciding to punctuate a title its own way.
    Normalised,
}

impl Tier {
    /// The name this tier goes by in the outcome JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Tier::Exact => "exact",
            Tier::Contains => "contains",
            Tier::Normalised => "normalised",
        }
    }

    /// Every tier, tightest first.
    const ALL: [Tier; 3] = [Tier::Exact, Tier::Contains, Tier::Normalised];

    /// Whether a tab title and a key meet at this tier.
    #[must_use]
    fn matches(self, title: &str, key: &str) -> bool {
        match self {
            Tier::Exact => !key.is_empty() && title.trim() == key,
            Tier::Contains => overlaps(strip_marks(title), strip_marks(key)),
            Tier::Normalised => overlaps(&normalise(title), &normalise(key)),
        }
    }
}

/// A tab the matcher settled on, and how it got there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabPick<'a> {
    /// The tab itself.
    pub tab: &'a TabCandidate,
    /// Which key matched.
    pub source: KeySource,
    /// How hard it had to look.
    pub tier: Tier,
    /// Whether more than one tab matched and the front one was taken.
    pub ambiguous: bool,
}

/// A title with its decoration trimmed off both ends.
///
/// Claude Code prefixes a status mark (`◐`, `✳`) and a space; a terminal or a shell may add
/// punctuation of its own. Nothing alphanumeric is removed, so a title that *is* decoration
/// comes back empty and matches nothing, which is the right answer for it.
#[must_use]
pub fn strip_marks(title: &str) -> &str {
    title.trim_matches(|c: char| !c.is_alphanumeric())
}

/// A title flattened to lower-case words separated by single spaces.
///
/// Every run of non-alphanumeric characters becomes one space and nothing else survives, so
/// `"◐ Nazar — jump, rung (b)"` and `"nazar jump rung b"` are the same string here. Case is
/// folded with Unicode's own rules and not ASCII's, because the titles this compares are
/// written in whatever language the user works in.
#[must_use]
pub fn normalise(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut gap = false;
    for character in title.chars() {
        if character.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.extend(character.to_lowercase());
        } else {
            gap = true;
        }
    }
    out
}

/// Equal, or one containing the other with enough characters to mean something.
fn overlaps(one: &str, other: &str) -> bool {
    if one.is_empty() || other.is_empty() {
        return false;
    }
    if one == other {
        return true;
    }
    let shorter = one.chars().count().min(other.chars().count());
    shorter >= MIN_CONTAINS && (one.contains(other) || other.contains(one))
}

/// Pick the tab a session is running in, or `None` when nothing is good enough.
///
/// `None` is a real answer and the caller is expected to use it: raise the window the
/// ranking chose and say why the tab could not be found. A wrong tab is worse than no tab,
/// because the user cannot tell the difference between "Nazar found it" and "Nazar guessed
/// and the guess happened to be where I already was".
#[must_use]
pub fn pick_tab<'a>(keys: &[TitleKey], tabs: &'a [TabCandidate]) -> Option<TabPick<'a>> {
    for key in keys {
        let text = key.text.trim();
        if text.chars().count() < MIN_KEY {
            continue;
        }
        for tier in Tier::ALL {
            let mut hits: Vec<&TabCandidate> = tabs
                .iter()
                .filter(|tab| tier.matches(&tab.title, text))
                .collect();
            if hits.is_empty() {
                continue;
            }
            if hits.len() > 1 && !key.source.tolerates_ambiguity() {
                // A looser tier can only match more tabs, so there is nothing left to try
                // with this key. Move to the next one rather than guessing.
                break;
            }
            // Front of the z-order first, then left to right, then by handle: the answer
            // must not depend on the order the enumeration happened to return.
            hits.sort_by_key(|tab| (tab.z, tab.index, tab.window));
            return Some(TabPick {
                tab: hits[0],
                source: key.source,
                tier,
                ambiguous: hits.len() > 1,
            });
        }
    }
    None
}

/* ------------------------------------------------------------------ *
 * When no key matched: narrowing, and refusing
 * ------------------------------------------------------------------ */

/// The titles a terminal shows for a Claude Code session nobody and nothing has named,
/// normalised by [`normalise`].
///
/// One entry, and it is the one that was read off a live terminal: Claude Code sets the
/// window title to its own name until it has generated one for the session. The status mark
/// in front of it (`✳`, `◐`) is not part of the comparison because [`normalise`] has
/// already dropped it.
///
/// This list is deliberately not "titles that look generic". A shell prompt writing
/// `C:\work\nazar` into the title is *not* on it: that string identifies a directory, four
/// sessions in one repository would all carry it, and treating it as "unnamed" would put
/// the coin toss back in a different place.
pub const DEFAULT_TITLES: &[&str] = &["claude code"];

/// Whether a title is Claude Code's own, meaning the session behind it has no name yet.
#[must_use]
pub fn is_default_title(title: &str) -> bool {
    let flattened = normalise(title);
    DEFAULT_TITLES.iter().any(|known| flattened == *known)
}

/// Which reasoning found a session's tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// One of the session's own keys matched a tab title. Direct evidence, and the only
    /// route that can report a [`KeySource`] and a [`Tier`].
    Title,
    /// Every other live session's tab was accounted for and exactly one was left over.
    Exclusion,
    /// This session has no title of its own, and exactly one unclaimed tab was still
    /// showing Claude Code's default one.
    DefaultTitle,
}

impl Route {
    /// The name this route goes by in the outcome JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Route::Title => "title",
            Route::Exclusion => "exclusion",
            Route::DefaultTitle => "defaultTitle",
        }
    }

    /// The rung of the jump ladder this route counts as, for the report.
    #[must_use]
    pub const fn rung(self) -> &'static str {
        match self {
            Route::Title => "b",
            Route::Exclusion => "b-exclusion",
            Route::DefaultTitle => "b-default",
        }
    }

    /// The sentence that says why this tab and not another.
    #[must_use]
    pub const fn reason(self) -> &'static str {
        match self {
            Route::Title => "a tab title matched this session",
            Route::Exclusion => "the only window not owned by another session",
            Route::DefaultTitle => {
                "the only window still showing Claude Code's default title, for the only \
                 session that has no title yet"
            }
        }
    }
}

/// What the whole tab question came to for one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim<'a> {
    /// This tab is the session's, by this route.
    Found {
        /// The tab, and so the window to raise.
        tab: &'a TabCandidate,
        /// How it was arrived at.
        route: Route,
        /// Which key matched, on [`Route::Title`] only.
        source: Option<KeySource>,
        /// How hard the match had to look, on [`Route::Title`] only.
        tier: Option<Tier>,
        /// Whether more than one tab matched a title and the front one was taken. Never
        /// true on a subtractive route: those two answer once or not at all.
        ambiguous: bool,
    },
    /// More than one tab could be this session and nothing separates them. The count is
    /// what the message tells the user, and the answer to it is `/rename`.
    Ambiguous {
        /// How many tabs were still unaccounted for.
        remaining: usize,
    },
    /// Nothing to work with: no tabs at all, or every one of them belongs to a session
    /// that is provably not this one.
    Nothing,
}

/// How many other sessions' keys the caller may hand over, so a machine with a hundred
/// stale registry entries cannot turn one double-click into a hundred file reads.
///
/// The bound is enforced on the caller's side of the wall — [`resolve`] is arithmetic and
/// does not care — but the reason it is safe to have a bound at all belongs here, next to
/// the rule it protects. The two directions are **not** symmetric:
///
/// * **Leaving a live session out** removes a claim, which leaves more tabs unaccounted for
///   and makes [`resolve`] more likely to refuse. It costs an answer and cannot cause a
///   wrong one, so truncating the list is a safe thing to do.
/// * **Putting a dead session in** adds a claim on a tab nobody is in, which can leave the
///   *wrong* tab as the only one over. That is a correctness bug and the caller prevents it
///   by filtering the list against a process snapshot, not by hoping.
pub const MAX_OTHERS: usize = 32;

/// Which tab a session is in, using every rule there is — or the refusal to guess.
///
/// `keys` are this session's names, strongest first. `others` are the same lists for every
/// other **live** session, in any order; each one is matched by the same [`pick_tab`], which
/// is what makes "owned by another session" mean the same thing as "found for that session".
/// Liveness is the caller's promise and it is load-bearing — see [`MAX_OTHERS`] for which
/// half of it can be relaxed and which cannot.
///
/// The order is the order of how much the answer is worth: a title match first, because it
/// is the one route with direct evidence; then exclusion, which is narrowing and cannot
/// invent a candidate; then the default title, which is narrowing with one extra fact. A
/// refusal is a real answer and the caller is expected to act on it by raising nothing.
#[must_use]
pub fn resolve<'a>(
    keys: &[TitleKey],
    others: &[Vec<TitleKey>],
    tabs: &'a [TabCandidate],
) -> Claim<'a> {
    if tabs.is_empty() {
        return Claim::Nothing;
    }

    // (1) The session's own name on a terminal. Nothing below this is as good.
    if let Some(picked) = pick_tab(keys, tabs) {
        return Claim::Found {
            tab: picked.tab,
            route: Route::Title,
            source: Some(picked.source),
            tier: Some(picked.tier),
            ambiguous: picked.ambiguous,
        };
    }

    // (2) Exclusion. Every other live session is matched against the same tabs, and what
    //     they claim is not ours.
    //
    //     Claims are taken tab by tab rather than window by window. In the shape that was
    //     measured they are the same thing — one Claude Code session per Windows Terminal
    //     window — and where they differ, tab-level is the safe half: a window holding
    //     somebody else's matched tab *and* an unmatched one may still be ours, and
    //     striking the whole window would throw that away.
    let claimed: Vec<&TabCandidate> = others
        .iter()
        .filter_map(|other| pick_tab(other, tabs).map(|picked| picked.tab))
        .collect();
    let unclaimed: Vec<&TabCandidate> = tabs
        .iter()
        .filter(|tab| !claimed.iter().any(|taken| std::ptr::eq(*taken, *tab)))
        .collect();

    if unclaimed.is_empty() {
        // Every tab on offer belongs to a session that is not this one. That is a fact,
        // not a failure, and it means this session's terminal is not among these windows.
        return Claim::Nothing;
    }
    if let [only] = unclaimed[..] {
        return Claim::Found {
            tab: only,
            route: Route::Exclusion,
            source: None,
            tier: None,
            ambiguous: false,
        };
    }

    // (3) The default title, and only for a session that is *known* to have none of its
    //     own. A session with a generated title is not the one behind a terminal reading
    //     "Claude Code" — Claude Code would have written the title there.
    //
    //     "Known" is doing work in that sentence. No keys at all is not the same fact as
    //     "this session has a derived name and no generated title": it is what a caller
    //     hands over for a session that has ended, or on a machine with no `~/.claude` to
    //     read, and it means nothing is known about the session rather than that it is
    //     young. Treating the two alike let a live test with no keys reach into a terminal
    //     and select a tab, which is how the distinction was found.
    let untitled = !keys.is_empty()
        && !keys
            .iter()
            .any(|key| matches!(key.source, KeySource::AiTitle | KeySource::RenamedName));
    if untitled {
        let mut defaults = unclaimed
            .iter()
            .copied()
            .filter(|tab| is_default_title(&tab.title));
        if let (Some(only), None) = (defaults.next(), defaults.next()) {
            return Claim::Found {
                tab: only,
                route: Route::DefaultTitle,
                source: None,
                tier: None,
                ambiguous: false,
            };
        }
    }

    Claim::Ambiguous {
        remaining: unclaimed.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(window: isize, z: usize, index: usize, title: &str) -> TabCandidate {
        TabCandidate {
            window,
            z,
            index,
            title: title.to_owned(),
        }
    }

    fn ai(text: &str) -> TitleKey {
        TitleKey::new(KeySource::AiTitle, text)
    }

    /* ---- normalisation ------------------------------------------------ */

    #[test]
    fn the_normalisation_table() {
        // One table, because the rule is one rule: alphanumerics survive folded to
        // lower-case, every run of anything else becomes a single space, and the ends are
        // bare. Each row is a shape seen on a real terminal title.
        let table = [
            ("", ""),
            ("   ", ""),
            ("◐", ""),
            ("◐ Harbour wall", "harbour wall"),
            ("✳ Harbour wall", "harbour wall"),
            ("Harbour wall", "harbour wall"),
            ("HARBOUR WALL", "harbour wall"),
            ("harbour   wall", "harbour wall"),
            ("  harbour wall  ", "harbour wall"),
            ("harbour-wall", "harbour wall"),
            ("harbour, wall — (again)", "harbour wall again"),
            ("Nazar: jump — rung (b)!", "nazar jump rung b"),
            ("🚀 ship it", "ship it"),
            ("Liman Duvarı", "liman duvarı"),
            ("ÇALIŞMA", "çalişma"),
            ("C:\\nazar", "c nazar"),
            ("v1.2.3", "v1 2 3"),
        ];
        for (input, want) in table {
            assert_eq!(normalise(input), want, "normalise({input:?})");
        }
    }

    #[test]
    fn stripping_marks_takes_decoration_off_both_ends_and_nothing_from_the_middle() {
        assert_eq!(strip_marks("◐ Harbour wall"), "Harbour wall");
        assert_eq!(strip_marks("✳ Harbour wall"), "Harbour wall");
        assert_eq!(strip_marks("  Harbour wall  "), "Harbour wall");
        assert_eq!(strip_marks("[Harbour wall]"), "Harbour wall");
        assert_eq!(
            strip_marks("Harbour — wall"),
            "Harbour — wall",
            "the middle is untouched"
        );
        assert_eq!(
            strip_marks("◐ ✳ —"),
            "",
            "a title of pure decoration is nothing"
        );
        assert_eq!(strip_marks(""), "");
    }

    #[test]
    fn the_status_mark_is_the_whole_difference_between_a_title_and_a_key() {
        // The observation this module exists for, as a test: Claude Code writes
        // "<mark> <title>" and the mark changes while the session works.
        let key = "Repaint the harbour wall";
        for mark in ["◐", "◑", "◒", "◓", "✳", "✶", "·"] {
            let title = format!("{mark} {key}");
            assert!(
                Tier::Contains.matches(&title, key),
                "{title:?} should match {key:?} once the mark is off"
            );
            assert!(
                !Tier::Exact.matches(&title, key),
                "{title:?} is not literally {key:?}"
            );
        }
    }

    /* ---- tiers -------------------------------------------------------- */

    #[test]
    fn the_tiers_are_tried_tightest_first_and_the_outcome_says_which_one_answered() {
        let exact = [tab(1, 0, 0, "Harbour wall")];
        let picked = pick_tab(&[ai("Harbour wall")], &exact).expect("an exact hit");
        assert_eq!(picked.tier, Tier::Exact);

        let marked = [tab(1, 0, 0, "◐ Harbour wall")];
        let picked = pick_tab(&[ai("Harbour wall")], &marked).expect("a hit past the mark");
        assert_eq!(picked.tier, Tier::Contains);

        let repunctuated = [tab(1, 0, 0, "◐ HARBOUR — WALL")];
        let picked = pick_tab(&[ai("Harbour wall")], &repunctuated).expect("a normalised hit");
        assert_eq!(picked.tier, Tier::Normalised);
    }

    #[test]
    fn a_tab_title_that_is_a_prefix_of_the_key_still_matches() {
        // Terminals truncate. The key is the whole title and the tab shows what fits.
        let tabs = [tab(1, 0, 0, "◐ Repaint the harbour")];
        let picked = pick_tab(&[ai("Repaint the harbour wall")], &tabs)
            .expect("containment works in both directions");
        assert_eq!(picked.tier, Tier::Contains);
    }

    #[test]
    fn containment_needs_enough_characters_to_mean_something() {
        // "src" is in half the titles on a developer's machine and is evidence of nothing.
        let tabs = [tab(1, 0, 0, "◐ working in src today")];
        assert!(pick_tab(&[TitleKey::new(KeySource::CwdBasename, "src")], &tabs).is_none());
        // Six characters is the floor, and a real directory name clears it.
        let tabs = [tab(1, 0, 0, "◐ pwsh — packages")];
        let picked = pick_tab(&[TitleKey::new(KeySource::CwdBasename, "packages")], &tabs)
            .expect("eight characters is specific enough");
        assert_eq!(picked.source, KeySource::CwdBasename);
    }

    #[test]
    fn a_key_shorter_than_the_floor_is_never_tried_at_all() {
        let tabs = [tab(1, 0, 0, "ui")];
        assert!(
            pick_tab(&[TitleKey::new(KeySource::CwdBasename, "ui")], &tabs).is_none(),
            "a two-character key would match by accident, exactly or otherwise"
        );
    }

    #[test]
    fn a_tab_of_pure_decoration_matches_nothing() {
        let tabs = [tab(1, 0, 0, "◐ ✳"), tab(2, 1, 0, "")];
        assert!(pick_tab(&[ai("Harbour wall")], &tabs).is_none());
    }

    /* ---- key strength ------------------------------------------------- */

    #[test]
    fn a_stronger_key_wins_even_when_a_weaker_one_matches_more_tightly() {
        // The directory name is *exactly* one tab's title and the generated title needs
        // the mark taken off another. The generated title is still the answer, because it
        // is the string Claude Code actually wrote into a terminal.
        let tabs = [
            tab(10, 0, 0, "nazar"),
            tab(20, 1, 0, "◐ Repaint the harbour wall"),
        ];
        let keys = [
            ai("Repaint the harbour wall"),
            TitleKey::new(KeySource::CwdBasename, "nazar"),
        ];
        let picked = pick_tab(&keys, &tabs).expect("one of them wins");
        assert_eq!(picked.tab.window, 20);
        assert_eq!(picked.source, KeySource::AiTitle);
    }

    #[test]
    fn a_weaker_key_is_reached_only_when_every_stronger_one_missed() {
        let tabs = [tab(10, 0, 0, "◐ packages")];
        let keys = [
            ai("Something else entirely"),
            TitleKey::new(KeySource::DerivedName, "widgets-7f"),
            TitleKey::new(KeySource::CwdBasename, "packages"),
        ];
        let picked = pick_tab(&keys, &tabs).expect("the last key carries it");
        assert_eq!(picked.source, KeySource::CwdBasename);
    }

    #[test]
    fn the_source_order_is_the_documented_one() {
        assert!(KeySource::AiTitle < KeySource::RenamedName);
        assert!(KeySource::RenamedName < KeySource::DerivedName);
        assert!(KeySource::DerivedName < KeySource::CwdBasename);
        assert!(KeySource::AiTitle.tolerates_ambiguity());
        assert!(KeySource::RenamedName.tolerates_ambiguity());
        assert!(!KeySource::DerivedName.tolerates_ambiguity());
        assert!(!KeySource::CwdBasename.tolerates_ambiguity());
    }

    /* ---- ambiguity ---------------------------------------------------- */

    #[test]
    fn two_tabs_with_the_same_generated_title_resolve_to_the_front_window_and_say_so() {
        // Two sessions in the same repository can be given the same title. The window the
        // user was in last is the best answer available, and the outcome admits it guessed.
        let tabs = [
            tab(10, 2, 0, "◐ Harbour wall"),
            tab(20, 0, 0, "◐ Harbour wall"),
            tab(30, 1, 0, "◐ Harbour wall"),
        ];
        let picked = pick_tab(&[ai("Harbour wall")], &tabs).expect("the front one");
        assert_eq!(picked.tab.window, 20, "z = 0 is the front of the z-order");
        assert!(picked.ambiguous);
    }

    #[test]
    fn two_tabs_of_one_window_break_their_shared_z_by_position() {
        let tabs = [
            tab(10, 0, 3, "◐ Harbour wall"),
            tab(10, 0, 1, "◐ Harbour wall"),
        ];
        let picked = pick_tab(&[ai("Harbour wall")], &tabs).expect("one of them");
        assert_eq!(
            picked.tab.index, 1,
            "leftmost of the two in the same window"
        );
        assert!(picked.ambiguous);
    }

    #[test]
    fn an_ambiguous_weak_key_gives_up_instead_of_tossing_a_coin() {
        // Four sessions in one repository is the ordinary case, not a corner one. A
        // directory name matching all four is the key admitting it was never an identifier.
        let tabs = [
            tab(10, 0, 0, "◐ nazar"),
            tab(20, 1, 0, "✳ nazar"),
            tab(30, 2, 0, "◐ nazar"),
            tab(40, 3, 0, "✳ nazar"),
        ];
        assert!(pick_tab(&[TitleKey::new(KeySource::CwdBasename, "nazar")], &tabs).is_none());
    }

    #[test]
    fn an_ambiguous_weak_key_does_not_block_a_later_key_that_is_unambiguous() {
        // The first key matches both tabs and refuses to answer; the second matches one.
        let tabs = [
            tab(10, 0, 0, "◐ packages"),
            tab(20, 1, 0, "✳ packages — shellwork"),
        ];
        let keys = [
            TitleKey::new(KeySource::DerivedName, "packages"),
            TitleKey::new(KeySource::CwdBasename, "shellwork"),
        ];
        assert!(
            pick_tab(&keys[..1], &tabs).is_none(),
            "the first key on its own is ambiguous and gives up"
        );
        let picked = pick_tab(&keys, &tabs).expect("the second key is specific");
        assert_eq!(picked.tab.window, 20);
        assert_eq!(picked.source, KeySource::CwdBasename);
        assert!(!picked.ambiguous);
    }

    #[test]
    fn one_match_is_never_reported_as_ambiguous() {
        let tabs = [
            tab(10, 0, 0, "◐ Harbour wall"),
            tab(20, 1, 0, "✳ Something else"),
        ];
        let picked = pick_tab(&[ai("Harbour wall")], &tabs).expect("exactly one");
        assert!(!picked.ambiguous);
    }

    /* ---- stability and the empty cases -------------------------------- */

    #[test]
    fn the_choice_does_not_depend_on_enumeration_order() {
        let one = tab(10, 1, 0, "◐ Harbour wall");
        let other = tab(20, 0, 0, "◐ Harbour wall");
        let forward = [one.clone(), other.clone()];
        let backward = [other, one];
        assert_eq!(
            pick_tab(&[ai("Harbour wall")], &forward)
                .expect("one wins")
                .tab,
            pick_tab(&[ai("Harbour wall")], &backward)
                .expect("one wins")
                .tab,
            "same input, same answer, either order"
        );
    }

    #[test]
    fn no_keys_no_tabs_and_no_match_are_all_the_same_no() {
        let tabs = [tab(10, 0, 0, "◐ Harbour wall")];
        assert!(pick_tab(&[], &tabs).is_none());
        assert!(pick_tab(&[ai("Harbour wall")], &[]).is_none());
        assert!(pick_tab(&[ai("A different session")], &tabs).is_none());
    }

    #[test]
    fn an_empty_key_is_skipped_rather_than_matching_everything() {
        let tabs = [tab(10, 0, 0, "◐ Harbour wall")];
        assert!(pick_tab(&[ai(""), ai("   ")], &tabs).is_none());
    }

    /* ---- hosts -------------------------------------------------------- */

    #[test]
    fn only_windows_terminal_is_searched_for_tabs() {
        assert!(hosts_tabs("WindowsTerminal.exe"));
        assert!(hosts_tabs("windowsterminal.EXE"));
        assert!(hosts_tabs("WindowsTerminal"));
        assert!(hosts_tabs(
            "C:\\Program Files\\WindowsApps\\WindowsTerminal.exe"
        ));
        // Both publish TabItem elements, and both mean editor tabs by it.
        assert!(!hosts_tabs("Code.exe"));
        assert!(!hosts_tabs("cursor.exe"));
        assert!(!hosts_tabs("mintty.exe"));
        assert!(!hosts_tabs("conhost.exe"));
    }

    /* ---- the machine this was built on -------------------------------- */

    #[test]
    fn the_four_sessions_measured_on_the_maintainers_machine() {
        // Four Claude Code sessions, four Windows Terminal windows, one
        // `WindowsTerminal.exe` — the case that made rung (b) necessary. The titles are
        // the shapes that were on screen, with the text replaced; what is real about this
        // row is the arrangement: one tab per window, a status mark in front of every
        // title, generated titles that share no words, and derived registry names that
        // share a prefix and match nothing.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x0079_0B28, 1, 0, "◐ Move the pallet racking"),
            tab(0x0012_0A70, 2, 0, "✳ Draft the winter timetable"),
            tab(0x03EB_07B6, 3, 0, "✳ Fit the new gantry"),
        ];
        let sessions = [
            ("Repaint the harbour wall", "widgets-db", 0x0037_08DA),
            ("Move the pallet racking", "widgets-32", 0x0079_0B28),
            ("Draft the winter timetable", "widgets-80", 0x0012_0A70),
            ("Fit the new gantry", "widgets-14", 0x03EB_07B6),
        ];
        for (title, derived, window) in sessions {
            let keys = [
                ai(title),
                TitleKey::new(KeySource::DerivedName, derived),
                TitleKey::new(KeySource::CwdBasename, "acme-widgets"),
            ];
            let picked = pick_tab(&keys, &tabs).unwrap_or_else(|| panic!("no tab for {title}"));
            assert_eq!(picked.tab.window, window, "wrong window for {title}");
            assert_eq!(picked.source, KeySource::AiTitle);
            assert_eq!(picked.tier, Tier::Contains, "the mark is the difference");
            assert!(!picked.ambiguous);
        }
    }

    /* ---- narrowing: exclusion, the default title, and the refusal ----- */

    /// The five windows that were on the maintainer's screen when the report was made.
    ///
    /// Three sessions had generated titles and matched; two had none and did not. One tab
    /// per window, which is the arrangement Windows Terminal was in. The titles are made
    /// up; the arrangement is what was real, and it is the only part any rule reads.
    fn five_windows() -> Vec<TabCandidate> {
        vec![
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x03EB_07B6, 1, 0, "◑ Move the pallet racking"),
            tab(0x0052_0966, 2, 0, "✳ Draft the winter timetable"),
            tab(0x00ED_09BA, 3, 0, "✳ Claude Code"),
            tab(0x0079_0B28, 4, 0, "◐ Claude Code"),
        ]
    }

    /// The keys of a session Claude Code has not titled yet: no `ai-title` line exists, so
    /// the strongest key available is the derived registry slug.
    fn untitled(derived: &str) -> Vec<TitleKey> {
        vec![
            TitleKey::new(KeySource::DerivedName, derived),
            TitleKey::new(KeySource::CwdBasename, "acme-widgets"),
        ]
    }

    /// And of one that has been: the generated title in front of the same two.
    fn titled(generated: &str, derived: &str) -> Vec<TitleKey> {
        let mut keys = vec![ai(generated)];
        keys.extend(untitled(derived));
        keys
    }

    #[test]
    fn five_candidates_with_three_owned_leaves_two_and_raises_nothing() {
        // The measured miss, exactly as it was: two untitled sessions, two terminals both
        // reading "Claude Code", and no fact anywhere that separates them. The answer is
        // the refusal, and the count is what the message tells the user.
        let tabs = five_windows();
        let others = vec![
            titled("Repaint the harbour wall", "widgets-db"),
            titled("Move the pallet racking", "widgets-14"),
            titled("Draft the winter timetable", "widgets-17"),
        ];
        assert_eq!(
            resolve(&untitled("widgets-9f"), &others, &tabs),
            Claim::Ambiguous { remaining: 2 },
            "two untitled sessions look alike and always will"
        );
    }

    #[test]
    fn five_candidates_with_four_owned_leaves_one_and_selects_it() {
        // The same machine one session later: the fifth has a title of its own, so four
        // tabs are spoken for and the one left over is this session's by elimination.
        let tabs = five_windows();
        let others = vec![
            titled("Repaint the harbour wall", "widgets-db"),
            titled("Move the pallet racking", "widgets-14"),
            titled("Draft the winter timetable", "widgets-17"),
            titled("Claude Code", "widgets-4c"),
        ];
        let claim = resolve(&untitled("widgets-9f"), &others, &tabs);
        let Claim::Found {
            tab,
            route,
            source,
            tier,
            ambiguous,
        } = claim
        else {
            panic!("one tab was left over, {claim:?}");
        };
        assert_eq!(route, Route::Exclusion);
        assert_eq!(route.rung(), "b-exclusion");
        assert!(!ambiguous, "elimination answers once or not at all");
        assert_eq!(
            source, None,
            "no key matched — that is the point of the route"
        );
        assert_eq!(tier, None);
        // The fourth other session's title is itself "Claude Code", which matches both
        // default-titled tabs; that is tolerated ambiguity for a generated title and it
        // takes the front one, leaving the other for us.
        assert!(
            tab.window == 0x0079_0B28 || tab.window == 0x00ED_09BA,
            "one of the two default-titled windows, {:#X}",
            tab.window
        );
    }

    #[test]
    fn the_only_window_still_showing_the_default_title_is_the_only_untitled_session() {
        // Rule 6, and the shape it was written for: several tabs still unaccounted for,
        // one of them untouched by Claude Code, and this session is the one with no name.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x0052_0966, 1, 0, "PowerShell 7 — C:\\nazar"),
            tab(0x00ED_09BA, 2, 0, "✳ Claude Code"),
        ];
        let claim = resolve(&untitled("widgets-9f"), &[], &tabs);
        let Claim::Found { tab, route, .. } = claim else {
            panic!("the default title carries it, {claim:?}");
        };
        assert_eq!(route, Route::DefaultTitle);
        assert_eq!(route.rung(), "b-default");
        assert_eq!(tab.window, 0x00ED_09BA);
    }

    #[test]
    fn knowing_nothing_about_a_session_is_not_the_same_as_knowing_it_has_no_title() {
        // A caller with no keys at all — a session that ended between the click and the
        // read, or a machine with no `~/.claude` — knows nothing. The default-title rule
        // needs the positive fact "this session has a name and it is a derived slug", so
        // it stays off, and several unaccounted-for tabs stay several.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x00ED_09BA, 1, 0, "✳ Claude Code"),
        ];
        assert_eq!(resolve(&[], &[], &tabs), Claim::Ambiguous { remaining: 2 });
        // The same tabs with the positive fact in hand answer.
        let claim = resolve(&untitled("widgets-9f"), &[], &tabs);
        assert!(
            matches!(
                claim,
                Claim::Found {
                    route: Route::DefaultTitle,
                    ..
                }
            ),
            "{claim:?}"
        );
    }

    #[test]
    fn two_default_titles_decline_rather_than_pick_one() {
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x00ED_09BA, 1, 0, "✳ Claude Code"),
            tab(0x0079_0B28, 2, 0, "◐ Claude Code"),
        ];
        assert_eq!(
            resolve(&untitled("widgets-9f"), &[], &tabs),
            Claim::Ambiguous { remaining: 3 },
        );
    }

    #[test]
    fn a_session_that_has_a_title_is_never_given_the_default_titled_window() {
        // If Claude Code had generated a title for this session it would have written it
        // into the terminal. A terminal still reading "Claude Code" is somebody else's.
        let tabs = [
            tab(0x0052_0966, 0, 0, "PowerShell 7 — C:\\nazar"),
            tab(0x00ED_09BA, 1, 0, "✳ Claude Code"),
        ];
        let keys = titled("A title that is on no terminal here", "widgets-db");
        assert_eq!(
            resolve(&keys, &[], &tabs),
            Claim::Ambiguous { remaining: 2 },
            "the default-title rule is for sessions with no title, and this one has one"
        );
        // A name the user typed counts the same way: it is a title, so the rule stays off.
        let renamed = vec![TitleKey::new(KeySource::RenamedName, "the harbour crew")];
        assert_eq!(
            resolve(&renamed, &[], &tabs),
            Claim::Ambiguous { remaining: 2 }
        );
    }

    #[test]
    fn the_default_title_is_recognised_under_every_status_mark_and_nothing_else_is() {
        for mark in ["◐", "◑", "◒", "◓", "✳", "✶", "·"] {
            assert!(is_default_title(&format!("{mark} Claude Code")));
        }
        assert!(is_default_title("Claude Code"));
        assert!(is_default_title("  claude   code  "));
        // A directory in a title is not "unnamed": four sessions in one repository would
        // all carry it, which is the coin toss this rule exists to avoid.
        assert!(!is_default_title("C:\\nazar"));
        assert!(!is_default_title("◐ Claude Code — rung b"));
        assert!(!is_default_title("pwsh"));
        assert!(!is_default_title(""));
        assert!(!is_default_title("◐"));
    }

    #[test]
    fn a_title_match_is_taken_before_any_amount_of_narrowing() {
        // Exclusion never gets a chance when the session's own name is on a terminal, even
        // though it would have answered too, and with a different window.
        let tabs = five_windows();
        let others = vec![titled("Repaint the harbour wall", "widgets-db")];
        let claim = resolve(
            &titled("Draft the winter timetable", "widgets-17"),
            &others,
            &tabs,
        );
        let Claim::Found {
            tab, route, source, ..
        } = claim
        else {
            panic!("the title matched, {claim:?}");
        };
        assert_eq!(route, Route::Title);
        assert_eq!(route.rung(), "b");
        assert_eq!(source, Some(KeySource::AiTitle));
        assert_eq!(tab.window, 0x0052_0966);
    }

    #[test]
    fn every_tab_belonging_to_somebody_else_is_nothing_rather_than_a_guess() {
        // Three windows, three other sessions, all matched. This session's terminal is
        // simply not among them — it is a fact and it is not a tab to raise.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x03EB_07B6, 1, 0, "◑ Move the pallet racking"),
            tab(0x0052_0966, 2, 0, "✳ Draft the winter timetable"),
        ];
        let others = vec![
            titled("Repaint the harbour wall", "widgets-db"),
            titled("Move the pallet racking", "widgets-14"),
            titled("Draft the winter timetable", "widgets-17"),
        ];
        assert_eq!(
            resolve(&untitled("widgets-9f"), &others, &tabs),
            Claim::Nothing
        );
    }

    #[test]
    fn a_stale_entry_in_the_others_list_moves_the_answer_which_is_why_liveness_is_the_callers_job()
    {
        // Written down because it is the one way this can be wrong, and it is not obvious.
        // Exclusion trusts that `others` is *exactly* the other live sessions. A session
        // that has ended but whose keys are still handed over claims a tab nobody is in,
        // and the tab left over is then somebody else's window rather than none.
        //
        // So `apps/desktop` filters the list against the same process snapshot the jump
        // already took, and that filter is a correctness requirement rather than a saving.
        // The test exists to make a future edit that drops it fail here.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x00ED_09BA, 1, 0, "✳ Claude Code"),
        ];
        let ghost = vec![ai("Claude Code")];
        let claim = resolve(&untitled("widgets-9f"), &[ghost], &tabs);
        let Claim::Found { tab, route, .. } = claim else {
            panic!("the ghost's claim left exactly one tab over, {claim:?}");
        };
        assert_eq!(route, Route::Exclusion);
        assert_eq!(
            tab.window, 0x0037_08DA,
            "and it is the wrong one — a dead session must never reach this list"
        );

        // With the ghost gone, which is what the liveness filter guarantees, the same
        // machine answers correctly: the default-titled tab is the untitled session's.
        let claim = resolve(&untitled("widgets-9f"), &[], &tabs);
        let Claim::Found { tab, route, .. } = claim else {
            panic!("the default title carries it, {claim:?}");
        };
        assert_eq!(route, Route::DefaultTitle);
        assert_eq!(tab.window, 0x00ED_09BA);
    }

    #[test]
    fn no_tabs_and_no_others_are_both_answered_without_a_panic() {
        assert_eq!(resolve(&untitled("widgets-9f"), &[], &[]), Claim::Nothing);
        assert_eq!(resolve(&[], &[], &[]), Claim::Nothing);
        // One tab, nobody else, no key that matches: elimination has an answer and it is
        // the right one — there is nowhere else the session could be.
        let one = [tab(0x00ED_09BA, 0, 0, "PowerShell 7")];
        let claim = resolve(&untitled("widgets-9f"), &[], &one);
        assert!(
            matches!(
                claim,
                Claim::Found {
                    route: Route::Exclusion,
                    ..
                }
            ),
            "{claim:?}"
        );
    }

    #[test]
    fn the_no_ai_title_fallback_tries_the_derived_name_then_the_directory_and_stops() {
        // The order a session with no generated title falls through, which is what
        // happened on the machine: the slug matches nothing, the directory name matches
        // nothing, and the answer has to come from narrowing rather than from a key.
        let tabs = five_windows();
        let keys = untitled("widgets-9f");
        assert_eq!(keys[0].source, KeySource::DerivedName);
        assert_eq!(keys[1].source, KeySource::CwdBasename);
        assert!(
            pick_tab(&keys, &tabs).is_none(),
            "neither the slug nor the directory is on any terminal"
        );

        // Both weak keys refuse ambiguity, so neither can answer even if it did match
        // several — and the derived name is tried first either way.
        let named = [
            tab(0x0037_08DA, 0, 0, "◐ widgets-9f"),
            tab(0x00ED_09BA, 1, 0, "◐ acme-widgets"),
        ];
        let picked = pick_tab(&keys, &named).expect("the derived name is tried first");
        assert_eq!(picked.source, KeySource::DerivedName);
        assert_eq!(picked.tab.window, 0x0037_08DA);
    }

    #[test]
    fn the_choice_of_leftover_does_not_depend_on_enumeration_order() {
        let tabs = five_windows();
        let mut backwards = tabs.clone();
        backwards.reverse();
        let others = vec![
            titled("Repaint the harbour wall", "widgets-db"),
            titled("Move the pallet racking", "widgets-14"),
        ];
        let forward = resolve(&untitled("widgets-9f"), &others, &tabs);
        let reverse = resolve(&untitled("widgets-9f"), &others, &backwards);
        assert_eq!(forward, Claim::Ambiguous { remaining: 3 });
        assert_eq!(reverse, Claim::Ambiguous { remaining: 3 });
    }

    #[test]
    fn a_window_holding_two_tabs_keeps_the_unclaimed_one() {
        // Tab-level exclusion rather than window-level. Two sessions in one window: one
        // matched, and the other tab of that same window is still a candidate — striking
        // the whole window would throw away the only answer there is.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x0037_08DA, 0, 1, "✳ Claude Code"),
        ];
        let others = vec![titled("Repaint the harbour wall", "widgets-db")];
        let claim = resolve(&untitled("widgets-9f"), &others, &tabs);
        let Claim::Found { tab, route, .. } = claim else {
            panic!("the second tab of the same window, {claim:?}");
        };
        assert_eq!(route, Route::Exclusion);
        assert_eq!(tab.index, 1);
    }

    #[test]
    fn the_routes_are_named_the_same_way_everywhere() {
        assert_eq!(Route::Title.as_str(), "title");
        assert_eq!(Route::Exclusion.as_str(), "exclusion");
        assert_eq!(Route::DefaultTitle.as_str(), "defaultTitle");
        assert_eq!(Route::Title.rung(), "b");
        assert_eq!(Route::Exclusion.rung(), "b-exclusion");
        assert_eq!(Route::DefaultTitle.rung(), "b-default");
        assert!(Route::Exclusion.reason().contains("not owned by another"));
    }

    #[test]
    fn the_derived_registry_names_alone_would_have_found_nothing() {
        // Why the generated title had to be read: the name the session registry carries
        // for a session nobody renamed appears in no terminal title on earth.
        let tabs = [
            tab(0x0037_08DA, 0, 0, "◐ Repaint the harbour wall"),
            tab(0x0079_0B28, 1, 0, "◐ Move the pallet racking"),
        ];
        for derived in ["widgets-db", "widgets-32"] {
            assert!(
                pick_tab(&[TitleKey::new(KeySource::DerivedName, derived)], &tabs).is_none(),
                "{derived} must not match anything"
            );
        }
    }
}
