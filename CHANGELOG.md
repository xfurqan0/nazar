# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **What the canvas shows is true: pruning, dead sessions, history paging and
  races, subagent totals, same-size rewrites** (N-WP20). An independent review
  of `4827ca1` produced six reproducible findings, and they are one bug wearing
  six coats: *the screen was confident about something it had not checked*.

  - **A machine with more than 200 past sessions lost the customisations of
    every session past the 200th.** On the first frame the canvas asks the
    transcript store what it still has and forgets the rest — the card position,
    the card size, the tab a session was moved to, and the name typed on it. It
    asked with `history.list(200)`, and treated one page as the whole store. So
    on a machine with 201 transcripts, the 201st was pruned as *gone* while
    sitting openable in the drawer two clicks away. The question now goes to a
    new unpaged route, **`GET /api/history/ids`**, which answers with session ids
    and nothing else; and if that request fails, **nothing is pruned at all** and
    the next frame tries again. Forgetting nothing is recoverable. Forgetting the
    wrong thing is not.
  - **A session that had ended came back, every few seconds, forever.** A crash
    leaves `~/.claude/sessions/<pid>.json` behind. The registry probed the pid,
    found nothing, held the session at `unknown` for one liveness gate and
    dropped it — and dropped the record of *having* dropped it at the same
    moment, so the next scan of the same untouched file added it straight back:
    `1 → 0 → 1 → 0`, for as long as the file sat there. The verdict is now
    remembered against the **identity of the file it was made about**, so a
    leftover stays gone while a file that actually changes gets a fresh hearing
    — which is what keeps a **reused pid** from being buried forever.
  - **The history drawer could not reach past its own first page.** It asked for
    200 rows and stopped, on a store the server was already reporting a
    `nextOffset` for. It printed *200 of 1 340* and offered no route to the other
    1 140. There is now a **load more** button under the list, in all six
    languages and counting what is left, and reaching the end of the list loads
    the next page on its own. Pages are appended, so a project split across a
    page boundary is one heading and not two.
  - **Clicking one past session and then another showed whichever finished
    last.** A transcript can take a second to parse, so selecting A and then B
    left two requests in flight and drew whichever the disk happened to return
    second — with the *other* row marked as the selected one. Worse, an answer
    arriving after the drawer was closed re-opened it onto a frozen tree whose
    back button no longer led anywhere. Every selection now carries a sequence
    number, closing the drawer invalidates whatever is in flight, and a stale
    answer is dropped rather than drawn.
  - **A session's token total ignored its subagents changing.** The headline
    number on a past session is `treeTokens` — the session **plus** every
    subagent under it — but the parse cache was keyed on the parent transcript
    alone. Append one line to a child and the same scanner went on reporting the
    total from before it, while a freshly built one over the same directory
    reported the new one: 11 against 31, one question and two answers. The key
    now includes the shape of the `subagents/` directory. Still a `readdir` and
    a `stat` each; still never an `open`.
  - **A transcript replaced by a file of exactly the same length was never
    read.** The tailer's only rule for *this is not the file I had* was that it
    had shrunk, so a rotation landing on the same byte count left it reading at
    an offset into a file that no longer existed — silently, and for good. It now
    tracks the file's identity as well (`ino` and `birthtimeMs`, falling back to
    a hash of a fixed window at the head where the platform's inode cannot be
    trusted), and appended bytes deliberately do not move it.

- **An empty canvas says why it is empty, and what to do about it** (N-WP20).
  The first five minutes of Nazar, on a machine that is not already running
  Claude Code, were a blank rectangle and the words *no sessions found* — with
  one piece of advice, *start `claude` in a terminal*, which is correct for
  exactly one of the three ways the canvas can be empty. `nazar doctor` has
  always been able to tell them apart, so the server now sends the same verdict
  and the page shows it: **the sessions directory does not exist** (check
  `CLAUDE_CONFIG_DIR`), **there is no live session right now** (start one), or
  **the session files are all leftovers from runs that ended**. Two quieter notes
  ride under it when they are true and never as the reason: `claude agents` not
  answering, and the status-line wrapper not being installed — the second being
  why cost and context stay unknown rather than why the canvas is empty.
  All of it comes from the catalogues, so it is in all six languages.

- **A disconnected canvas says how old what it is showing is.** When the event
  stream drops, the canvas deliberately keeps the last snapshot on screen —
  blanking it would throw away the only thing left that is true — but the top bar
  said only *disconnected · retrying*, which left a stale reading looking exactly
  like a live one. It now reads **disconnected · last data 12s ago**, and the
  number keeps moving.

- **`nazar doctor` names the shell instead of blaming a turn that has not
  happened** (T-WP8). On Windows Claude Code runs `statusLine.command` through
  Git Bash, where a backslash outside quotes is the escape character — so a
  status-line wrapper installed at `C:\…\nazar-statusline.exe` is never spawned
  at all, no capture is written, and every card shows no cost and no context
  window. Doctor reported that as *no status-line tick yet*, which is what a
  session sitting at a prompt honestly looks like, so the report told a person
  to wait rather than to fix it. It is now a fifth reason, ranked **above** the
  install-date reason, because that one ends "restart it and the capture
  appears" and a restart changes nothing here. A project override still outranks
  it, being the only reason that explains one session and not its neighbour.
  Two lines that contradicted the new one were corrected with it: the `captures`
  row no longer says "the status-line wrapper is not installed" about a wrapper
  that *is* the user-level status line, and the machine-wide sentence under it
  now names the shell. The rewrite is nazar-tray's own installer's job; doctor
  prints its dry run and, as ever, runs nothing.

### Added

- **The task text, switched off** (N-WP15a). Nazar draws *how much* and *how
  long* and never *what*, and that stays the default — but forty cards raise one
  question no token count answers: **which of these is the one I asked to do the
  thing?** So there is now a switch, in **Settings → Behaviour**, that adds one
  quiet line to each card: what that session was **last asked to do**, and what
  each subagent was **launched for**. Hover either and the card shows the whole
  thing, up to 300 characters. It is **off on a fresh install and off in every
  new browser**, and the note under the switch is the entire contract: *read from
  the transcript, never written to disk, kept in this browser only*.

  What reaches the line is the human turn and nothing else — **never the model's
  reply, never a tool result, never a system reminder**, never a slash command's
  own bookkeeping and never an interruption marker. A session shows its *last*
  turn, because one you opened this morning is not still doing what you opened it
  for; a subagent shows its *first*, because that is the brief it was launched
  with and a later message is a correction to a job rather than the job. The text
  is collapsed to one line, stripped of control characters and invisible
  formatting, cut at 300 characters with the cut marked, and swept for anything
  credential-shaped exactly as a working directory is.

  **Three independent switches, and each one outranks the last.** The browser's,
  which starts off and never leaves that browser. The request's: the server adds
  the field only for a page that asked, so a browser that has not switched it on
  gets the payload it always got. And the machine's — `nazar --no-task-text`, or
  `NAZAR_TASK_TEXT=0` — which stops the text being **read**, not merely being
  sent, so no browser talking to that server can be shown a task line whatever
  its own switch says. The desktop app offers the same thing as a **recording
  mode** switch, which restarts the canvas server with that flag: it is the one to
  use while sharing a screen, and it is the only one that is a promise rather than
  a preference.

