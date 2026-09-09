//! The shell's own settings: `%APPDATA%\nazar\desktop.json`.
//!
//! **Why `desktop.json` and not `config.json`.** The plan said `%APPDATA%\nazar\config.json`,
//! and that file already exists: it is nazar-tray's, and nazar-tray reads and writes it
//! (`nazar_core::paths::config_path`). The two products are siblings and share the
//! directory happily, but they must not share the document — an older sibling reading a
//! file the other one rewrote would lose the user's thresholds, quiet hours and language.
//! Same directory, different file, and the deviation is written up in `docs/PROJECT.md`
//! section 8.
//!
//! Everything else follows nazar-tray's settings pattern, and each rule is there for the
//! same reason it is there:
//!
//! * **Unknown fields survive.** A key a newer build wrote is read back and written out
//!   unchanged, so running an older shell once does not throw a setting away.
//! * **Atomic writes.** A temporary file beside the target, then a rename. A reader sees
//!   the old document or the new one, never half of either.
//! * **A missing file is not an error.** It means the defaults, and the defaults are what
//!   the shell does before anybody has chosen anything.
//! * **Reading never creates it.** A machine where nothing has been configured has no
//!   `desktop.json`, and that is a state worth being able to see.
//!
//! `NAZAR_HOME` moves the whole thing, exactly as it does for nazar-tray, which is what
//! makes the settings safe to exercise from a test on a real machine.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Settings version written by this build.
pub const SCHEMA_VERSION: u32 = 1;

/// Environment variable that moves the settings directory somewhere else.
pub const NAZAR_HOME_VAR: &str = "NAZAR_HOME";

/// The whole document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Settings version, so a future shape change can be recognised rather than guessed.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,

    /// Whether Windows should start Nazar at login.
    ///
    /// This is the user's *intent*. What Windows actually does is the registry entry the
    /// autostart plugin owns, and the registry wins when the two disagree: a user who
    /// removed the entry by hand has said something louder than this file has.
    #[serde(default)]
    pub autostart: bool,

    /// The loopback port the canvas was last served on (N-WP9).
    ///
    /// **Why this is stored at all.** The canvas keeps the user's workspace in the
    /// browser's `localStorage`: the arrangement (`nazar.layout.v1`), the tabs and
    /// projects (`nazar.tabs.v1`), the sticky notes (`nazar.notes.v1`), the card names
    /// (`nazar.names.v1`), the frame colours (`nazar.colours.v1`) and whether the usage
    /// panel is open (`nazar.usage.v1`). `localStorage` is keyed by **origin, and an
    /// origin includes the port** — so a shell that asked the operating system for a
    /// fresh ephemeral port on every launch was giving the webview a new origin on every
    /// launch, and the application forgot all six every time it started. Browser mode
    /// never had the bug, because `nazar` binds the fixed 4676 by default.
    ///
    /// **Why not simply use a fixed default here too.** Because the shell is not the only
    /// Nazar on the machine. `nazar --port` defaults to 4676, and a person running
    /// `npx @xfurqan0/nazar` in a terminal — which is the documented first line of the
    /// README and the way most people will ever meet this program — takes it. A shell
    /// hard-coded to the same number would fail to start whenever the browser copy was
    /// already running, and, worse, a shell that *bound it first* would make the terminal
    /// copy fail instead. An ephemeral port chosen once and then remembered has neither
    /// problem: it collides with nothing, and it is stable across launches, which is the
    /// only property `localStorage` cares about.
    ///
    /// **What a change of port costs the user, exactly once.** The workspace above is
    /// per-origin and is not migrated: if this number changes — the port was taken by
    /// something else while Nazar was closed, or the file was deleted — the canvas comes
    /// up with the default layout, no tabs, no notes and no card names. Nothing is
    /// destroyed; the old origin's store is still in the webview's profile and would
    /// reappear if that port were ever chosen again. It is a one-time loss of an
    /// arrangement, which is why the port is only abandoned when it genuinely cannot be
    /// used, and never merely because it is *busy*: a busy port serving a healthy Nazar
    /// of this same version is reused as a running server rather than replaced.
    ///
    /// Absent on a machine that has never started the shell, and written the first time
    /// the canvas comes up. `null` and a nonsensical value both read as absent.
    #[serde(
        default,
        deserialize_with = "lenient_port",
        skip_serializing_if = "Option::is_none"
    )]
    pub port: Option<u16>,

    /// N-WP15a: whether the canvas may show the task text at all.
    ///
    /// `"on"` — the default and the absent value — means *the browser decides*, and every
    /// browser decides "no" until somebody moves the switch in the settings panel. `"off"`
    /// is recording mode: the shell starts its child server with `--no-task-text`, so no
    /// browser talking to it can be shown a task line whatever its own switch says, and
    /// the readers in `@nazar/core` never take prose out of a transcript in the first
    /// place.
    ///
    /// **Why a string and not a `bool`.** Two reasons, and the second is the one that
    /// decided it. A boolean called `taskText` would have to be `false` for "off", and
    /// `#[serde(default)]` on a `bool` is `false` — so a file written by a build that
    /// predates this key, or a file with the key hand-deleted, would read as recording
    /// mode and quietly turn the feature off for a user who never asked. And the setting
    /// genuinely has room to grow a third state later ("on, and remember it per project",
    /// say) that a boolean would have to be replaced to express. An unrecognised value
    /// reads as the default, for the same reason [`lenient_port`] exists: one strange
    /// setting must not cost the user their autostart choice as well.
    #[serde(default = "default_task_text")]
    pub task_text: String,

    /// Everything this build did not recognise, kept so it survives a round trip.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The value that means "the browser decides", which is what an absent key means.
