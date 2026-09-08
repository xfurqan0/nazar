//! N-WP13: the few strings the shell draws, out of the same files the canvas reads.
//!
//! The tray menu and its tooltip are the only text this application puts on screen
//! outside the webview, and the rule the canvas keeps — *every visible string comes from
//! a locale file* — has no exception for them. So `packages/ui/locales/<lang>.json` is
//! compiled in with `include_str!` and looked up with the same `{placeholder}` rule
//! `packages/ui/src/i18n.ts` uses, in about sixty lines. The shape is nazar-tray's
//! `crates/nazar-tray/src/i18n.rs`, adapted.
//!
//! **The shell does not know what the canvas chose, and does not ask.** The canvas keeps
//! its language in `localStorage`, which belongs to the page; the tray menu is drawn
//! before any page exists and by a process that has no access to it. So the shell
//! resolves the *system* UI language and uses that ([`resolve`]). The two can therefore
//! disagree — a Turkish machine whose canvas has been switched to English gets an English
//! canvas under a Turkish tray — and that is the honest trade for not inventing an IPC
//! call and a settings file to carry one enum. `docs/PROJECT.md` §7 records it.
//!
//! **Every value in a locale file must be a string, and the price of forgetting is
//! silence.** [`parse`] asks serde for a `BTreeMap<String, String>`; a file with one
//! nested object in it does not parse, becomes an empty catalogue, and that language
//! quietly falls back to English. It is the right failure — a damaged translation must
//! not stop the shell from starting — but it is an invisible one, which is why
//! `packages/ui/test/i18n.test.ts` fails on a non-string value.

use std::collections::BTreeMap;

/// English, the fallback for every missing string.
const EN: &str = include_str!("../../../packages/ui/locales/en.json");
/// Turkish, written by hand alongside English.
const TR: &str = include_str!("../../../packages/ui/locales/tr.json");
/// The four that were machine-translated first; corrections arrive by pull request.
const ZH: &str = include_str!("../../../packages/ui/locales/zh.json");
const KO: &str = include_str!("../../../packages/ui/locales/ko.json");
const RU: &str = include_str!("../../../packages/ui/locales/ru.json");
const ES: &str = include_str!("../../../packages/ui/locales/es.json");

/// Every language this build can paint itself in, in the order the canvas lists them.
pub const LOCALES: [&str; 6] = ["en", "tr", "zh", "ko", "ru", "es"];

/// A catalogue bound to one language, with English behind it.
#[derive(Debug)]
pub struct Catalog {
    messages: BTreeMap<String, String>,
    fallback: BTreeMap<String, String>,
}

/// Parse one catalogue. A file that does not parse is an empty catalogue, never a panic.
fn parse(text: &str) -> BTreeMap<String, String> {
    serde_json::from_str(text).unwrap_or_default()
}

/// The primary subtag of a language tag: `tr-TR` and `TR_tr` both become `tr`.
#[must_use]
pub fn primary_subtag(locale: &str) -> String {
    locale
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// The source text of a catalogue this build carries, or `None`.
fn source(primary: &str) -> Option<&'static str> {
    match primary {
        "en" => Some(EN),
        "tr" => Some(TR),
        "zh" => Some(ZH),
        "ko" => Some(KO),
        "ru" => Some(RU),
        "es" => Some(ES),
        _ => None,
    }
}

/// The catalogue for a language tag such as `tr`, `tr-TR` or `en-GB`.
#[must_use]
pub fn catalog(locale: &str) -> Catalog {
    let primary = primary_subtag(locale);
    let messages = match primary.as_str() {
        // English is the fallback; loading it twice would only double the memory.
        "en" => BTreeMap::new(),
        other => source(other).map(parse).unwrap_or_default(),
    };
    Catalog {
        messages,
        fallback: parse(EN),
    }
}

/// The language the shell paints itself in: the machine's, then English.
///
/// A tag no catalogue answers for falls through rather than being selected, so a machine
/// set to German gets an English tray instead of one full of message keys.
#[must_use]
pub fn resolve(system: Option<&str>) -> String {
    if let Some(tag) = system {
        let primary = primary_subtag(tag);
        if LOCALES.contains(&primary.as_str()) {
            return primary;
        }
    }
    "en".to_owned()
}

impl Catalog {
    /// The message for a key, with the placeholders filled in.
    ///
    /// Lookup order is the chosen language, then English, then the key itself — an
    /// untranslated string shows up as `tray.quit` in the menu instead of as a gap.
    #[must_use]
    pub fn format(&self, key: &str, params: &[(&str, &str)]) -> String {
        let template = self
            .messages
            .get(key)
            .or_else(|| self.fallback.get(key))
            .map_or(key, String::as_str);
        interpolate(template, params)
    }

    /// The message for a key that has no placeholders.
    #[must_use]
    pub fn text(&self, key: &str) -> String {
        self.format(key, &[])
    }

    /// Every key English defines. Used by the parity tests.
    #[cfg(test)]
    #[must_use]
    pub fn keys(&self) -> Vec<&str> {
        self.fallback.keys().map(String::as_str).collect()
    }