- **Six UI languages: English, Türkçe, 中文, 한국어, Русский, Español** (N-WP13). Every word the canvas draws now comes from a catalogue — the sidebar and the settings panel, the cards and their menus, the tab bar, the history view, the usage panel, the empty states, and every tooltip and `aria-label` — and the desktop app's tray menu reads the very same files, so the tray and the canvas cannot end up in different languages. The picker is in **Settings → Language** and lists the six by name, with the one you are reading ticked. **There is no *follow the system* entry, and the behaviour it named is still what you get**: until you pick a language, Nazar takes the first of your browser's preferred languages it can paint itself in and falls back to English rather than to a page of message keys — so the option already ticked the first time you open the list is the language your machine asked for. **Changing language does not reload the page.** Your choice lives in this browser under `nazar.locale.v1`. English and Turkish were written by hand; Chinese, Korean, Russian and Spanish were machine-translated first and **corrections are welcome as pull requests** — `packages/ui/locales/README.md` has the rules and the status table. Numbers are deliberately not localised: durations, token counts, byte sizes and timestamps read the same everywhere, because this canvas is read next to other tools that print the same numbers.

- **The desktop app for macOS and Linux** (N-WP19a). Until now the shell was one
  artifact — a Windows installer — and on the other two platforms the desktop
  application simply did not exist. There are now four: the NSIS installer, a
  `.dmg` for Apple silicon, a `.dmg` for Intel, and an `.AppImage` plus a `.deb`
  for x86-64 Linux. They come out of a new `desktop bundle` job that runs **on a
  `v*` tag or when somebody asks for it by hand**, and not on every push: a macOS
  runner bills at ten times a Linux one, and none of these artifacts is what
  decides whether a change was correct.

  **What each platform gets is written down rather than discovered** — the new
  `docs/PLATFORMS.md` is a table of it. The window, the tray, close-to-tray and
  start-at-login work on all three. **The jump to the terminal does not**: it is
  still Windows-only, and on macOS and Linux the gesture answers *jumping to a
  terminal is not available on this platform yet* instead of doing nothing
  silently. The Linux tray is a **menu only**, because the protocol every modern
  Linux desktop uses hands the click to the desktop rather than to the
  application.

  **Unsigned, and said out loud.** The `.dmg` is ad-hoc signed and not notarised,
  so the first launch wants a right-click → Open, or one
  `xattr -d com.apple.quarantine`. The `.AppImage` arrives without its executable
  bit, because a zip cannot carry one, so it wants a `chmod +x`. Both are in
  `docs/PLATFORMS.md`, next to the reason each is true.

- **A `Needs you` strip: who is waiting for you, for how long, and what finished
  while you were away** (N-WP21). Nazar has shouted about a waiting session since
  the first release — an amber frame, an expanding ring, and a banner across the
  top that outranks everything else on the page. What it never said is **which
  one to answer first**. With three sessions waiting, the banner is three folder
  names in whatever order they came back in, and the one that has been sitting on
  a permission prompt for eleven minutes looks exactly like the one that started
  waiting four seconds ago.

  So there is now a badge in the top bar — `Needs you · 2`, with the longest wait
  next to it — and a list behind a click, **longest wait first**. Every row says
  the card's name, the folder it runs in, what it is waiting for (a permission
  prompt, an input request, a sandbox request, an open dialog — in all six
  languages) and how long it has been waiting; clicking one takes you to that
  card, switching tab and scrolling the canvas to it, and in the desktop app
  raises its terminal as well. If a session answers one question and immediately
  asks another, its timer starts again: the number is how long *this* question
  has gone unanswered, not how long that terminal has been unattended.

  Under it, **Finished while you were away** — sessions whose work went quiet in
  the last ten minutes, with how long the run took and, where the status-line
  wrapper supplies them, its token totals and cost. It clears itself, and a
  session that picks work up again leaves it at once.

  Three things it deliberately does not do. It **never guesses**: there is no
  *stuck* verdict, because "nothing has been written for a while" is an
  inference, and a monitor that infers is one you stop believing the first time
  it is wrong. It **remembers nothing**: how long each session has been waiting
  is held for as long as the page is open and is written nowhere — a reload
  starts the clocks again, which is the honest answer for a page that was not
  there. And it **changes nothing on the canvas**: the frame, the ring and the
  banner are exactly as they were, and this list is their index. The badge is
  keyboard-reachable, the arrows walk the list, Escape closes it, and the count
  is announced when it changes.

- **The jump is offered only where it can actually work** (N-WP21). The desktop
  app has told the canvas whether it can raise a terminal since the Windows
  release, and the canvas was not listening. That cost nothing while Windows was
  the only build; with macOS and Linux builds it meant a **Jump to terminal**
  entry in every card menu whose one possible answer was *not available on this
  platform yet*, and a double-click on a card that appeared to do nothing. The
  entry is no longer drawn where the platform has no jump — the menu keeps its
  rule that an item which can never work is worse than an item that is not there
  — the double-click and <kbd>Enter</kbd> are an ordinary click there, and the
  line in **About** about double-clicking a card goes with them.

- **A sound when a session ends** (N-WP16). A monitor is only useful while you
  are looking at it, and the point of a long agent run is that you are not. So
  the canvas has a voice: a 250 ms tick when a **session** ends, on by default.
  Never a subagent — a busy session finishes dozens a minute and not one of them
  means the work is done — and never more than once for the same session.

  **The restraint is the feature.** Several sessions ending inside two seconds
  are one sound. The canvas is silent for the first five seconds after the page
  opens, so a reload never rings for work that finished while nobody was
  watching. **Quiet hours** (off by default; `22:00`–`07:00` when you turn them
  on, wrapping midnight on your own wall clock, with nazar-tray's semantics down
  to equal endpoints meaning an empty range rather than a whole silent day)
  silence it. `?demo=1` makes no noise at all. A second sound, for **a session
  waiting for permission**, is off by default: a prompt is common and is as often
  answered in the terminal you are already in.

  All of it is in **Settings → Behaviour → Sound**, in all six languages, with a
  button that plays the tick so you can hear it before you decide. The
  preferences live in this browser under `nazar.sound.v1` and nowhere else.

  **Sounds play after your first click.** Every browser refuses to start audio on
  a page nobody has touched, and refuses silently, so Nazar builds no audio
  context and fetches nothing until you click or press a key — and says that
  once, quietly, if a session ends before you have.

  The clip is **synthesised, not stock**: `scripts/render-sound.mjs` writes 250 ms
  of two sine partials (880 Hz and a fifth 9 dB under it) with an 8 ms attack and
  an exponential tail that reaches exactly zero, peaking at −6 dBFS, as a 21.6 KB
  16-bit mono WAV that is committed to the repository. A test re-runs the script
  and fails if the bytes have moved — the same discipline the icon is held to,
  applied to a sound. The canvas gains a `session-ended` frame on the SSE stream
  to carry the event; it is a frame rather than a field because an event is heard
  once by whoever is connected, where a snapshot is replayed to everyone who
  reconnects. Zero runtime dependencies, as before.

