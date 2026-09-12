# Release checklist

Every command on this page is **for the maintainer to run**. Nothing here is
run by CI or by any assistant: publishing, tagging and changing a repository's
visibility are one-way doors, and they belong to a person.

Read it top to bottom the first time. Steps 1 to 5 are reversible; step 6
onwards is not.

**A release has six artifacts, and every one of them is cut from the same
commit:**

| Artifact | Platforms | Built by | Goes to |
|---|---|---|---|
| `xfurqan0-nazar-<version>.tgz` | Windows, macOS, Linux | `npm pack` (through `prepack`) | npm, and attached to the GitHub Release |
| `nazar-desktop_<version>_x64-setup.exe` | Windows | `node scripts/build-desktop.mjs` on your own machine (step 4b) | the GitHub Release only |
| `nazar-desktop-macos-arm64` — one `.dmg` | macOS, Apple silicon | the `desktop bundle` job in CI, on the `v*` tag (step 6) | the GitHub Release only |
| `nazar-desktop-macos-x64` — one `.dmg` | macOS, Intel | the same job, cross-compiled on the same runner | the GitHub Release only |
| `nazar-desktop-linux-x64` — an `.AppImage` and a `.deb` | Linux, x86-64 | the same job | the GitHub Release only |

**One tarball for all three platforms, and a desktop bundle per platform.** The
tarball is pure JavaScript and is the same file everywhere — one `npm publish`
covers all three, and `npx @xfurqan0/nazar` opens the same canvas on each. The
desktop shell is a native application, so it is one bundle per platform and per
architecture, and only one of them is built where you are standing: the Windows
installer in step 4b, on your own machine. The other four come out of the
`desktop bundle` job in `.github/workflows/ci.yml`, which runs on a `v*` tag and
on `workflow_dispatch` and on nothing else — a macOS runner bills at ten times a
Linux one and none of those four files decides whether a change is correct, so
they are built at the moment a release actually needs them. You download them
from the tag's own run with `gh run download` (step 6) and attach them in step 9.
`docs/PLATFORMS.md` is the page that says what each platform gets, and it is the
one to keep in step with this table.

**Nothing here is signed by an authority a desktop trusts on sight**, and that
is a fact about the release rather than a step: the Windows installer is
unsigned, the two `.dmg` files are ad-hoc signed and not notarised, and the
Linux bundles are not signed at all, which is ordinary for both formats. The
release notes say each of those plainly instead of leaving people to guess.

Every desktop bundle ships the tarball's own contents as resources — the same
`bin/nazar.mjs`, `dist/nazar.mjs` and `dist/web/` — so the shell and the package
can never be built from different code. There is one version number and step 1
sets it for all of them.

---

## 0. Preconditions

- The gate in the project notes is green — every functional and hygiene item,
  each one either ✅ or a ⚠ you have read and accepted.
- `main` is clean, and CI is green on it (build + type-check + tests on Windows,
  Ubuntu and macOS, plus the pack smoke on all three).
- You are logged in to npm as the account that owns the `@xfurqan0` scope, with
  two-factor authentication on.

```bash
git switch main
git pull --ff-only
git status --porcelain          # must print nothing

npm whoami                      # must print your npm account
npm org ls xfurqan0 2>/dev/null || npm profile get   # scope + 2FA check
```

The package name must still be free the first time:

```bash
npm view @xfurqan0/nazar        # a 404 is the expected, good answer
```

---

## 1. Set the version

The root `package.json` is the version of record. The three workspace packages
are private and never published, but they are kept in step by hand, and so is
the `version` constant `packages/core/src/index.ts` exports.

The desktop shell has two more: the Cargo workspace's `[workspace.package]`
version, which every crate inherits, and `apps/desktop/tauri.conf.json`, which
is what the installer's file name and the Windows *Installed apps* entry come
from. `crates/nazar-shell/Cargo.toml` and `apps/desktop/Cargo.toml` both say
`version.workspace = true`, so they cannot drift on their own.

