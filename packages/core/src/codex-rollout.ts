/**
 * N-WP18: the Codex rollout reader.
 *
 * Codex keeps one append-only JSONL file per thread —
 * `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`, whose name ends in
 * the thread's own id — and that file is the whole of what it writes down. There is no registry of
 * live sessions the way `~/.claude/sessions/<pid>.json` is one, no process id
 * anywhere in the record, and no per-message token block: the counters are
 * cumulative for the thread, which is the one thing that makes this reader
 * *simpler* than the Claude side rather than harder.
 *
 * So this file is the transcript tailer's sibling, and deliberately built to
 * the same three rules:
 *
 * 1. **Incremental.** One {@link TranscriptTailer} per rollout, one byte offset,
 *    and a rollout is never read twice. The largest one on the maintainer's
 *    machine is 13 MB.
 * 2. **Poll is the floor, `fs.watch` is the accelerator.** Same reasoning as
 *    `fs-watch.ts`: watch delivery is a platform's business and not a contract,
 *    so the bound holds with no watch at all.
 * 3. **Metadata only.** The parser rebuilds a new object from a closed list of
 *    fields. `content`, `text`, `arguments`, `stdout`, `stderr`,
 *    `aggregated_output`, `formatted_output`, `unified_diff`, `command`,
 *    `parsed_cmd`, `base_instructions.text` and `developer_instructions` are
 *    never read into it. The one exception is the opt-in task text, which goes
 *    through the same `task-text.ts` as Claude's and is off unless a caller
 *    asked (N-WP15a).
 *
 * ## What "live" means here, and what it honestly cannot mean
 *
 * A rollout carries no pid, so a Codex card can never offer jump-to-terminal
 * and never claims a process. Two signals decide whether a thread is on the
 * canvas at all:
 *
 * - **The thread lock.** Codex takes a zero-byte file named after the thread in
 *   `~/.codex/thread-writer-locks` while a writer holds the thread open, and
 *   releases it when the thread closes. On the machine this was audited on, 19 rollouts had exactly
 *   one lock, and it named the newest thread — so lock present means *open*,
 *   which is the closest thing Codex has to liveness. Only the directory
 *   **listing** is read; the file itself is never opened.
 * - **Silence.** A rollout with no lock but a write in the last
 *   {@link DEFAULT_CODEX_SILENCE_MS} is reported with `state: 'unknown'` and
 *   dropped on the pass after that. That covers the case the lock cannot: a
 *   Codex build that does not take one, or one left behind by a crash. "No
 *   news" is never promoted to `alive` — the rule the whole product rests on.
 *
 * `status` is decided from the turn stream and not from either of those:
 * `task_started` opens a turn, `task_complete` and `turn_aborted` close it, so
 * an open turn is `busy` and a closed one is `idle`.
 *
 * **`waiting` is never emitted, and that is a measurement rather than an
 * oversight.** Codex persists `approval_policy` and the permission profile —
 * the *rules* — and no record of an approval actually being asked for. All 19
 * rollouts were swept for a request-shaped key, including the four turns that
 * ran under `approval_policy: on-request`, and there is none. A Codex session
 * sitting on a permission prompt is therefore indistinguishable on disk from
 * one thinking hard, and Nazar says `busy` rather than inventing the banner.
 */
import { EventEmitter } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { DirectoryWatcher, WatchFactory } from './fs-watch.js';
import { watchPath } from './fs-watch.js';
import { codexSessionsDirPath, codexThreadLocksDirPath } from './paths.js';
import { cleanTaskText, stripHarnessText } from './task-text.js';
import { TranscriptTailer } from './transcript-tailer.js';
import { NO_PID } from './types.js';
import type { Session, SessionStatus, SessionTokens } from './types.js';

/** Name shape of a rollout. Nothing else in that tree is opened. */
export const CODEX_ROLLOUT_PREFIX = 'rollout-';
export const CODEX_ROLLOUT_SUFFIX = '.jsonl';

/** Name shape of a thread lock. Listed by name; never opened. */
export const CODEX_LOCK_SUFFIX = '.lock';

/**
 * How long a rollout with no lock keeps its card.
 *
 * Long enough to cover a Codex build that takes no lock and the gap between an
 * append and the next poll; short enough that a thread which ended two minutes
 * ago is off the canvas. A card that reaches this is `unknown`, never `alive`.
 */
export const DEFAULT_CODEX_SILENCE_MS = 90_000;

/**
 * How many day directories back the scanner looks.
 *
 * The store is partitioned by date and grows for as long as Codex is installed
 * — a year of it is 365 directories — while the canvas only ever draws threads
 * that are still open. Seven days is far past any session that could still be
 * running and bounds the listing to a handful of `readdir` calls.
 */