### Changed

- **A right-click on a link opens a menu again** (N-WP15a). Taking the browser's
  menu away everywhere was right for a canvas and wrong for the three links on
  it — all of them in the sidebar, all of them answering a right-click with
  nothing at all since the last release. They now open a small menu of their own:
  **Open in browser** and **Copy address**, which are the only two things anybody
  wants from a link. *Open in browser* rather than *Open in new tab*, because
  that is the true sentence in both places this page runs: a browser opens a new
  tab, and the desktop window has no tabs and hands the address to the machine's
  browser, which is where an external link was always meant to go. Same keyboard
  behaviour as the other three menus — it takes focus when it opens, `Esc` closes
  it, and a press anywhere else closes it — and a text field still keeps the
  browser's own menu, links included.

- **The right-click is the page's, everywhere, and a note answers it with its
  own menu** (N-WP14). Right-clicking the top bar, the sidebar, the tab bar or a
  frozen history tree used to hand over the browser's menu — *Reload*, *View
  page source*, *Save image as* — none of which has anything to say about a
  canvas you arrange. It is gone from all of them: a card still opens its **⋯**
  menu at the pointer and empty canvas still offers **Add note here · Arrange ·
  Fit**, and everywhere else the gesture now simply does nothing rather than
  producing the wrong menu, because a page that answers it in four places out of
  five looks broken in the fifth. **A sticky note answers it too**, with the
  same **⋯** menu the button opens — the four colours and *Delete* — placed at
  the pointer instead of under the button. It is the same element and the same
  entries, opened two ways: the menu takes the keyboard when it opens, `Esc`
  closes it, and focus goes back to the note's **⋯**. **The one exception is a
  text field.** An `<input>`, a `<textarea>` and a note you are typing into keep
  the browser's own menu, because that is where Cut, Copy, Paste, Undo and the
  spell-checker live and no menu this canvas draws could carry them — a
  browser's menu is the only one allowed to touch the clipboard unasked. What
  makes a note a text field is the **caret**, not the pointer: a note being
  typed into is being edited, and a note merely under the pointer is an object
  on a canvas. Press `Esc` to leave its text box and the right-click is the
  note's own again.

- **The left menu is three sections and a gear** (N-WP12). The drawer behind the hamburger keeps only what you use while you work — **Sessions**, **Folder tabs**, **View** — and a bar at its foot, outside the scrolling area, carries a gear and the version. The gear opens a **settings panel in the drawer's own place**: same width, no overlay, no dimmed canvas, so the sessions behind it stay visible and stay updating while you pick a colour. The panel holds **Appearance** (light/dark, the four palettes, the five frame colours), **Behaviour**, **Language** (arriving next), **Usage limits** and **About**. `Esc` or the arrow at its head goes back; `a`, `0` and `h` keep working while it is open. Four controls that said their own state in their label — `demo data: off`, `start with Windows: off`, `auto-create projects for new folders: on`, `light or dark: system` — are now switches and a three-way light/dark segment, announced to a screen reader as the controls they are. **Nothing changed meaning**: every setting does exactly what it did, in the same place in storage, and the panel itself remembers nothing — the drawer always opens on the menu.

- **A folder tab is opened from a session you can see, and the typed project
  form is gone** (N-WP11). The sidebar's **Sessions** section now lists the
  sessions on the canvas, one row each, with the folder that session is running
  in and a button reading *Open a tab for `app`* — or *Go to tab app*, when that
  folder already has one. Right-clicking a row opens the card's own menu at the
  pointer, where **Open a tab for** (formerly *Make project from*) offers every
  folder up the tree, and a folder that already has a tab now takes you to it
  instead of sitting there disabled. **The tab is named after the folder and
  nobody is asked**: `app`, with the parent folder added only when another tab
  already has that name (`api · srv`, `api · web`); renaming by double-click is
  unchanged. The **new project…** button and the field you typed a path into are
  removed — a path typed at a card that reads `~/proj/app` could be written a
  way no card ever writes it and then own nothing for ever, which is the mistake
  a row on screen cannot make. The sidebar section is now called **Folder tabs**
  and the word *project* leaves the interface with it; the stored schema,
  `nazar.tabs.v1`, is untouched, and every tab saved before this reads and
  behaves exactly as it did. The ownership rules are unchanged: the deepest
  folder wins, a card dragged onto a tab is still pinned, and **Follow project**
  still hands it back. **auto-create projects for new folders** stays where it
  was, still off by default.
- **Cards resize from all eight handles, not just the four corners** (N-WP10).
  Each edge moves one dimension and holds the edge opposite it — top and bottom
  set the height, left and right the width — and each corner scales the card
  on the aspect ratio it had at the press, holding the corner opposite it. The
  height is a card's own for the first time: `nazar.layout.v1` gained a
  `heights` map beside `widths`, read as a floor under the height the subagent
  tree needs and never as a value in place of it, so a card can be given room
  under its tree but can never be made to hide it. Layouts written before this
  have no `heights` key, read as none, and go on sizing their own height. The
  ⋯ menu's *Reset width* is now *Reset size* and clears both axes.
- **The cards say less, and mean more by it** (N-WP15). One fact, one signal:
  the card answers, the hover card explains, and colour is spent only where it
  means something. **The state is back on the ring**, which now carries the
  activity rather than the narrower question of whether the process answers a
  probe — green working, blue idle, grey-blue done, dashed grey unknown — and
  **exactly one card on the canvas has a coloured border**: the one waiting for
  you, which is the only state you can act on. A subagent's node has no coloured
  border in any state; its dot and its last line carry it. Nothing breathes any
  more: the working frame's 1.6 s pulse is gone, and the only motion left is the
  halo on a waiting session. **The card's body is one line** —
  `2h 17m · 214 tool calls · Grep · 34k tokens` — where it was a line plus two
  rows of token counters; the four exact counters are on the hover card, which
  is unchanged to the row. The total is input plus output (never cache) and is
  the one rounded figure in the product, because a card carries a magnitude and
  a hover card carries the number. **A subagent node is three lines** instead of
  six and 61 px instead of 106, so a card with sixteen of them is half the
  height it was; `done · 12m 03s` is text on its third line rather than a pill.
  **No pill is left on a card at rest**: the model and effort chips are ordinary
  secondary text, the `permission prompt` chip is the card's own status label in
  amber, and the two chips that remain are the folded tree's summary row and the
  pressable *N finished hidden · show*. **Nothing is uppercase** — eight
  `text-transform` rules went, and the labels read as the sentences the six
  catalogues always wrote. The provider badge is 16 px on the name line rather
  than 30 px beside two, the *watches, does not drive* tagline is the browser tab
  title and the brand's tooltip rather than a line of the top bar, the
  `demo data` badge is a caption rather than an outlined pill, and **the tab
  strip is not drawn until there is a second tab**. Card names (WP4g) and task
  text (N-WP15a) are untouched; this package took the noise underneath them.

## [0.1.0] — unreleased

First release. A local canvas that draws every running Claude Code session on
this machine, its subagent tree, and every past session Claude Code still keeps
a transcript for.

### Added