pub const TASK_TEXT_ON: &str = "on";

/// The value that means recording mode: the child server gets `--no-task-text`.
pub const TASK_TEXT_OFF: &str = "off";

fn default_task_text() -> String {
    TASK_TEXT_ON.to_owned()
}

const fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

/// Read the port without letting a bad value take the rest of the document with it.
///
/// The derived implementation refuses the whole file when one field does not fit its
/// type, and `Config::load` turns a refusal into the defaults — so a hand-edited `"port":
/// "4676"` would silently throw away the user's autostart choice as well. That trade is
/// wrong for a setting the application chose for itself: an unusable port costs one
/// arrangement, and it should cost nothing else. `null`, a string, a negative number and
/// anything past 65535 all read as "no port stored", which is the state a fresh machine
/// is in and which the caller already knows how to answer.
fn lenient_port<'de, D>(deserializer: D) -> Result<Option<u16>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    Ok(raw
        .as_ref()
        .and_then(Value::as_u64)
        .and_then(|number| u16::try_from(number).ok())
        // Port 0 means "ask the operating system", which is not something that can be
        // stored: the number it hands back is different every time.
        .filter(|port| *port > 0))
}

impl Default for Config {
    fn default() -> Self {
        Config {
            schema_version: SCHEMA_VERSION,
            autostart: false,
            port: None,
            task_text: default_task_text(),
            extra: Map::new(),
        }
    }
}

/// Where the settings live: `$NAZAR_HOME`, else `%APPDATA%\nazar` on Windows, else
/// `$XDG_CONFIG_HOME/nazar` or `~/.config/nazar`.
///
/// The same resolution order as nazar-tray's `settings_dir`, on purpose: two applications
/// that disagree about where a user's settings live are two applications one of which is
/// wrong.
///
/// **This is not the directory `packages/core/src/paths.ts` resolves, and the two are not
/// meant to agree.** nazar-tray keeps two roots and says so in its `docs/limits-contract.md`:
/// a *data* directory, `<home>/.nazar`, holding everything a consumer reads — `limits.json`,
/// `limits.lock`, `tray.request`, `statusline/` — and this *settings* directory, holding the
/// files that are the user's rather than a consumer's. `desktop.json` belongs here for the
/// same reason `config.json` does. `NAZAR_HOME` overrides both, which is why they move
/// together whenever it is set and differ whenever it is not.
#[must_use]
pub fn settings_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os(NAZAR_HOME_VAR).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(|value| PathBuf::from(value).join("nazar"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(xdg).join("nazar"));
    }
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(value).join(".config").join("nazar"))
}

