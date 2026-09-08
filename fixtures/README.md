# Fixtures

Sanitized samples of every internal file and command Nazar reads. They exist so
parsers can be tested without a live Claude Code session, and so CI can run on a
machine that has never seen Claude Code.

All of them were captured on the maintainer's machine on **2026-09-07** with
**Claude Code 2.1.263** on **Windows 11**, then stripped by hand. `test/fixtures.test.ts`
is the gate: it fails if any file here contains an email address, a real user home path
(the Windows per-user directory, or a macOS or Linux home directory), either of the
maintainer's handles, or a hexadecimal run of 32 characters or more that is not an
all-zero placeholder. The exact patterns live in that test.

**Rule for new fixtures:** sanitize first, add a row to the table below saying exactly
what you removed, then run `npm test`. Never commit a raw capture; `.gitignore` blocks
`*.raw.json`, `*.raw.jsonl` and `fixtures/local/`.

## Placeholder conventions

| Real thing | Placeholder |
|---|---|
| Working directory | `C:/proj/example` |
| Session UUID | `00000000-0000-4000-8000-0000000000NN` |
| Message / line UUID | `00000000-0000-4000-8000-0000000010NN` |
| Session name | `session-a` … `session-d` |
| Process id | `1001` … `1004` |
| Subagent id (17 hex) | `a000000000000000N` |
| Message id | `msg_0000000000000000000000NN` |
| Request id | `req_0000000000000000000000NN` |
| Tool use id | `toolu_00000000000000000000000N` |
| Free text written by a person | `[redacted]` or `task placeholder` |

Note on path separators: real Windows payloads use backslashes, JSON-escaped
(`"C:\\proj\\example"`). Most fixtures here use forward slashes, so they do not exercise
backslash unescaping; `sessions/1002.json` is the one that does, and it names the same
directory as its forward-slash siblings.

## Files

### `claude-agents.json`

- **Origin:** `claude agents --json`, run live with four interactive sessions open.
- **Kept as observed:** `kind`, `status`, `startedAt` (epoch milliseconds), and the
  overall array shape.
- **Replaced:** `pid` → `1000 + n`; `cwd` → `C:/proj/example`; `sessionId` → placeholder
  UUIDs; `name` → `session-a` … `session-d`.
- **Removed:** nothing. The command emits exactly these seven keys for interactive
  sessions.
- **Not represented:** `id`, `state` (background sessions only) and `waitingFor`
  (`status == "waiting"` only) never appeared on this machine, so WP1 cannot test the
  waiting-for-permission path against this fixture.

### `subagents/agent-a00000000000000{1..7}.meta.json`

- **Origin:** seven files from `~/.claude/projects/<slug>/<session>/subagents/`. The
  first four form one chain (depth 1 → depth 2 → two siblings at depth 3); `5`, `6` and
  `7` were added in WP2 as three standalone roots so the tree builder is exercised on a
  forest and not only on a single chain, and so the transcript slices below have meta
  files to pair with.
- **Kept as observed:** `agentType`, `model`, `spawnDepth`, and the exact key set
  (the real schema is exactly these six keys; a depth-1 root simply omits
  `parentAgentId`, and a `claude-code-guide` agent omits `model`).
- **Replaced:** file names and `parentAgentId` → synthetic 17-hex ids that keep the
  chain closed; `toolUseId` → numbered placeholder; `description` → `task placeholder`.
- **Removed:** nothing else — but note that `description` is **written by a person** and
  is the one field in this file that must never reach the UI.
- **The three added in WP2 pin the observed variation:** `5` is a `claude-code-guide`
  agent with **no `model` key** (18 of 346 real files omit it) and bridges to
  `claude-haiku-4-5-20251001`; `6` is a `general-purpose` agent with `model: "opus"` and
  is the one with a transcript; `7` is an `Explore` agent (12 of 346 real files) with no
  transcript, which is what an agent looks like in the moment between its meta file
  landing and its first transcript write.

### `subagents/agent-a0000000000000006.jsonl`

- **Origin:** the first 26 `assistant`/`user` lines of one real subagent transcript
  (`~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl`).
- **Kept as observed:** `type`, `timestamp`, `isSidechain`, `apiBlockIndex`, `effort`,
  `message.model`, `message.role`, the four `usage` counters and `service_tier`, the
  order of the lines, and the `name` of every `tool_use` block.