Three more places carry the number in prose or markup rather than in a manifest,
and one of them ships: `packages/ui/web/index.html` has a literal in the About
panel, which `packages/ui/web/app.ts` overwrites at runtime from the root
manifest — but the literal is what a user sees if `bundle.js` fails to load, and
`dist/web/index.html` is in the tarball. All of them drift silently, because
nothing fails until a release.

```bash
# Edit by hand, all ten in the same commit:
#   package.json                     -> "version": "0.1.0"
#   packages/core/package.json       -> "version": "0.1.0"
#   packages/server/package.json     -> "version": "0.1.0"
#   packages/ui/package.json         -> "version": "0.1.0"
#   packages/core/src/index.ts       -> export const version = '0.1.0';
#   Cargo.toml                       -> [workspace.package] version = "0.1.0"
#   apps/desktop/tauri.conf.json     -> "version": "0.1.0"
#   packages/ui/web/index.html       -> <span id="version">0.1.0</span>
#   CHANGELOG.md                     -> ## [0.1.0] — YYYY-MM-DD
#   README.md                        -> nazar-desktop_0.1.0_x64-setup.exe
#
# Then regenerate these two rather than hand-editing them, and commit both
# before tagging — cargo would otherwise rewrite Cargo.lock in step 4b, after
# the release commit was already made:
#   package-lock.json                -> npm install --package-lock-only
#   Cargo.lock                       -> cargo metadata --offline >/dev/null
#
# Deliberately NOT bumped: fixtures/statusline-captures/*.json carries
# nazar-tray's wrapper version, and the fixtures under packages/ui and
# apps/desktop carry Claude Code's.

grep -rn '"version"' package.json packages/*/package.json apps/desktop/tauri.conf.json
grep -n 'export const version' packages/core/src/index.ts
grep -n '^version' Cargo.toml
grep -n 'id="version"' packages/ui/web/index.html
grep -n '"version"' package-lock.json | head -2
grep -n 'nazar-desktop_' README.md CHANGELOG.md
```

`package-lock.json` is the one that has already drifted: it is committed at
`0.0.0`, and it still describes the pre-WP6 layout (`bin` pointing at
`packages/server/bin/nazar.mjs`). `npm ci` in step 2 installs strictly from it,
so regenerate it *before* the release commit, not after.

Move the `## [0.1.0] — unreleased` heading in `CHANGELOG.md` to
`## [0.1.0] — YYYY-MM-DD`, and set the README status line to the released
wording (drop the "not yet published" sentence).

Add them by name. A release commit is the one commit whose contents you can
list before you make it, and `git add -A` is how a stray file rides along into
the thing you are about to tag:

```bash
git add package.json packages/core/package.json packages/server/package.json \
        packages/ui/package.json packages/core/src/index.ts Cargo.toml \
        apps/desktop/tauri.conf.json packages/ui/web/index.html \
        CHANGELOG.md README.md package-lock.json Cargo.lock
git status --porcelain          # read it: nothing staged that you did not name
git commit -m "Release 0.1.0"
```

---

## 2. Build and test from clean

A stale `dist/` is the classic way to publish something that does not match the
source. Start from nothing.

```bash
npm run clean
rm -rf dist node_modules            # PowerShell: Remove-Item -Recurse -Force dist, node_modules
npm ci
npm run build
npm run typecheck
npm test
```

---

## 3. Inspect the tarball

`npm pack` runs `prepack`, which builds the workspace and then the published
layout (`dist/nazar.mjs` plus `dist/web/`).

```bash
npm pack --dry-run
```

Read the file list. It must contain **only**:

```
LICENSE
README.md
CHANGELOG.md
package.json
bin/nazar.mjs
dist/BUILD.txt
dist/nazar.mjs
dist/web/index.html
dist/web/bundle.js
dist/web/styles.css
dist/web/assets/*            (provider badges + LICENSE-lobehub.txt)
```

Anything else — a source file, a fixture, a screenshot, a `.map`, a
`node_modules` entry — means the `files` whitelist has drifted. Fix it before
continuing.