- **Session registry.** A two-second poll of `~/.claude/sessions` that always
  runs, with `fs.watch` and a 100 ms debounce on top of it as the fast path,
  `claude agents --json` as a liveness gate every 25 seconds, and a signal-0
  probe that holds a vanished process at `unknown` for one gate before dropping
  it. A status transition reaches the canvas in about 110 ms where `fs.watch` is
  prompt and within a poll interval plus a pass — about two seconds — anywhere
  it is not. The watch is an accelerator and never the guarantee: its delivery
  latency belongs to the platform, and on macOS a directory watch goes through
  FSEvents, which coalesces events and hands them over on its own schedule.
- **Subagent tree.** Reader for the `agent-*.meta.json` side-car files, workflow
  runs grouped by run id, and an incremental byte-offset transcript tailer that
  survives partial lines, truncation, CRLF and a BOM.
- **Exact token counts,** deduplicated by `(message.id, requestId)`. The same
  message is written once per API block with the full usage on every copy;
  without the dedupe, output tokens inflate by about 2.1x. There is a regression
  test for that trap.
- **Metadata-only extraction.** The transcript reader builds a new object from a
  closed list of fields, so no prompt, response, thinking block or tool input
  can reach memory. Two leak tests enforce it, one over ten real transcripts.
- **The canvas.** SVG and CSS, no framework: a grid of session cards, a
  hand-written layered subagent tree, pan and zoom from 0.25x to 3x, a hover
  card, keyboard-focusable nodes, dark and light themes, and a prominent banner
  plus a pulsing ring on any session waiting for you. The dot pattern behind it
  pans and zooms with the content rather than staying nailed to the window, so
  a drag reads as the eye travelling and not as the cards drifting — one
  attribute per frame, and the translation is reduced modulo one tile, which is
  exact rather than approximate because a pattern tiles with a period and
  shifting the origin by a whole one cannot move a pixel.

- **The mark: a bead drawn on a 16x16 pixel grid.** Six directions were drawn
  in `docs/design/` and the pixel bead was chosen. It is data rather than
  geometry — sixteen rows of sixteen cells, written once — and every drawing of
  it comes from that grid: the Windows application and installer icon, the tray
  icon, the browser tab's favicon, the mark in the top bar, the one on an empty
  canvas, and the one on the desktop app's starting screen. A test compares
  every copy against the design master cell by cell, in both languages, so the
  logo in the tray and the logo in the tab cannot drift apart.

  **It is sharp at the size that matters.** The application icon set is
  rendered from the grid with nearest-neighbour sampling rather than through a
  resampler, so there are **zero partly transparent pixels** in every output at
  every size, asserted from both sides — `cargo tauri icon` had been returning a
  32 px icon with 268 of them and a halo around every cell, which is invisible
  unless somebody decodes the PNG and counts. The rim is the ring of cells that
  touch an undrawn one rather than a 1 px stroke, because a stroke is a
  half-pixel line down each side of the shape it follows. Every bead on the page
  is a size the grid divides into.
- **Server.** HTTP and SSE on 127.0.0.1 with `GET /api/state`, `GET /api/events`,
  a Host allow-list against DNS rebinding, a traversal guard and a
  `default-src 'none'` content-security policy.
- **Agent history.** Finished subagents stay faded on the live canvas with a
  `done · 12m 03s` chip; a History drawer lists past sessions by project and
  opens any of them as a frozen tree with per-agent duration, exact tokens and
  tool-call count. The scanner lists by `readdir` and opens no transcript until
  a session is opened.
- **`done` detection with three named signals** — a genuine completion result,
  the session's process being gone, or a closing assistant turn quiet for 60 s.
  Silence alone never produces `done`.
- **`nazar doctor`.** Reports the resolved configuration directory, session-file
  and transcript counts, whether `claude agents --json` answers and how long it
  takes, which pinned formats could be validated on this machine and why not
  when they could not, and why the canvas would be empty. It starts no server
  and prints no path under your home directory without `--verbose`.
- **`npx @xfurqan0/nazar`.** One bundled entry plus the static canvas, packed as
  a single tarball with no workspace links to resolve. Smoke-tested on Windows,
  macOS and Linux in CI: pack, install with a cold npm cache, run, read
  `/api/state`.

- **The browser is opened through a chain, and the hint tells the truth**
  (`packages/server/src/open.ts`). One opener was one point of failure: on the
  maintainer's machine `cmd /c start "" <url>` exited 0, no browser appeared,
  and nothing in the output said anything had been attempted. Windows now gets
  three launchers tried in order — `cmd.exe /c start "" <url>`, resolved through
  `ComSpec` when the environment sets it because `cmd` looked up on a trimmed
  `PATH` is an `ENOENT` the old code discarded; then
  `rundll32 url.dll,FileProtocolHandler <url>`, the shell's own protocol handler,
  which needs no shell builtin; then `explorer.exe <url>`, whose exit code `1`
  is accepted as success alongside `0` because it answers either way. macOS gets
  `open` and everything else `xdg-open`, one each. The chain stops at the first
  link that answers, and a link that throws, errors or stays silent for three
  seconds moves it along: nothing throws, and nothing holds the terminal.

  **None of the Windows launchers can report whether a browser actually
  opened.** `start` exits 0 whether or not the shell found a handler, `rundll32`
  exits 0 unconditionally, and `explorer.exe` exits 1 even when it succeeds. So
  the canvas URL is printed on its own line *before* anything is spawned, and
  every Windows run adds `if no browser opened, open the URL above` — a line
  that is always true rather than a success Nazar cannot verify. `open` and
  `xdg-open` do fail loudly when there is no handler, so on macOS and Linux the
  same line appears only when something actually went wrong.

  **`nazar doctor` prints the same chain** it would walk on this machine,
  numbered and in order, with the confirmation gap named underneath it — so a
  machine where the canvas never appears is diagnosed with a command line to
  paste rather than a guess. `nazar --no-open` skips the whole chain, which is
  what a remote shell or a screenshot run wants.

- **Name a card** (WP4g). Click the title, or **Name this card…** in the
  card's **⋯** menu, and type: the label takes the title line and the folder
  the card was named after stays on the line below it. Enter commits, Escape
  cancels, an empty field clears the name. The name shows on the card, in the
  hover card and in a tab's tooltip, so a tab you are not looking at can say
  *release build, tray installer* instead of a count. Kept in `localStorage`
  under `nazar.names.v1`, pruned with the same rule as tab membership, and
  **never sent anywhere** — not to disk, not over the wire, and not into your
  session. Nazar cannot rename a terminal and does not try; the menu prints the
  one line that makes the two titles agree (`/rename <name>`, in that session),
  which matters because the jump matches terminal titles and not card labels.

- **Projects: folders that own a tab** (WP4g). A project is a folder path, and
  **every session whose working directory is inside it is on that tab** — live
  and in history, without filing anything. Make one from a card's **⋯** menu
  (*Make project from*, which offers every folder up the tree, so a session in
  `C:\proj\app\src` can become the project `C:\proj\app`) or from **new
  project…** in the sidebar, which previews how many live and past sessions a
  path would own *as you type it*. The deepest matching folder wins, so
  `C:\proj` and `C:\proj\app` can both exist and a session in `app` belongs to
  the second. Matching is separator-tolerant and case-insensitive as soon as
  either side looks like a Windows path. Dragging a card onto another tab still
  wins over the rule — that is a **pin**, and **Follow project** in the **⋯**
  menu is the way back. *All* still shows everything, and removing a project
  deletes the rule and nothing else.

