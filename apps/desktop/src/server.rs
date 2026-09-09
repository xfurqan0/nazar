//! The child server: the package npm publishes, started by the shell.
//!
//! **Why a child process and not an embedded canvas.** The alternative — bundling
//! `dist/web` as the Tauri frontend and reimplementing the readers in Rust — would give
//! two canvases to keep in step and two answers to every question about what Nazar can
//! see. Browser mode is first-class and stays first-class; the shell is a window around
//! it. So the shell ships the *published layout* as a resource, starts it exactly as a
//! terminal would, and navigates its webview at the URL that comes back.
//!
//! ```text
//!   nazar-desktop.exe
//!     └─ node <resources>/server/bin/nazar.mjs --no-open --port <free>
//!            listening on 127.0.0.1:<free>                 ← the webview goes here
//! ```
//!
//! `bin/nazar.mjs` and not `dist/nazar.mjs`, and the difference is not cosmetic:
//! [`resolve_entry`] has the whole story.
//!
//! **Finding the port.** The CLI's `--port` refuses `0` — `packages/server/test/cli.test.ts`
//! pins that, and a published contract is not worth bending for a caller — so the shell
//! picks the number itself by binding an ephemeral port, reading it, and letting it go.
//! There is a window between the release and the child's own bind in which something else
//! could take it; [`ATTEMPTS`] is the answer, and the child announcing its URL on stdout
//! is how the race is detected rather than assumed.
//!
//! **Keeping the port (N-WP9).** Picking a fresh ephemeral port on *every* launch was a
//! bug with an invisible cause: `localStorage` is keyed by origin, an origin includes the
//! port, and so the desktop application forgot the user's layout, tabs, projects, notes,
//! names and colours every time it started. The number is now stored in `desktop.json`
//! (`config::Config::port`, whose doc comment argues the case in full, including why a
//! fixed default would be worse) and [`plan_port`] decides what to do with it:
//!
//! ```text
//!   no stored port           → ask the OS for one, and store it        (Plan::Bind)
//!   stored, and free         → bind it again; the workspace comes back (Plan::Bind)
//!   stored, and a healthy    → show the server that is already there   (Plan::Adopt)
//!     Nazar of this version
//!   stored, and anything     → ask the OS for another one, and store   (fresh Plan::Bind)
//!     else holds it
//! ```
//!
//! The third rung is the one worth explaining. A stored port being busy is *usually* this
//! same shell's own server, still running from a launch whose window was closed to the
//! tray, or a second instance racing the first. Starting a second server on a new port
//! would work and would cost the user their arrangement for no reason, so the shell asks
//! the port what it is: a `GET /api/state` that answers `200` with an
//! `X-Nazar-Version` header equal to this build's is a Nazar it can simply show.
//! **A server this shell adopted is never killed on Quit** — it belongs to whoever started
//! it, which may be a terminal running `nazar --port`.
//!
//! Versions must match exactly. A different version is a different canvas, a different
//! wire shape and possibly a different `localStorage` migration, and pointing this
//! build's webview at it would be showing the user another program.
//!
//! **Knowing it is up.** Two signals, and both are required. The `canvas: <url>` line is
//! printed by `serve()` only after the listener is bound, so it says the port is real;
//! `GET /api/state` answering says the application behind it is assembled. Waiting for
//! only the first would navigate the webview at a socket that is not yet serving.
//!
//! **Not leaving it behind.** [`ServerHandle::stop`] kills the child on Quit, and on
//! Windows the child is also assigned to a job object marked kill-on-close, so a shell
//! that is itself killed — Task Manager, a crash, a debugger detaching — takes its server
//! with it instead of leaving a listener on a port nobody remembers.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::node;

/// How many ports the shell will try before giving up.
pub const ATTEMPTS: usize = 4;

/// How long one attempt has to print its URL before it is treated as failed.
pub const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(25);

/// How long `/api/state` has to answer once the URL is known.
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Environment variable that points the shell at a bundle of the caller's choosing.
///
/// It is what the live check on a development machine uses, so a shell can be driven
/// against a freshly built `dist/` without packaging an installer first.
pub const ENTRY_VAR: &str = "NAZAR_SERVER_ENTRY";