Check the numbers too: about 165 kB packed, about 584 kB unpacked, 15 files. A
jump of an order of magnitude means something got in. The canvas is most of it —
`dist/web/bundle.js` and `dist/web/styles.css` together are over half the
unpacked size, and they grow with every package that adds to the UI, so compare
against the previous release rather than against a number written here.

---

## 4. Smoke the tarball as a user would

```bash
npm run smoke
```

That packs, installs into a fresh temporary directory with a cold cache, and
drives the installed binary through `--version`, `--help`, `npx`, `doctor`, and
a real `GET /api/state` on a free port. Run it on every platform you have. CI
runs the same script on all three.

For a fully manual pass:

```bash
npm pack --pack-destination /tmp/nazar-release
cd /tmp/nazar-release
npx --yes ./xfurqan0-nazar-0.1.0.tgz --version
npx --yes ./xfurqan0-nazar-0.1.0.tgz --help
npx --yes ./xfurqan0-nazar-0.1.0.tgz doctor
npx --yes ./xfurqan0-nazar-0.1.0.tgz --no-open --port 4699
# then, in another shell:
curl -s http://127.0.0.1:4699/api/state | head -c 200
```

---

## 4b. Build and smoke the desktop installer (Windows)

Needs the Rust toolchain `rust-toolchain.toml` pins and `cargo install
tauri-cli`. The NSIS toolchain is downloaded by the Tauri bundler on first use.

```powershell
node scripts/check-licenses.mjs     # every Rust and npm dependency, permissive only
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

node scripts/build-desktop.mjs      # npm build + stage + release bundle
```

The artifact is `target/release/bundle/nsis/nazar-desktop_<version>_x64-setup.exe`.
Check its size against the last release; an order of magnitude means something
got into `apps/desktop/resources/`.

Then install it and drive it as a user would. **This is the only part of a Nazar
release that puts a program on your machine, so it gets an uninstall check too:**

- it opens a window and the canvas appears in it, with your real sessions;
- the tray bead is there — left click shows the window, right click gives
  Open · Refresh · Quit;
- the close button hides it to the tray rather than ending it;
- double-clicking a session card raises that session's terminal;
- *start with Windows* in the sidebar adds and removes the entry under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (check both directions);
- **Quit leaves nothing**: no `node.exe` still serving, no window, no tray icon.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*resources\server\bin*' }   # must be empty
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run |
  Select-Object nazar-desktop                                      # empty unless you asked for it
```

Uninstall from *Installed apps* and confirm the install directory is gone.
`%APPDATA%\nazar\desktop.json` is expected to remain — it is the user's setting,
and it is a different file from nazar-tray's `config.json` in the same folder.

---

## 5. Last read-through

```bash
# No AI attribution anywhere in the history or the tree.
git log --all --format=%B | grep -niE "generated with|co-authored-by|claude\.ai/"
git grep -niE "generated with|co-authored-by" -- . ':!package-lock.json'

# No personal data, no absolute paths, no leftover secrets.
git grep -niE "yldz|@gmail|C:\\\\Users|/Users/|/home/" -- . ':!package-lock.json'
git grep -nE "(sk-ant-|ghp_|xox[abprs]-|AIza)" -- . ':!package-lock.json'

# The tree is not the whole story: making the repository public publishes every
# commit's author and committer fields too, and no grep over files can see them.
git log --all --format='%an <%ae> | %cn <%ce>' | sort -u

# The fixture gate and the pinned-path gate, on their own.
node --import tsx --test test/fixtures.test.ts
node --import tsx --test packages/core/test/pinned-paths.test.ts
```

**And inside the binary, which none of the greps above can see.** Panic locations
are compiled in as string literals, so `strip` does not remove them and a
release build carries the path every crate was compiled from. The build script
passes `--remap-path-prefix` for exactly this reason; here is the check that it
worked:

```powershell
$text = [System.Text.Encoding]::ASCII.GetString(
  [System.IO.File]::ReadAllBytes("target/release/nazar-desktop.exe"))
