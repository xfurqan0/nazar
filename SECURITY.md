# Security

Nazar reads the files an AI coding agent leaves on your disk. That is a category
of tool that can leak your work by accident, so this page is specific about what
it opens, what it refuses to open, and what leaves the machine.

## What Nazar reads

Nazar reads from **three roots** and runs **one command**. Most of it is under
Claude Code's own configuration directory (`~/.claude`, or wherever
`CLAUDE_CONFIG_DIR` points). Two optional files belong to the sibling project
nazar-tray and live under `~/.nazar` (or `$NAZAR_HOME`). One file is inside your
own repository.

| Source | What is taken from it |
|---|---|
| `claude agents --json` | pid, working directory, kind, status, and what a waiting session is waiting for |
| `~/.claude/sessions/<pid>.json` | pid, session id, working directory, start time, kind, name, status, timestamps, version |
| `~/.claude/projects/**` | directory listings, and from transcripts: line type, timestamps, uuids, model, effort, token counts, message and request ids, tool **names**, and the agent id a launch record carries |
| `~/.nazar/statusline/<session_id>.json` | the run's cost, how full its context window is, the effort level, the model name and id, and the rate-limit windows. Written by `nazar-statusline`, a nazar-tray binary |
| `~/.nazar/limits.json` | one percentage, state and reset time per provider window, plus the plan name. Written by nazar-tray |
| `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` | `statusLine.command`, and nothing else in the file |

The two files under `~/.nazar` are **optional and read-only**. Neither reader
can do anything but read: they import `readdir`, `readFile` and `stat` and
nothing else (`packages/core/src/statusline-captures.ts:31`,
`packages/core/src/limits-file.ts:30`). A capture is the *whole* status-line
payload, so it also carries `cwd`, `transcript_path`, `scratchpad_dir`,
`workspace.*` and `session_name` — none of which is read, because the parser
builds a new object from a closed list rather than filtering a parsed one, and a
leak test plants a sentinel in every one of those fields and fails if it appears
anywhere in the output (`packages/core/test/statusline-captures.test.ts`).
`chain.json` sits in the same directory and is skipped **by name** rather than
parsed. On a machine with neither file the usage-limits bead is not drawn at
all, the two optional hover-card rows are not there, and nothing is shown
as `0`.

The complete inventory, field by field, with the Claude Code version each shape
was observed under and the fixture that pins it, is in
[docs/pinned-internal-formats.md](docs/pinned-internal-formats.md). A test fails
the build if code in `packages/core` reads a path that is not on that list —
which is where every reader that feeds the canvas lives
(`packages/core/test/pinned-paths.test.ts` scans that package's `.ts` sources
and no others). The desktop shell's own readers are on the list by review rather
than by that test.

## What Nazar never reads

- **Credential files.** `~/.claude/sessions/<pid>.<hash>.key` sits next to the
  session files. The reader accepts a file name of `<digits>.json` and nothing
  else, and a test asserts the skip.
- **The user-level `~/.claude/settings.json`.** Not read, not written, not
  backed up, not touched, and a test fails the build if any shipped source so
  much as names it. v1 installs no hooks, so there is nothing for it to change
  there. A *project's* settings file is a different file and is read; see below.
- **Message content.** No prompt, response, thinking block (or its signature),
  tool input, or tool result body is ever parsed into memory. The transcript
  reader builds a new object from a closed list of fields rather than filtering
  a parsed line, so a field that is not on the list is gone with the parse
  result. Only a `tool_use` block's **name** survives.
- **Overflowed tool output** (`<session>/tool-results/*`): raw file contents,
  command output and fetched pages. Exactly the kind of leak Nazar exists not to
  be.
- **A transcript's `cwd`.** History knows a project by its directory slug alone,
  with your home prefix collapsed to `~`.

Two mechanical guards back this up: every string the extractor keeps is capped
at 200 characters, because every field on the list is an id, a model name, a
timestamp or a tool name; and two leak tests fail if a sentinel — or a word
sampled at test time from a real transcript's own prose — appears anywhere in
the output.

### The one file Nazar reads inside your repository