/// How many lines of the child's output are kept for the failure message.
const LOG_LINES: usize = 40;

/// The header the server answers with, so a caller can tell which build it is.
///
/// Set by `baseHeaders()` in `packages/server/src/http.ts`; the constant is spelled here
/// rather than shared, because the two halves of this repository are two languages and a
/// four-word string is a smaller seam than a generated one.
pub const VERSION_HEADER: &str = "x-nazar-version";

/// The version this shell expects a server it adopts to report.
///
/// The Cargo workspace version and the npm package version are one number, set together
/// by step 1 of `docs/RELEASE.md`. That is a convention rather than a mechanism, and the
/// failure it can produce is benign: a mismatch makes the shell start its own server on a
/// new port, which costs an arrangement and nothing else.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A running server the shell is showing.
pub struct ServerHandle {
    /// The canvas URL, exactly as the child printed it.
    pub url: String,
    /// The port it bound.
    pub port: u16,
    /// True when this server was already running and the shell only found it.
    pub adopted: bool,
    /// The child, when this shell started one. `None` for an adopted server.
    child: Option<Child>,
    #[cfg(windows)]
    _job: Option<JobObject>,
}

impl ServerHandle {
    /// Stop the child, if this shell started one.
    ///
    /// `kill` is `TerminateProcess` on Windows, and that is clean here in the only sense
    /// that matters: the server holds no file it is part-way through writing, because
    /// Nazar writes nothing at all — `test/no-writes.test.ts` is the static gate that
    /// says so. What it holds is a listener and some open transcript handles, and the
    /// kernel closes both.
    ///
    /// **An adopted server is left alone.** It was running before this shell started and
    /// it belongs to whoever started it — another instance, or a terminal running
    /// `nazar --port`. Quitting a window must not end somebody else's process.
    pub fn stop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Where the packaged entry point is, in the three layouts that have to work.
///
/// **It is `bin/nazar.mjs`, not `dist/nazar.mjs`.** The bundle is a module that exports
/// `main`; running it directly loads declarations and exits, printing nothing, which is a
/// failure with no error in it and cost an afternoon the first time. `bin/nazar.mjs` is
/// what npm puts on `PATH` and what `npx` runs, and it is what the shell runs too.
///
/// 1. [`ENTRY_VAR`], which is how a development run points at a rebuilt package.
/// 2. The installed layout: `resources/server/bin/nazar.mjs` beside the executable, which
///    is what the NSIS installer lays down and what `scripts/build-desktop.mjs` stages.
/// 3. A debug build's repository, two directories above the crate. Compiled out of
///    release builds entirely, so no shipped binary carries a path from the machine it
///    was built on.
#[must_use]
pub fn resolve_entry(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os(ENTRY_VAR).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(dir) = resource_dir {
        let packaged = dir
            .join("resources")
            .join("server")
            .join("bin")
            .join("nazar.mjs");
        if packaged.is_file() {
            return Some(packaged);
        }
    }

    #[cfg(debug_assertions)]
    {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("bin")
            .join("nazar.mjs");
        if repo.is_file() {
            return Some(repo);
        }
    }

    None
}

/// Strip Windows' `\\?\` verbatim prefix from a path, when it has one.
///
/// **This is not cosmetic.** `PathResolver::resource_dir()` can hand back a canonicalised
/// path, and canonicalising on Windows produces the verbatim form. It is a perfectly good
/// path as far as the Win32 API is concerned, so the file is found and `is_file()` says
/// yes — and then Node's own `path` module parses `\\?\C:\...` as a UNC share, resolves
/// the main module to something that is not a file, and exits with
/// `EISDIR: illegal operation on a directory, lstat 'C:'`. A correct path, a real file,
/// and an error message that names neither: it cost an afternoon, so the fix is here with
/// the reason attached rather than in a commit message nobody will read again.
///
/// `\\?\UNC\server\share` becomes `\\server\share`; anything else is returned unchanged.
#[must_use]
pub fn simplify(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        // Only a drive-letter path is safe to unwrap: the verbatim form also exists to
        // express paths the normal form cannot, and shortening one of those would break it.
        Some(rest)
            if rest.len() >= 2
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && rest.as_bytes()[1] == b':' =>
        {
            PathBuf::from(rest)
        }
        _ => path.to_path_buf(),
    }
}