export const DEFAULT_CODEX_DAYS = 7;

/** Longest identifier-shaped string this reader keeps. Same cap as WP2's. */
export const MAX_CODEX_STRING = 200;

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_DEBOUNCE_MS = 100;

/** Bytes drained per pass while catching up with a rollout already on disk. */
const MAX_BYTES_PER_READ = 4 * 1024 * 1024;

/**
 * Item types Codex writes for something it actually ran, as opposed to
 * something it said or thought.
 *
 * `Reasoning`, `AgentMessage` and `UserMessage` are turns rather than tools and
 * are deliberately not here. `SubAgentActivity` is not either: it is a progress
 * note about another thread, and that thread has a rollout of its own.
 */
const TOOL_ITEM_TYPES = new Set([
  'CommandExecution',
  'FileChange',
  'McpToolCall',
  'Extension',
  'CollabAgentToolCall',
  'ImageView',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short identifier-shaped string, or `undefined`. Never a sentence. */
function short(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= MAX_CODEX_STRING ? value : value.slice(0, MAX_CODEX_STRING);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** An ISO stamp as epoch ms, or `undefined`. Codex writes RFC 3339. */
function stamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

/**
 * One rollout line, reduced to the fields this reader uses.
 *
 * Every field is a number, an enum-shaped name or an id. The only free-form
 * string that can appear is {@link CodexEvent.taskText}, and it is filled only
 * when the caller asked for task text.
 */
export interface CodexEvent {
  /** The record kind, normalised across `type` and `payload.type`. */
  readonly kind:
    | 'session_meta'
    | 'turn_context'
    | 'turn_started'
    | 'turn_ended'
    | 'settings'
    | 'tool_call'
    | 'tool_output'
    | 'tool_item'
    | 'tokens'
    | 'user_turn';
  readonly at?: number;
  readonly threadId?: string;
  readonly parentThreadId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly version?: string;
  /** `exec`, `vscode`, or `subagent` when the thread was spawned by another. */
  readonly origin?: string;
  readonly turnId?: string;
  readonly toolName?: string;
  readonly tokens?: SessionTokens;
  /** N-WP15a. Absent unless the caller asked for task text. */
  readonly taskText?: string;
}

/** What the extractor is allowed to read. */
export interface CodexExtractOptions {
  /** N-WP15a: read the human turn's text. Off unless a caller says otherwise. */
  readonly taskText?: boolean;
}

/**
 * Codex's counters, mapped onto Nazar's four.
 *
 * One difference matters and is corrected here rather than left to every
 * consumer: Codex's `input_tokens` **includes** the cached read, where the
 * Anthropic usage block Claude Code writes reports the two separately. So `in`
 * is the fresh input — the subtraction — and the cached read keeps its own
 * field. `cache_write_input_tokens` is passed through untouched: it was `0` on
 * every one of the 16 rollouts with a token record on the maintainer's machine,
 * so whether it is inside `input_tokens` is unobserved, and subtracting an
 * unobserved quantity would be a guess.
 */
function toTokens(usage: unknown): SessionTokens | undefined {
  if (!isRecord(usage)) return undefined;
  const input = count(usage['input_tokens']);
  const cached = count(usage['cached_input_tokens']);
  const write = count(usage['cache_write_input_tokens']);
  const output = count(usage['output_tokens']);
  const out: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number } = {};
  if (input !== undefined) out.in = Math.max(0, input - (cached ?? 0));
  if (output !== undefined) out.out = output;
  if (cached !== undefined) out.cacheRead = cached;
  if (write !== undefined) out.cacheWrite = write;
  return out.in === undefined && out.out === undefined && out.cacheRead === undefined
    ? undefined
    : out;
}

/**
 * The human text of one Codex `message`, or `undefined`.
 *
 * Codex names its blocks `input_text` where Claude Code names them `text`, so
 * `extractTaskText` cannot be reused whole; the *cleaning* is, which is the
 * half that matters. `stripHarnessText` now knows Codex's own injections
 * (`<environment_context>` and the rest), so a turn that is nothing but an
 * injection produces no task rather than a paragraph of harness.
 */
function codexTaskText(payload: Record<string, unknown>): string | undefined {
  const content = payload['content'];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isRecord(block)) continue;
    // `input_image` and anything else is not the human turn and is not read.
    if (block['type'] !== 'input_text') continue;
    const text = block['text'];
    if (typeof text !== 'string') continue;
    const cleaned = cleanTaskText(stripHarnessText(text));
    if (cleaned !== undefined) return cleaned;
  }
  return undefined;
}