foreach ($needle in 'yldz', 'C:\Users', 'Documents and Settings') {
  "{0}: {1}" -f $needle, $text.Contains($needle)      # all three must be False
}
```

All of them must come back empty or green. The only expected hits are the
maintainer's own name in `LICENSE`, and the forbidden patterns written into the
gate tests themselves.

The author scan is the exception, and it is the one to read carefully: it lists
identities rather than matches, and **every one of them becomes public with the
history**. A commit made before `user.email` was set to the GitHub noreply
address carries a real mailbox that no later commit can take back. If one shows
up, the only fix is to rewrite history before the repository is ever public —
`git filter-repo --mailmap`, then a force-push to a repository nobody has cloned
— and it is a decision to take deliberately, with the rewritten hashes in front
of you, not a step to run in passing.

Also confirm by eye:

- `LICENSE` — MIT, the right year and name.
- `packages/ui/assets/LICENSE-lobehub.txt` — present, and referenced from the
  README's "Third-party assets" section.
- `.gitattributes` — present, so line endings do not turn a first contributor's
  pull request into a whole-repository diff.
- The README's screenshots render on github.com after the repository is public.

---

## 6. Tag

**From here on, nothing is reversible.**

```bash
git tag -a v0.1.0 -m "Nazar 0.1.0"
git push origin main
git push origin v0.1.0
```

**The tag is also what builds the macOS and Linux bundles.** Pushing it starts a
full CI run, and in that run — and in no run an ordinary push ever starts — the
`desktop bundle` job produces the two `.dmg` files, the `.AppImage` and the
`.deb`. It is a release build on three runners, so it is tens of minutes; it is
started here rather than in step 9 for that reason, and npm can be published
while it runs.

```bash
gh run list --workflow ci.yml --branch v0.1.0 --limit 1   # the tag's own run
gh run watch <run-id> --exit-status                       # every job green
gh run download <run-id> --dir bundles                    # one directory per artifact
ls bundles/nazar-desktop-macos-arm64 \
   bundles/nazar-desktop-macos-x64 \
   bundles/nazar-desktop-linux-x64