/// Ask the operating system for a port nobody is using, then let it go.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

/// Whether a port can be bound right now. A `false` says only that it is busy.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// What to do about the port stored in `desktop.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Start a server on this port.
    Bind(u16),
    /// A healthy Nazar of this version is already on it. Show that one.
    Adopt(u16),
}

/// Decide what the stored port is good for, without starting anything.
///
/// `None` means "this number is no use; ask the operating system for another one" — the
/// caller does that rather than this function, so a test can drive the decision without a
/// machine that has spare ports. See the module note for the four cases and the reasoning.
#[must_use]
pub fn plan_port(stored: Option<u16>, version: &str) -> Option<Plan> {
    let port = stored.filter(|port| *port > 0)?;

    if port_is_free(port) {
        return Some(Plan::Bind(port));
    }

    // Busy. The interesting question is whether it is busy with *us*.
    match probe(port, "/api/state") {
        Ok(answer) if answer.version.as_deref() == Some(version) => Some(Plan::Adopt(port)),
        // Something else on this machine — another program, or a Nazar of a version whose
        // canvas is not this build's. Either way the number cannot be kept, and the user
        // pays for it once, in a lost arrangement.
        _ => None,
    }
}

/// Start the server, waiting until its canvas is actually serving.
///
/// `stored` is the port from `desktop.json`, and the returned handle's `port` is the one
/// the caller should store back. A launch that reuses its port writes nothing.
pub fn start(entry: &Path, stored: Option<u16>, task_text: bool) -> Result<ServerHandle, String> {
    let entry = simplify(entry);
    // The plan is used once. If the stored port fails to start a server, every later
    // attempt asks the operating system for a number nobody has, because retrying a port
    // that just refused is retrying the same failure.
    let mut planned = plan_port(stored, VERSION);
    let mut last = String::new();

    for attempt in 1..=ATTEMPTS {
        let port = match planned.take() {
            // N-WP15a. A server this shell did not start was started by
            // somebody else, on somebody else's command line, and there is no
            // way to ask it whether it was started with `--no-task-text`.
            // Adopting one while recording mode is on would mean showing a
            // canvas that could hand out task text under a switch that
            // promises it cannot. So in recording mode the shell never adopts:
            // it starts a server it knows the flags of. The cost is one
            // ephemeral port and therefore, once, the browser-stored
            // arrangement — which is the right way round, because the mode
            // exists for the moment a screen is being shared.
            Some(Plan::Adopt(port)) if task_text => match adopt(port) {
                Ok(handle) => return Ok(handle),
                Err(error) => {
                    // It answered a moment ago and does not now. Fall through to starting
                    // one of our own rather than reporting somebody else's shutdown.
                    last = format!("attempt {attempt} of {ATTEMPTS} adopting port {port}: {error}");
                    continue;
                }
            },
            Some(Plan::Adopt(_)) => match free_port() {
                Ok(port) => port,
                Err(error) => {
                    last = format!("attempt {attempt} of {ATTEMPTS}: no free port ({error})");
                    continue;
                }
            },
            Some(Plan::Bind(port)) => port,
            None => match free_port() {
                Ok(port) => port,
                Err(error) => {
                    last = format!("attempt {attempt} of {ATTEMPTS}: no free port ({error})");
                    continue;
                }
            },
        };

        match attempt_start(&entry, port, task_text) {
            Ok(handle) => return Ok(handle),
            Err(error) => {
                // The path is in every failure line, because a server that will not start
                // is nearly always a server looked for in the wrong place, and the boot
                // page is the only screen the user gets.
                last = format!(
                    "attempt {attempt} of {ATTEMPTS} starting {} on port {port}: {error}",
                    entry.display()
                );
            }
        }
    }
    Err(last)
}

/// Take over a server that is already running, without starting anything.
fn adopt(port: u16) -> Result<ServerHandle, String> {
    wait_until_serving(port)?;
    Ok(ServerHandle {
        // The child prints a trailing slash and so does this: the webview is told the
        // same address either way, and an origin is an origin.
        url: format!("http://127.0.0.1:{port}/"),
        port,
        adopted: true,
        child: None,
        #[cfg(windows)]
        _job: None,
    })
}

