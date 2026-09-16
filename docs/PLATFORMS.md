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
| **Desktop bundle** | `.exe` (NSIS, per-user install) | `.dmg` — one for Apple silicon, one for Intel | `.AppImage` and `.deb`, one pair per architecture; an `.rpm` builds but is not shipped |
| **Architectures** | x86-64 | arm64 (Apple silicon) and x86-64 (Intel) | x86-64 and arm64 |
| **Tray icon** | yes; left click shows the window, right click opens the menu | yes, in the menu bar, drawn as a template icon so it follows light and dark | yes, as an AppIndicator **menu only** — see below |
| **Close minimises to the tray** | yes | yes | yes |
| **No server left behind** | yes, a job object | yes, the child watches its parent | yes, `PR_SET_PDEATHSIG` and the same watch |
| **Start at login** | yes, *start with Windows* | yes, *start with macOS* (a LaunchAgent) | yes, *start at login* (a `.desktop` entry in `~/.config/autostart`) |
| **Jump to the terminal** | yes, including the right tab in Windows Terminal | **not yet** | **no on Wayland** — the compositor forbids it; **not yet** on X11 |
| **Signed** | no | ad-hoc only, **not** notarised | not applicable |
| **Built on** | every push | on a tag or by hand | compiled, linked and tested on every push, on both architectures; the `.AppImage` and `.deb` on a tag or by hand |
| **Usage limits outside the canvas** | nazar-tray's tray icon | nazar-tray's menu-bar icon | nazar-tray's tray icon where the desktop draws one; on a stock GNOME, the [nazar-gnome](https://github.com/xfurqan0/nazar-gnome) Shell extension instead |

The desktop *bundles* for macOS and Linux come out of the `desktop bundle` job in
`.github/workflows/ci.yml`, which runs on a `v*` tag or on `workflow_dispatch` and not on
an ordinary push. A macOS runner costs ten times a Linux one per minute and none of these
four artifacts decides whether a change is correct — the jobs that do (`build`, `pack
smoke`, `shell logic`, `desktop shell — lint, build, test (linux)` and its arm64 sibling)
run on every push.

The Linux shell itself is not in that arrangement any more. It is linted and **linked** on
every push, because clippy is a check and not a link: it never asks whether the GTK,
WebKit and AppIndicator symbols are there. Until that job existed, the first thing to find
a Linux link regression was the tag build — which is to say, a release.

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

  ```sh
  sudo apt install ./nazar-desktop_0.1.0_amd64.deb     # or _arm64.deb
  ```

- **There is no `.rpm` in a release**, and the bundler will build one: `--bundles rpm`
  produces a package whose requirements are library sonames
  (`libappindicator3.so.1`, `libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`) rather than
  Debian package names, which is what Fedora wants. It is not shipped because nobody has
  accepted one on a Fedora machine yet — installing and running it is the step between
  here and a release that carries it. On Fedora today the `.AppImage` is the download,
  and building from source is the other option; see below.

