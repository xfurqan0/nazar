# Pinned internal formats

Nazar reads files and commands that belong to Claude Code. None of them is a public API,
so every one of them can change without notice. This page is the inventory: what we read,
which fields we depend on, the Claude Code version the shape was observed under, and the
fixture that pins it.

**Observed under Claude Code 2.1.263, Windows 11, 2026-09-08.** Every row was verified on
a real machine in the WP0 data-layer audit or in the work package that added it; nothing
here is copied from documentation without a matching observation.

Everything above the Codex heading is Claude Code's. **Codex is a second provider with a
completely different shape**, so it has its own section at the foot of this page — its own
inventory, its own not-read table, and its own version stamp.

Rules that follow from this table:

1. A parser reads **only** the fields in its "fields used" column. Anything else is
   skipped, including fields that look harmless.
2. No prompt text, no response text, no tool input is ever parsed into memory. The
   transcript reader is metadata-only (docs/PROJECT.md section 3, Privacy).
3. When a field is missing, Nazar shows nothing. It never shows `0` for "unknown".
4. Each row's fixture is the regression test. Update the fixture and the "version
   observed" column together whenever a format changes under us.
5. **The gate that enforces this table reaches exactly as far as `packages/core/src`**, and
   knowing where it stops is part of trusting it. Three limits.
   `packages/core/test/pinned-paths.test.ts` scans that one directory and `.ts` files only,
   so `packages/server/src`, `packages/ui`, `apps/desktop/src` and `crates/` are outside it
   — the desktop shell's readers are on this list **by review rather than by test**. It
   matches a source literal against any backticked span by *substring*, so a shorter path is
   satisfied by a longer pinned one. And it greps for the literals `~/.claude/`, `~/.nazar`
   and `<cwd>/.claude/` in raw source text, so a path assembled with `path.join` and no
   matching string constant is invisible to it — which is why the constants in
   `packages/core/src/paths.ts` and `project-settings.ts` are kept even when nothing reads
   them.

## Inventory