fn attempt_start(entry: &Path, port: u16, task_text: bool) -> Result<ServerHandle, String> {
    let mut command = node::command("node");
    command
        .arg(entry)
        .arg("--no-open")
        .arg("--port")
        .arg(port.to_string());
    // N-WP15a. Recording mode is passed to the child as the CLI flag rather
    // than as a setting the server would have to read for itself: the flag is
    // already the documented way to say this, `desktop.json` is the shell's
    // file and not the server's, and a flag on the command line is something a
    // user can see in Task Manager. Turning the mode on is therefore a server
    // restart, which is exactly what makes the guarantee real — the readers
    // come back up unable to take text out of a transcript at all.
    if !task_text {
        command.arg("--no-task-text");
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start node: {error}"))?;

    #[cfg(windows)]
    let job = JobObject::confine(&child)?;

    let log = Arc::new(Mutex::new(Vec::new()));
    let (announced, urls) = channel::<String>();

    // stdout carries the URL and has to be drained anyway: a pipe nobody reads fills up,
    // and a child blocked writing to a full pipe is a child that has stopped serving.
    if let Some(stdout) = child.stdout.take() {
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(url) = line.strip_prefix("canvas: ") {
                    let _ = announced.send(url.trim().to_owned());
                }
                remember(&log, line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                remember(&log, line);
            }
        });
    }

    let url = match wait_for_url(&urls, &mut child) {
        Ok(url) => url,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(with_log(&error, &log));
        }
    };

    if let Err(error) = wait_until_serving(port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(with_log(&error, &log));
    }

    Ok(ServerHandle {
        url,
        port,
        adopted: false,
        child: Some(child),
        #[cfg(windows)]
        _job: Some(job),
    })
}

fn remember(log: &Arc<Mutex<Vec<String>>>, line: String) {
    if let Ok(mut lines) = log.lock() {
        if lines.len() == LOG_LINES {
            lines.remove(0);
        }
        lines.push(line);
    }
}

fn with_log(error: &str, log: &Arc<Mutex<Vec<String>>>) -> String {
    let lines = log.lock().map(|lines| lines.clone()).unwrap_or_default();
    if lines.is_empty() {
        error.to_owned()
    } else {
        format!("{error}\n{}", lines.join("\n"))
    }
}

/// Wait for the `canvas: <url>` line, or for the child to give up first.
fn wait_for_url(urls: &Receiver<String>, child: &mut Child) -> Result<String, String> {
    let deadline = Instant::now() + ANNOUNCE_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match urls.recv_timeout(left.min(Duration::from_millis(250))) {
            Ok(url) => return Ok(url),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("the server closed its output without announcing a URL".to_owned());
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        // A server that has already exited is never going to announce anything, and the
        // usual reason is the port going to somebody else between the probe and the bind.
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the server exited before it was ready ({status})"));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the server did not announce a URL within {} s",
                ANNOUNCE_TIMEOUT.as_secs()
            ));
        }
    }
}

/// Poll `/api/state` until it answers, so the webview never lands on a dead socket.
fn wait_until_serving(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last = String::from("no attempt was made");
    while Instant::now() < deadline {
        match probe(port, "/api/state") {
            Ok(_) => return Ok(()),
            Err(error) => last = error,
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    Err(format!(
        "/api/state did not answer within {} s ({last})",
        READY_TIMEOUT.as_secs()
    ))
}

/// What one probe learned. A `200`, and whatever the answer said it was.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    /// The value of [`VERSION_HEADER`], when the answer carried one.
    pub version: Option<String>,
}

/// How much of a response head is read. A generous bound on a handful of small headers.
const HEAD_BYTES: usize = 2048;

/// One HTTP/1.1 GET against the loopback address, by hand.
///
/// No HTTP client is linked for this. The request is four lines of text to a socket on
/// 127.0.0.1, and what is read back is the status line and the headers — a dependency
/// with a TLS stack, a redirect policy and a cookie jar would be a large answer to a
/// small question.
///
/// It reads past the status line because of N-WP9: a shell deciding whether to adopt a
/// server it did not start needs to know *which* Nazar is on the port, and the answer is
/// [`VERSION_HEADER`]. The read stops at the blank line that ends the head, or at
/// [`HEAD_BYTES`], so a socket that answers with a megabyte of JSON costs two kilobytes
/// and a close.
fn probe(port: u16, path: &str) -> Result<Probe, String> {
    let mut stream = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(600),
    )
    .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .map_err(|error| error.to_string())?;

    // `Host` matters: the server refuses a request whose Host is not this loopback
    // address and port (`isLocalHost` in packages/server/src/http.ts).
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut head = Vec::with_capacity(HEAD_BYTES);
    let mut chunk = [0u8; 256];
    while head.len() < HEAD_BYTES {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
        if find_head_end(&head).is_some() {
            break;
        }
    }
    let _ = stream.shutdown(Shutdown::Both);

    let text = String::from_utf8_lossy(&head).into_owned();
    parse_probe(&text)
}