```

`gh run download` writes each artifact into a directory named after it, so the
four files land under those three. GitHub delivers an artifact as a zip and a
zip does not carry the executable bit, so the `.AppImage` arrives
non-executable — a fact about the download rather than about the build, and the
release notes tell the reader the `chmod +x` that answers it.

---

## 7. Publish to npm

The first publish of a scoped package needs `--access public`; `publishConfig`
in `package.json` already says so, and the flag makes it explicit.

```bash
npm publish --access public
```

npm will ask for your one-time password. Then verify:

```bash
npm view @xfurqan0/nazar
npm view @xfurqan0/nazar dist.tarball
cd /tmp && npx --yes @xfurqan0/nazar --version    # from the registry this time
```

If something is wrong, **do not unpublish** unless it is within 72 hours and
nobody could have installed it. Publish a patch instead:

```bash
npm deprecate @xfurqan0/nazar@0.1.0 "Broken build, use 0.1.1"
```

---

## 8. Flip the repository to public

Do this deliberately, and only after step 5 came back clean: the history becomes
public with it, and a repository that has been public cannot be un-published
from anyone who cloned it.

```bash
gh repo view xfurqan0/nazar --json visibility
gh repo edit xfurqan0/nazar --visibility public --accept-visibility-change-consequences
```

Then turn on the two things a public repository wants:

```bash
gh api -X PATCH repos/xfurqan0/nazar -f has_issues=true
gh api -X PUT repos/xfurqan0/nazar/vulnerability-alerts
```

---

## 9. GitHub Release

All six artifacts go on the one release: the tarball, the Windows installer you
built in step 4b, and the four bundles you downloaded in step 6.

```bash
gh release create v0.1.0 --title "Nazar 0.1.0" --notes-file docs/release-notes-0.1.0.md \
  "xfurqan0-nazar-0.1.0.tgz" \
  "target/release/bundle/nsis/nazar-desktop_0.1.0_x64-setup.exe" \
  bundles/nazar-desktop-macos-arm64/*.dmg \
  bundles/nazar-desktop-macos-x64/*.dmg \
  bundles/nazar-desktop-linux-x64/*.AppImage \
  bundles/nazar-desktop-linux-x64/*.deb
```

`gh release upload v0.1.0 <file>` adds one that was missed. Six downloads means
six things a reader has to tell apart, so the notes name each one by the machine
it is for: the two `.dmg` files differ by architecture and by nothing else, and
the `.AppImage` and the `.deb` answer different questions on the same
distribution.

Three of them warn on first run, and none of the three warnings means anything
is wrong with the file. Windows SmartScreen warns on the installer until the
download builds reputation; Gatekeeper refuses a plain double-click on an
ad-hoc signed `.dmg`, which a right-click · **Open** gets past; and the
`.AppImage` needs its executable bit back after the zip. All three are facts
about the release rather than steps, and the notes below say them plainly.

Write `docs/release-notes-0.1.0.md` from this template — it is the CHANGELOG
entry, shortened, with the limits kept rather than buried:

```markdown
# Nazar 0.1.0

**Keep a nazar on your agents.** A local canvas that draws every running Claude
Code session on your machine, its subagent tree, and every past session Claude
Code still keeps a transcript for.

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
  matches your machine. They are ad-hoc signed and not notarised, so Gatekeeper
  will refuse a normal double-click: **right-click the application and choose
  Open**, then Open again in the dialog, and macOS remembers the decision for
  that copy.
- **Linux** — an `.AppImage` that runs anywhere with a recent enough glibc, and
  a `.deb` for Debian and Ubuntu that declares its dependencies. A download
  arrives as a zip and a zip carries no executable bit, so the AppImage needs
  it back: `chmod +x nazar-desktop_*.AppImage`.

[docs/PLATFORMS.md](https://github.com/xfurqan0/nazar/blob/main/docs/PLATFORMS.md)
says exactly what each of the three gets.

## What it does

- One node per running session, with its subagents as a tree underneath.
- A prominent banner on any session waiting for a permission prompt.
- Exact token counts, deduplicated by `(message.id, requestId)` — a naive sum
  inflates output tokens by up to about 2.5x.
- Cards you place yourself, on tabs and projects of your own, with names,
  sticky notes, four themes and your own frame colours.
- A History panel that opens any past session as a frozen tree with per-agent
  duration and tokens, grouped by project.
- Usage limits, cost and context window, when the sibling tool that owns the
  status line is installed — and nothing at all when it is not.
- Metadata only: no prompt, response or tool input is ever read.
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
- The jump to a terminal is Windows-only. It raises the window and, on Windows
  Terminal, selects the session's own tab within it; when several windows could
  be the same session it raises nothing and says so rather than guessing. The
  macOS and Linux apps answer the same gesture with *not available on this
  platform yet*.
- On Linux the tray is a menu only — the desktop environment owns the click —
  so *Open · Refresh · Quit* is the whole tray interaction and the window is
  opened from the menu.
- No bundle is signed the way a desktop trusts on sight: the Windows installer
  is unsigned and SmartScreen warns on first run, and the `.dmg` files are
  ad-hoc signed rather than notarised, so the first launch needs the
  right-click · Open above.

Full list in the [README](https://github.com/xfurqan0/nazar#known-limits).

## Verify

```
npm view @xfurqan0/nazar dist.shasum
```

MIT licensed.
```

---

## 10. After the release

- Bump the version to the next `-dev` only when the next change lands; do not
  leave `main` on a version that is already on the registry without a note in
  `CHANGELOG.md` under `## [Unreleased]`.
- Watch the first issues. A tool that reads another program's internal files
  will get "it shows nothing" reports; `nazar doctor` output is the first thing
  to ask for.
- Code signing: the npm package needs none — it is JavaScript through a
  registry. **The desktop bundles do**, eventually: the Windows installer is an
  unsigned executable, so SmartScreen warns until the download builds enough
  reputation, and the `.dmg` files are ad-hoc signed rather than notarised, so
  Gatekeeper asks for a right-click · Open every first launch. Every warning
  costs installs. Neither a certificate nor Apple's $99 a year is worth it for a
  pre-alpha with an unknown number of users; revisit both when the download
  count says otherwise, and keep them out of the v1 gate until then.