**The glibc floor is 2.35, and it is a property of the runner rather than of the code.**
A Linux binary records the glibc version of every symbol it uses, and glibc is compatible
backwards but never forwards: a build on Ubuntu 24.04 needs 2.39 and a build on Fedora 44
more still. Measured by installing a locally built `.deb` into a Debian 12 container —
`apt` resolved every dependency and installed it cleanly, and the binary then refused to
start with *`/lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found'*. So the
release bundle is built on `ubuntu-22.04` (glibc 2.35), which runs on Debian 12 (2.36),
Ubuntu 22.04 and everything newer. **A package built on your own machine is for testing
on your own machine**; the one people download comes out of CI.

**The tray is a menu, not a panel.** The status-notifier protocol every modern Linux
desktop uses has no concept of a left click reaching the application — the desktop
environment owns the click and opens the menu. So *Open · Refresh · Quit* is the whole
tray interaction on Linux, and the window is opened from the menu rather than by clicking
the bead. On a desktop that shows no tray at all the icon is registered and simply never
drawn: the application runs, and closing the window still hides it. Starting it a second
time is what brings the window back — the shell is single-instance, and a second launch
shows the first one's window instead of starting another server.

**On GNOME, installing the extension is not the same as enabling it.** GNOME Shell has no
status-notifier host of its own, and without one there is no `StatusNotifierWatcher` on
the session bus for the icon to register with. The extension that provides it is
`gnome-shell-extension-appindicator`, and it has to be switched on as well as installed:

```sh
sudo dnf install gnome-shell-extension-appindicator     # or your distribution's name for it
gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
```

Under Wayland the Shell has to be restarted for that to take effect, which means logging
out and back in. Measured on Fedora 44 with GNOME Shell 50.4, with the package installed
and the extension left disabled: `gnome-extensions info` reports *Enabled: no*,
`busctl --user list` shows no `StatusNotifierWatcher`, and the shell's own icon is
registered against nothing. Nothing in the application is wrong in that state and nothing
in it can be fixed — the desktop simply has nobody to draw the icon.

**The bead in the GNOME panel is a different program, and it is not this one's tray icon.**
[nazar-gnome](https://github.com/xfurqan0/nazar-gnome) is a Shell extension that reads the
same `~/.nazar/limits.json` Nazar's quota strip reads and draws the binding window in the
top bar, with nazar-tray running as the engine (`nazar-tray --headless`) underneath it. It
needs no AppIndicator bridge, because it is not an indicator: it is an extension drawing in
the panel itself. What it does not do is give **Nazar** a tray icon — the paragraph above is
still the whole story for this application's icon, and the two can be installed together or
apart without either knowing about the other.

**There is an arm64 build, and it is built on an arm64 machine.** The release carries an
`.AppImage` and a `.deb` for `aarch64` beside the x86-64 pair — a Raspberry Pi 5 running a
64-bit Debian, an Ampere or Graviton desktop, an arm64 virtual machine on an Apple laptop —
and the download to take is the one matching `uname -m` (`aarch64`, or `x86_64`). Both come
off GitHub's own arm64 and x86-64 runners rather than out of a cross-compiler: a build for
another architecture needs that architecture's GTK, WebKit and AppIndicator to link
against, and a sysroot assembled to hold them is a thing to keep working for as long as the
project lives, where a runner already has one. The arm64 bundle is built on the same
`22.04` image as the x86-64 one and carries the same glibc floor, 2.35.

The shell is also **compiled, linked and tested on arm64 on every push** — `desktop shell
— build, test (linux arm64)` in `.github/workflows/ci.yml`, alongside the pure crate's own
arm64 entry — which is what makes the sentence above a measurement rather than a hope. The
lints are not repeated there: nothing in this repository is conditional on the
architecture, so what a second runner is for is the link and the `libc` calls, not
`clippy`.

### Fedora, and the AppIndicator it does not have

Fedora does not package `libayatana-appindicator`, which is the library the `.deb`
depends on and the one `docs/PLATFORMS.md` used to name as though it were the only
option. It is not: the shell builds against the older `libappindicator-gtk3` instead,
because `libappindicator-sys` looks for either.

Measured on Fedora 44: `pkg-config --modversion ayatana-appindicator3-0.1` finds nothing,
`appindicator3-0.1` answers `12.10.0`, and `cargo build -p nazar-desktop` completes with
no missing system library at all. Ubuntu's `libayatana-appindicator3-dev` and Fedora's
`libappindicator-gtk3-devel` are interchangeable here, and CI uses the first only because
CI runs on Ubuntu.

What that machine already had, and what was enough:

```sh
sudo dnf install gcc gcc-c++ make file \
  webkit2gtk4.1-devel gtk3-devel librsvg2-devel openssl-devel \
  libappindicator-gtk3-devel