/// Where the blank line separating the head from the body starts, if it is in view yet.
fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Turn a response head into a [`Probe`], or into the reason it is not one.
///
/// Separated from the socket so the parsing has tests of its own: a wrong status line and
/// a header spelled in a different case are both things a future server could produce,
/// and neither should need a listener to check.
fn parse_probe(text: &str) -> Result<Probe, String> {
    let mut lines = text.lines();
    let status = lines.next().unwrap_or("").trim();
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        return Err(format!(
            "answered {}",
            if status.is_empty() { "nothing" } else { status }
        ));
    }

    let mut probe = Probe::default();
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        // Header names are case-insensitive, and nothing here should depend on which
        // casing a server happens to send.
        if name.trim().eq_ignore_ascii_case(VERSION_HEADER) {
            probe.version = Some(value.trim().to_owned());
        }
    }
    Ok(probe)
}

/* ------------------------------------------------------------------ *
 * Windows: the child does not outlive the shell
 * ------------------------------------------------------------------ */

/// A job object holding the child server, marked kill-on-close.
///
/// The handle is kept alive by [`ServerHandle`] and closed when the process ends —
/// including when it ends abruptly, because the kernel closes handles for a process it is
/// tearing down. That is the whole point: `stop()` covers Quit, and this covers every way
/// of ending that never reaches `stop()`.
#[cfg(windows)]
struct JobObject(windows::Win32::Foundation::HANDLE);

// SAFETY: a job object handle is a kernel handle, not a pointer into this process's
// address space. Every Win32 call that takes one is safe from any thread, and this one is
// only ever used twice: once to assign the child at creation, and once to close it. The
// wrapper exists because `HANDLE` is a raw pointer newtype and so is `!Send` by default,
// which would otherwise stop `ServerHandle` from living in the application's state.
#[cfg(windows)]
unsafe impl Send for JobObject {}