| Path / command | Fields used | CC version observed | Fixture | Notes |
|---|---|---|---|---|
| `claude agents --json` | `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`, and `waitingFor` when `status == "waiting"` | 2.1.263 | `fixtures/claude-agents.json` | Authoritative for **liveness only**. Lists top-level terminal CLI sessions; never subagents, never Desktop or IDE sessions. Interactive sessions emit exactly the seven keys above and nothing else; re-verified live in WP1 with four sessions open. Costs 257-275 ms per call on this machine (five runs, mean 263 ms; the WP0 audit measured ~373 ms cold), so it runs on registry change and every 20-30 s under a 5 s timeout, not on a tight loop. `id` and `state` appear for background sessions only and were not observed; neither was `waitingFor`, because no session was waiting during either measurement. |
| `~/.claude/sessions/<pid>.json` | `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, `name`, `status`, `updatedAt`, `statusUpdatedAt`, `version`, and `nameSource` **in the desktop shell only** | 2.1.263 | `fixtures/sessions/100{1,2,3}.json` | The registry Nazar watches with `fs.watch`; mtime moves on every status transition. 19 keys observed, of which we use 11. The rest (`procStart`, `peerProtocol`, `peerFeatures`, `entrypoint`, `pidDomain`, `messagingSocketPath`, `nameSince`, `bridgeSessionId`) are ignored. **`nameSource` moved off that list in WP8b** and is read by `apps/desktop/src/titles.rs` alone, which needs to tell a name a person typed from one Claude Code derived from the project directory — the jump ladder weighs the two very differently as evidence. Observed values: `derived`, on all four live sessions here. One line of minified JSON per file, 586 bytes on this machine. `status` was seen as `busy` and `idle`; there is **no `waitingFor` key here**, so the file can say a session is waiting and never say what for — that comes from `claude agents --json` alone. The reader accepts a file name of `<digits>.json` and nothing else: **never read the sibling `<pid>.<hash>.key` files**, they are credential material, and a test asserts the skip. |
| `~/.claude/projects` | directory listing only: one entry per project slug | 2.1.263 | none (the store itself) | **WP4b enumerates this directory**, which nothing before it did: the history panel lists past sessions, and a past session is one that no source but the filesystem remembers. The walk is `readdir` on this directory, `readdir` on each project directory, one `stat` per `<session>.jsonl` and one `readdir` per `subagents/` that exists — **no file is opened**, and a test asserts the read counter stays at zero for a listing. Measured here: 68 project directories, 134 session transcripts, 57 session directories of which 33 hold subagents, walked in **16-18 ms**. The listing is therefore rebuilt on demand rather than watched; a 2 s TTL keeps a burst of requests from repeating it. |
| `~/.claude/projects/<slug>` | directory name only | 2.1.263 | slug table in `packages/core/test/project-slug.test.ts` | The slug is `cwd.replace(/[^a-zA-Z0-9]/g, "-")`; past **200** characters it becomes the first 200 characters, a `-`, and `Math.abs(h).toString(36)` where `h` is a 32-bit `h = h * 31 + c` hash **of the original path**, not of the sanitized one. Verified twice: all 68 directories on the maintainer's machine reproduce from the `cwd` recorded inside their own transcripts, and the transform is carried verbatim in the shipped binary. The regex has no `u` flag, so it replaces **UTF-16 code units**: an astral emoji is a surrogate pair and costs two dashes. Case is preserved, which matters on Windows, where the filesystem does not care but this directory name does. |
| `~/.claude/projects/<slug>/<session>/subagents` | directory listing only: `agent-*.meta.json`, `agent-*.jsonl`, `workflows/` | 2.1.263 | `fixtures/subagents/` | The side-car directory a session gets when it spawns its first subagent; absent otherwise, which is the normal case and not an error. Present under 33 of 68 project session directories here. Every meta file has a transcript and every transcript a meta file (346 of 346, both directions). Any other entry is ignored by name, so a new file type Claude Code adds is skipped rather than parsed. |
| `~/.claude/projects/<slug>/<session>/subagents/agent-*.meta.json` | `agentType`, `model`, `parentAgentId`, `spawnDepth`, `toolUseId` | 2.1.263 | `fixtures/subagents/agent-a00000000000000{1..7}.meta.json` | The whole subagent tree, already on disk: 6 keys total, the parent chain closes 100 %, and `spawnDepth` (1-3 observed) is written into the file rather than computed. Re-verified in WP2 across **346 files**: `agentType`, `description`, `toolUseId`, `spawnDepth` on all 346; `model` on 328 (`opus` 319, `sonnet` 8, `haiku` 1); `parentAgentId` on 59, all of them resolving (287 roots at depth 1, 31 at depth 2, 28 at depth 3, **0 dangling**). A depth-1 root omits `parentAgentId` entirely here, though the WP0 audit also saw it as an empty string, so both spellings mean root. `agentType` values seen: `general-purpose` (328), `Explore` (12), `claude-code-guide` (6). **`description` is written by a person and is deliberately not in the "fields used" column** — Nazar keeps it in memory for the hover card only when it is 200 characters or shorter, and writes it nowhere. `model` here is a shortcut (`opus`); the full id lives in the parent transcript's `toolUseResult.resolvedModel`. |
| `~/.claude/projects/<slug>/<session>/subagents/workflows/<runId>` | directory names only, plus the `agent-*` files inside a run directory | not observed | none | Workflow runs group their agents under a run id. **0 of 33 session directories on this machine had a `workflows/` directory**, so the shape is handled defensively rather than pinned: a run whose directory carries meta files contributes ordinary agents tagged with its `runId`; a run with none is still surfaced as an empty group, never dropped. The first machine that produces one is the one that turns this row into an observation. |
| `~/.claude/projects/<slug>/<session>.jsonl` | `type`, `timestamp`, `uuid`, `parentUuid`, `sessionId`, `requestId`, `apiBlockIndex`, `effort`, `isSidechain`, `agentId`, `message.id`, `message.model`, `message.role`, `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, the `name` of `tool_use` blocks, and `toolUseResult.{agentId, resolvedModel}` plus its duration numbers | 2.1.263 | `fixtures/transcript-slice.jsonl`, `fixtures/subagents/parent-slice.jsonl` | **Deduplicate by `(message.id, requestId)`.** The same message is written once per content block with the full `usage` object on every copy; a naive sum inflated output tokens by 2.08x on a real session, 2.49x on `transcript-slice.jsonl` and 2.38x on `parent-slice.jsonl`. Coverage measured in WP2 over **49,936 assistant lines in 480 transcripts**: `message.id` on all of them, `requestId` on all but **2** (hence the `dedupeFallbacks` counter), the four `usage` counters on all of them, `effort` on all but 194 (older files). `apiBlockIndex` explains *why* lines repeat but **cannot be the key: 29,704 of those lines do not have it.** Files are append-only, so `fs.watch` plus a byte offset works; never re-read a whole file (they reach 9 MB). Writes are asynchronous, so totals can lag a few seconds — show the age of the last write. `cache_read_input_tokens` runs ~1000x the other counters and must be displayed separately. Line types other than `assistant` and `user` are skipped by **this** reader; `attachment` lines in particular carry hook output and system-prompt text. One other line type is read, by one other reader, and it has a row of its own below. |
| `~/.claude/projects/<slug>/<session>.jsonl` -> the last `ai-title` line | `type`, `aiTitle` | 2.1.263 | `fixtures/transcript-slice.jsonl` (the shape; the desktop shell reads live files) | **Read by the desktop shell alone** (`apps/desktop/src/titles.rs`, WP8b), and never by `packages/core` — the TypeScript transcript reader still skips every `ai-title` line, and the leak tests that say so are unchanged. It exists because rung (b) of the jump ladder needs to know what a session is *called*, and this is the only place on disk that says: **Claude Code writes the generated title into the terminal title**, with a one-character status mark in front of it (`◐ Refactoring the settings reader`), while the registry's `name` for the same session is a directory-derived `nazar-7f` that appears in no title anywhere. Shape: `{"type":"ai-title","aiTitle":"…","sessionId":"…"}` — three keys, of which two are read. The line is **appended, not replaced**, so the last one wins: 190 of them in a 9 MB transcript here, 15-61 in the others, roughly one per 48 KB. The read is a **1 MB tail scanned backwards, stopping at the first `ai-title` line**, so no other line type is ever parsed and a 76 MB transcript costs a megabyte; a title older than that window is out of reach, and the deliberate consequence is a jump that falls back to the narrowing rules rather than a reader that grows without a bound. **Absent on a session Claude Code has not titled yet** — measured: a seven-turn session had no such line anywhere in its 0.35 MB transcript, so this is not a tail-window effect and widening the window would not find one. That is an ordinary answer rather than an error, and it is the case `nazar_shell::tabs::resolve` handles by exclusion and by the default terminal title (WP8c): what such a session's terminal is showing is Claude Code's own name, `✳ Claude Code`. |
| Windows Terminal's UI Automation tree — its `TabItem` elements | the element's accessible `Name` and its position; `SelectionItemPattern`, to select one | Windows Terminal 1.x on Windows 11 | `crates/nazar-shell/src/tabs.rs` tests (hand-written candidates; there is no terminal on a CI runner) | **Read by the desktop shell alone** (`apps/desktop/src/jump.rs`, WP8b), and the one format on this page owned by **Microsoft** rather than by Anthropic or nazar-tray. It exists because every Windows Terminal window belongs to one `WindowsTerminal.exe`: a process-tree walk narrows a session to the *program* and no further, so four windows on four monitors are one pid and the ranking cannot tell them apart. The tree is reached through `CoCreateInstance(CUIAutomation)` **on its own thread under a deadline**, because a cross-process accessibility call blocks on another program's UI thread and the shell's message loop must not wait on it. Selection is `SelectionItemPattern.Select()` on the element already in hand, so **`wt.exe` is never invoked** — its `focus-tab` subcommand would work and is deliberately not used — and a test asserts the jump starts no process at all. Restricted to `TAB_HOSTS` (`crates/nazar-shell/src/tabs.rs:96`), deliberately the single entry `WindowsTerminal`: VS Code and Cursor publish `TabItem` elements too, for *editor* tabs, and selecting one would be confidently wrong. If Windows Terminal stops publishing the tab title as the accessible name, that rung stops matching and the jump falls back to the subtractive rules rather than raising a wrong window. |
| The Windows process table and window list — `CreateToolhelp32Snapshot`, `EnumWindows`, `GetWindowThreadProcessId`, `GetWindowTextW` (`apps/desktop/src/jump.rs:290-291, 337, 348, 358, 381, 395, 401, 408, 423`) | pid, parent pid, executable file name; a window's handle, owning pid, visibility, and title text | Windows 11 | `crates/nazar-shell/src/{proc,rank}.rs` tests | Owned by the **operating system**, and read only by the desktop shell, during a jump the user asked for. The parent walk is bounded to `MAX_DEPTH` 8, cycle-guarded against pid reuse, and stops at pids 0 and 4. ⚠️ **A window title read here can be another Claude Code session's generated title** — the same string the `ai-title` row above is careful about, because Claude Code writes it into the terminal title. Its only destinations are a string comparison and the one sentence the jump reports, and that sentence names the host executable rather than the title. Nothing read here is written to a file, sent over the HTTP wire, or drawn on the canvas: the outcome that returns to the shell's own webview carries the chosen window's title as a field, and `packages/ui/web/shell.ts` renders only the sentence. |
| `~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl` | the same field list as the session transcript above | 2.1.263 | `fixtures/subagents/agent-a0000000000000006.jsonl` | One transcript per subagent, tailed and deduplicated exactly like the session's own, which is why a subagent's tokens are never folded into its parent's count by accident. On this machine, all **70,282** lines of all 346 subagent transcripts carry `agentId` and `isSidechain: true`; `sessionId` is the **parent session's** uuid, not the file name, so the agent id must come from the file name. A subagent transcript can itself contain `toolUseResult.agentId`, which is how a depth-3 agent is bridged from its depth-2 parent. |
| `toolUseResult` on a `user` line (`Agent` tool result) | `agentId`, `resolvedModel`, `status`, `isAsync`; `totalDurationMs` / `durationMs` / `durationSeconds` when present | 2.1.263 | `fixtures/subagents/parent-slice.jsonl` | The parent-to-subagent bridge: 348 launches on this machine, **all 348** carrying `agentId` and `resolvedModel` (`claude-opus-5[1m]` 328, `claude-sonnet-5` 12, `claude-haiku-4-5-20251001` 6) and matching the meta files one to one. ⚠️ **It is a launch record, not an ending.** Re-measured in WP4b across the whole store: **348 of 348** carry `isAsync: true` and `status: "async_launched"`, and **0 of 348** carry any duration field — the `Agent` tool returns as soon as the subagent starts, and the parent writes its tool result there. Reading a bridge as "the subagent finished" marked an agent that had written 124 ms earlier as done, on live data. `isCompletionResult()` is the gate: a result is an *ending* only when `isAsync !== true` and `status` is not in `LAUNCH_STATUSES`. The synchronous shape (neither key, a duration present) still counts as an ending, so an older Claude Code keeps working. A resumed agent answers with `resumedAgentId` instead and is not read. The same object also carries `prompt` (the subagent's entire brief), `description`, `stdout`, `stderr`, `content`, `outputFile`, `canReadOutputFile`, `oldString` and `newString`: **none of them is read**, and the leak test in `packages/core/test/transcript-extract.test.ts` is what keeps it that way. |
| `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` | `statusLine.command` **only** | 2.1.263 | `packages/core/test/project-settings.test.ts` (temp directories) | **Added in WP4f, and the only file Nazar reads that lives outside the home directory.** Claude Code merges a project's settings over the user's, so a repository that sets `statusLine` for itself does not chain to the `nazar-statusline` wrapper — it *replaces* it, for every session started in that directory. The wrapper then never runs, no capture is written, and cost and context are missing on exactly those cards and no others, on a machine where everything is installed correctly. That is undiagnosable from the canvas, so the canvas says it: `captureBlockedBy: "project statusLine"` on the session, one line on the card, and `nazar doctor` printing the offending file and the exact key. Read **read-only**, with `readFile`, and only for a live session that has been alive past `CAPTURE_GRACE_MS` (90 s) with no capture — a session four seconds old has not necessarily had a status-line redraw yet, and a wrong explanation is worse than none. The parser builds a new object from `statusLine.command` alone: `permissions`, `hooks`, `env`, `model`, `apiKeyHelper`, `mcpServers` and everything else in that file are never named, and `test/no-writes.test.ts` fails if this reader so much as mentions `permissions`, `hooks`, `env`, `model` or `apiKeyHelper` — the five it pins by name. A command containing `nazar-statusline` is **not** an override; a `statusLine` key with no readable command is, because the key displaces the user-level one either way. Malformed JSON reads as "this project says nothing", not as an error: a settings file someone is half-way through editing is not evidence. Answers are cached per directory for five minutes — a settings file changes about as often as a repository is cloned. |
| Status-line payload (stdin JSON handed to `statusLine.command`) | `session_id`, `cost.total_cost_usd`, `context_window.*`, `effort.level`, `model.id`, `model.display_name`, `rate_limits.{five_hour,seven_day,spend_limit}` | 2.1.263 | `fixtures/statusline-payload.json` | The payload itself, as Claude Code hands it to a status line. Nazar never reads it from a pipe — it reads the capture the wrapper wrote, one row down — so this row exists to pin the *shape* the capture carries. `rate_limits` exists only on Pro and Max plans and only after a session's first API response, and Claude Code drops a window once its `resets_at` has passed, which is why the real capture in `fixtures/` has only `seven_day`. The wrapper keys its file by `session_id`: a single fixed path is overwritten by every concurrent session, which is the mistake the WP0 data-layer audit found in the prototype it replaced. Nazar still writes nothing under `~/.claude` and installs nothing.
| `~/.claude/settings.json`, plus the listing that finds `~/.claude/settings.json.nazar-bak-<stamp>` | `statusLine.command` **only**, and the backup file's modification time | 2.1.263 / wrapper 0.1.0 | `packages/core/test/project-settings.test.ts` (temp directories) | **Added in N-WP9, and it moved this file up out of the “not read” table below.** WP4f could tell a user that *a project* had replaced the status-line wrapper; it could not tell them the three commoner reasons a live session has no capture — the wrapper was never installed, something replaced it since, or the session is older than the install — and all three are written in this one file. `nazar doctor` now names whichever applies, per session. **Read-only, one key, and never written**: `test/no-writes.test.ts` allows exactly two files to spell this path (the reader and the barrel), pins the reader's whole set of filesystem imports to `readFile`, `readdir` and `stat`, and still fails the build on any binding that could modify a byte. Precision mode (WP7, v1.1) remains the only thing that will ever *change* this file, with a backup, a shown diff and an exact uninstall. The install date comes from the wrapper's own artefact where there is one: `nazar-statusline install` copies the settings file to `settings.json.nazar-bak-<stamp>` **before** it edits anything, never overwrites an existing copy and leaves it behind on uninstall (nazar-tray's `docs/statusline-wrapper.md`), so the **oldest** such copy dates the first install. The stamp's format is nazar-tray's, so the name is matched by prefix and the time is taken from `stat`; the file itself is a copy of the user's settings and is **never opened**. With no backup on the machine the settings file's own mtime is used and the report says so, because any other edit to that file moves it too. |
| `~/.nazar/statusline` | directory listing only: one `<session_id>.json` per session, plus `chain.json`, skipped by name | wrapper 0.1.0 | `fixtures/statusline-captures/` | The directory `nazar-statusline` writes into — a nazar-tray binary, not ours. Read on the same 2 s poll as every other source, with `fs.watch` as the accelerator. **Absent on any machine without the wrapper, which is the normal case and not an error:** the reader answers `configured: false`, the strip is hidden and the two optional hover-card rows are not drawn. Files are rewritten on every status-line redraw and removed seven days after a session goes quiet. **`NAZAR_HOME` moves the whole root**, the same variable the wrapper honours (`packages/core/src/paths.ts:186-193`), which is how both test suites run without touching the machine they are on. **The two halves of Nazar resolve two different directories, and both are right** (settled in T-WP8 against nazar-tray's own `crates/nazar-core/src/paths.rs` and written into its `docs/limits-contract.md`). `paths.ts` resolves nazar-tray's **data** directory, `<home>/.nazar`, which is where `limits.json`, `limits.lock`, `tray.request` and `statusline/` live and is the only root a consumer reads; `apps/desktop/src/config.rs` resolves its **settings** directory, `%APPDATA%\nazar` on Windows and `$XDG_CONFIG_HOME/nazar` or `~/.config/nazar` elsewhere, which is where the user's own `config.json` lives and where Nazar's `desktop.json` sits beside it. They were never two spellings of one path. `NAZAR_HOME` overrides both, which is what makes a whole installation pointable at a throwaway directory, and is why both move together when it is set.
| `~/.nazar/statusline/<session_id>.json` | envelope `schemaVersion`, `updatedAt`, `wrapper`, `sessionId`; payload `cost.total_cost_usd`, `context_window.{total_input_tokens,context_window_size,used_percentage}`, `effort.level`, `model.{id,display_name}`, `rate_limits.{five_hour,seven_day,spend_limit}.{used_percentage,resets_at}` | CC 2.1.263 / wrapper 0.1.0 | `fixtures/statusline-captures/00000000-0000-4000-8000-00000000000{1,2,3}.json` | **Consumed from v1 (WP3′, `0fd7b18`).** The capture is the *whole* payload inside a four-field envelope — the wrapper does not decide on every redraw which fields its two consumers will ever want — so it carries `cwd`, `transcript_path`, `scratchpad_dir`, `workspace.*` and `session_name`. **None of them is read**, and `packages/core/test/statusline-captures.test.ts` fails if a sentinel planted in any of them reaches the parser's output. A `schemaVersion` other than 1 is refused rather than parsed hopefully. `resets_at` is Unix **seconds**; a value past 10^12 is read as milliseconds, so a future switch degrades instead of breaking. `used_percentage` is the payload's own and is never recomputed here, so the canvas and the status line cannot disagree by a rounding step.
| `~/.nazar/statusline/chain.json` | **nothing: never opened** | wrapper 0.1.0 | `fixtures/statusline-captures/chain.json` | The wrapper's record of the status line it displaced. It sits among the captures, so the reader has to know it exists — and all it does with that knowledge is skip it by name. The fixture is there to pin the skip, and to keep a malformed-capture count from including it.
| `~/.nazar/limits.json` | `schemaVersion`, `updatedAt`, `providers.<name>.{configured,plan,source,sourceAt,binding}`, `providers.<name>.windows.<key>.{percent,resetsAt,windowMinutes,state,error,model,detailed}` | contract v1 | `fixtures/limits.sample.json`, vendored from nazar-tray | **Consumed from v1 (WP5, `0fd7b18`).** Written by nazar-tray; the contract is `docs/limits-contract.md` in that repository, and the fixture is *its* sample copied in verbatim, as that document asks consumers to do. Five properties this reader depends on: `percent` is **optional**, and an absent one is drawn as *unknown* rather than as `0 %`; window keys are open-ended (`five_hour`, `seven_day`, `seven_day_<model>`, `primary`, `secondary`, and whatever a later writer adds), so the reader iterates and hard-codes no set; `state` and `source` are plain strings and an unrecognised value survives as written; every timestamp is RFC 3339 in UTC and every derived value — which window binds, the countdown, the age, the severity — is the consumer's to compute; and `binding` is **recomputed** rather than believed, because the file may have been written by an older build. A `schemaVersion` other than 1 is refused by name. Absent on a fresh machine: with neither this file nor a capture, the strip is hidden entirely. `NAZAR_HOME` moves this file too, by the same `nazarHomeDir` the captures use; `%APPDATA%\nazar` is nazar-tray's *settings* directory and holds none of this, as the note three rows up says.
| `%APPDATA%\nazar\desktop.json` (`$NAZAR_HOME`, else `$XDG_CONFIG_HOME/nazar`, else `~/.config/nazar`) | `schemaVersion`, `autostart`, `port` — and every other key, read and written back untouched | Nazar's own, schema 1 | `apps/desktop/src/config.rs` tests | **The one file any part of Nazar writes**, and it is on this page because the *directory* is shared rather than because the format is somebody else's: nazar-tray owns `config.json` in it and Nazar owns `desktop.json`, and `the_file_is_not_the_one_nazar_tray_owns` asserts the two names never converge. Resolved by `apps/desktop/src/config.rs:79-94` and written by `:123-149` — atomically, through a temporary file beside the target and a rename, because a rename across volumes is not atomic and `%APPDATA%` and `%TEMP%` are on different volumes more often than one would like. Written when the user toggles the start-with-Windows switch, and once more the first time the canvas comes up on a port this file does not already name; reading never creates it. **`port` (N-WP9)** is the loopback port the shell serves the canvas on. It is stored because `localStorage` is keyed by origin and an origin includes the port, so an ephemeral port picked afresh each launch meant a desktop application that forgot the user's layout, tabs, projects, card names, notes and colours every time it started. On the next launch a stored port that is free is bound again; one held by a healthy Nazar of the same version — `GET /api/state` answering `200` with a matching `X-Nazar-Version` header — is *adopted* rather than duplicated, and never killed on Quit, because it may belong to a terminal running `nazar --port`; anything else means a new port and, once, a lost arrangement. A fixed default was rejected because `npx @xfurqan0/nazar` binds 4676 and the two copies would take it from each other. A `port` that is not a number in 1-65535 reads as absent without costing the rest of the document, which the derived deserialiser would have done. A key a newer build wrote survives a round trip through an older one. **The JavaScript half writes nothing anywhere**, and `test/no-writes.test.ts` still proves it: this row does not weaken that gate, because the gate covers the whole of the JavaScript and this file is Rust. |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (a LaunchAgent on macOS) | one entry: whether Windows starts Nazar at login | Windows 11 | none — `tauri-plugin-autostart` owns the key | The other half of the switch above. One entry, added when it goes on and removed when it goes off, written through `tauri-plugin-autostart` so **the key path is never a literal in Nazar's own source**. The registry is the truth and the file is the record of intent: `reconcile_autostart` (`apps/desktop/src/main.rs:426-440`) compares the two at start-up and corrects the file, so a user who removed the entry by hand does not get it back silently. |

## Not read, on purpose

| Path | Why not |
|---|---|
| `~/.claude/sessions/<pid>.<hash>.key` | Credential material. Never opened. |
| `~/.claude/settings.json` — the **user-level** file, for **writing** | Nazar writes nothing into Claude Code's settings. It reads one key of this file (the row above, N-WP9) and changes none of it. That is where `nazar-statusline` installs itself, and installing it is nazar-tray's business and the user's decision, taken in their own terminal with the diff in front of them. Precision mode (WP7, v1.1) is the only thing that will ever touch this file, with a backup, a shown diff and an exact uninstall. **`test/no-writes.test.ts` is the gate:** it fails if a source outside the two-file allow-list names `~/.claude/settings` at all, if a source outside the three-file allow-list names `settings.json` at all (WP4f reads the *project* file), if a source imports a `node:fs` binding that is not on a read-only allow-list, or if a file handle is opened with a flag other than `'r'`. |
| `<session>/tool-results/*` | Overflowed tool output: raw file contents, command output, fetched pages. Exactly the kind of leak Nazar exists not to be. |
| `message.content` text and `tool_use.input` | Metadata only. Tool **names** are read; tool **inputs** never are. |
| `agent-*.meta.json` -> `description` | Written by a person, describing their own work. Never written to disk, never serialised into an event, dropped entirely past 200 characters. **It is the only prose field in the node model, so it stops at three gates rather than one:** the live tree parses it into memory for the hover card, `toWireAgent` drops it before the wire (live *and* history), and **the history builder never constructs it at all** — `HistoryScanner` passes `omitDescription: true`, so a frozen session's `History` has no such key in memory either. `packages/core/test/history-leak.test.ts` keeps `description` off its allowed-key list and asserts on a synthetic session that the key is absent from the object, not merely from the wire. |
| `~/.claude/sessions/<pid>.json` -> `name` | A session title a user may have typed. Live only: it is redacted by `redact()` before the wire, and **history has no `name` field at all** — neither `History` nor `HistorySummary` declares one, and the history scanner never reads the sessions registry, so a past session is known by its id, its project slug and its measurements alone. |
| `~/.codex/auth.json`, and everything under `~/.codex` that is not one of the two paths below | **N-WP18 shipped the Codex reader**, so the rollout store and the thread locks moved out of this table and into the Codex section at the foot of this page, which has a not-read table of its own. What stays here is the rest of that directory, credentials first. **Codex quota still does not come from the rollout** — it reaches the canvas through `~/.nazar/limits.json`, which nazar-tray builds from Codex's API; `payload.rate_limits` is read by nobody here. |
| a capture's `cwd`, `transcript_path`, `scratchpad_dir`, `workspace.*`, `session_name`, `prompt_id` | The capture is the whole status-line payload, so every one of these is in the file. The parser builds a new object from a closed list rather than filtering a parsed one, so a field that is not on the list is gone with the parse result. The envelope's `sessionId` is the map key and is the only identifier that survives. A leak test plants a sentinel in each of the fields above and fails if it appears anywhere in the output or in `JSON.stringify` of it. |
| `~/.nazar/statusline/chain.json`, and the tray's writer lock beside `limits.json` | The wrapper's record of the status line it displaced, and the lock that makes "one writer" enforced rather than promised. Neither is quota. The first is skipped **by name** while listing captures, so it never even counts as a malformed one; the second is never named at all. |
| `~/.nazar`, for **writing** | Nazar consumes that directory and never writes to it. One writer per file and neither is us: `nazar-statusline` owns the captures, nazar-tray owns `limits.json`. `test/no-writes.test.ts` is the same gate here as it is for `~/.claude`, and it is a static one — it proves no code path *can* write, not that one particular run did not. **This is about `~/.nazar` and not about every directory with `nazar` in its name.** `%APPDATA%\nazar` is a different directory, and Nazar does write one file in it — its own `desktop.json`, which has a row in the table above. |
| The browser-local keys: `nazar.layout.v1`, `nazar.tabs.v1`, `nazar.names.v1`, `nazar.notes.v1`, `nazar.colours.v1`, `nazar.usage.v1`, and the unversioned `nazar.theme` and `nazar.palette` (`packages/ui/web/app.ts:133, 135`) | **Not a source.** Every other entry on this page is somebody else's data that Nazar reads; this is the one place Nazar *adds* data, and it is listed so the inventory is not read as complete when it is only complete about reading. Two of these keys hold text a person typed — a sticky note (`nazar.notes.v1`) and a card name (`nazar.names.v1`). All of it lives in the browser, on the page's own origin: never sent to the server, never written to disk, and never read back by any parser in this repository. The wire is one-way and the server has no code that could receive it. Clearing site data deletes them, and nothing else holds a copy. |

### Never extracted from a transcript line

This section is about **`packages/core`'s transcript reader**, the one that feeds
the canvas, and it is unchanged by WP8b. It builds a new object from a closed
list of fields; it does not filter a parsed line, so a field that is not on the
list is gone with the parse result. Everything below appears in real transcripts
on this machine and **none of it ever leaves the parser**:

- Any content-block body: `text`, `thinking` (and its `signature`), `tool_use.id`,
  `tool_use.input`, `tool_result.content`. Only a `tool_use` block's **`name`**
  survives, and it is the one string that does.
- Every `toolUseResult` field except the bridge: `prompt`, `description`,
  `stdout`, `stderr`, `content`, `filePath`, `originalFile`, `oldString`,
  `newString`, `structuredPatch`, `outputFile`, `matches`, `answers`.
- Line-level context: `cwd`, `gitBranch`, `version`, `entrypoint`, `userType`,
  `slug`, `promptId`, `promptSource`, `origin`, `permissionMode`, `aiTitle`,
  `lastPrompt`, `leafUuid`, `snapshot`, `hookAdditionalContext`, `hookInfos`,
  `attachment`, `artifacts`, `accountUuid`, `ownerAccountUuid`,
  `ownerOrganizationUuid`, `bridgeSessionId`.
- Message-level extras: `message.stop_reason`, `message.stop_details`,
  `message.diagnostics`, `message.type`, and every `usage` key beyond the four
  counters (`cache_creation`, `iterations`, `output_tokens_details`,
  `server_tool_use`, `service_tier`, `speed`, `inference_geo`).
- Whole line types: `attachment`, `system`, `summary`, `ai-title`,
  `last-prompt`, `file-history-snapshot`, `file-history-delta`, `mode`,
  `permission-mode`, `bridge-session`, `queue-operation`, `atis-latch`,
  `frame-link`, `artifact-*`. Only `assistant` and `user` lines are read at all.

**The one exception is outside this parser and stays outside it.** The desktop
shell reads the `aiTitle` of the last `ai-title` line — its own row in the table
above — because rung (b) of the jump ladder has to compare a session's title with
a terminal's. It is a separate reader in a separate language: nothing it reads
reaches `packages/core`, the wire, the canvas's state or any file. The title's
only destination is a string comparison and the one sentence the jump reports,
which has carried the same window title since WP8 anyway.

Two mechanical guards back the list: every string the extractor keeps is capped
at 200 characters, because every field on the list is an id, a model name, an
ISO timestamp or a tool name; and a leak test feeds a line whose every free-text
field carries a sentinel and fails if the sentinel appears in any emitted event
or in `JSON.stringify` of the accumulated state.

## History reads exactly the same files (WP4b)

The history panel adds no reader. It walks `~/.claude/projects` for the listing
(the row above) and, when a session is opened, runs that session through the
same four pieces the live canvas uses — `TranscriptTailer`,
`extractTranscriptLine`, `TranscriptStats`, `buildAgentTree` — over the same
paths in the table above. There is one parser in this codebase, and a
regression test opens a fixture session through *both* paths and fails if their
token totals, tool counts, models or per-agent numbers disagree.

Three consequences worth writing down:

- **A project is known by its slug and nothing else.** `cwd` is on the
  never-extracted list, so history cannot recover a working directory and does
  not try. The slug's own home prefix is collapsed to `~` before it leaves the
  scanner (52 of the 68 directories here carry the account name), and the
  result then goes through the same `redact()` the live canvas puts `cwd`
  through.
- **Reads are bounded, not just incremental.** History starts at byte zero of
  files that reach **76 MB** on this machine, so it drains them in 4 MB slices
  (`maxBytesPerRead`) rather than concatenating a file into one buffer, and it
  opens at most four at a time. Parsed sessions are cached by
  `(path, size, mtime)`, 50 at most, least-recently-used dropped first.
- **Nothing is written, moved, copied or deleted.** Retention is Claude Code's
  (`cleanupPeriodDays`, default 30; the maintainer runs 90). A session that
  Claude Code expires disappears from the panel, and Nazar keeps no copy of it
  anywhere.

A second leak gate covers this path: `packages/core/test/history-leak.test.ts`
runs **ten real transcripts from the machine it is run on** through the history
builder and asserts that every string in the result sits under a key on a closed
list, that none is longer than 200 characters, that twenty words sampled at test
time from each file's own `text` and `thinking` blocks appear nowhere in the
output, and that no home path, account name or e-mail address does either. It
skips on a machine with no transcript store, so CI does not fake a pass.

## Codex (N-WP18)

**Observed under Codex 0.153.4 (and four earlier builds back to 0.150.0-alpha.8),
Windows 11, 2026-09-09**, over the 19 rollouts on the maintainer's machine — 4,600 lines,
46 MB, `originator` `codex_exec` and `Codex Desktop`. Every claim below was measured
there; the audit read **keys and numbers only** and no prompt, command or output text was
ever printed, written to a file, or put in a fixture.

Codex writes nothing that corresponds to `~/.claude/sessions/<pid>.json`. There is no
registry of live sessions, no process id anywhere in the record, and no `claude agents
--json` to ask. One append-only JSONL per thread is the whole of it, plus a lock file
while a writer holds the thread open.

### Line shape

Every line is `{ timestamp, type, payload }`, plus an `ordinal`. **`ordinal` is not a line
index**: a thread forked out of another one starts at the parent's
`history_base.end_ordinal_exclusive`, so one 118-line file ends at ordinal 410. Offsets
are bytes, as everywhere else in this codebase.

`type` is one of six, and `payload.type` refines two of them:

| `type` | `payload.type` | Seen | Read? |
|---|---|---|---|
| `session_meta` | — | 20 | yes: `id`, `timestamp`, `cwd`, `cli_version`, `source`, `parent_thread_id`, `base_instructions.provenance.model` |
| `turn_context` | — | 42 | yes: `model`, `effort`, `cwd`, `turn_id` |
| `token_usage_record` | — | 246 | yes: `thread_token_usage` (six counters) |
| `event_msg` | `item_completed` | 802 | only `item.type`, `item.status`, and `item.tool` on an MCP call |
| `event_msg` | `token_count` | 363 | yes: `info.total_token_usage` |
| `event_msg` | `task_started` | 41 | yes: `turn_id` |
| `event_msg` | `task_complete` | 37 | yes: `turn_id` |
| `event_msg` | `turn_aborted` | 3 | yes: `turn_id` |
| `event_msg` | `thread_settings_applied` | 31 | yes: `thread_settings.{model, reasoning_effort, cwd}` |
| `response_item` | `custom_tool_call` / `function_call` | 318 | yes: `name` |
| `response_item` | `custom_tool_call_output` / `function_call_output` | 318 | the line's existence, and nothing in it |
| `response_item` | `message` | 229 | `role`; the text **only** under the task-text switch |
| `response_item` | `reasoning` / `agent_message` | 319 | no |
| `world_state`, `realtime_item`, `inter_agent_communication_metadata` | — | 52 | no |

### The five facts a card is built from

- **Tokens are cumulative for the thread and need no deduplication.** Both
  `token_usage_record.thread_token_usage` and `event_msg/token_count.info.total_token_usage`
  carry the same six counters and the same values; the last one in the file is the answer.
  `total_tokens == input_tokens + output_tokens` held on all 16 rollouts with a record, and
  `cached_input_tokens` is a **subset of** `input_tokens` — the opposite of the Anthropic
  usage block, where the two are disjoint. So the reader reports `in = input − cached` and
  gives the cached read its own field, or the same number would mean two things on two
  cards. `cache_write_input_tokens` was `0` on all 16, so whether it too sits inside
  `input_tokens` is unobserved and it is passed through untouched.
- **A turn is a bracket.** `task_started` opens one and `task_complete` or `turn_aborted`
  closes it, matched on `turn_id`. Open means `busy`, closed means `idle`, and no bracket
  at all means `unknown`. The brackets balanced on 18 of the 19 files; the one that did not
  is a multi-agent thread whose last turn was still open when it was last written.
- **A tool call is a second bracket.** `custom_tool_call` / `function_call` opens it and the
  matching `*_output` closes it; they balanced exactly on every finished file. Codex routes
  shell, `apply_patch` and MCP through one custom tool called `exec`, so the *name* on the
  call is rarely informative — the `item_completed` that follows names what actually ran
  (`CommandExecution`, `FileChange`, `McpToolCall`, `Extension`, `CollabAgentToolCall`,
  `ImageView`), and an `McpToolCall` names its own `tool`. That is where the card's current
  tool comes from.
- **Model and effort move mid-thread.** `session_meta` carries only the model the base
  instructions were provenanced from; `turn_context.model` / `.effort` and
  `thread_settings_applied` are what a `/model` actually changes, and both were observed
  changing inside one file.
- **Subagents exist, and they are siblings rather than children.** A thread Codex spawns
  gets its **own rollout file**, with `session_meta.payload.source.subagent.thread_spawn`
  carrying `parent_thread_id`, `agent_nickname`, `agent_path` and `depth`. Three of the 19
  files are such threads. Nazar draws them as their own cards: nesting them would mean
  keeping a card alive because *another* file is being written, which is exactly the "no
  news is still running" inference the rest of the product refuses.

### Liveness, and the one thing that is honestly missing

**There is no pid.** Not in `session_meta`, not in `turn_context`, not anywhere: the only
process id in a rollout is `item.process_id` on a `CommandExecution`, which is the *child*
Codex spawned and not Codex. A Codex card therefore shows no pid and offers no
jump-to-terminal — absent, rather than offered and then failed. Matching a rollout to a
`codex.exe` by start time does not work either and was tried: one long-lived Codex Desktop
process opened a thread five and a half hours after the process itself started.

What does exist is `~/.codex/thread-writer-locks/<thread id>.lock` — zero bytes, named
after the thread, held open by the writer while the thread is open. On this machine, 19
rollouts had exactly **one** lock and it named the newest thread; opening the file for
writing fails with `EBUSY`. Nazar reads the **listing only** and never opens it: a lock is
`state: 'alive'`, and a rollout with no lock but a write in the last 90 seconds is
`state: 'unknown'` for one window and then gone.

**No approval request is ever written down.** All 19 rollouts were swept for a
request-shaped key at every depth — `approval`, `pending`, `awaiting`, `confirm`,
`permission`, `elicit`, `user_input`, `clarif` — and every hit was a *policy*:
`turn_context.approval_policy`, `.approvals_reviewer`, `.permission_profile`,
`thread_settings_applied.thread_settings.approval_policy`, and
`world_state.state.permissions.approved_command_prefixes`. Four turns ran under
`approval_policy: on-request` and none of them recorded a request. So a Codex thread
sitting on a permission prompt is indistinguishable on disk from one thinking hard, and
**Nazar never shows a Codex session as `waiting`**. If Codex starts persisting the event,
this is the row to change.

### Inventory

| Path | Fields used | Version observed | Fixture | Notes |
|---|---|---|---|---|
| `~/.codex/sessions` | directory listing only: `<year>/<month>/<day>` names | 0.153.4 | none needed | Walked newest-first by **name**, not by `stat`. Only the newest 7 day directories are listed, which bounds a store that gains a directory a day for as long as Codex is installed. |
| `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` | `timestamp`, `type`, `payload.type`, and per record: `id`, `cwd`, `cli_version`, `source`, `parent_thread_id`, `base_instructions.provenance.model`, `model`, `effort`, `turn_id`, `thread_token_usage`, `info.total_token_usage`, `thread_settings.{model, reasoning_effort, cwd}`, `item.{type, status, tool}`, `name`, `role` | 0.153.4 | `fixtures/codex/rollout-{open,closed,subagent}.jsonl` | Append-only; tailed by byte offset with the same `TranscriptTailer` the Claude Code side uses. A name that does not match `rollout-*.jsonl` is not opened. |
| `~/.codex/thread-writer-locks` | directory listing only: one `~/.codex/thread-writer-locks/<thread_id>.lock` per open thread | 0.153.4 | none — a lock is a zero-byte file whose *existence* is the datum | The liveness signal, and the only one there is. The listing is read and the file is **never opened**: it is held open by its writer, and on Windows opening it fails with `EBUSY`. `.coordination.lock` is Codex's own global lock and is skipped by its leading dot. |

### Not read, on purpose

| Path or field | Why not |
|---|---|
| `~/.codex/auth.json` | Credential material sitting in the same directory. **Never opened**, and nothing in `paths.ts` resolves it. |
| `~/.codex/*.sqlite`, `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/archived_sessions`, `~/.codex/attachments`, `~/.codex/generated_images`, `~/.codex/dictation-history` | Everything else in that directory. Nazar opens two paths under `~/.codex` and no others. |
| `payload.item.{command, parsed_cmd, stdout, stderr, aggregated_output, formatted_output, changes, arguments, result, content}` | The command that ran, its output, and the diff it produced — raw file contents and command output, which is exactly the kind of leak Nazar exists not to be. Tool *kinds* are read; tool inputs and outputs never are. |
| `payload.base_instructions.text`, `collaboration_mode.settings.developer_instructions`, `payload.instructions` | The system prompt, in three places. |
| `response_item/reasoning`, `response_item/agent_message`, `payload.last_agent_message` | The model's own prose and its private reasoning. Not read at any setting, including with task text on: that switch reads the **human** turn and nothing else. |
| `payload.rate_limits` on `token_count` | Codex's own usage windows. They reach the canvas already, through `~/.nazar/limits.json`, which nazar-tray builds from Codex's API — one reader per fact, and it is not this one. |
| `world_state`, `realtime_item`, `inter_agent_communication_metadata`, `payload.item.questions` | Whole record types Nazar has no use for. Only the eleven `payload.type` values in the table above are read at all. |
| `~/.codex/sessions/**` for **writing**, and `~/.codex/thread-writer-locks/*.lock` for **opening** | Nazar writes nothing here and takes no lock. `test/no-writes.test.ts` is the static gate; the lock is decided by the directory listing precisely so that no handle is ever taken on a file another process owns. |