/** Where a thread came from: `exec`, `vscode`, or a parent that spawned it. */
function originOf(source: unknown): string | undefined {
  if (typeof source === 'string') return short(source);
  if (isRecord(source) && 'subagent' in source) return 'subagent';
  return undefined;
}

/** The parent thread of a spawned subagent thread, when the record names one. */
function parentOf(payload: Record<string, unknown>): string | undefined {
  const direct = short(payload['parent_thread_id']);
  if (direct !== undefined) return direct;
  const source = payload['source'];
  if (!isRecord(source)) return undefined;
  const subagent = source['subagent'];
  if (!isRecord(subagent)) return undefined;
  const spawn = subagent['thread_spawn'];
  return isRecord(spawn) ? short(spawn['parent_thread_id']) : undefined;
}

/**
 * One rollout line as a {@link CodexEvent}, or `undefined` for a line this
 * reader has no use for — which is most of them.
 *
 * Never throws: a rollout is tailed while it is being written, and half a line
 * is a normal thing to be handed.
 */
export function extractCodexLine(
  raw: string,
  options: CodexExtractOptions = {},
): CodexEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const at = stamp(parsed['timestamp']);
  const payload = isRecord(parsed['payload']) ? parsed['payload'] : undefined;
  const type = parsed['type'];

  if (type === 'session_meta' && payload !== undefined) {
    const provenance = isRecord(payload['base_instructions'])
      ? payload['base_instructions']['provenance']
      : undefined;
    return {
      kind: 'session_meta',
      at: stamp(payload['timestamp']) ?? at,
      ...pick('threadId', short(payload['id'])),
      ...pick('parentThreadId', parentOf(payload)),
      ...pick('cwd', short(payload['cwd'])),
      ...pick('version', short(payload['cli_version'])),
      ...pick('origin', originOf(payload['source'])),
      ...pick('model', isRecord(provenance) ? short(provenance['model']) : undefined),
    };
  }

  if (type === 'turn_context' && payload !== undefined) {
    return {
      kind: 'turn_context',
      ...pick('at', at),
      ...pick('cwd', short(payload['cwd'])),
      ...pick('model', short(payload['model'])),
      ...pick('effort', short(payload['effort'])),
      ...pick('turnId', short(payload['turn_id'])),
    };
  }

  if (type === 'token_usage_record' && payload !== undefined) {
    // The thread total, which is cumulative by contract: no deduplication, and
    // the last record in the file is the answer.
    return { kind: 'tokens', ...pick('at', at), ...pick('tokens', toTokens(payload['thread_token_usage'])) };
  }

  if (type === 'event_msg' && payload !== undefined) {
    const kind = payload['type'];
    if (kind === 'task_started') {
      return { kind: 'turn_started', ...pick('at', at), ...pick('turnId', short(payload['turn_id'])) };
    }
    if (kind === 'task_complete' || kind === 'turn_aborted') {
      return { kind: 'turn_ended', ...pick('at', at), ...pick('turnId', short(payload['turn_id'])) };
    }
    if (kind === 'token_count') {
      const info = isRecord(payload['info']) ? payload['info'] : undefined;
      return {
        kind: 'tokens',
        ...pick('at', at),
        ...pick('tokens', info === undefined ? undefined : toTokens(info['total_token_usage'])),
      };
    }
    if (kind === 'thread_settings_applied') {
      const settings = isRecord(payload['thread_settings']) ? payload['thread_settings'] : undefined;
      if (settings === undefined) return undefined;
      return {
        kind: 'settings',
        ...pick('at', at),
        ...pick('cwd', short(settings['cwd'])),
        ...pick('model', short(settings['model'])),
        ...pick('effort', short(settings['reasoning_effort'])),
      };
    }
    if (kind === 'item_completed') {
      const item = isRecord(payload['item']) ? payload['item'] : undefined;
      const itemType = item === undefined ? undefined : item['type'];
      if (typeof itemType !== 'string' || !TOOL_ITEM_TYPES.has(itemType)) return undefined;
      // An MCP call names its own tool; everything else is named by its kind,
      // which is what Codex itself calls it. Neither is free-form text.
      const named = itemType === 'McpToolCall' ? short(item?.['tool']) : undefined;
      return { kind: 'tool_item', ...pick('at', at), ...pick('toolName', named ?? itemType) };
    }
    return undefined;
  }

  if (type === 'response_item' && payload !== undefined) {
    const kind = payload['type'];
    if (kind === 'custom_tool_call' || kind === 'function_call') {
      return { kind: 'tool_call', ...pick('at', at), ...pick('toolName', short(payload['name'])) };
    }
    if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
      return { kind: 'tool_output', ...pick('at', at) };
    }
    if (kind === 'message' && payload['role'] === 'user') {
      // The only line that can carry prose, and only when asked. With the flag
      // off the text is never touched, which is what makes `--no-task-text` a
      // switch on a code path rather than a filter over its output.
      if (options.taskText !== true) return undefined;
      const text = codexTaskText(payload);
      return text === undefined ? undefined : { kind: 'user_turn', ...pick('at', at), taskText: text };
    }
    return undefined;
  }

  return undefined;
}