/// `<settings dir>/desktop.json`.
#[must_use]
pub fn config_path() -> Option<PathBuf> {
    settings_dir().map(|dir| dir.join("desktop.json"))
}

impl Config {
    /// Read the settings, or the defaults.
    ///
    /// A missing file, an unreadable one and a malformed one all mean the defaults. A
    /// damaged settings file is not a reason to refuse to open a window — and refusing
    /// would leave the user with no way to fix it.
    #[must_use]
    pub fn load() -> Self {
        let Some(path) = config_path() else {
            return Config::default();
        };
        Config::read(&path).unwrap_or_default()
    }

    /// Read one file. Separated from [`Config::load`] so a test can name its own path.
    pub fn read(path: &std::path::Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str(&text).map_err(|error| error.to_string())
    }

    /// N-WP15a: may the canvas ask for task text on this machine?
    ///
    /// True unless the setting says exactly [`TASK_TEXT_OFF`]. Anything else — the
    /// default, a value from a newer build, a hand-edited typo — leaves the browser in
    /// charge, and the browser's own default is off. That direction is deliberate: the
    /// failure mode of guessing wrong here is a feature that is switched off in a
    /// browser and stays off, rather than a machine that silently stopped honouring a
    /// mode somebody turned on for a reason.
    #[must_use]
    pub fn task_text_allowed(&self) -> bool {
        self.task_text != TASK_TEXT_OFF
    }

    /// Turn recording mode on or off. Returns whether anything was written.
    pub fn set_task_text_allowed(&mut self, allowed: bool) -> Result<bool, String> {
        let wanted = if allowed { TASK_TEXT_ON } else { TASK_TEXT_OFF };
        if self.task_text == wanted {
            return Ok(false);
        }
        self.task_text = wanted.to_owned();
        self.save()?;
        Ok(true)
    }

    /// Record the port the canvas is being served on, if it is not already recorded.
    ///
    /// Returns whether anything was written. A launch that reused the stored port writes
    /// nothing at all, which is the ordinary case and keeps the file's modification time
    /// meaning "the user changed a setting" rather than "the application started".
    pub fn remember_port(&mut self, port: u16) -> Result<bool, String> {
        if self.port == Some(port) {
            return Ok(false);
        }
        self.port = Some(port);
        self.save()?;
        Ok(true)
    }

    /// Write the settings where [`config_path`] says, creating the directory if needed.
    pub fn save(&self) -> Result<(), String> {
        let path =
            config_path().ok_or_else(|| "no settings directory on this machine".to_owned())?;
        self.write(&path)
    }