    /// Whether the chosen language defines a key of its own.
    #[cfg(test)]
    #[must_use]
    pub fn translates(&self, key: &str) -> bool {
        self.messages.contains_key(key)
    }
}

/// Replace `{name}` with the value given for `name`.
///
/// A placeholder with no value is left as written rather than blanked, so a missing value
/// reads as `{percent}` instead of disappearing — the same rule as `src/i18n.ts`.
#[must_use]
fn interpolate(template: &str, params: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(end) = rest[start..].find('}').map(|at| start + at) else {
            break;
        };
        let name = &rest[start + 1..end];
        out.push_str(&rest[..start]);
        match params.iter().find(|(key, _)| *key == name) {
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&rest[start..=end]),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The operating system's UI language, as a tag, or `None`.
///
/// Windows answers through `GetUserDefaultLocaleName`; everywhere else the POSIX
/// environment is the convention and is what every other tool on the machine reads.
/// `C` and `POSIX` mean *no preference* rather than a language, so they fall through.
#[must_use]
pub fn system_language() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(tag) = windows_ui_language() {
            return Some(tag);
        }
    }
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(name) else {
            continue;
        };
        let tag = value.split('.').next().unwrap_or_default();
        if tag.is_empty() || tag == "C" || tag == "POSIX" {
            continue;
        }
        return Some(tag.to_owned());
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_ui_language() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    // The documented maximum is 85 UTF-16 code units including the terminator.
    let mut buffer = [0u16; 85];
    // SAFETY: the wrapper hands the slice and its length over together, and the call
    // writes at most that many units into it.
    let written = unsafe { GetUserDefaultLocaleName(&mut buffer) };
    if written <= 1 {
        return None;
    }
    // The count includes the terminating null.
    String::from_utf16(&buffer[..(written as usize - 1)]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_placeholder_is_filled_and_an_unknown_one_is_left_alone() {
        assert_eq!(
            interpolate("{a} and {b}", &[("a", "1"), ("b", "2")]),
            "1 and 2"
        );
        assert_eq!(
            interpolate("{a} and {b}", &[("a", "1")]),
            "1 and {b}",
            "a missing value must be visible, not silently blank"
        );
        assert_eq!(interpolate("nothing to fill", &[]), "nothing to fill");
        assert_eq!(interpolate("{unclosed", &[]), "{unclosed");
    }

    #[test]
    fn each_language_answers_for_itself_and_falls_back_to_english() {
        assert_eq!(catalog("en").text("tray.quit"), "Quit");
        assert_eq!(catalog("tr-TR").text("tray.quit"), "Çık");
        assert_eq!(catalog("zh-CN").text("tray.quit"), "退出");
        assert_eq!(catalog("ko").text("tray.quit"), "종료");
        assert_eq!(catalog("ru").text("tray.quit"), "Выйти");
        assert_eq!(catalog("es-MX").text("tray.quit"), "Salir");
        assert_eq!(
            catalog("de-DE").text("tray.quit"),
            "Quit",
            "a language nobody has translated gets English, not message keys"
        );
    }

    #[test]
    fn a_key_nobody_wrote_shows_as_the_key() {
        assert_eq!(catalog("en").text("nothing.like.this"), "nothing.like.this");
    }

    #[test]
    fn every_english_key_is_translated_into_every_other_language() {
        for locale in LOCALES {
            if locale == "en" {
                continue;
            }
            let catalog = catalog(locale);
            let missing: Vec<&str> = catalog
                .keys()
                .into_iter()
                .filter(|key| !catalog.translates(key))
                .collect();
            assert!(
                missing.is_empty(),
                "{locale} is behind English on {} keys: {missing:?}",
                missing.len()
            );
        }
    }

    #[test]
    fn every_key_the_shell_draws_exists_in_all_six() {
        // Read out of this crate's own sources, so a new `catalog.text(…)` is covered
        // the moment it is written rather than the next time somebody remembers.
        let source_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut keys: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&source_dir).expect("the crate has a src directory") {
            let path = entry.expect("a readable entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mut rest = text.as_str();
            while let Some(at) = rest.find(".text(\"") {
                rest = &rest[at + 7..];
                if let Some(end) = rest.find('"') {
                    keys.push(rest[..end].to_owned());
                }
            }
        }
        keys.retain(|key| key != "nothing.like.this");
        keys.sort();
        keys.dedup();
        assert!(
            keys.len() >= 4,
            "the scan found only {} keys, so it has stopped working: {keys:?}",
            keys.len()
        );
        for locale in LOCALES {
            let catalog = catalog(locale);
            for key in &keys {
                assert!(
                    locale == "en" || catalog.translates(key),
                    "{locale} does not translate {key}, which the shell draws"
                );
            }
        }
    }

    #[test]
    fn the_language_is_the_machines_and_then_english() {
        assert_eq!(resolve(Some("tr-TR")), "tr");
        assert_eq!(resolve(Some("TR_tr")), "tr", "tags are normalised");
        assert_eq!(resolve(None), "en", "English is the floor");
        assert_eq!(
            resolve(Some("de-DE")),
            "en",
            "an English tray beats a tray full of message keys"
        );
        for locale in LOCALES {
            assert_eq!(resolve(Some(locale)), locale);
        }
    }
}
