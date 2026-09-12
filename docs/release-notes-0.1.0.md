# Nazar 0.1.0

**Keep a nazar on your agents.** A local canvas that draws every running Claude
Code session on your machine, its subagent tree, and every past session Claude
Code still keeps a transcript for — and Codex threads beside them, from the
rollout store Codex already writes.

```
npx @xfurqan0/nazar
```

Node 22 or newer. Nothing is installed into Claude Code, nothing is written
anywhere, and nothing leaves the machine.

Or take a desktop bundle from the downloads below: the same canvas in a window
with a tray icon, and one thing a browser tab cannot do — **double-click a
session card and its terminal comes to the front**, which is Windows-only for
now. It needs the same Node 22, which Claude Code already required, so no
runtime is bundled.

- **Windows** — `nazar-desktop_0.1.0_x64-setup.exe`. Unsigned, so SmartScreen
  warns on first run: *More info · Run anyway*.
- **macOS** — one `.dmg` for Apple silicon, one for Intel; take the one that
  matches your machine, and macOS 12 or newer. They are ad-hoc signed and not
  notarised, so Gatekeeper will refuse a normal double-click: **right-click the
  application and choose Open**, then Open again in the dialog, and macOS
  remembers the decision for that copy.
- **Linux** — an `.AppImage` that runs anywhere with a recent enough glibc, and
  a `.deb` for Debian and Ubuntu that declares its dependencies
  (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`), both
  x86-64. A download arrives as a zip and a zip carries no executable bit, so
  the AppImage needs it back: `chmod +x nazar-desktop_*.AppImage`.

`xfurqan0-nazar-0.1.0.tgz` is attached too: it is the package that is on npm,
the same file on all three platforms.
[docs/PLATFORMS.md](https://github.com/xfurqan0/nazar/blob/main/docs/PLATFORMS.md)
says exactly what each of the three gets.

## What it does

- One node per running session, with its subagents as a tree underneath.
- A prominent banner on any session waiting for a permission prompt, and a
  **Needs you** strip that says which one to answer first, how long it has been
  waiting, and what finished while you were away.
- Exact token counts, deduplicated by `(message.id, requestId)` — a naive sum
  inflates output tokens by up to about 2.5x.
- Cards you place yourself, on tabs and on folder tabs that file a session by
  the directory it runs in, with names, sticky notes, resize from any edge or
  corner, four themes and your own frame colours.
- A History panel that opens any past session as a frozen tree with per-agent
  duration and tokens, grouped by project.
- Usage limits, cost and context window, when the sibling tool that owns the
  status line is installed — and nothing at all when it is not.
- **Codex threads on the same canvas**, read from `~/.codex/sessions`. Nothing
  installed, nothing configured, and a machine without Codex is unchanged.
- **Another machine's agents**, over one `ssh` per host —
  `nazar --remote build-box` — with no port opened, no token stored and nothing
  installed on the far end.
- Six UI languages: English, Türkçe, 中文, 한국어, Русский, Español.
- A 250 ms tick when a session ends, with quiet hours, so a long run can finish
  while you are looking at something else.
- Metadata only: no prompt, response or tool input is read. The one exception is
  off by default and off in three independent places — a single line saying what
  a session was last asked to do.
- `nazar doctor` explains an empty canvas without starting the server.

## Known limits

- Usage limits, cost and the context window come from Claude Code's status
  line, which means installing [nazar-tray](https://github.com/xfurqan0/nazar-tray)
  or its wrapper. Without one the bead is hidden and the two card rows are not
  drawn — nothing is shown as `0`.
- Claude Desktop and VS Code sessions do not appear.
- A subagent's node appears when its transcript starts.
- Transcript writes are asynchronous, so totals lag by seconds — the age of the
  last write is shown.
- History reaches back only as far as Claude Code's own retention.
- A Codex card knows less than a Claude Code card, and says so: a rollout
  carries no process id, so there is no jump and the card says *pid unknown*;
  Codex records the approval *policy* and never a request, so a Codex thread is
  never shown as waiting; and cost and context window are Claude Code's status
  line, which Codex does not have.
- The jump to a terminal is Windows-only. It raises the window and, on Windows
  Terminal, selects the session's own tab within it; when several windows could
  be the same session it raises nothing and says so rather than guessing. The
  macOS and Linux apps answer the same gesture with *not available on this
  platform yet*.
- On Linux the tray is a menu only — the desktop environment owns the click — so
  *Open · Refresh · Quit* is the whole tray interaction and the window is opened
  from the menu rather than by clicking the bead.
- No bundle is signed the way a desktop trusts on sight: the Windows installer
  is unsigned, so SmartScreen warns until the download builds reputation, and
  the two `.dmg` files are ad-hoc signed rather than notarised, so the first
  launch needs the right-click · **Open** above.

Full list in the [README](https://github.com/xfurqan0/nazar#known-limits).

## Verify

```
npm view @xfurqan0/nazar dist.shasum
```

MIT licensed.