/** `{ k: v }` when `v` is set, `{}` when it is not. Keeps fields absent. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/* ------------------------------------------------------------------ *
 * One rollout
 * ------------------------------------------------------------------ */

/** Everything one rollout has said about itself so far. */
export interface CodexRolloutFacts {
  readonly threadId?: string;
  readonly parentThreadId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly version?: string;
  readonly origin?: string;
  readonly startedAt?: number;
  readonly tokens?: SessionTokens;
  readonly toolCalls: number;
  readonly currentTool?: string;
  /** Turns opened by `task_started` and not yet closed. `> 0` is `busy`. */
  readonly openTurns: number;
  /** True once a turn boundary has been seen at all. */
  readonly sawTurn: boolean;
  readonly task?: string;
}

/**
 * One rollout file, tailed by byte offset.
 *
 * The accumulator is a handful of scalars: a rollout is a stream of turns and
 * tool calls, and none of the per-line records has to be kept.
 */
export class CodexRollout {
  readonly file: string;

  /** The thread id the file name encodes, before a line has been read. */
  readonly threadIdFromName: string | undefined;

  private readonly tailer: TranscriptTailer;

  private readonly taskText: boolean;

  private threadId: string | undefined;

  private parentThreadId: string | undefined;

  private cwd: string | undefined;

  private model: string | undefined;

  private effort: string | undefined;

  private version: string | undefined;

  private origin: string | undefined;

  private startedAt: number | undefined;

  private tokens: SessionTokens | undefined;

  private tools = 0;

  private openCalls: string[] = [];

  private turns = 0;

  private sawTurn = false;

  private task: string | undefined;

  private lastWrite: number | undefined;

  private size = 0;

  constructor(file: string, options: { readonly taskText?: boolean } = {}) {
    this.file = file;
    this.taskText = options.taskText ?? false;
    this.threadIdFromName = threadIdFromRolloutName(path.basename(file));
    this.tailer = new TranscriptTailer(file, { maxBytesPerRead: MAX_BYTES_PER_READ });
  }

  /** `mtimeMs` of the rollout as of the last read. */
  get lastWriteAt(): number | undefined {
    return this.lastWrite;
  }

  /** Size of the rollout as of the last read. */
  get bytes(): number {
    return this.size;
  }

  /** Bytes pulled off disk since this reader was constructed. */
  get bytesRead(): number {
    return this.tailer.bytesRead;
  }

  facts(): CodexRolloutFacts {
    const out: {
      -readonly [K in keyof CodexRolloutFacts]: CodexRolloutFacts[K];
    } = {
      toolCalls: this.tools,
      openTurns: this.turns,
      sawTurn: this.sawTurn,
    };
    const id = this.threadId ?? this.threadIdFromName;
    if (id !== undefined) out.threadId = id;
    if (this.parentThreadId !== undefined) out.parentThreadId = this.parentThreadId;
    if (this.cwd !== undefined) out.cwd = this.cwd;
    if (this.model !== undefined) out.model = this.model;
    if (this.effort !== undefined) out.effort = this.effort;
    if (this.version !== undefined) out.version = this.version;
    if (this.origin !== undefined) out.origin = this.origin;
    if (this.startedAt !== undefined) out.startedAt = this.startedAt;
    if (this.tokens !== undefined) out.tokens = this.tokens;
    const current = this.openCalls[this.openCalls.length - 1];
    if (current !== undefined) out.currentTool = current;
    if (this.task !== undefined) out.task = this.task;
    return out;
  }

  /** Read everything appended since the last pass. Never throws. */
  async read(): Promise<{ readonly changed: boolean; readonly missing: boolean }> {
    let changed = false;
    // A rollout already on disk can be 13 MB, so drain it in slices rather than
    // holding the whole file in one buffer.
    for (;;) {
      const result = await this.tailer.read();
      if (result.missing) return { changed, missing: true };
      if (result.restarted) {
        this.reset();
        changed = true;
      }
      this.size = result.size;
      if (result.mtimeMs !== undefined && result.mtimeMs !== this.lastWrite) {
        this.lastWrite = result.mtimeMs;
        changed = true;
      }
      if (result.lines.length > 0) changed = true;
      for (const line of result.lines) this.apply(line);
      if (result.bytesRead === 0) break;
    }
    return { changed, missing: false };
  }