- **A Projects section in the sidebar** (WP4g): every project with its live and
  past session counts, rename, remove, and **auto-create projects for new
  folders** — off by default, because on a machine with forty repositories that
  is forty tabs. The past column reads `—` until the transcript store has been
  read once, and one button reads it: a `0` there would be a number nobody
  measured.

- **The History drawer names the folders you have made projects of** (WP4g).
  The listing still groups by the `~/.claude/projects` directory name — that is
  all a past session carries — but a group whose slug is one of your projects
  now shows the name you gave it, with the slug beside it. Matched by exact
  slug and never by prefix: a slug turned every separator into a dash and
  cannot turn them back, so `C--proj-nazar-tray` is a *sibling* of
  `C:\proj\nazar` rather than a child, and a prefix rule would claim it.

- **Resizable cards, from any of their four corners** (WP4f). The width is the
  subagent tree's wrapping budget, so a drag **re-lays the tree out** rather than
  scaling it: pull a card wider and the tree spreads into more columns, narrower
  and it wraps into more rows. The height follows the tree and is not the user's
  to set. A card cannot be dragged narrower than the tree that is *showing*
  needs — a minimum measured by laying that tree out one subtree per row, not
  guessed — so folding the tree away or clearing its finished agents drops the
  floor. Widths are kept per session in `nazar.layout.v1`; **Arrange** respects
  them, **Fit** is unchanged, and **Reset width** in the **⋯** menu gives a card
  back to the automatic sizing.

- **Clear finished subagents** (WP4f), from the card's **⋯** menu. On a session
  that has run for hours the finished agents are what push the running ones off
  the screen. This hides them — and hides is the word: nothing is deleted, a
  `6 finished hidden · show` chip on the card brings them all back in one click,
  and the History panel shows the run entire. A finished agent that spawned one
  still running stays put, because taking it would orphan its child. Kept per
  session in `nazar.layout.v1`. **Hide subagents** (the chevron) is unchanged and
  does the other thing: it folds the whole tree away to a row of chips.

- **Nazar explains a missing cost and context window** (WP4f). `nazar-statusline`
  installs itself at the **user** level, and Claude Code merges a project's own
  settings over the user's — so a repository that sets `statusLine` for itself
  *replaces* the wrapper for every session started in it. The wrapper never runs,
  no capture is written, and cost and context are absent on exactly those cards
  on a machine where everything is installed correctly. A session with no capture
  after ninety seconds now has its project checked, **read-only**, for one key;
  when it overrides, the card carries *cost/context: this project overrides the
  status line* on the line those numbers would have used, and `nazar doctor`
  lists the offending files with the exact key and both fixes — pointing the
  project's `statusLine` at `nazar-statusline` as well, or removing the key.

- **A project's own `.claude/settings.json` became a read path** (WP4f) — one
  key, read-only, and the thing that makes the diagnosis above possible. Because
  it is the first file Nazar reads out of your repository rather than out of your
  home directory, it is described under **Security** below rather than here.

- **Sticky notes on the canvas** (WP4e). **Add note** in the sidebar, a
  double-click on empty canvas, or **Add note here** from the canvas's own
  right-click menu. A note is a draggable, resizable, editable card: plain text
  up to 2,000 characters, four colours that follow the theme, delete from its
  **⋯** menu. Notes belong to a tab, pan and zoom with the canvas, and closing a
  tab moves its notes to *All* rather than deleting them. They are kept in
  `localStorage` under `nazar.notes.v1` and **never leave the browser** — not to
  disk, not over the wire, not to Claude Code.

- **Two more themes, and your own frame colours** (WP4e). **Sepia** (warm paper)
  and **Midnight** (near-black with saturated states, plus a pure black-on-white
  light mode) join Nazar and Graphite, each with its own light and dark mode and
  each picking its own activity colours — a gate now measures every palette
  against every other, because a theme that only changes the background is not a
  theme. The picker is in the sidebar and its list comes from the same array the
  stylesheet is generated from. Under **Colours**, the five activity colours
  (working, idle, done, waiting, unknown) can each be overridden with a colour
  picker, kept in `nazar.colours.v1` and applied as CSS custom properties. Each
  shows its contrast against a card; the number is a hint and never a refusal,
  and the contrast gate stays on the palettes Nazar itself ships.

- **Right-click does something useful** (WP4e). On a card it opens that card's
  **⋯** menu at the pointer instead of the browser's; on empty canvas it offers
  **Add note here · Arrange · Fit**. Inside a note the browser's own menu is left
  alone — that is where Cut, Paste and the spell-checker live — and so it is on a
  frozen history tree, where every entry would be refused.

