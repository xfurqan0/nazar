# Watching another machine

Nazar reads the machine it is running on. A build server, a VPS, a spare laptop under the
desk — the agents on those are invisible to it, and they are often the ones you most want
to see, because nobody is sitting in front of them.

`nazar --remote <alias>` fixes that, and it does it with the connection you already have.

```
nazar --remote build-box
nazar --remote build-box,vps
```

Each alias becomes one child process:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=10 <alias> -- nazar --agent --hermes
```

The far end writes the canvas to its stdout as newline-delimited JSON; the near end reads
it, tags every session with the alias, and draws it beside the local cards with a small
`@alias` next to the name.

---

## The security model, in one paragraph

**There is no port, no token and no daemon.** Nazar opens nothing on the remote machine,
listens on nothing, stores no credential and installs nothing. The transport is `ssh`,
run as you, with your keys, to a host that is already in your own `~/.ssh/config`. If you
can `ssh` to the machine, Nazar can read it; if you cannot, Nazar cannot, and there is no
second path for it to find. When Nazar exits, the ssh connection closes, the remote
process sees its pipe close and exits too. Nothing is left behind.

Four consequences worth stating on their own:

- **Nazar never reads `~/.ssh/config`.** It hands `ssh` a name and lets `ssh` be the thing
  that knows what names mean. Your keys, your ports, your jump hosts and your agent
  forwarding stay in the file that already holds them.
- **The command line takes no credentials.** There is no `--port`, no `-i`, no `--user`
  and no password flag, and there will not be. `--remote` accepts an *alias* — a bare
  name — and refuses `user@host`, a path, anything with a space in it and anything
  beginning with `-`.
- **`BatchMode=yes` means it never prompts.** Key-based authentication or nothing. A
  password prompt inside a child process whose stdout is being parsed as JSON is a hang,
  not a login.
- **The remote side is still read-only.** It is the same Nazar: it reads what Claude Code
  and Hermes already wrote, installs no hook, changes no setting and writes nothing
  anywhere. `test/no-writes.test.ts` is the gate, and it covers the agent as much as the
  server.

---

## Installing Nazar on the far end

The far end needs Nazar on it, and the package is on npm, so the shortest way is one
line — `ssh build-box 'npm i -g @xfurqan0/nazar && nazar --version'`. The two below put
it there without the registry, from a tarball you built or from a clone.

### From a tarball

On your own machine:

```
npm pack                                  # → xfurqan0-nazar-0.1.0.tgz
scp xfurqan0-nazar-0.1.0.tgz build-box:
ssh build-box 'npm i -g ./xfurqan0-nazar-0.1.0.tgz && nazar --version'
```

### From a clone

```
ssh build-box 'git clone https://github.com/xfurqan0/nazar && cd nazar && npm ci && npm run build'
```

and then point Nazar at it, because a clone puts nothing on the `PATH`:

```
nazar --remote build-box --remote-cmd 'node ~/nazar/bin/nazar.mjs --agent --hermes'
```

Requirements on the far end: **Node 22 or newer** (Node 22.5+ for the Hermes reader, which
needs `node:sqlite`), and a non-login shell whose `PATH` finds `node`. Check both with:

```
ssh build-box 'node --version && command -v nazar'
```

---

## What the far end reads

| Flag | What it does |
|---|---|
| `--agent` | Write the canvas to stdout as newline-delimited JSON, and exit when the pipe closes. No server, no port, no browser. |
| `--claude` / `--no-claude` | Read Claude Code's session registry and transcripts on that machine. **On** by default. |
| `--hermes` | Also read Hermes sessions out of `~/.hermes/state.db`, read-only. **Off** unless asked for; `--remote`'s default command asks for it. |
| `--task-text` | Let the far end read task text. **Off** by default — see below. |

### Task text is off by default over a network

This is the opposite of the local default, and deliberately. On your own machine "task
text" means *the browser decides*, because the reader and the browser are on the same
machine as the person. Over ssh it is text leaving one machine for a screen that may be
shared, so it has to be typed:

```
nazar --remote build-box --remote-cmd 'nazar --agent --hermes --task-text'
```

Without it, no prose is read on the far end at all — not filtered on the way out, not
read in the first place. `NAZAR_TASK_TEXT=0` in the remote environment overrides even
that, in the one direction the switch ever moves.

---

## What you see, and what you do not

- **`@alias` next to the card's name.** The alias you typed, nothing resolved and nothing
  looked up.
- **No jump.** Double-clicking a remote card does nothing: the process it names is on the
  other machine, and raising a local window that happens to be wearing the same pid would
  be confidently wrong. Remote cards carry `pid: 0` for exactly this reason.
- **Faded cards when the connection drops.** They are *kept*, not removed — a closing
  laptop lid must not look like every remote agent finishing at once — and they go quiet
  (`state: unknown`) with a hover that says how long ago the last frame arrived.
  Reconnection backs off from one second to a minute, and it never gives up.
- **A `hello` timeout.** If ssh connects and nothing that looks like a Nazar agent
  answers within 30 seconds, the host reads as `unknown` and `nazar doctor` says so —
  usually because `nazar` is not on the remote `PATH`.

---

## Hermes

Hermes keeps every session it has ever run in one SQLite file per profile
(`~/.hermes/state.db`, plus `~/.hermes/profiles/<profile>/state.db`). With `--hermes` the
agent opens each one **read-only** — `file:<path>?mode=ro` and `readOnly: true` — reads a
fixed list of columns from three tables, and closes it. It writes nothing, copies nothing
and installs nothing; a Hermes plugin was designed and then dropped, because everything a
card needs was already on disk.

Two honest gaps, both by design:

- **A Hermes card never says *waiting*.** Hermes holds a pending permission in its
  gateway's memory and writes it to no file, so Nazar cannot know. The hover card says so
  in those words rather than leaving an absence to be read as "nothing is waiting".
- **The message and system-prompt tables are never opened.** They are in the same file as
  the metadata, which is exactly why the reader has a static gate of its own
  (`test/hermes-columns.test.ts`): no `SELECT *`, and every `FROM` on a three-table
  allow-list.

`docs/pinned-internal-formats.md` has the column-by-column table.

---

## Diagnosing a connection

```
nazar doctor --remote build-box
```

makes one attempt per alias and reports what came back: the ssh output, whether a `hello`
arrived, which build and machine answered, and the sources it found with their counts. It
starts nothing that outlives it — the canvas is the thing that keeps retrying.

Common answers:

| What doctor says | What it usually means |
|---|---|
| `Permission denied (publickey)` | `ssh <alias>` needs a password, or an agent that is not running. `BatchMode=yes` will not prompt. |
| `Could not resolve hostname` | The alias is not in `~/.ssh/config` and is not a real host name either. |
| `ssh connected but no hello arrived` | `nazar` is not on the remote non-login `PATH`. Check with `ssh <alias> 'command -v nazar'`, or use `--remote-cmd` with a full path. |
| `hermes -- (node:sqlite is not available…)` | The remote Node is older than 22.5. Claude Code sessions still arrive; Hermes ones do not. |
| `hermes ok (no state.db found)` | Hermes is not installed there, or `HERMES_HOME` points elsewhere. |

---

## In the desktop application

The settings panel has a **Remote hosts** field: one line, comma separated, the same
aliases. It is written to `desktop.json` and passed to the child server as `--remote`, so
changing it restarts that server — the same mechanism recording mode uses, and for the
same reason: what the canvas is reading should be visible on a command line rather than
hidden in a file the server reads for itself.