  private reset(): void {
    this.threadId = undefined;
    this.parentThreadId = undefined;
    this.cwd = undefined;
    this.model = undefined;
    this.effort = undefined;
    this.version = undefined;
    this.origin = undefined;
    this.startedAt = undefined;
    this.tokens = undefined;
    this.tools = 0;
    this.openCalls = [];
    this.turns = 0;
    this.sawTurn = false;
    this.task = undefined;
  }

  private apply(line: string): void {
    const event = extractCodexLine(line, { taskText: this.taskText });
    if (event === undefined) return;

    if (event.threadId !== undefined) this.threadId = event.threadId;
    if (event.parentThreadId !== undefined) this.parentThreadId = event.parentThreadId;
    if (event.cwd !== undefined) this.cwd = event.cwd;
    if (event.model !== undefined) this.model = event.model;
    if (event.effort !== undefined) this.effort = event.effort;
    if (event.version !== undefined) this.version = event.version;
    if (event.origin !== undefined) this.origin = event.origin;
    if (event.tokens !== undefined) this.tokens = event.tokens;

    switch (event.kind) {
      case 'session_meta':
        // A forked thread carries a second `session_meta`; the first one's
        // timestamp is when this file started being written.
        if (this.startedAt === undefined && event.at !== undefined) this.startedAt = event.at;
        break;
      case 'turn_started':
        this.sawTurn = true;
        this.turns += 1;
        break;
      case 'turn_ended':
        this.sawTurn = true;
        this.turns = Math.max(0, this.turns - 1);
        // A turn that ended is not running a tool, whatever the call stream
        // said: an aborted turn never writes the outputs it owed.
        this.openCalls = [];
        break;
      case 'tool_call':
        this.tools += 1;
        this.openCalls.push(event.toolName ?? 'tool');
        break;
      case 'tool_output':
        this.openCalls.pop();
        break;
      case 'tool_item':
        // Named by what actually ran. The call it belongs to was already
        // counted, so this only sharpens the name.
        if (event.toolName !== undefined && this.openCalls.length > 0) {
          this.openCalls[this.openCalls.length - 1] = event.toolName;
        }
        break;
      case 'user_turn':
        // The **last** human turn, for the same reason the Claude reader takes
        // it: a thread open for an hour is not still doing what it was opened
        // for.
        if (event.taskText !== undefined) this.task = event.taskText;
        break;
      default:
        break;
    }
  }
}

/** The thread id a `rollout-<stamp>-<id>.jsonl` name encodes, or `undefined`. */
export function threadIdFromRolloutName(name: string): string | undefined {
  if (!name.startsWith(CODEX_ROLLOUT_PREFIX) || !name.endsWith(CODEX_ROLLOUT_SUFFIX)) {
    return undefined;
  }
  const stem = name.slice(CODEX_ROLLOUT_PREFIX.length, name.length - CODEX_ROLLOUT_SUFFIX.length);
  // `rollout-<stamp>-<uuid>` normally, and `..-<parent uuid>_<uuid>` for a
  // thread forked out of another one, where the id is the half after the
  // underscore.
  const forked = stem.lastIndexOf('_');
  const tail = forked >= 0 ? stem.slice(forked + 1) : stem;
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(tail);
  return match?.[0];
}

/** The thread id a `<id>.lock` name encodes, or `undefined`. */
export function threadIdFromLockName(name: string): string | undefined {
  if (!name.endsWith(CODEX_LOCK_SUFFIX) || name.startsWith('.')) return undefined;
  const id = name.slice(0, name.length - CODEX_LOCK_SUFFIX.length);
  return id.length > 0 ? id : undefined;
}

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

export interface CodexSessionsOptions {
  /** Rollout store. Defaults to `~/.codex/sessions`; tests inject a temp dir. */
  readonly sessionsDir?: string;
  /** Lock directory. Defaults to `~/.codex/thread-writer-locks`. */
  readonly locksDir?: string;
  /** How often the store is rescanned. Default 2 s, same floor as WP1's. */
  readonly pollIntervalMs?: number;
  /** Debounce applied to `fs.watch` events. Default 100 ms. */
  readonly debounceMs?: number;
  /** Set false to skip `fs.watch` and rely on the poll alone. */
  readonly watch?: boolean;
  /** Builds the watch handle. Tests inject a double. */
  readonly watchFactory?: WatchFactory;
  /** Day directories to look back over. Default {@link DEFAULT_CODEX_DAYS}. */
  readonly days?: number;
  /** How long a lockless rollout keeps its card. Default 90 s. */
  readonly silenceMs?: number;
  /** N-WP15a: read the human turn's text. Off unless a caller says otherwise. */
  readonly taskText?: boolean;
  /** Clock, injected by tests. */
  readonly now?: () => number;
}