- **Replaced:** every uuid, `sessionId`, `agentId`, `message.id` and `requestId` →
  placeholders mapped one to one, so repeated keys stay repeated. `agentId` is
  `a0000000000000006` on all 26 lines and `sessionId` is the **parent session's**
  placeholder uuid, which is how the real files spell it: the agent id lives in the file
  name, never in `sessionId`. Every `text`, `thinking` and `tool_result` body →
  `"[redacted]"`; `tool_use` blocks → `{ "type": "tool_use", "name": … }`.
- **Removed:** `cwd`, `gitBranch`, `version`, `entrypoint`, `userType`, `slug`,
  `promptId`, `rendered`, `attributionAgent`, `attributionMcpServer`,
  `attributionMcpTool`, `sourceToolAssistantUUID`, `toolUseResult`, `message.type`,
  `message.stop_reason`, `message.stop_details`, `message.diagnostics`, the `usage` keys
  beyond the four counters, tool-use `id` and **all tool inputs**. Every
  `type: "attachment"` line was dropped whole.
- **Token shape:** 16 `assistant` lines carrying only 6 distinct
  `(message.id, requestId)` keys. Naive output 1140, deduplicated 1100 — a 1.04x
  inflation, far below the session slice's 2.49x, because a subagent answers in fewer
  content blocks. That difference is the point: the inflation factor is not a constant
  and cannot be applied after the fact.
- **The slice ends inside a message**, on its `thinking` block, so `currentTool` is
  `undefined` at the end of the file rather than the previous message's tool. That is
  the honest live behaviour and `test/session-tree.test.ts` asserts it.

### `subagents/parent-slice.jsonl`

- **Origin:** 25 lines of one real **session** transcript, starting at its first `Agent`
  launch. It is not part of a real `subagents/` directory — it is the parent that *owns*
  such a directory — and it lives here so the WP2 fixtures stay together. The reader
  ignores it: a transcript is only an agent's if its name starts with `agent-`, and
  `packages/core/test/subagent-meta.test.ts` asserts that.
- **Kept as observed:** everything the subagent slice keeps, plus `apiBlockIndex` on all
  22 assistant lines (WP0 had dropped it) and `isSidechain: false`.