```

`libxdo-dev` has no counterpart in that list, and it is not needed: it is on the Debian
list for the jump, which does not exist on Linux yet.

Bundling needs one more thing and fewer than it looks. `cargo tauri` is not a Fedora
package — `cargo install tauri-cli --locked` — and with it, **`.deb` and `.rpm` both
build with nothing else installed**: the Tauri bundlers write both formats themselves, so
neither `dpkg` nor `rpmbuild` has to be on the machine. Measured on Fedora 44:

```sh
node scripts/build-desktop.mjs --bundles deb rpm     # 2.5 MB each
node scripts/check-binary-paths.mjs                  # and then read what came out
```

Only the **AppImage** needs a tool that is not there — `patchelf`, which the bundler uses
to rewrite the interpreter path of the binary it packs — so `--bundles appimage` is the
one form a plain Fedora install cannot produce.

**Built and smoke-tested on Fedora 44**, GNOME Shell 50.4 on Wayland, with Node 22 and
rustc 1.98: the crate compiles, the binary starts, the webview renders, the node server
comes up as a child and the canvas is served, and the `.deb` and `.rpm` bundles build.
The `.deb` installs in a Debian 12 container and the binary in it does not run there,
which is the glibc floor above and not a packaging fault. That is a smoke test on one
machine and one distribution, not a claim that Nazar is tested on Linux.

**What is in the `.deb`**, because a package nobody has opened is a claim rather than a
fact: `/usr/bin/nazar-desktop`, the staged Node server under
`/usr/lib/nazar-desktop/resources/server/`, `/usr/share/applications/nazar-desktop.desktop`
— which `desktop-file-validate` passes without a word — and three icon sizes under
`/usr/share/icons/hicolor/`. The control file names a maintainer with an address in it
(`Cargo.toml`'s `authors`, which is where `tauri-bundler` reads it from) and lists
`libappindicator3-1` in *addition* to the Ayatana package when the build machine linked
the older library, as Fedora's does — one more reason the shipped package is built on
Ubuntu.

## Closing the shell, and what it takes with it

The desktop shell runs the same server the browser mode runs, as a child process. Quitting
kills it, and that is the easy half; the hard half is a shell that never gets to quit —
killed from a task manager, crashed, or a desktop session ending underneath it. Each
platform answers that differently, and until recently only one of them answered at all:

- **Windows**: the child is in a job object marked kill-on-close. The kernel closes the
  handle as it tears the process down and the job takes the child with it.
- **Linux**: `prctl(PR_SET_PDEATHSIG, SIGTERM)`, set in the child between the fork and the
  exec. The same guarantee from a different kernel.
- **macOS and Linux both**: the server is started with `--exit-with-parent`, and watches
  its own parent id. When an orphan is handed to a reaper the id changes, and the server
  exits. It is about a second slower than a signal from the kernel and it is the only
  answer macOS has, so Linux carries both.
- **Every unix**: the child leads its own process group, so stopping the server also stops
  the `ssh` processes a `--remote` session started underneath it.

Before this, killing the shell on Linux left a node process holding the port it had been
given, and the next launch found that port busy. If you are running an older build and see
that, `pkill -f nazar.mjs` is the one-line answer.

## The jump, and why it stops at Windows

Double-clicking a session card and having the terminal running that session come to the
front is the one thing the desktop shell does that a browser tab cannot. It is
**Windows-only today**, and everywhere else the canvas says so rather than offering a
control that cannot answer: the card menu has no **Jump to terminal** entry and the
double-click is an ordinary click.

**On Linux it says which no.** The shell reads `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY`
at start-up and tells the canvas one word — `wayland`, `x11`, or nothing — and the canvas
turns that word into a sentence out of its own catalogues, in About and on the
double-click:

- **Wayland**: *the compositor does not let an application raise another one's window.
  Use the terminal's own window switcher.* Not *yet*: see below, this one is never coming.
- **X11**: *not wired up yet*, which is a promise, because there it is only work.
- **A session that says neither** — a `tty`, a machine with neither variable set — gets
  the sentence every unported platform gets.

The parts of it that are arithmetic — the parent-chain walk, the window ranking, the
title matching — live in `crates/nazar-shell`, have no platform API in them, and are
compiled and tested on all three systems on every push. That is deliberate: it makes a
port a step rather than a rewrite. What is missing on each side is the last rung, the one
that actually raises a window:

- **macOS**: `NSRunningApplication(processIdentifier:).activate()`, which is permitted
  because the jump is a user gesture. Getting from a session's pid to the terminal
  application is the same parent-chain walk that already exists.
- **Linux, X11**: `wmctrl` or `xdotool` can raise a window by pid when either is
  installed. Windows only, never tabs: no X11 tool can see a terminal's tabs, so the best
  a port could do is the right window.
- **Linux, Wayland**: a client cannot raise its own window, let alone somebody else's.
  This is a design decision of the protocol and not a gap to be worked around, so the
  honest answer there will stay *not supported*. The one door — an `xdg-activation` token
  — is handed to an application by the user's own gesture on *that* application, which a
  double-click on Nazar's canvas is not.

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

On Fedora, with `libappindicator-gtk3-devel` standing in for the Ayatana package that
Fedora does not carry — see above:

```sh
sudo dnf install gcc gcc-c++ make file \
  webkit2gtk4.1-devel gtk3-devel librsvg2-devel openssl-devel \
  libappindicator-gtk3-devel
```

On macOS, Xcode command line tools. On Windows, the MSVC build tools and WebView2 — which
Windows 11 already has, and which the installer downloads on Windows 10 if it is missing.