Claude Code merges a project's settings over the user's. So a repository that
sets its own `statusLine` does not chain to the `nazar-statusline` wrapper — it
*replaces* it, for every session started in that directory. The wrapper never
runs, no capture is written, and cost and context are missing on exactly those
cards and no others, on a machine where everything is installed correctly. That
is undiagnosable from the canvas, so Nazar reads `<cwd>/.claude/settings.json`
and `<cwd>/.claude/settings.local.json` in order to say so.

**One key leaves the parser and it is `statusLine.command`**, capped at 200
characters (`packages/core/src/project-settings.ts:103-114`). `permissions`,
`hooks`, `env`, `model`, `apiKeyHelper`, `mcpServers` and everything else in
those files are never named, and `test/no-writes.test.ts` fails the build if the
reader so much as mentions `permissions`, `hooks`, `env`, `model` or
`apiKeyHelper` — the five it pins by name. The files are opened with `readFile` and
nothing else, only for a session that has been alive past 90 seconds with no
capture — a session four seconds old has not necessarily had a status-line
redraw yet — and the answer is cached per directory for five minutes. Malformed
JSON reads as "this project says nothing", not as an error: a settings file
somebody is half-way through editing is not evidence of anything.

## What leaves your machine

Nothing.

- The server binds `127.0.0.1`, and the address is not configurable.
- Requests are checked against a small allow-list of `Host` headers, so a page
  on the open internet cannot point a DNS name at 127.0.0.1 and read the canvas
  through your browser.
- The page is served under `default-src 'none'`: no CDN, no web font, no
  analytics, enforced by the browser rather than by convention.
- There is no telemetry, no crash reporting, no update check and no account.
- Nazar makes no network request of any kind, and never reads a credential,
  token or keychain entry to obtain one.

## What Nazar writes

Nothing, anywhere. No configuration directory, no cache, no state file, no
change to Claude Code's settings, and no modification, copy, move or deletion of
anything under `~/.claude`. Transcript retention stays Claude Code's
(`cleanupPeriodDays`), and Nazar does not extend it.

That is enforced statically rather than promised: `test/no-writes.test.ts` reads
every shipped source and fails if one of them imports a filesystem call that
could write, or opens a file handle with anything but the `'r'` flag. It has two
rules about settings files, and they are not the same rule. **`settings.json`
may be named by three files and no others** — the project-settings reader, the
package's entry point, and `nazar doctor` — so a second reader appearing
anywhere in the tree fails the build. And **the user-level file is forbidden
outright**: a separate assertion fails if any shipped source contains the string
`~/.claude/settings` at all. A runtime test proves one code path did not write;
this proves none of them can.

**The desktop app writes exactly one file**, and the sentence above is still
true of everything it shows you: the gate covers the whole of the JavaScript,
which is all of the reading. The file is `%APPDATA%\nazar\desktop.json`, it
holds whether you asked Windows to start Nazar at login, and it is written only
when you toggle that switch. It is a *different file* from
`%APPDATA%\nazar\config.json`, which belongs to the sibling project nazar-tray;
they share a directory and nothing else. Turning the switch on also adds an
entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, and turning it
off removes it.

## What the desktop app can reach

The window shows the same page a browser does, served over the loopback address
by a child process the app starts. That makes the canvas a *remote* origin as
far as Tauri is concerned, so what it may ask the application to do is listed
explicitly in `apps/desktop/capabilities/canvas.json` — **four commands**: what
the shell is, jump to a session's terminal, and read and write the autostart
switch. It has no filesystem, shell, dialog or network permission of any kind,
and no plugin is exposed to it. The pattern that grants those four is narrowed
to `http://127.0.0.1` and `http://localhost`, which is where the app's own child
server is and where — by the server's own `Host` check — nothing else can
answer.

## The jump

**The jump is the one thing Nazar does that acts outside its own window**, so it
gets the longest section on this page. It reads the process table, walks up from
a session's pid, and raises a window. It types nothing into that window and
starts no process — `wt.exe` is never invoked, even though its `focus-tab`
subcommand would work, and a test asserts the jump creates no process at all. It
runs only from a gesture you made, which is also what makes it work at all:
Windows lets a process take the foreground when it already has it, so a jump can
never fire from a timer or a server event.

