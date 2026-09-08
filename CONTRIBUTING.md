# Contributing

Thanks for looking. Nazar is small on purpose, and these are the few rules that
keep it that way.

## Getting set up

Node 22 or newer, and nothing else.

```
npm ci
npm run build     # compile packages/{core,server,ui}, then bundle the canvas
npm test          # every workspace's tests, then the four repository-wide gates
npm run typecheck # sources, tests and browser code, no emit
```

Build before you test: the tests resolve `@nazar/core` through the workspace
link, and that link points at build output.

The desktop shell is the one part that needs more than Node. It is a Cargo
workspace beside the npm one (`apps/desktop`, the Tauri crate; `crates/nazar-shell`,
the pure half), and `rust-toolchain.toml` pins the toolchain:

```
node scripts/build-desktop.mjs --stage    # build the package and stage it for the crate
cargo test --workspace                    # Windows
cargo test -p nazar-shell                 # anywhere; no Tauri, no platform API
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check                # the same formatting check CI runs
node scripts/check-licenses.mjs           # permissive licences only, Rust and npm
```

Stage before you build: `bundle.resources` names `resources/server`, and
`tauri-build` checks that the path exists while the crate compiles.

**You do not need any of this to work on Nazar.** The canvas, the readers and
the server are the whole product; the shell is a window around them. If a change
is not about the window, the tray or the jump, `npm test` is the suite that
matters.

## The rules

- **English everywhere.** Code, comments, commit messages, issues, pull
  requests, documentation.
- **Tests are required.** A change without a test that fails before it and
  passes after it does not go in. Bug fixes need the regression test that pins
  the bug; new behaviour needs a test of the behaviour, not of the
  implementation.
- **Zero runtime dependencies.** Not one. `dependencies` stays empty and the
  build asserts it: after bundling, every import left in the shipped file must
  be a Node builtin. A pull request that adds a runtime dependency needs to
  argue why the thing cannot be written in fifty lines, and the answer has been
  no every time so far — including for the tree layout.
- **Metadata only.** No prompt, response, thinking block, tool input or tool
  result body may ever be parsed into memory, serialised into an event, or shown
  in the UI. The transcript reader keeps a closed list of fields; adding to it
  is a deliberate decision, not a convenience. Two leak tests guard this.
- **Read-only.** Nazar does not write, move, copy or delete anything, anywhere.
  `test/no-writes.test.ts` enforces it statically: every binding a shipped
  source imports from `node:fs` must be on a read-only allow-list, the one file
  handle opened must pass `'r'`, and `settings.json` may not be named at all.
  Build tooling under `scripts/` is exempt, because it is not shipped.
- **Pinned paths.** Any path Nazar reads under `~/.claude` must have a row in
  [docs/pinned-internal-formats.md](docs/pinned-internal-formats.md), with the
  fields used, the Claude Code version it was observed under, and a fixture. A
  test greps the sources and fails on a path that is not listed. Add the row
  first.
- **Generated files are checked.** `package-lock.json` is regenerated with
  `npm install --package-lock-only`, and `npm test` fails if its version, its
  `bin` or any workspace package no longer agrees with `package.json`. The
  licence allow-list lives in `deny.toml` and nowhere else;
  `scripts/check-licenses.mjs` reads it.
- **No AI attribution in commits or pull requests.** No `Generated with …`
  trailer, no `Co-Authored-By:` for a model or an assistant, no session links.
  Write the message in your own voice; the history is a record of decisions, not
  of tooling.

## Fixtures

`fixtures/` holds sanitized samples of everything Nazar reads, so the parsers
can be tested without a live Claude Code session. If you add one:

1. **Sanitize it by hand.** Replace every identifier with a placeholder: uuids
   become `00000000-0000-4000-8000-…`, agent ids become `a0000000000000001`,
   message and request ids become `msg_000…` / `req_000…`. Replace prompt,
   response and thinking text with `"[redacted]"`. Working directories become
   something like `C:/proj/example`.
2. **Record what you removed** in [fixtures/README.md](fixtures/README.md), so
   the next person knows what the fixture is standing in for.
3. **Pass the gate.** `npm test` walks every file under `fixtures/` and fails on
   an email address, a home path on any of the three platforms, the maintainer's
   handle, or any hexadecimal run of 32 characters or more that is not all
   zeroes. It also checks that every JSON and JSONL fixture parses.

Do not commit a capture straight off a machine. `*.raw.json`, `*.raw.jsonl` and
`fixtures/local/` are gitignored for exactly this reason — use them for your own
working copies.

## Pull requests

- Branch off `main`, keep the change focused, and say what you observed rather
  than what you assumed. Measurements are welcome; this codebase is full of them.
- If your change depends on a Claude Code internal shape, say which version you
  observed it under and on which platform.
- CI runs the build, the type-check and the tests on Windows, Ubuntu and macOS,
  plus a pack-install-run smoke of the published tarball on all three. All of it
  must be green.

## Reporting a bug

`nazar doctor` output is the most useful thing you can attach, along with your
Nazar and Claude Code versions. Read it before you attach it if you used
`--verbose`, which prints absolute paths.

Security issues go through [SECURITY.md](SECURITY.md), privately, not into a
public issue.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence, the same as the rest of the project.
