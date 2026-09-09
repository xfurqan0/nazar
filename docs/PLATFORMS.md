# Platforms

Nazar is two programs sharing one canvas. **The browser one** — `npx @xfurqan0/nazar` —
is Node and nothing else, and it has run the same on Windows, macOS and Linux since the
first commit; the CI matrix builds and tests it on all three on every push. **The desktop
one** is a Tauri shell around that same server, and it is the reason this file exists: it
is a native application, so what it can do depends on which desktop it is standing on.

This page says exactly what each of the three gets today. It is written so that nobody has
to find out by installing.

## What each platform gets

| | Windows | macOS | Linux |
|---|---|---|---|
| **Browser mode** (`npx @xfurqan0/nazar`) | yes | yes | yes |
| **Desktop bundle** | `.exe` (NSIS, per-user install) | `.dmg` — one for Apple silicon, one for Intel | `.AppImage` and `.deb` (x86-64) |
| **Tray icon** | yes; left click shows the window, right click opens the menu | yes, in the menu bar, drawn as a template icon so it follows light and dark | yes, as an AppIndicator **menu only** — see below |
| **Close minimises to the tray** | yes | yes | yes |
| **Start at login** | yes, *start with Windows* | yes, *start with macOS* (a LaunchAgent) | yes, *start at login* (a `.desktop` entry in `~/.config/autostart`) |
| **Jump to the terminal** | yes, including the right tab in Windows Terminal | **not yet** | **not yet** |
| **Signed** | no | ad-hoc only, **not** notarised | not applicable |
| **Built on** | every push | on a tag or by hand | on a tag or by hand |

The desktop bundles for macOS and Linux come out of the `desktop bundle` job in
`.github/workflows/ci.yml`, which runs on a `v*` tag or on `workflow_dispatch` and not on
an ordinary push. A macOS runner costs ten times a Linux one per minute and none of these
three artifacts decides whether a change is correct — the jobs that do (`build`, `pack
smoke`, `shell logic`) run everywhere, on everything.

## macOS

**The first launch needs one deliberate gesture.** The `.dmg` is ad-hoc signed — there is
no Developer ID certificate behind it and it has not been through Apple's notary service —
so Gatekeeper will refuse a normal double-click with *"nazar-desktop" cannot be opened
because Apple cannot check it for malicious software*. Two ways past it, and both are
things you are choosing to do rather than things a warning tricked you into:

- **Right-click the application and choose Open**, then Open again in the dialog. macOS
  remembers the decision for that copy.
- Or clear the quarantine flag from a terminal:

  ```sh
  xattr -d com.apple.quarantine /Applications/nazar-desktop.app
  ```

Notarisation costs $99 a year and would remove the gesture. It is not worth it for a
project with an unknown number of users; the trigger to revisit is a download count, the
same trigger as the Windows code-signing certificate in `docs/PROJECT.md` §7.

**Two bundles, and you want the one matching your machine.** `nazar-desktop-macos-arm64`
is for Apple silicon, `nazar-desktop-macos-x64` for Intel. There is no universal binary:
two `.dmg` files are two downloads, a universal one is a single download twice the size
for everybody, and the CI matrix produces both from the same runner either way.

**The deployment target is macOS 12.** Older systems are not tested and not claimed.

## Linux

**Two formats, and they answer different questions.**

- The **`.AppImage`** is one file that runs anywhere with a recent enough glibc and no
  install step. GitHub artifacts are delivered as a zip, and a zip does not carry the
  executable bit, so the first thing to do after unpacking is give it back:

  ```sh
  chmod +x nazar-desktop_*.AppImage
  ./nazar-desktop_*.AppImage
  ```

- The **`.deb`** is for Debian and Ubuntu and declares its dependencies —
  `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1` — so `apt` will tell
  you what is missing instead of the application failing to start. WebKitGTK **4.1** is
  what Tauri v2 links against; a distribution old enough to ship only 4.0 will not
  satisfy it.

**The tray is a menu, not a panel.** The status-notifier protocol every modern Linux
desktop uses has no concept of a left click reaching the application — the desktop
environment owns the click and opens the menu. So *Open · Refresh · Quit* is the whole
tray interaction on Linux, and the window is opened from the menu rather than by clicking
the bead. On a desktop that shows no tray at all (GNOME, without an extension for it) the
icon is registered and simply never drawn: the application runs, and closing the window
still hides it. Starting it a second time is what brings the window back — the shell is
single-instance, and a second launch shows the first one's window instead of starting
another server.

**No ARM build yet.** The matrix builds x86-64 only.

## The jump, and why it stops at Windows

Double-clicking a session card and having the terminal running that session come to the
front is the one thing the desktop shell does that a browser tab cannot. It is
**Windows-only today**, and on macOS and Linux it says so: the gesture and the card's menu
entry are both still there, and both answer *jumping to a terminal is not available on
this platform yet*. A sentence, not a red box and not a silent no-op — the shell reports
what it did in every other case too, and "nothing, and here is why" is a result like any
other.

The parts of it that are arithmetic — the parent-chain walk, the window ranking, the
title matching — live in `crates/nazar-shell`, have no platform API in them, and are
compiled and tested on all three systems on every push. That is deliberate: it makes a
port a step rather than a rewrite. What is missing on each side is the last rung, the one
that actually raises a window:

- **macOS**: `NSRunningApplication(processIdentifier:).activate()`, which is permitted
  because the jump is a user gesture. Getting from a session's pid to the terminal
  application is the same parent-chain walk that already exists.
- **Linux, X11**: `wmctrl` or `xdotool` can raise a window by pid when either is
  installed.
- **Linux, Wayland**: a client cannot raise its own window, let alone somebody else's.
  This is a design decision of the protocol and not a gap to be worked around, so the
  honest answer there will stay *not supported*.

## Building it yourself

The same script on all three, with the bundle kinds named explicitly:

```sh
npm ci
npm run build
node scripts/build-desktop.mjs --skip-npm-build --bundles nsis      # Windows
node scripts/build-desktop.mjs --skip-npm-build --bundles app dmg   # macOS
node scripts/build-desktop.mjs --skip-npm-build --bundles appimage deb  # Linux
```

`--bundles` is optional: `apps/desktop/tauri.macos.conf.json` and
`apps/desktop/tauri.linux.conf.json` already set the right defaults per platform, and the
flag exists so that CI is the single place that says what each runner produces. Add
`--target <triple>` to cross-compile — that is how the Intel `.dmg` is built on an Apple
silicon runner. Add `--debug` for a build measured in minutes rather than tens of them.

The Tauri prerequisites are the standard ones. On Debian and Ubuntu:

```sh
sudo apt install build-essential curl file wget \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libwebkit2gtk-4.1-dev libxdo-dev patchelf
```

On macOS, Xcode command line tools. On Windows, the MSVC build tools and WebView2 — which
Windows 11 already has, and which the installer downloads on Windows 10 if it is missing.