    /// Write one file, atomically: temporary file beside the target, then a rename.
    pub fn write(&self, path: &std::path::Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;

        let text = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        // The temporary file is beside the target rather than in the system temporary
        // directory, because a rename across volumes is not atomic — and `%APPDATA%` and
        // `%TEMP%` are on different volumes more often than one would like.
        let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&temporary, format!("{text}\n")).map_err(|error| error.to_string())?;
        match std::fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = std::fs::remove_file(&temporary);
                Err(error.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory that removes itself, so the suite leaves nothing on the machine it
    /// ran on. Small enough not to be worth a dependency.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nazar-desktop-{}-{}-{name}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since| since.as_nanos())
                    .unwrap_or_default()
            ));
            std::fs::create_dir_all(&dir).expect("a scratch directory");
            Scratch(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("desktop.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_defaults_are_what_a_machine_with_no_file_gets() {
        let scratch = Scratch::new("absent");
        assert!(Config::read(&scratch.file()).is_err());
        assert!(
            !Config::default().autostart,
            "nothing starts itself uninvited"
        );
    }

    #[test]
    fn a_setting_survives_a_round_trip() {
        let scratch = Scratch::new("round-trip");
        let config = Config {
            autostart: true,
            ..Config::default()
        };
        config.write(&scratch.file()).expect("written");

        let read = Config::read(&scratch.file()).expect("read back");
        assert_eq!(read, config);
    }

    #[test]
    fn a_key_this_build_does_not_know_is_written_back_unchanged() {
        let scratch = Scratch::new("unknown-keys");
        std::fs::write(
            scratch.file(),
            r#"{"schemaVersion":1,"autostart":true,"somethingNewer":{"a":1}}"#,
        )
        .expect("seeded");

        let read = Config::read(&scratch.file()).expect("read");
        assert!(read.autostart);
        read.write(&scratch.file()).expect("written");

        let text = std::fs::read_to_string(scratch.file()).expect("re-read");
        assert!(
            text.contains("somethingNewer"),
            "an older build must not eat a newer build's settings; got {text}"
        );
    }

    #[test]
    fn a_damaged_file_reads_as_an_error_rather_than_a_panic() {
        let scratch = Scratch::new("damaged");
        std::fs::write(scratch.file(), "{ not json").expect("seeded");
        assert!(Config::read(&scratch.file()).is_err());
    }

    #[test]
    fn writing_leaves_no_temporary_file_behind() {
        let scratch = Scratch::new("atomic");
        Config::default().write(&scratch.file()).expect("written");
        let leftovers: Vec<_> = std::fs::read_dir(&scratch.0)
            .expect("listed")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left behind {leftovers:?}");
    }

    /* ---- N-WP9: the port -------------------------------------------- */

    #[test]
    fn a_machine_that_has_never_started_the_shell_has_no_port_and_writes_none() {
        let scratch = Scratch::new("port-absent");
        let config = Config::default();
        assert_eq!(
            config.port, None,
            "nothing is chosen before the first launch"
        );

        config.write(&scratch.file()).expect("written");
        let text = std::fs::read_to_string(scratch.file()).expect("re-read");
        assert!(
            !text.contains("port"),
            "an absent port is an absent key, not a null: {text}"
        );

        let read = Config::read(&scratch.file()).expect("read back");
        assert_eq!(read.port, None);
    }

    #[test]
    fn the_port_survives_a_round_trip_because_the_whole_workspace_depends_on_it() {
        // `localStorage` is keyed by origin, and an origin includes the port. This
        // number *is* the layout, the tabs, the notes and the card names.
        let scratch = Scratch::new("port-round-trip");
        let config = Config {
            port: Some(49_732),
            ..Config::default()
        };
        config.write(&scratch.file()).expect("written");

        let read = Config::read(&scratch.file()).expect("read back");
        assert_eq!(read, config);
        assert_eq!(read.port, Some(49_732));
    }

    #[test]
    fn a_port_and_a_key_this_build_does_not_know_survive_each_other() {
        let scratch = Scratch::new("port-unknown-keys");
        std::fs::write(
            scratch.file(),
            r#"{"schemaVersion":1,"autostart":false,"port":49732,"somethingNewer":{"a":1}}"#,
        )
        .expect("seeded");

        let read = Config::read(&scratch.file()).expect("read");
        assert_eq!(read.port, Some(49_732));
        assert!(
            !read.extra.contains_key("port"),
            "a key this build knows is not an unknown one"
        );
        read.write(&scratch.file()).expect("written");

        let text = std::fs::read_to_string(scratch.file()).expect("re-read");
        assert!(text.contains("somethingNewer"), "{text}");
        assert!(text.contains("49732"), "{text}");
    }

    #[test]
    fn a_port_that_is_not_a_port_reads_as_no_port_rather_than_a_refusal() {
        // A hand-edited file, or one from a build that meant something else by the key.
        // A damaged setting must not cost the user their autostart choice as well, which
        // is exactly what the derived implementation would have done: one bad field, and
        // the whole document falls back to the defaults.
        let scratch = Scratch::new("port-nonsense");
        for body in [
            r#"{"autostart":true,"port":null}"#,
            r#"{"autostart":true,"port":"4676"}"#,
            r#"{"autostart":true,"port":70000}"#,
            r#"{"autostart":true,"port":-1}"#,
            r#"{"autostart":true,"port":0}"#,
        ] {
            std::fs::write(scratch.file(), body).expect("seeded");
            let read = Config::read(&scratch.file()).expect("the document still parses");
            assert_eq!(read.port, None, "{body}");
            assert!(read.autostart, "the other settings survive it: {body}");
        }
    }

    #[test]
    fn remembering_the_same_port_twice_writes_nothing_the_second_time() {
        let scratch = Scratch::new("port-remember");
        let mut config = Config::default();

        // `remember_port` writes through `save`, which resolves its own path from the
        // environment, so the test drives `write` directly and checks the decision.
        assert_eq!(config.port, None);
        config.port = Some(49_732);
        config.write(&scratch.file()).expect("written");

        let mut again = Config::read(&scratch.file()).expect("read back");
        assert!(
            !again.remember_port(49_732).expect("no write needed"),
            "a launch that reused its port changes nothing on disk"
        );
        assert_eq!(again.port, Some(49_732));
    }

    /* ---- N-WP15a: recording mode ------------------------------------ */

    #[test]
    fn a_fresh_machine_leaves_the_task_text_setting_to_the_browser() {
        let config = Config::default();
        assert_eq!(config.task_text, TASK_TEXT_ON);
        assert!(
            config.task_text_allowed(),
            "the default is 'the browser decides', and every browser decides no"
        );
    }

    #[test]
    fn a_file_written_before_this_key_existed_does_not_read_as_recording_mode() {
        // The whole reason the setting is a string. A `bool` would default to
        // `false`, and every machine upgrading from an older build would come
        // up with the feature silently hard-disabled and no way to see why.
        let scratch = Scratch::new("task-text-absent");
        std::fs::write(scratch.file(), r#"{"schemaVersion":1,"autostart":true}"#).expect("seeded");
        let read = Config::read(&scratch.file()).expect("read");
        assert!(read.task_text_allowed());
        assert!(read.autostart, "the rest of the document survives it");
    }

    #[test]
    fn recording_mode_survives_a_round_trip_and_a_value_nobody_knows_does_not_break_it() {
        let scratch = Scratch::new("task-text-round-trip");
        let config = Config {
            task_text: TASK_TEXT_OFF.to_owned(),
            ..Config::default()
        };
        config.write(&scratch.file()).expect("written");
        let read = Config::read(&scratch.file()).expect("read back");
        assert_eq!(read, config);
        assert!(!read.task_text_allowed());

        // A value from a newer build, or a typo. It must not be read as "off":
        // the safe direction is the one that leaves the browser in charge, and
        // the browser is off by default anyway.
        std::fs::write(scratch.file(), r#"{"taskText":"per-project"}"#).expect("seeded");
        let odd = Config::read(&scratch.file()).expect("still parses");
        assert!(odd.task_text_allowed());
    }

    #[test]
    fn setting_the_mode_to_what_it_already_is_writes_nothing() {
        let mut config = Config::default();
        assert!(config.task_text_allowed());
        // `set_task_text_allowed` writes through `save`, which resolves its own
        // path from the environment, so the no-op branch is what is asserted
        // here — the same shape as `remember_port` above.
        assert!(
            !config.set_task_text_allowed(true).expect("no write needed"),
            "a switch moved to where it already was changes nothing on disk"
        );
    }

    /// The collision this module exists to avoid, asserted rather than described.
    #[test]
    fn the_file_is_not_the_one_nazar_tray_owns() {
        let path = config_path();
        if let Some(path) = path {
            assert_eq!(
                path.file_name().and_then(|name| name.to_str()),
                Some("desktop.json"),
                "config.json in this directory belongs to nazar-tray"
            );
        }
    }
}