**It uses UI Automation.** `apps/desktop/src/jump.rs:715-716` calls
`CoCreateInstance(&CUIAutomation, …)`; `:736` collects `IUIAutomationElement`s;
`:851-861` calls `GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>` and
`Select()`. That is the accessibility interface `inspect.exe` uses: a
cross-process read of another application's UI tree *and* a change to its
selection. So "sends no input to that window" is true only in the narrow sense
that no keystrokes are synthesized. What it needs and what it grants: no
elevation, the same view of the desktop a screen reader has, at your own
privilege level. It cannot reach a window running as another user or as
administrator.

**It is bounded.** The whole of that rung runs on its own thread under a
deadline, because a cross-process accessibility call blocks on another program's
UI thread. And it runs only for `TAB_HOSTS`, which is deliberately the single
entry `WindowsTerminal` (`crates/nazar-shell/src/tabs.rs:96`) — VS Code and
Cursor publish `TabItem` elements too, for *editor* tabs, and selecting one
would be confidently wrong.

**It excludes rather than guesses.** Every other **live** session's keys are
matched against the same tabs by the same matcher, and a tab another session
demonstrably owns is removed from consideration; only if exactly one is left
over is it raised. The exclusion is tab by tab, not window by window, so a
window holding two tabs keeps its unclaimed one
(`crates/nazar-shell/src/tabs.rs:488-501`). Liveness is part of the rule rather
than an optimisation: a session that has ended leaves its registry file behind,
and letting a ghost claim a tab could leave the *wrong* tab as the only one over.
When several windows could still be the session, nothing is raised and the
canvas says how many it could not choose between. "Another session" here means
another Claude Code session, not a Windows logon session.

**A jump also reads titles.** To learn what the other sessions are called it
reads `~/.claude/sessions/<pid>.json` and up to 1 MB from the tail of the
session's own transcript plus up to 32 others
(`apps/desktop/src/titles.rs:59, 272-286`; `crates/nazar-shell/src/tabs.rs:450`).
From each transcript exactly two fields are read — `type` and `aiTitle` — and the
scan stops at the first title line it finds walking backwards. What leaves that
module is a list of candidate title strings for the matcher to compare. Nothing
is written.

One caveat, and it is a limitation rather than a leak: the jump's title lookup
resolves Claude Code's directory from `USERPROFILE`/`HOME` alone and does **not**
honour `CLAUDE_CONFIG_DIR` (`apps/desktop/src/titles.rs:82-87`). On a machine
that sets that variable the canvas reads the configured directory and the jump
finds no titles, so it falls back to the narrowing rules. It can only make the
jump refuse, never send you to the wrong window.

## Before you share a screenshot

Working directories, session names and project labels do reach the canvas, and a
screenshot of it can end up in a bug report. They pass through a redaction gate
first: credential-shaped strings (vendor-prefixed keys, `--token=…`, bearer
tokens, JWTs, `https://user:pass@host`) are masked, the home directory is
collapsed to `~`, and the result is cut to 80 characters. Masking happens before
truncation, so the readable head of a token cannot survive the cut.

`nazar doctor` follows the same rule: it prints no path under your home
directory unless you pass `--verbose`.

## Reporting a vulnerability

Please report privately, not as a public issue:

- Open a [private security advisory](https://github.com/xfurqan0/nazar/security/advisories/new)
  on the repository. That is the preferred route: it is private, it threads, and
  it produces a CVE if one is warranted.

Include what you did, what happened, and the Nazar and Claude Code versions
(`nazar --version` and `claude --version`). A `nazar doctor --verbose` output is
useful, but read it before you attach it: `--verbose` prints absolute paths.

Expect an acknowledgement within a week. This is a personal open-source project
with no security team behind it, so please treat that as a best effort rather
than a service level. Fixes land in a patch release, and the advisory is
published once the fix is out.

Nazar has no server side, no account system and no network surface, so the
interesting classes of report are: a path it reads that is not in the pinned
inventory, a way to make it write or delete something, a way to get message
content into the UI or into an HTTP response, and a way to reach the server from
outside `127.0.0.1`.

## Supported versions

Pre-1.0: only the latest released version is supported.