/**
 * A Codex thread on its way to the canvas.
 *
 * `Session` plus the two measured fields `SessionView` adds for Claude Code —
 * they come out of the *same* file here rather than out of a second watcher, so
 * there is nothing for `state.ts` to join and no reason to make it invent them.
 * Declared here rather than imported, because `state.ts` is what pulls the two
 * providers together and importing it back would be a cycle.
 */
export interface CodexSession extends Session {
  /** Tool calls the rollout has recorded so far. */
  readonly toolCalls?: number;
  /** Age of the rollout's last write at snapshot time. */
  readonly writeAgeMs?: number;
}

export interface CodexSessionsEvents {
  change: [readonly CodexSession[]];
}

/** What one pass over the store found. Reported by `nazar doctor`. */
export interface CodexScan {
  /** False when `~/.codex/sessions` does not exist: Codex is not installed. */
  readonly configured: boolean;
  /** Rollout files the last pass listed, live or not. */
  readonly rollouts: number;
  /** Thread locks the last pass listed. */
  readonly locks: number;
  /** Whether the lock directory exists at all. */
  readonly locksConfigured: boolean;
  /** Sessions currently on the canvas. */
  readonly sessions: number;
  /** Rollout files that could not be read on the last pass. */
  readonly warnings: number;
}

/** Everything except `lastSeenAt`, which moves on every pass by design. */
function fingerprint(session: CodexSession): string {
  return JSON.stringify([
    session.id,
    session.cwd ?? null,
    session.status,
    session.model ?? null,
    session.effort ?? null,
    session.currentTool ?? null,
    session.toolCalls ?? null,
    session.startedAt ?? null,
    session.lastWriteAt ?? null,
    session.task ?? null,
    session.state,
    session.tokens ?? null,
  ]);
}

/**
 * Codex threads on this machine, as far as the rollout store can describe them.
 *
 * The shape is `SessionRegistry`'s on purpose — `start`, `stop`, `refresh`,
 * `snapshot`, one `change` event — so `state.ts` joins the two the same way and
 * neither has to know about the other.
 */
export class CodexSessions extends EventEmitter<CodexSessionsEvents> {
  readonly sessionsDir: string;

  readonly locksDir: string;

  readonly pollIntervalMs: number;

  readonly debounceMs: number;

  readonly silenceMs: number;

  readonly days: number;

  private readonly useWatch: boolean;

  private readonly watchFactory: WatchFactory;

  private readonly taskText: boolean;

  private readonly now: () => number;

  private readonly rollouts = new Map<string, CodexRollout>();

  private sessions = new Map<string, CodexSession>();

  /** Thread ids seen with no lock, against the pass they were first missed. */
  private readonly quietSince = new Map<string, number>();

  private storeMissing = true;

  private locksMissing = true;

  private rolloutCount = 0;

  private lockCount = 0;

  private warningCount = 0;

  private started = false;

  private watcher: DirectoryWatcher | undefined;

  private debounceTimer: NodeJS.Timeout | undefined;

  private pollTimer: NodeJS.Timeout | undefined;

  private queue: Promise<void> = Promise.resolve();

  constructor(options: CodexSessionsOptions = {}) {
    super();
    this.sessionsDir = options.sessionsDir ?? codexSessionsDirPath();
    this.locksDir = options.locksDir ?? codexThreadLocksDirPath();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.silenceMs = options.silenceMs ?? DEFAULT_CODEX_SILENCE_MS;
    this.days = Math.max(1, options.days ?? DEFAULT_CODEX_DAYS);
    this.useWatch = options.watch ?? true;
    this.watchFactory = options.watchFactory ?? watchPath;
    this.taskText = options.taskText ?? false;
    this.now = options.now ?? Date.now;
  }

