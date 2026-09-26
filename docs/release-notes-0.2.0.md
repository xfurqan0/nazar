# Nazar 0.2.0

**Keep a nazar on your agents.** A local canvas that draws every running Claude
Code session on your machine, its subagent tree, every past session Claude Code
still keeps a transcript for, and Codex threads beside them.

```
npx @xfurqan0/nazar
```

Node 22 or newer. Nothing is installed into Claude Code, nothing is written
anywhere, and nothing leaves the machine.

**If your canvas ever sat on *connecting…* and a reload did not help, this is
the release that fixes it.** It happened to anyone who left the menu drawer
open, in the browser and in the desktop app alike, and every earlier build has
it. On 0.1.0, closing the drawer with the menu button and reloading gets the
canvas back.

Or take a desktop bundle from the downloads below: the same canvas in a window
with a tray icon, and one thing a browser tab cannot do — **double-click a
session card and its terminal comes to the front**, which is Windows-only for
now. It needs the same Node 22, which Claude Code already required, so no
runtime is bundled.

- **Windows** — `nazar-desktop_0.2.0_x64-setup.exe`. Unsigned, so SmartScreen
  warns on first run: *More info · Run anyway*.
- **macOS** — one `.dmg` for Apple silicon, one for Intel; take the one that
  matches your machine, and macOS 12 or newer. They are ad-hoc signed and not
  notarised, so Gatekeeper will refuse a normal double-click: **right-click the
  application and choose Open**, then Open again in the dialog, and macOS
  remembers the decision for that copy.
- **Linux** — an `.AppImage` that runs anywhere with glibc 2.35 or newer, and a
  `.deb` for Debian and Ubuntu that declares its dependencies
  (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`), **now in
  an x86-64 and an arm64 flavour each**; `uname -m` says which pair is yours
  (`x86_64` or `aarch64`). The arm64 packages are tested in CI on an arm64
  runner, not yet on hardware. A download arrives as a zip and a zip carries no
  executable bit, so the AppImage needs it back:
  `chmod +x nazar-desktop_*.AppImage`.

`xfurqan0-nazar-0.2.0.tgz` is attached too: it is the package that is on npm,
the same file on all three platforms.
[docs/PLATFORMS.md](https://github.com/xfurqan0/nazar/blob/main/docs/PLATFORMS.md)
says exactly what each of the three gets.

## What changed

- **A drawer left open no longer stops the canvas connecting.** Restoring the
  remembered drawer on load threw before the page opened its stream, and the
  drawer was still remembered as open on the next load, so a reload did not
  help. `npm test` now loads the real canvas in a headless browser, opens the
  drawer and reloads, so this cannot come back unseen.
- **Linux desktop bundles for arm64**, built natively on an arm64 runner on the
  same `ubuntu-22.04` base and glibc floor as the x86-64 pair.
- **The server no longer outlives the desktop app on macOS or Linux.** Killing
  the app used to leave its `node` server holding the port; the server now runs
  in its own process group, gets a death signal on Linux, and exits with its
  parent everywhere (`nazar --exit-with-parent`).
- **On Linux, the jump says which no.** A double-click on Wayland now says the
  compositor does not allow raising another program's window and points at the
  terminal's own window switcher; on X11 it says the port is not written yet.
- **A Codex store that Codex compressed is named, not reported as empty.**
  Rollouts Codex rewrote as `.jsonl.zst` are counted and never opened, and
  `nazar doctor` says *compressed, not readable yet* with the count, instead of
  reporting a store with nothing in it.
- **One tour instead of twenty-three screenshots** at the top of the README: a
  twenty-six second recording of the canvas in use, with every still kept in
  the screenshot gallery.

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
  line, which Codex does not have. Rollouts Codex has compressed are counted but
  not read.
- The jump to a terminal is Windows-only. It raises the window and, on Windows
  Terminal, selects the session's own tab within it; when several windows could
  be the same session it raises nothing and says so rather than guessing. The
  macOS app answers the same gesture with *not available on this platform yet*,
  and the Linux app says why: Wayland does not allow it, and X11 is not written
  yet.
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