- **Replaced:** the same placeholder mapping. `toolUseResult` is **narrowed to
  `{agentId, resolvedModel, isAsync, status}`** — the real object also carries `prompt`
  (the subagent's entire brief), `description`, `outputFile` and `canReadOutputFile`,
  none of which is in the fixture and none of which Nazar reads.
- **`isAsync: true` and `status: "async_launched"` were added in WP4b, and they are
  observed values, not decoration.** The `Agent` tool returns at *launch* on Claude Code
  2.1.263 and writes its tool result there, carrying these two keys and **no duration at
  all**: 348 of 348 bridges across the whole store on this machine are that shape. WP4b's
  first draft read a bridge as "the subagent finished" and consequently marked a subagent
  that had written 124 ms earlier as done. A fixture without these two keys would pin the
  synchronous shape that no longer exists here and would let that bug back in, which is
  why `test/fixtures.test.ts` now asserts both.
- **The three bridges resolve to two different models** (`claude-haiku-4-5-20251001` for
  agent `5`, `claude-opus-5[1m]` for agents `6` and `7`), so a test cannot pass by
  assuming one model per session. `test/fixtures.test.ts` fails if either property is
  lost.
- **The dedupe trap is preserved:** 22 `assistant` lines, 10 distinct keys, naive output
  41,411 against 17,371 deduplicated — 2.38x, close to the 2.08x measured on a whole
  real session. One message (`req_…110`) is written three times and launches an `Agent`
  from two of its three blocks.

### `transcript-slice.jsonl`

- **Origin:** the first 40 non-`attachment` lines of one real session transcript
  (`~/.claude/projects/<slug>/<session>.jsonl`).
- **Kept:** `type`, `timestamp`, `uuid`, `parentUuid`, `sessionId`, `requestId`,
  `isSidechain`, `effort`, `message.id`, `message.model`, `message.role`,
  `message.usage.*` (verbatim, including `cache_creation`, `output_tokens_details`,
  `iterations`, `service_tier`, `speed`).
- **Replaced:** all uuids, `sessionId`, `message.id` and `requestId` → placeholders,
  mapped one-to-one so **repeated keys stay repeated**. Every `text` and `thinking`
  block body → `"[redacted]"`. Every `tool_result` body → `"[redacted]"`.
  `tool_use` blocks → `{ "type": "tool_use", "name": … }`.
- **Removed:** `cwd`, `gitBranch`, `version`, `entrypoint`, `userType`, `session_id`
  (the duplicate of `sessionId`), `promptId`, `permissionMode`, `origin`, `promptSource`,
  `apiBlockIndex`, `message.type`, `message.stop_reason`, `message.stop_sequence`,
  `message.stop_details`, `message.diagnostics`, `toolUseResult`,
  `sourceToolAssistantUUID`, tool-use `id` and **all tool inputs**. Every
  `type: "attachment"` line was dropped whole, because attachments carry hook output and
  system-prompt text.
- **The dedupe trap is preserved:** 40 lines, 11 of them `assistant`, carrying only
  5 distinct `(message.id, requestId)` keys — three keys are written three times each,
  once per content block, with the full `usage` object repeated on every copy. Summing
  `output_tokens` naively gives **4799**; deduplicating by key gives **1929**, a 2.49x
  inflation. `test/fixtures.test.ts` fails if that property is ever lost.
- **Not represented:** `isSidechain: true` and `agentId` — the source was a main-session
  transcript, not a subagent one. `apiBlockIndex` was dropped as an out-of-scope field;
  WP2 may want it back to explain *why* lines repeat.

### `sessions/1001.json`, `sessions/1002.json`, `sessions/1003.json`

- **Origin:** `~/.claude/sessions/<pid>.json`, the registry WP1 watches. Four session
  files were open on this machine; three were sanitized into these.
- **Kept as observed:** the exact 19-key set and its order, `kind`, `entrypoint`,
  `version`, `nameSource`, `peerProtocol`, `peerFeatures`, and the epoch-millisecond
  timestamps. Pids and `startedAt` line up one-to-one with `claude-agents.json`, so the
  two fixtures describe the same sessions seen through the two different sources.
- **Replaced:** `pid` → `1001` … `1003`; `sessionId` → placeholder UUIDs; `cwd` →
  `C:/proj/example`; `name` → `session-a` … `session-c`; `procStart` → a fixed
  placeholder counter; `pidDomain` → `win32:example-user` (the real value carries the OS
  user name); `messagingSocketPath` → the same pipe shape with an all-zero id;
  `bridgeSessionId` → an all-zero placeholder (the real one is account-scoped).
- **Removed:** nothing. All 19 keys are present, the nine Nazar ignores included, so the
  fixture pins the whole shape and not only the part we read.
- **Reformatted:** the real files are one minified line of 586 bytes; these are
  pretty-printed so a diff is readable. No parser depends on the whitespace.
- **`1002.json` spells its `cwd` with backslashes** (`"C:\\proj\\example"`), the form real
  payloads use. It is the backslash sample the note above says WP1 needs, and it names
  the same directory as the other two.
- **`1003.json` carries `status: "waiting"`, and that one field is synthetic.** Only
  `busy` and `idle` were ever observed here, and provoking a real permission prompt would
  have meant interfering with a live session. Everything else in the file is a sanitized
  real capture. The marker sits in this note rather than as a `"_synthetic": true` key
  inside the JSON, because an extra key would stop the file being a faithful sample of
  the format. Note that the real format has **no `waitingFor` key**: a session file can
  say a session is waiting and never say what for. That field exists only in
  `claude agents --json`.

### `statusline-payload.json`

- **Origin:** the raw stdin JSON handed to a `statusLine.command`, captured by the
  maintainer's own status-line script. Nazar never reads a payload from a pipe — it
  reads the *captures* below, which wrap one of these — so this file pins the shape
  the capture carries, and is the payload the first capture fixture was built from.
- **Kept as observed:** `model`, `effort`, `version`, `output_style`, `cost`,
  `context_window`, `exceeds_200k_tokens`, `prompt_cache`, `fast_mode`, `thinking`,
  `rate_limits`. These carry real numbers; they are usage figures, not identity, and
  they are the entire reason the fixture exists.
- **Replaced:** `session_id`, `prompt_id` → placeholder UUIDs; `transcript_path`,
  `scratchpad_dir`, `cwd` → placeholder paths under `C:/claude-home` and
  `C:/proj/example`; `session_name` → `session-a`; the whole `workspace` object,
  including `workspace.repo.{host,owner,name}` → `example-owner/example-repo`.
- **Removed:** nothing.
- **Not represented:** `vim`, `agent`, `pr`, `worktree`, `workspace.git_worktree` and
  `rate_limits.spend_limit` are conditional and were absent in the capture.
  `rate_limits.five_hour` was also absent at capture time; only `seven_day` is present.

### `statusline-captures/00000000-0000-4000-8000-00000000000{1,2,3}.json`

Three captures as `nazar-statusline` writes them: the whole status-line payload inside a
four-field envelope (`schemaVersion`, `updatedAt`, `wrapper`, `sessionId`), one file per
session, **named after the session id** — a wrapper writing one fixed path would have
concurrent sessions overwrite each other.

- **Origin:** `1` is `statusline-payload.json` above, wrapped in a real envelope. `2` and
  `3` are hand-built from that same shape to cover what one capture cannot.
- **Replaced:** nothing beyond what `statusline-payload.json` already had replaced. The
  paths, the workspace object and the repository name are still in there, **on purpose**:
  they are what makes these files a leak test. A capture sanitized down to the four fields
  Nazar keeps would prove nothing, and `test/fixtures.test.ts` fails if any of `cwd`,
  `transcript_path`, `scratchpad_dir`, `workspace` or `session_name` is ever removed.
- **The three shapes, and why each is needed:** `1` carries **only `seven_day`**, because
  Claude Code drops a window once its reset has passed and that is what a live payload
  looks like; `2` carries **both windows**, which `1` cannot exercise, plus a different
  model and a 41 % context window; `3` carries **no `cost`, no `context_window` and no
  `rate_limits` at all**, because every one of those is optional and "absent" has to be a
  shape the reader has seen.
- **Not represented:** a capture from a newer wrapper (`schemaVersion: 2`), which is
  refused by name rather than parsed, and is tested against an inline sample.

### `statusline-captures/chain.json`

- **Origin:** the shape `nazar-statusline` writes beside its captures to record the status
  line it displaced. **Nazar never opens it.** It is here so the reader's skip is pinned:
  the capture scan ignores it by name, and a test asserts that it is neither parsed nor
  counted as a malformed capture.
- **Replaced:** every path → `C:/claude-home` and `C:/proj/example`.

### `limits.sample.json`

- **Origin:** copied **verbatim** from nazar-tray's `fixtures/limits.sample.json`. Its
  `docs/limits-contract.md` asks consumers to vendor that file rather than hand-write one,
  and this copy is what makes that instruction load-bearing here: if the two ever disagree,
  this repository's tests are what notice.
- **Replaced:** nothing. It was written to be safe to paste into a bug report — no tokens,
  no account identifiers, no session ids, no paths.
- **Why it is worth having:** it carries both providers, a plan name, a `seven_day_fable`
  window that only the opt-in detailed-windows mode can produce, and a `binding` that the
  reader deliberately recomputes rather than trusts.
- **Updating it** is a two-repository change, in nazar-tray's order: its `limits.rs` and
  its sample first, then this copy, then run `npm test` here.

## What has no fixture yet

- A session in `status: "waiting"` seen through `claude agents --json`, which is the only
  source of `waitingFor`. No session waited during either capture, so the four documented
  values (`permission prompt`, `input needed`, `sandbox request`, `dialog open`) are
  pinned in code and tested against an inline sample rather than a fixture.
- ~~`~/.nazar/limits.json`~~ → vendored in WP5 as `limits.sample.json`, from nazar-tray.
- A `limits.json` written by the **passive path alone** (`source: "statusline"`, no plan,
  no model-scoped weekly). The vendored sample is the detailed-mode document; the passive
  shape is a subset of it and is tested against inline samples rather than a fixture.
- ~~A subagent transcript~~ → added in WP2 as `subagents/agent-a0000000000000006.jsonl`.
- A `subagents/workflows/<runId>/` directory. **None exists on this machine** (0 of 33
  session directories), so the reader handles the shape defensively and the tests build
  it in a temporary directory instead. The first real one seen should become a fixture.
- An `assistant` line with **no `requestId`**. Two exist among 49,936 lines on this
  machine, both in old transcripts; the `dedupeFallbacks` path is tested against an
  inline sample rather than a fixture.