#[cfg(windows)]
impl JobObject {
    fn confine(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;

        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        // SAFETY: `CreateJobObjectW` with no security attributes and no name is the
        // documented way to make an anonymous job; the returned handle is owned here and
        // closed in `Drop`.
        let job = unsafe { CreateJobObjectW(None, None) }
            .map_err(|error| format!("could not create a job object: {error}"))?;

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `limits` is a correctly sized, fully initialised structure of the class
        // named, and it outlives the call.
        let set = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .unwrap_or_default(),
            )
        };
        if let Err(error) = set {
            // SAFETY: `job` is a handle this function created and has not yet given away.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!("could not configure the job object: {error}"));
        }

        let handle = HANDLE(child.as_raw_handle());
        // SAFETY: the child is alive — it was spawned by the caller and has not been
        // waited on — so its handle is valid for the duration of this call.
        if let Err(error) = unsafe { AssignProcessToJobObject(job, handle) } {
            // SAFETY: as above.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(format!(
                "could not confine the server to a job object: {error}"
            ));
        }

        Ok(JobObject(job))
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        // SAFETY: the handle was created in `confine` and is closed exactly once.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_port_is_actually_free() {
        let port = free_port().expect("the machine has a spare port");
        assert!(port > 0);
        // Binding it again immediately is the whole contract: the probe released it.
        let bound = TcpListener::bind(("127.0.0.1", port));
        assert!(bound.is_ok(), "the probe held on to {port}");
    }

    #[test]
    fn probing_a_port_with_nothing_on_it_is_an_error_rather_than_a_wait() {
        let port = free_port().expect("a spare port");
        let started = Instant::now();
        assert!(probe(port, "/api/state").is_err());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "a closed port must fail fast, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_verbatim_path_is_unwrapped_before_node_ever_sees_it() {
        // The failure this guards against had a correct path, a real file, and an error
        // message naming neither: `EISDIR ... lstat 'C:'`, from Node parsing `\\?\C:` as
        // a UNC share. See `simplify`.
        assert_eq!(
            simplify(Path::new(r"\\?\C:\nazar\bin\nazar.mjs")),
            PathBuf::from(r"C:\nazar\bin\nazar.mjs")
        );
        assert_eq!(
            simplify(Path::new(r"\\?\UNC\build\share\nazar.mjs")),
            PathBuf::from(r"\\build\share\nazar.mjs")
        );
    }

    #[test]
    fn a_path_that_is_already_plain_is_left_exactly_as_it_is() {
        for plain in [
            r"C:\nazar\bin\nazar.mjs",
            r"\\build\share\nazar.mjs",
            "/usr/local/lib/nazar/bin/nazar.mjs",
        ] {
            assert_eq!(simplify(Path::new(plain)), PathBuf::from(plain));
        }
        // The verbatim form also expresses paths the plain form cannot. Shortening one of
        // those would turn a working path into a broken one, so only drive letters are
        // unwrapped.
        assert_eq!(
            simplify(Path::new(r"\\?\Volume{2eca078d-5cbc}\nazar.mjs")),
            PathBuf::from(r"\\?\Volume{2eca078d-5cbc}\nazar.mjs")
        );
    }

    /* ---- N-WP9: keeping the port ------------------------------------- */

    /// A socket that answers one canned HTTP response to everything, until it is dropped.
    ///
    /// Nine lines instead of an HTTP server crate, for the same reason [`probe`] is
    /// nine lines instead of an HTTP client one: what is being checked is a status line
    /// and one header on 127.0.0.1, and a dependency with a router and a TLS stack would
    /// be a large answer to a small question.
    struct Canned {
        port: u16,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Canned {
        fn answering(response: &'static str) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a spare port");
            let port = listener.local_addr().expect("an address").port();
            listener
                .set_nonblocking(true)
                .expect("a listener that can be polled");
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = std::sync::Arc::clone(&stop);

            let thread = std::thread::spawn(move || {
                while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // The request is drained only far enough to be polite; what
                            // matters is that the answer goes out and the socket closes.
                            let mut sink = [0u8; 512];
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                            let _ = stream.read(&mut sink);
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });

            Canned {
                port,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Canned {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn ok_with_version(version: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Nazar-Version: {version}\r\nConnection: close\r\n\r\n{{}}"
        )
    }

    #[test]
    fn a_machine_with_no_stored_port_has_no_plan_and_asks_the_operating_system() {
        assert_eq!(plan_port(None, VERSION), None);
        // Port 0 is "ask the operating system", which cannot be a stored answer: the
        // number it hands back is different every time.
        assert_eq!(plan_port(Some(0), VERSION), None);
    }

    #[test]
    fn a_stored_port_nobody_holds_is_bound_again_which_is_what_keeps_the_workspace() {
        let port = free_port().expect("a spare port");
        assert_eq!(plan_port(Some(port), VERSION), Some(Plan::Bind(port)));
    }

    #[test]
    fn a_stored_port_serving_this_version_is_adopted_rather_than_replaced() {
        let response = Box::leak(ok_with_version(VERSION).into_boxed_str());
        let server = Canned::answering(response);
        assert_eq!(
            plan_port(Some(server.port), VERSION),
            Some(Plan::Adopt(server.port)),
            "a Nazar of this build on this port is a Nazar to show, not one to duplicate"
        );
    }

    #[test]
    fn a_stored_port_serving_another_version_is_given_up_on() {
        // A different version is a different canvas and possibly a different browser-local
        // migration. Showing it would be showing the user another program, so the shell
        // takes a new port and the user pays once, in a lost arrangement.
        let response = Box::leak(ok_with_version("0.0.1-other").into_boxed_str());
        let server = Canned::answering(response);
        assert_eq!(plan_port(Some(server.port), VERSION), None);
    }

    #[test]
    fn a_stored_port_held_by_something_that_is_not_nazar_is_given_up_on() {
        // Two shapes of "not us": a socket that answers nothing at all, and one that
        // answers HTTP without the header. Neither may be adopted.
        let silent = TcpListener::bind(("127.0.0.1", 0)).expect("a spare port");
        let port = silent.local_addr().expect("an address").port();
        assert_eq!(
            plan_port(Some(port), VERSION),
            None,
            "a listener that never answers is not a canvas"
        );
        drop(silent);

        let response = Box::leak(
            String::from(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\nhi",
            )
            .into_boxed_str(),
        );
        let stranger = Canned::answering(response);
        assert_eq!(plan_port(Some(stranger.port), VERSION), None);
    }

    #[test]
    fn a_probe_reads_the_status_line_and_the_version_header() {
        let probe = parse_probe(&ok_with_version("1.2.3")).expect("a 200");
        assert_eq!(probe.version.as_deref(), Some("1.2.3"));

        // Header names are case-insensitive on the wire, and nothing should depend on
        // which casing a server happens to send.
        let odd = "HTTP/1.1 200 OK\r\nx-NAZAR-version:  4.5.6  \r\n\r\n{}";
        assert_eq!(
            parse_probe(odd).expect("a 200").version.as_deref(),
            Some("4.5.6")
        );

        // A 200 with no header at all is still a 200: `wait_until_serving` only needs
        // that much, and only `plan_port` cares who answered.
        let bare = "HTTP/1.1 200 OK\r\n\r\n{}";
        assert_eq!(parse_probe(bare).expect("a 200").version, None);
    }

    #[test]
    fn a_probe_that_is_not_a_200_is_an_error_naming_what_came_back() {
        for (head, expected) in [
            ("HTTP/1.1 404 Not Found\r\n\r\n", "404"),
            ("HTTP/1.1 403 Forbidden\r\n\r\n", "403"),
            ("", "nothing"),
        ] {
            let error = parse_probe(head).expect_err("not a 200");
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn the_head_of_a_response_is_found_wherever_the_reads_happened_to_split_it() {
        assert_eq!(find_head_end(b"HTTP/1.1 200 OK\r\n\r\nbody"), Some(15));
        assert_eq!(find_head_end(b"HTTP/1.1 200 OK\r\nX: 1\r\n"), None);
        assert_eq!(find_head_end(b""), None);
    }

    #[test]
    fn an_adopted_server_is_never_killed_because_it_belongs_to_whoever_started_it() {
        // It may be another instance of this shell, or a terminal running
        // `nazar --port`. Quitting a window must not end somebody else's process.
        let response = Box::leak(ok_with_version(VERSION).into_boxed_str());
        let server = Canned::answering(response);

        let mut handle = adopt(server.port).expect("the canned server answers /api/state");
        assert!(handle.adopted);
        assert_eq!(handle.port, server.port);
        assert_eq!(handle.url, format!("http://127.0.0.1:{}/", server.port));
        assert!(handle.child.is_none(), "nothing was started to be stopped");

        handle.stop();
        // Still answering afterwards, which is the whole claim.
        assert!(
            probe(server.port, "/api/state").is_ok(),
            "stopping an adopted handle must leave its server running"
        );
    }

    #[test]
    fn a_bundle_that_is_not_there_resolves_to_nothing() {
        let nowhere = std::env::temp_dir().join("nazar-desktop-no-such-resource-dir");
        // In a debug build the repository's own `dist/` is the last resort, and on a
        // machine that has built it this legitimately answers. Either outcome is correct;
        // what must not happen is a panic or a path from somebody else's machine.
        if let Some(found) = resolve_entry(Some(&nowhere)) {
            assert!(found.is_file());
            assert_eq!(
                found.file_name().and_then(|name| name.to_str()),
                Some("nazar.mjs")
            );
        }
    }
}
