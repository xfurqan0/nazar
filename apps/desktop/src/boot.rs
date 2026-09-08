//! What the window says before the canvas is there, and when it never will be.
//!
//! One value, one event. The boot thread replaces [`BootState`] as it goes; every
//! replacement is emitted as `boot-state`, and the page can also ask for the current one
//! with the `boot_state` command because it may have loaded after the answer was known.
//!
//! The phases are strings rather than a Rust enum with a serde tag because the page keys a
//! lookup table on them, and a string that arrives without a translation shows itself
//! instead of showing nothing.

use serde::Serialize;

/// Everything the boot page paints.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootState {
    /// `checking-node`, `starting-server`, `ready`, `node-missing`, `node-too-old`,
    /// `node-unreadable` or `server-failed`.
    pub phase: &'static str,
    /// A sentence under the headline. Empty when there is nothing to add.
    pub detail: String,
    /// `nazar doctor` output, when it could be produced. Empty otherwise.
    pub doctor: String,
    /// The shell's version, shown in the footer.
    pub version: String,
    /// The canvas URL, once there is one.
    pub url: String,
}

/// Phase constants, so a typo is a compile error rather than a blank headline.
pub mod phase {
    /// Running `node --version`.
    pub const CHECKING_NODE: &str = "checking-node";
    /// Waiting for the child server to bind and answer.
    pub const STARTING_SERVER: &str = "starting-server";
    /// The canvas is up; the webview is on its way there.
    pub const READY: &str = "ready";
    /// `node` could not be run at all.
    pub const NODE_MISSING: &str = "node-missing";
    /// `node` ran and is older than the packaged server needs.
    pub const NODE_TOO_OLD: &str = "node-too-old";
    /// `node` ran but printed no version.
    pub const NODE_UNREADABLE: &str = "node-unreadable";
    /// Node was fine and the server still did not come up.
    pub const SERVER_FAILED: &str = "server-failed";
}

impl BootState {
    /// The state a window opens in.
    #[must_use]
    pub fn starting(version: &str) -> Self {
        BootState {
            phase: phase::CHECKING_NODE,
            detail: String::new(),
            doctor: String::new(),
            version: version.to_owned(),
            url: String::new(),
        }
    }

    /// The same state in a later phase, with a new sentence.
    #[must_use]
    pub fn moved_to(&self, phase: &'static str, detail: impl Into<String>) -> Self {
        BootState {
            phase,
            detail: detail.into(),
            doctor: self.doctor.clone(),
            version: self.version.clone(),
            url: self.url.clone(),
        }
    }

    /// The same state with `nazar doctor` attached.
    #[must_use]
    pub fn with_doctor(mut self, report: Option<String>) -> Self {
        self.doctor = report.unwrap_or_default();
        self
    }

    /// The same state with the canvas URL attached.
    #[must_use]
    pub fn with_url(mut self, url: &str) -> Self {
        self.url = url.to_owned();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_change_keeps_what_was_already_known() {
        let start = BootState::starting("0.1.0")
            .with_doctor(Some("two sessions".to_owned()))
            .with_url("http://127.0.0.1:4676");
        let later = start.moved_to(phase::SERVER_FAILED, "it did not bind");

        assert_eq!(later.phase, phase::SERVER_FAILED);
        assert_eq!(later.detail, "it did not bind");
        assert_eq!(
            later.doctor, "two sessions",
            "the report is not lost by a phase change"
        );
        assert_eq!(later.version, "0.1.0");
        assert_eq!(later.url, "http://127.0.0.1:4676");
    }

    #[test]
    fn the_page_and_the_shell_agree_on_every_phase_name() {
        // The page keys its headline table on these. A phase the page has never heard of
        // shows its own name, which is survivable — but a phase renamed on one side only
        // is a regression nobody would notice, so it is checked here.
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("shell")
                .join("boot.js"),
        )
        .expect("the boot page sits beside this crate");

        for name in [
            phase::CHECKING_NODE,
            phase::STARTING_SERVER,
            phase::READY,
            phase::NODE_MISSING,
            phase::NODE_TOO_OLD,
            phase::NODE_UNREADABLE,
            phase::SERVER_FAILED,
        ] {
            assert!(
                script.contains(name),
                "boot.js has no headline for the {name} phase"
            );
        }
    }

    #[test]
    fn the_serialised_shape_is_the_one_the_page_reads() {
        let json = serde_json::to_string(&BootState::starting("0.1.0")).expect("serialises");
        for key in ["phase", "detail", "doctor", "version", "url"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "{key} is missing from {json}"
            );
        }
    }
}