  /** Sessions as of the last pass, oldest first. */
  snapshot(): readonly CodexSession[] {
    return [...this.sessions.values()].sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id),
    );
  }

  /** What the last pass found. `nazar doctor` prints this. */
  scan(): CodexScan {
    return {
      configured: !this.storeMissing,
      rollouts: this.rolloutCount,
      locks: this.lockCount,
      locksConfigured: !this.locksMissing,
      sessions: this.sessions.size,
      warnings: this.warningCount,
    };
  }

  /** Read the store once and start watching. Resolves with `snapshot()` filled. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    if (!this.started) return;
    this.beginWatching();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** One pass over the store. Serialised: passes never overlap. */
  refresh(): Promise<void> {
    const task = (): Promise<void> => this.reconcile();
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private beginWatching(): void {
    // The poll starts first and unconditionally; the watch is an accelerator.
    if (this.pollTimer === undefined) {
      this.pollTimer = setInterval(() => {
        void this.refresh();
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    }
    if (!this.useWatch) return;
    // The **lock** directory is what is watched, not the date-partitioned store:
    // a lock appears when a thread opens and vanishes when it closes, which is
    // exactly the transition worth reacting to, and it is one directory rather
    // than a tree that grows a level a day.
    try {
      const watcher = this.watchFactory(this.locksDir, () => {
        this.scheduleRefresh();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      // Absent on a machine with no Codex, and unwatchable on some filesystems.
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private async reconcile(): Promise<void> {
    const [files, locks] = await Promise.all([this.listRollouts(), this.listLocks()]);
    const now = this.now();

    const wanted = new Set(files);
    for (const file of [...this.rollouts.keys()]) {
      if (!wanted.has(file)) this.rollouts.delete(file);
    }

    await Promise.all(
      files.map(async (file) => {
        let rollout = this.rollouts.get(file);
        if (rollout === undefined) {
          rollout = new CodexRollout(file, { taskText: this.taskText });
          this.rollouts.set(file, rollout);
        }
        try {
          const result = await rollout.read();
          if (result.missing) this.rollouts.delete(file);
        } catch {
          this.warningCount += 1;
          this.rollouts.delete(file);
        }
      }),
    );

    const next = new Map<string, CodexSession>();
    for (const rollout of this.rollouts.values()) {
      const facts = rollout.facts();
      const threadId = facts.threadId;
      if (threadId === undefined) continue;

      const locked = locks.has(threadId);
      const writeAge = rollout.lastWriteAt === undefined ? undefined : now - rollout.lastWriteAt;

      /*
       * Three cases, and the third is the one that took a live run to get
       * right. The store holds every thread of the last seven days — 18 of
       * them on the maintainer's machine, exactly one of them open — so the
       * default answer for a rollout has to be **no card**.
       *
       * 1. **Locked.** A writer holds the thread open: `alive`.
       * 2. **No lock, but bytes arrived inside the silence window.** Something
       *    is appending even though no lock was listed, which is what an older
       *    Codex build looks like. The card is drawn as `unknown` and never
       *    promoted to `alive`.
       * 3. **No lock and no recent bytes.** A finished thread. It keeps a card
       *    only if it already *had* one — one window of "we no longer know" for
       *    a thread that was open a moment ago, exactly what the Claude
       *    registry gives a session whose process stopped answering — and a
       *    thread that was already cold the first time it was seen never gets
       *    one at all.
       */
      const recent = writeAge !== undefined && writeAge <= this.silenceMs;
      if (locked || recent) {
        this.quietSince.delete(threadId);
      } else {
        if (!this.sessions.has(threadId)) continue;
        const since = this.quietSince.get(threadId) ?? now;
        this.quietSince.set(threadId, since);
        if (now - since > this.silenceMs) continue;
      }

      next.set(threadId, this.toSession(threadId, facts, rollout, locked, now, writeAge));
    }

    for (const id of [...this.quietSince.keys()]) {
      if (!next.has(id)) this.quietSince.delete(id);
    }

    this.publish(next);
  }

  private toSession(
    threadId: string,
    facts: CodexRolloutFacts,
    rollout: CodexRollout,
    locked: boolean,
    now: number,
    writeAgeMs: number | undefined,
  ): CodexSession {
    const previous = this.sessions.get(threadId);
    /*
     * `busy` while a turn is open, `idle` once it closed, `unknown` before any
     * turn boundary has been written. `waiting` is never produced: see the
     * module note — Codex writes the approval *policy* and never the request.
     */
    const status: SessionStatus = !facts.sawTurn ? 'unknown' : facts.openTurns > 0 ? 'busy' : 'idle';
    const out: { -readonly [K in keyof CodexSession]: CodexSession[K] } = {
      id: threadId,
      provider: 'codex',
      pid: NO_PID,
      status,
      agents: [],
      // The lock is the only evidence a writer still holds this thread. Recent
      // bytes are not promoted to `alive`: they are why the card is still here.
      state: locked ? 'alive' : 'unknown',
      source: 'files',
      lastSeenAt: now,
    };
    if (facts.cwd !== undefined) out.cwd = facts.cwd;
    if (facts.model !== undefined) out.model = facts.model;
    if (facts.effort !== undefined) out.effort = facts.effort;
    if (facts.version !== undefined) out.version = facts.version;
    if (facts.origin !== undefined) out.kind = facts.origin;
    if (facts.startedAt !== undefined) out.startedAt = facts.startedAt;
    if (facts.currentTool !== undefined) out.currentTool = facts.currentTool;
    if (facts.toolCalls > 0) out.toolCalls = facts.toolCalls;
    if (facts.tokens !== undefined) out.tokens = facts.tokens;
    if (facts.task !== undefined) out.task = facts.task;
    if (rollout.lastWriteAt !== undefined) out.lastWriteAt = rollout.lastWriteAt;
    if (writeAgeMs !== undefined) out.writeAgeMs = Math.max(0, writeAgeMs);
    if (previous !== undefined && facts.startedAt === undefined) {
      out.startedAt = previous.startedAt;
    }
    return out;
  }

  private publish(next: Map<string, CodexSession>): void {
    let moved = next.size !== this.sessions.size;
    if (!moved) {
      for (const [id, session] of next) {
        const previous = this.sessions.get(id);
        if (previous === undefined || fingerprint(previous) !== fingerprint(session)) {
          moved = true;
          break;
        }
      }
    }
    this.sessions = next;
    if (moved) this.emit('change', this.snapshot());
  }

  /**
   * The newest {@link days} day directories' worth of rollout files.
   *
   * Walked by directory *name* rather than by `stat`: the tree is
   * `<year>/<month>/<day>` and the names sort lexically, so the newest days are
   * found without touching a file.
   */
  private async listRollouts(): Promise<string[]> {
    const days = await this.listDayDirs();
    const files: string[] = [];
    for (const day of days) {
      let names: string[];
      try {
        names = await readdir(day);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(CODEX_ROLLOUT_PREFIX) || !name.endsWith(CODEX_ROLLOUT_SUFFIX)) continue;
        files.push(path.join(day, name));
      }
    }
    this.rolloutCount = files.length;
    return files;
  }

  private async listDayDirs(): Promise<string[]> {
    // The root is read directly rather than through `subdirs`, because this is
    // the one level where "it could not be read" is an answer worth keeping:
    // it is what `nazar doctor` prints as *Codex is not installed here*.
    let years: string[];
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      years = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      this.storeMissing = true;
      this.rolloutCount = 0;
      return [];
    }
    this.storeMissing = false;

    const days: string[] = [];
    for (const year of years.sort().reverse()) {
      const yearDir = path.join(this.sessionsDir, year);
      for (const month of (await this.subdirs(yearDir)).sort().reverse()) {
        const monthDir = path.join(yearDir, month);
        for (const day of (await this.subdirs(monthDir)).sort().reverse()) {
          days.push(path.join(monthDir, day));
          if (days.length >= this.days) return days;
        }
      }
    }
    return days;
  }

  /**
   * Subdirectories of one directory, or none.
   *
   * It swallows its own errors on purpose. The date tree belongs to another
   * program: a stray file where a year directory is expected, a directory
   * removed between two `readdir`s, a permission the user has since changed —
   * none of that is Nazar's to be broken by, and letting it throw would reject
   * the whole pass and, through `NazarState.start()`, the whole canvas. The
   * caller that *does* need to tell "no store" from "an unreadable one" is
   * `listDayDirs`, and it asks for the root separately.
   */
  private async subdirs(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  /**
   * Thread ids with a lock held right now.
   *
   * The **listing** and nothing else. The lock file is zero bytes and is held
   * open by its writer; opening it would be both pointless and, on Windows,
   * a failure. `.coordination.lock` is Codex's own global lock and is skipped
   * by the leading dot.
   */
  private async listLocks(): Promise<Set<string>> {
    const ids = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.locksDir);
    } catch {
      this.locksMissing = true;
      this.lockCount = 0;
      return ids;
    }
    this.locksMissing = false;
    for (const name of names) {
      const id = threadIdFromLockName(name);
      if (id !== undefined) ids.add(id);
    }
    this.lockCount = ids.size;
    return ids;
  }
}

/**
 * One pass over the store with nothing started, for `nazar doctor`.
 *
 * Reads the listings and the head of every rollout it finds, exactly as the
 * watcher's first pass would, and then throws the readers away.
 */
export async function readCodexStore(
  options: CodexSessionsOptions = {},
): Promise<{ readonly scan: CodexScan; readonly sessions: readonly CodexSession[] }> {
  const codex = new CodexSessions({ ...options, watch: false });
  await codex.refresh();
  const result = { scan: codex.scan(), sessions: codex.snapshot() };
  codex.stop();
  return result;
}

/** Whether `~/.codex/sessions` exists at all. Cheap; opens nothing. */
export async function codexInstalled(sessionsDir: string): Promise<boolean> {
  try {
    return (await stat(sessionsDir)).isDirectory();
  } catch {
    return false;
  }
}