- **Usage limits in the top bar, and cost and context window on every card** (WP3′ + WP5 + WP4e).
  Three numbers the transcripts cannot answer — how much of your rate-limit
  window is spent, what a run has cost, how full its context window is — now
  reach the canvas, from the two files [nazar-tray](https://github.com/xfurqan0/nazar-tray)
  and its status-line wrapper leave under `~/.nazar`. They are called *usage
  limits* everywhere a person reads them — the panel, the sidebar, `nazar
  doctor` and the README; "quota" is jargon and the thing it names is not.
  Code identifiers, the wire format, `limits.json` and nazar-tray's contract
  keep the older word.

  **Both sources are optional and Nazar installs neither.** All three numbers
  come from Claude Code's status line, and installing a status line means
  writing into `~/.claude` — which Nazar does not do, at all, by design.
  nazar-tray does it, on purpose, with a shown diff and an exact uninstall;
  Nazar reads what it leaves behind. With neither installed the strip is not
  drawn and the two hover-card rows are not there: nothing is shown as `0`, and
  nothing says `unknown` forever.

  **One bead at the leading edge of the top bar**, filled by the window you are
  closest to spending — the *binding* one, recomputed rather than believed, and
  the fullest across providers — with that window's percentage beside it.
  Clicking it opens a panel listing every window, under a line saying what a
  usage limit is; whether the panel is open is remembered, so leaving it open is
  a permanent strip. It is a bead rather than a band across the page because the
  number moves a few times an hour and is looked at twice a day, and 60 px of
  canvas spent all day on a question asked twice is the wrong trade.

  **In the panel:** one bead-fill per provider window, filling as the window is
  spent, with a bar underneath for comparing six of them at a glance: blue below
  60 %, amber from 60, red from 85, and **grey with the word `unknown` for a
  window that could not be read**, which is never drawn as `0 %`. Percentages
  round *down*, because 99.6 % is not 100 %. Each item carries a countdown to
  its reset in your own time zone and, once a reading is old enough to matter,
  how old it is. Two rules survive the collapse into one bead and are worth
  stating because that is exactly how rules get lost: a window with no reading
  cannot become the bead while any window has one, and with no reading anywhere
  the bead is grey and says `unknown` rather than sitting at a reassuring zero.
  The fill rises a whole cell at a time, which is the only way a hard-edged mark
  stays hard-edged while part of it moves.

  **What you get depends on what you install.** nazar-tray gives everything:
  both providers, the five-hour and weekly windows, the **model-scoped
  weeklies** (`weekly Fable`) that exist in no other source, a plan name, and
  **Codex quota** — plus the wrapper, so cost and context window come too. The
  wrapper alone gives Claude's two global windows, cost and context window; a
  status-line payload carries nothing else. `limits.json` wins over a capture
  when both are there, and the two are never merged: two readings of one window
  taken seconds apart would put two different numbers for one quantity on one
  strip.

  **On the cards:** `cost $9.60` and `context 54 %`, each on its own row and
  each labelled — a number with no word in front of it is invisible in a column
  of numbers, and `ctx` is jargon for a thing the rest of the interface spells
  out. The context figure takes the same amber-at-60 red-at-85 severity the bead
  does, and the exact counts (`159,283 / 1,000,000 (16%)`) stay one hover away,
  where there is room for them. Both rows *appear* when there is a source rather
  than saying `unknown` on every machine without one, and the card does not
  change size either way. Subagents have neither: the status line reports a
  session, and splitting one session's cost across its tree would be an invented
  number.

  **`nazar doctor` reports both sources** — whether each is there, how many
  captures and how old the newest is, what `limits.json` says, and which source
  the strip would draw from — and prints the wrapper's own
  `nazar-statusline install --dry-run` when there is nothing to read. It prints
  it; it never runs it.

  **Privacy.** A capture is the *whole* status-line payload, so it holds your
  working directory, your transcript path, your scratchpad directory and your
  repository name. Nazar reads four things out of it — cost, context window,
  effort, rate limits — and nothing else: the parser builds a new object from a
  closed list rather than filtering a parsed one, and a test plants a sentinel
  in every one of those path fields and fails if it appears in the output.
  Captures stay in `~/.nazar`; nothing is uploaded, by either project. Nazar
  reads that directory and never writes to it, and the same static gate that
  proves it cannot write to `~/.claude` now covers `~/.nazar` too.

- **A desktop app for Windows, and a jump from a session card to its terminal**
  (WP8, pulled forward out of v2). `nazar-desktop_0.1.0_x64-setup.exe` ships
  beside the npm package on each release. It is a Tauri v2 window and a tray
  bead around **the same canvas** — it starts the very package `npx` runs, on a
  free loopback port, and shows it. There is no second build of the page and no
  desktop-only fork of it.

  **Jump to terminal** is what the app is actually for. Double-click a session
  card, press <kbd>Enter</kbd> on it, or pick *Jump to terminal* from the card's
  `⋯` menu, and the terminal running that Claude Code session comes to the
  front. A browser tab cannot raise another program's window; that is the whole
  argument for the app existing at all.

  It works by walking up the process tree from the session's pid — bounded,
  cycle-guarded, over one `CreateToolhelp32Snapshot` — until it finds an
  ancestor owning a top-level window, preferring the terminals it knows
  (`WindowsTerminal`, `conhost`, `OpenConsole`, `Code`, `cursor`, `mintty`,
  `alacritty`, `wezterm-gui`) over a nearer stranger, and then does the Windows
  foreground dance: restore if minimised, `AttachThreadInput` to the current
  foreground thread, `SetForegroundWindow`, and `SwitchToThisWindow` as the
  fallback — with `GetForegroundWindow` read back afterwards, so what you are
  told is what happened.

  **One thing it cannot do, stated rather than hidden.** It does not open the
  integrated terminal panel in VS Code or Cursor — the editor window comes
  forward, and which panel it shows is the editor's business. macOS and Linux
  say "not supported yet" rather than doing nothing.

- **The jump finds the right Windows Terminal *tab*, and with it the right
  window** (WP8b; `crates/nazar-shell/src/tabs.rs`, `apps/desktop/src/titles.rs`
  and rung (b) in `apps/desktop/src/jump.rs`).

  **The report was "it always opens the same one".** Four Claude Code sessions,
  four Windows Terminal windows, and every double-click raised the same window.
  The cause was a sentence in the note above, which was half right: *all tabs of
  one window share one `WindowsTerminal.exe`, so the right window always comes
  forward*. The first half is true. The second does not follow, because
  **Windows Terminal hosts every window it has in one process** — four windows
  on four monitors are one pid. The parent-chain walk produced four candidates
  agreeing on host, on depth and on pid, and the ranking fell through to its
  stable tie-break, the window handle. Nothing was broken; the evidence had run
  out.

  **What was missing was a key, not a tab index.** There is one and it is on
  screen: Claude Code writes the session's generated title into the terminal
  title, with a status mark in front of it — `◐ Refactoring the settings reader`
  for a session titled `Refactoring the settings reader`. So the jump now reads
  the tabs through **UI Automation**, the interface `inspect.exe` uses, and
  matches them against what the session is called: the generated title from the
  tail of its transcript first, then a name `/rename` gave it, then the
  registry's derived name, then the working directory's last segment. Three
  tiers per key — the raw strings, the strings with the status mark trimmed off
  both ends, and a normalised form — and the tab that matches is selected with
  `SelectionItemPattern.Select()` before the window holding it is raised.

  **`wt.exe` is never invoked.** Its `focus-tab --target <index>` would work now
  that the index is known, but selecting the element already in hand does the
  same thing without spawning a process and without a command line to get wrong.

  **It declines rather than guesses.** No key matching means the window is
  raised, the outcome says why, and the canvas adds *"name the session with
  /rename and its tab can be found"* — but only when there was more than one tab
  to tell apart, because on a single-tab terminal that advice is noise on top of
  a jump that worked. Two tabs sharing a generated title resolve to the front
  one and report `ambiguous`. A *directory name* matching two tabs is discarded
  instead: it was never an identifier. And only Windows Terminal is searched at
  all — VS Code and Cursor publish `TabItem` elements too, for **editor** tabs,
  and selecting one of those would be confidently wrong.

  The lookup runs on **its own thread with a 1.5 s deadline**, because a UI
  Automation call is a blocking call into another program's UI thread and the
  shell's message loop must not wait on one. Overrunning it costs the tab and
  nothing else. Measured here: four windows answer in a small fraction of that,
  and a whole `--jump` — process start, process snapshot, window enumeration,
  transcript tail, tab lookup and the foreground dance — is **179-217 ms**
  against a **79 ms** floor for the same binary doing none of it.

  **One new source is read**, and `docs/pinned-internal-formats.md` carries the
  row: the `aiTitle` of the last `ai-title` line of a session's transcript, by
  the desktop shell alone, as a 1 MB tail scanned backwards that stops at the
  first such line. `packages/core` still skips every `ai-title` line and its
  leak tests are untouched; the title's only destinations are a string
  comparison and the sentence the jump has reported since WP8. The outcome JSON
  gains a `tab` object — `matched`, `title`, `index`, `window`, `source`,
  `tier`, `ambiguous`, `selected`, `candidates`, `reason` — and `rung` reads
  `"b"` when the tab was identified.

  The rest of the app is the part you leave running: the close button minimises
  to the tray, the bead's left click shows the window and its right click gives
  **Open · Refresh · Quit**, `--hidden` starts into the tray, a *start with
  Windows* switch lives in the sidebar, and a second launch focuses the first
  window rather than starting a second server.

  **No Node runtime is bundled, and that is an argument rather than a
  shortcut**: Claude Code is itself a Node program, so a machine with sessions
  worth watching already has Node on `PATH`. The app checks for 22 or newer at
  start-up and, when it is missing, shows a window saying exactly that — with
  the download address and whatever `nazar doctor` could still produce — rather
  than an empty canvas.

  **Browser mode is unchanged.** `npx @xfurqan0/nazar` is still the install-free
  entry point and still first-class. Inside the shell the canvas detects
  `window.__TAURI__` and adds the jump; in a browser the menu entry is not
  drawn, and a double-click says where the feature lives instead of failing
  silently.

- **You can see which sessions are working.** Every card — session and subagent
  — is now framed in the colour of what it is doing, with the word on the card
  next to it: **working** in green, and the frame breathes (1.6 s in and out,
  never a flash); **idle** in blue and fixed; **done** in grey-blue and fixed;
  **waiting** keeps its amber frame, banner and ring, and beats working, because
  a session waiting for a permission prompt is also a busy one; **unknown** stays
  dashed grey. A frozen history tree is all fixed colour — nothing in the past
  moves. `prefers-reduced-motion` stops the breathing and leaves the word.

  A session counts as working when Claude Code says it is `busy` **or its
  transcript was appended to in the last 30 seconds**: the session file lags
  behind the transcript, so a card reading `idle` while the model was mid-turn
  was the common case and not the rare one. A failed liveness probe still beats
  a fresh write — a transcript flushed a second before a process died does not
  bring it back. One pure function, `activityOf`, decides this for both node
  types and is tested as a table with the clock injected.

  New theme token `stateWorking` in both themes (`#3FE3A6` dark / `#0F8A5F`
  light for Nazar, `#5CCFA8` / `#12805A` for Graphite), added to the contrast
  gate — which now measures every state colour against **both** card surfaces.
  It is a green rather than the accent because `stateAlive` already *is* the
  bead's light blue, so a working frame drawn in the accent would have been the
  same colour as a resting one. The four bead hexes are unchanged.

  The demo canvas gained a fourth session, alive and idle, because a canvas on
  which nothing is resting cannot show the difference the frames exist to draw;
  `?demo=1` now defaults to whatever the fixtures hold rather than a hard-coded
  three. Subagent cards are 14 px taller: the activity word gets a line of its
  own rather than being squeezed beside a twenty-character token total, and the
  `orphan` marker moved down to share it.

- **Sessions go where you put them.** Drag a card by its header — the body still
  pans the canvas — and the position is remembered per session id in
  `localStorage` under `nazar.layout.v1`. A session that has just appeared takes
  the first free slot instead of landing on anything you have arranged.
  **Arrange** re-packs everything width-first; **Fit** frames what is on screen.
- **Several canvases, as tabs.** A tab bar above the canvas: *All* shows every
  session and is the fallback for anything unfiled, and you can add a tab,
  rename it (double-click), remove it, and move a session onto it either from
  the small menu on the card or by dragging the card onto the tab title. A
  session lives on exactly one tab. <kbd>Ctrl</kbd>+<kbd>1</kbd>..<kbd>9</kbd>
  switch. Stored in `nazar.tabs.v1`, and memberships for sessions that are
  neither running nor still in history are dropped on load.
- **A left sidebar** behind a hamburger button: theme, arrange, fit, the history
  drawer, the demo switch, and an About block with the version. The counts, the
  connection pill and the waiting banner stay in the top bar, where they can be
  read without opening anything. <kbd>m</kbd> toggles it, and open or closed is
  remembered.
- **Fold a big tree away.** A chevron on the card collapses the subagent tree to
  a summary line — `60 subagents · 37 running · 22 done` — and the folded card
  shrinks to one column. Folding removes the nodes from the document rather than
  hiding them. Remembered per session id.

- **`nazar doctor` explains a missing status-line capture, per session**
  (N-WP9). It printed "3 live processes" in one section and "1 capture" in
  another and never subtracted one from the other, which is the question a
  person runs it to answer. Every live session without a capture now gets a line
  naming the likeliest reason: a `statusLine` its own project sets (checked in
  the working directory **and every directory above it**, because Claude Code
  merges a project's settings with its ancestors'), a user-level status line
  that is not the wrapper, a session that started before the wrapper was
  installed — dated by the wrapper's own backup file where there is one, and the
  report says when it had to fall back to the settings file's modification time
  — or, when nothing else fits, a status-line tick that has not happened yet,
  since Claude Code runs the status line after a turn. Reading
  `~/.claude/settings.json` for one key is what the last three need, and it is a
  read: the static gate still fails the build on any shipped source that could
  write anything, anywhere.

### Fixed

- **`nazar doctor -v` runs doctor instead of printing the version, and an
  unknown flag is refused** (N-WP9). `-v` was the short form of `--version`, and
  the parser searched the whole argument list for it without noticing that
  `doctor` had already claimed the line — so the one flag doctor documents did
  the one thing doctor does not. `-v` and `--verbose` now belong to `doctor`;
  `--version` and `-V` are the top level's; each level validates its own flags,
  and **anything else beginning with `-` exits 2 with a line naming the flag**
  rather than being silently ignored, which is what `nazar --prot 8080` used to
  be. Typing `-v` at the top level names both of the things it could have meant,
  since this program is the reason it is ambiguous.

- **The desktop app keeps your canvas between launches** (N-WP9). It asked the
  operating system for a fresh loopback port every time it started, and
  `localStorage` is keyed by origin — which includes the port — so the layout,
  tabs, projects, card names, sticky notes, colours and usage panel came up
  empty on every launch. The port is chosen once, stored in
  `%APPDATA%\nazar\desktop.json`, and reused; if something else has taken it,
  the shell asks what is there, and a healthy Nazar of the same version is
  *shown* rather than duplicated — and never killed on Quit, because it belongs
  to whoever started it. Only a port that genuinely cannot be used is abandoned,
  and then the arrangement is lost once. A fixed default would have been worse
  than either: 4676 is what `npx @xfurqan0/nazar` binds, and the two copies would
  have taken it from each other.

- **The desktop jump honours `CLAUDE_CONFIG_DIR`** (N-WP9). The canvas has
  honoured it since WP1 and the shell's title reader had not, so on a machine
  that had moved its Claude Code configuration directory every card drew
  correctly and every jump found nothing — it was looking for a session registry
  where Claude Code had stopped writing one.

- **The plural helper pluralises** (N-WP9). It added `s` and nothing else, so
  `2 entrys` was one new call site away; every caller that needed `entries`,
  `directories` or `processes` had been passing the plural by hand, which is how
  a broken helper survives a review. Consonant + `y` now becomes `ies`,
  sibilants take `es`, and a table test covers 0, 1, 2 and both endings.

- **The committed `package-lock.json` described a package that no longer
  existed** (N-WP9): version `0.0.0` against a manifest at `0.1.0`, and a `bin`
  path that moved in WP6. Neither could break an install — a lockfile's root
  entry describes the workspace rather than instructing it — but both were
  wrong for anyone reading the repository to find out what this is. Regenerated,
  and `npm test` now fails if the version, the `bin` or any workspace package
  drifts from `package.json` again.

- **The licence allow-list had two copies** (N-WP9). `scripts/check-licenses.mjs`
  carried its own list of the fifteen SPDX identifiers in `deny.toml`, kept in
  step by hand and compared by nobody. `cargo deny` cannot read a JavaScript
  array, so the script reads the TOML now; a `deny.toml` it cannot parse is an
  error rather than a quiet fall back to whatever it remembered.

- **Real session titles were baked into the Rust test data** (N-WP9): generated
  titles, derived registry names and one session id copied off the maintainer's
  machine, in `apps/desktop/src/titles.rs` and `crates/nazar-shell/src/tabs.rs`.
  All of it is made-up data now, and the assertions are unchanged — what those
  tests check is the *shape* of a title and a match, never the words in one.

- **Jump no longer sends an untitled session to somebody else's terminal**
  (WP8c). Measured on the maintainer's machine: five Claude Code sessions, five
  Windows Terminal windows, three found by title and **two that landed on a
  third session's terminal** — which he experienced as "jump goes to the current
  terminal". Both misses had the same cause and it was not the one that looked
  likely: the two sessions had **no `ai-title` line anywhere in their
  transcripts**, not merely past the megabyte the reader scans. Claude Code had
  not titled them yet, so their terminals still read `✳ Claude Code`, nothing
  matched, and the ladder fell through to rung (a) — whose last tie-break is the
  window handle, which carries no information at all. "The lowest handle of five"
  is a coin toss with a stable outcome, which is exactly why it looked like the
  same window every time.

  Three changes, and none of them guesses. **Exclusion by ownership**: before
  answering for a session, every *other live* session is matched against the same
  tabs by the same code, and a window one of them is demonstrably in is not this
  one's; exactly one left over is the answer (`rung: "b-exclusion"`). **The
  default title, once**: if several are still left and this session is known to
  have no title of its own, a single remaining window still showing Claude Code's
  own title is that session's (`rung: "b-default"`). And **rung (a) may now raise
  only when the host owns exactly one candidate window** — conhost, mintty, a
  single VS Code window, which is most machines most of the time. When nothing
  can separate them, **nothing is raised**: `rung: "none"`, and the hint says how
  many windows could have been this session and asks for `/rename`. Raising an
  arbitrary window is worse than raising none, because a person cannot tell a
  lucky guess from a right answer and will trust the next wrong one.

  The liveness filter on that list is a correctness requirement rather than a
  saving — a session that has ended leaves its registry file and transcript
  behind, and letting a ghost claim a window can leave the *wrong* one over — so
  it is filtered against the process snapshot the jump already took, and a test
  in `nazar-shell` fails if the filter is ever dropped. The jump's report gained
  `route`, `others`, `owned` and `unclaimed` so a surprising answer can be read
  rather than guessed at.

- **The jump to a terminal cannot start one, and now a test says so** (WP4e). The
  maintainer reported seeing "a terminal open" during a jump; what he saw was an
  existing window coming forward, which is the entire feature. Two tests hold the
  line — one reads the jump's own source and fails on any process-creation call,
  the other snapshots the process table around a real jump and fails if anything
  terminal-shaped appears — and the README says what a jump does.

### Security

- Binds 127.0.0.1 only, never a routable interface, and the address is not
  configurable.
- Writes nothing, anywhere, enforced statically: a test reads every shipped
  source and fails if one imports a filesystem call that could write, or opens a
  file handle without the `'r'` flag. Naming Claude Code's settings files is an
  allow-list rather than a ban (`test/no-writes.test.ts`): exactly three shipped
  files — `packages/core/src/project-settings.ts`,
  `packages/core/src/index.ts` and `packages/server/src/doctor.ts` — may name a
  *project's* `settings.json`, and only the first two may name the **user-level**
  `~/.claude/settings.json`. A fourth file naming either, anywhere in the tree,
  fails the build. Both are read for one key and neither can be written: the
  reader's whole set of filesystem imports is pinned to `readFile`, `readdir`
  and `stat`, and precision mode (v1.1) is still the only thing that will ever
  change one, with a backup, a shown diff and an exact uninstall.
- Never opens the `<pid>.<hash>.key` credential files that sit beside the
  session files; the reader accepts `<digits>.json` and a test asserts it.
- Working directories, session names and project labels pass through a
  redaction gate that masks credential-shaped strings, collapses the home
  directory to `~` and truncates to 80 characters before anything is served.

- **Three settings files are read paths, for one key each.** A *project's*
  `.claude/settings.json` and `.claude/settings.local.json` (WP4f) were the first
  things Nazar read that live in the user's repository rather than in their home
  directory; `~/.claude/settings.json` joined them in N-WP9, so `nazar doctor`
  can say whether the status-line wrapper is installed at all and roughly when.
  The key is `statusLine.command` and nothing else is looked at; each path has
  its own row in `docs/pinned-internal-formats.md` and its own gate in
  `packages/core/test/pinned-paths.test.ts`. What "untouchable" means for the
  user-level file was narrowed deliberately and is now said exactly: it may be
  read and it may not be written, and the no-writes gate still proves nothing in
  the program can write anywhere.

- The arrangement, the tabs and the folded trees live in the browser's
  `localStorage` on the page's own origin and nowhere else. Nazar still writes
  nothing to disk, and the static gate that proves it is unchanged — it only
  narrowed its `open(` search to files that actually import `open` from
  `node:fs`, which is where an `fs.open` can be.

- The page is served under `style-src 'self'`, so an inline `style` attribute is
  dropped by the browser rather than applied — and the page's own sources are
  read by a test that fails the build if one writes `setAttribute('style', …)`.
  Widths and colours go through the CSSOM, which the policy allows and which no
  injected attribute can reach.

- The jump raises a window only when exactly one candidate is left after every
  other live session's tabs have been accounted for; when several are still
  possible it raises nothing and reports how many it could not choose between.
  See *Jump no longer sends an untitled session to somebody else's terminal*
  under **Fixed** for how that is worked out.

### Known limits

*Not one of Keep a Changelog's headings but a deliberate extension of them,*
because a first release is exactly when these are worth stating.

The usage-limits bead, cost and context window need
[nazar-tray](https://github.com/xfurqan0/nazar-tray) or its status-line wrapper
installed; with neither, all three are hidden entirely — nothing is drawn as `0`
and nothing stands in as a placeholder, because a number Nazar does not have is
a number it does not show. The desktop app and its jump are Windows-only; macOS
and Linux say "not supported yet" rather than doing nothing. The jump refuses
rather than guessing when several windows could still be one session, and says
how many it could not choose between. The desktop installer is unsigned, so
Windows SmartScreen warns on first run. Claude Desktop and VS Code sessions are
invisible to `claude agents --json`; a subagent's node appears when its
transcript starts; transcript writes are asynchronous, so totals lag by seconds
and the age of the last write is shown; history reaches back only as far as
Claude Code's own retention. See the README for the full list.

[Unreleased]: https://github.com/xfurqan0/nazar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xfurqan0/nazar/releases/tag/v0.1.0
