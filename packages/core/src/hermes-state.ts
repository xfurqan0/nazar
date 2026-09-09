/**
 * N-WP17a: Hermes sessions, read-only.
 *
 * Hermes is a second agent runtime — its own tool-calling loop, several model
 * providers behind it — and it keeps no per-session transcript on disk. Every
 * session it has ever run is in one SQLite file, `state.db`, one per profile.
 * That file is written continuously by a gateway process that knows nothing
 * about Nazar, which makes it exactly the kind of source this program was built
 * for: **somebody else's file, opened read-only, never written, never copied.**
 *
 * ## Why there is no plugin
 *
 * The first plan for this was a Hermes plugin that would write a small JSON
 * file Nazar could read. A survey of a live installation killed it: the card
 * contract is already on disk. Identity, model, working directory, git branch,
 * message and tool counts, five token counters, the start, the end and the last
 * activity of every session, and the subagent relation itself — all of it is in
 * `sessions`, and "is this session's turn running right now" is in
 * `session_turn_leases`. Installing anything on a machine to learn what the
 * machine already wrote down is the wrong trade, and it would have made Nazar a
 * thing that mutates a server.
 *
 * One field is genuinely not there, and it is the loudest one: **waiting**.
 * Hermes holds a pending permission or clarification in the gateway's memory
 * and writes it nowhere, so a Hermes card can never say "this one is waiting
 * for you". It says so, in those words, rather than showing a state it cannot
 * know (docs/PROJECT.md section 5, and rule 3 of the pinned formats: a field no
 * source can fill is absent, never `0` and never invented).
 *
 * ## What "read-only" is made of here
 *
 * Four separate things, because one of them alone would be a promise:
 *
 * 1. The connection is opened as `file:<path>?mode=ro` **and** with
 *    `readOnly: true`. The URI is what SQLite itself enforces; the option is
 *    what `node:sqlite` enforces before SQLite is reached.
 * 2. Every statement names its columns. There is no `SELECT *` in this file,
 *    and `test/hermes-columns.test.ts` is a static gate that fails the build if
 *    one appears — because the same file holds prompt text and system prompts,
 *    and a `SELECT *` is how a metadata-only reader stops being one.
 * 3. The tables this file may name at all are {@link HERMES_TABLES_READ}. The
 *    same gate extracts every `FROM` and `JOIN` in the source and fails on
 *    anything else, so the message and system-prompt tables cannot be reached
 *    even by accident.
 * 4. Nothing here opens a file handle, allocates a temporary directory or
 *    writes a journal: a read-only connection to a WAL database reads the WAL
 *    without checkpointing it, and `busy_timeout` is kept small so a reader
 *    never sits on a database a writer wants.
 *
 * ## What is deliberately not derived
 *
 * The five token counters are copied one-for-one by name and nothing is summed.
 * Whether Hermes's `input_tokens` already contains `cache_read_tokens` or
 * excludes it is **not determinable from the schema**, and this reader will not
 * guess: it maps the four names Nazar has a field for, drops `reasoning_tokens`
 * rather than folding it into "out", and computes no total that would depend on
 * the answer. docs/pinned-internal-formats.md records that as `unknown`.
 */
import { EventEmitter } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionView } from './state.js';
import type { Agent, AgentNode, SessionTokens } from './types.js';

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** Root of a Hermes installation. `HERMES_HOME` overrides it. */
export const HERMES_HOME_DIR = '~/.hermes';

/** The default profile's session store. One SQLite file, written live. */
export const HERMES_STATE_DB = '~/.hermes/state.db';

/** Where every profile beyond the default one lives. */
export const HERMES_PROFILES_DIR = '~/.hermes/profiles';

/** One named profile's session store. Each is a source of its own. */
export const HERMES_PROFILE_STATE_DB = '~/.hermes/profiles/<profile>/state.db';

/**
 * Root of the Hermes installation on this machine. `HERMES_HOME` is Hermes's
 * own variable and is honoured for the same reason `CLAUDE_CONFIG_DIR` is: a
 * reader that only knows the default path is a reader that silently finds
 * nothing on a machine that moved it.
 */
export function hermesHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = env['HERMES_HOME'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return path.join(home, '.hermes');
}

/* ------------------------------------------------------------------ *
 * The column allow-list
 * ------------------------------------------------------------------ */

/** The only three tables this file may name. The gate checks the source. */
export const HERMES_TABLES_READ = ['sessions', 'session_turn_leases', 'async_delegations'] as const;

/**
 * Every column read out of `sessions`, and the whole of what a Hermes card is
 * made of.
 *
 * `title` is on this list and is treated as **prose**: Hermes writes a summary
 * of the conversation there, and a summary of a conversation is the
 * conversation. It reaches the wire only under the N-WP15a task-text gate, the
 * same one the Claude reader's human turn goes through.
 */
export const HERMES_SESSION_COLUMNS = [
  'id',
  'title',
  'model',
  'source',
  'parent_session_id',
  'cwd',
  'git_branch',
  'message_count',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'started_at',
  'ended_at',
  'last_activity_at',
] as const;

/**
 * The lease table's two columns: which session, and when the lease dies.
 *
 * The session key was observed as `conversation_id` on Hermes 0.20.5 and the
 * name is not a contract, so {@link HERMES_LEASE_KEYS} lists both spellings and
 * the reader picks whichever the table actually declares. That is a *narrowing*
 * of the allow-list, not a widening: one of two known names, chosen from the
 * schema rather than assumed, and the column is still named in the statement.
 */
export const HERMES_LEASE_KEYS = ['conversation_id', 'session_id'] as const;

/** The other lease column. A lease with no expiry is not evidence of anything. */
export const HERMES_LEASE_EXPIRY = 'expires_at';

/**
 * Delegations contribute **edges and nothing else**.
 *
 * `event_json`, `result_json` and `task_json` are on the same row and every one
 * of them is model or user text, so the read stops at the three identifiers the
 * tree needs. Whether a delegation finished is answered where it is answered
 * for every other node — a live lease, or an `ended_at` — and not from a status
 * column this reader would then have to trust.
 */
export const HERMES_DELEGATION_COLUMNS = [
  'delegation_id',
  'origin_session',
  'parent_session_id',
] as const;

/* ------------------------------------------------------------------ *
 * Loading node:sqlite
 * ------------------------------------------------------------------ */

/** What `node:sqlite` gives us, reduced to the two calls this file makes. */
interface SqliteStatement {
  all(...params: readonly unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteOpen = (file: string) => SqliteDatabase;

/** Resolved once: the module is either there for this process or it is not. */
let sqlitePromise: Promise<SqliteOpen | undefined> | undefined;

/**
 * Load `node:sqlite`, or answer `undefined` on a runtime that has no such
 * module — Node before 22.5, or a build with it compiled out.
 *
 * The `ExperimentalWarning` the module prints is suppressed **around this
 * import and nothing else**: `process.emitWarning` is swapped for the length of
 * one dynamic import and put back in a `finally`. Nazar does not run with
 * `--no-warnings`, because silencing every warning a process will ever emit to
 * hide one line is how a real one goes unnoticed.
 */
export async function loadSqlite(): Promise<SqliteOpen | undefined> {
  sqlitePromise ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
      const name = typeof warning === 'string' ? String(rest[0] ?? '') : warning.name;
      if (name === 'ExperimentalWarning') return;
      (emit as (...args: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      const mod = (await import('node:sqlite')) as {
        DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
      };
      return (file: string) => new mod.DatabaseSync(file, { readOnly: true });
    } catch {
      return undefined;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return sqlitePromise;
}

/** Test seam: forget the cached module so a second scenario can be run. */
export function resetSqliteCache(): void {
  sqlitePromise = undefined;
}

/**
 * A SQLite `file:` URI in read-only mode.
 *
 * Backslashes become forward slashes, and the three characters that would end
 * the path early in a URI are escaped. Everything else is left alone: SQLite
 * accepts a raw path after `file:` and over-encoding it breaks a directory with
 * a Turkish or a Chinese name for no gain.
 */
export function readOnlyUri(file: string): string {
  const slashed = file.split(path.sep).join('/');
  const escaped = slashed.replace(/[%?#]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return `file:${escaped}?mode=ro`;
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** One `state.db` and the profile it belongs to. */
export interface HermesSourceRef {
  /** `default` for `<home>/state.db`, otherwise the profile directory's name. */
  readonly profile: string;
  readonly file: string;
}

const STATE_DB_FILE = 'state.db';
const PROFILES_DIR = 'profiles';

/** Profile directories are read; a name that could escape one is not. */
function isPlainName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..';
}

/**
 * Every `state.db` under a Hermes home: the default profile's, plus one per
 * directory under `profiles/`. A missing home is an empty list, not an error —
 * a machine without Hermes is the normal case.
 */
export async function discoverHermesSources(homeDir: string): Promise<HermesSourceRef[]> {
  const found: HermesSourceRef[] = [];

  const isFile = async (target: string): Promise<boolean> => {
    try {
      return (await stat(target)).isFile();
    } catch {
      return false;
    }
  };

  const root = path.join(homeDir, STATE_DB_FILE);
  if (await isFile(root)) found.push({ profile: 'default', file: root });

  let entries: string[] = [];
  try {
    entries = (await readdir(path.join(homeDir, PROFILES_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isPlainName(entry.name))
      .map((entry) => entry.name);
  } catch {
    return found;
  }

  for (const profile of entries.sort()) {
    const file = path.join(homeDir, PROFILES_DIR, profile, STATE_DB_FILE);
    if (await isFile(file)) found.push({ profile, file });
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Reading one database
 * ------------------------------------------------------------------ */

/** How long a read-only connection waits for a writer. Deliberately short. */
export const DEFAULT_BUSY_TIMEOUT_MS = 250;

/** How often the reader re-reads every source. The registry's own interval. */
export const DEFAULT_HERMES_POLL_MS = 2000;

/**
 * How long a session that has ended stays on the canvas.
 *
 * A Hermes database holds every session it has ever run — sixty-odd on the
 * installation this was written against — and drawing all of them would make
 * the canvas a history list. So the live picture is "not ended, plus what ended
 * recently", and ten minutes is the window the Needs-you strip already uses for
 * *what finished while you were away*. The two agreeing is the point: a session
 * that ended is worth seeing exactly as long as somebody might still be coming
 * back to look at it.
 */
export const DEFAULT_ENDED_WINDOW_MS = 10 * 60 * 1000;

/** A raw `sessions` row, as far as this reader is prepared to describe one. */
interface RawSession {
  readonly id: string;
  readonly title?: string;
  readonly model?: string;
  readonly source?: string;
  readonly parentId?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly messageCount?: number;
  readonly toolCalls?: number;
  readonly tokens?: SessionTokens;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly lastActivityAt?: number;
}

/** What one source produced on one pass. */
export interface HermesSourceScan {
  readonly profile: string;
  readonly file: string;
  /**
   * `ok` when the read completed. `unknown` when it did not — a locked
   * database, a schema this reader does not recognise, a file that vanished.
   * Never an exception, and never a source silently reporting zero sessions.
   */
  readonly state: 'ok' | 'unknown';
  /** Why it is `unknown`. One short line; never the SQL, never a row. */
  readonly error?: string;
  readonly sessions: number;
  /** Sessions holding an unexpired turn lease at read time. */
  readonly running: number;
}

/** Everything one pass over every profile produced. */
export interface HermesScan {
  readonly generatedAt: number;
  /**
   * Whether the reader can run at all on this runtime. `false` with a reason
   * when `node:sqlite` is missing — which is a fact about Node, not about
   * Hermes, and `nazar doctor` prints it as one.
   */
  readonly available: boolean;
  readonly reason?: string;
  readonly sources: readonly HermesSourceScan[];
  readonly sessions: readonly SessionView[];
}

/** A number of milliseconds since the epoch, from whatever the column held. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'bigint') return toEpochMs(Number(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    // Hermes's own columns were observed as seconds; a value large enough to be
    // milliseconds is taken as milliseconds. The boundary is the year 5138 in
    // seconds and 1973 in milliseconds, so no real timestamp is ambiguous.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    /*
     * SQLite is dynamically typed and column affinity is a *hint*: an integer
     * written into a column declared `TEXT` comes back as the string `"17880…"`
     * and `Date.parse` would read that as a year. So a run of digits is a
     * number here, and only something that is not one is offered to the date
     * parser.
     */
    if (/^\d+(?:\.\d+)?$/.test(value)) return toEpochMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A non-negative whole number, from the same three shapes a column can hold. */
function asCount(value: unknown): number | undefined {
  if (typeof value === 'bigint') return asCount(Number(value));
  if (typeof value === 'string') {
    return /^\d+(?:\.\d+)?$/.test(value) ? asCount(Number(value)) : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/**
 * The four token counters Nazar has a field for, copied by name.
 *
 * `reasoning_tokens` is read (it is on the pinned column list, so the statement
 * is honest about what it touches) and deliberately **not** mapped: Nazar's
 * `out` is output tokens, and adding a fifth counter into it would invent a
 * number no source reported. See the module note.
 */
function tokensOf(row: Record<string, unknown>): SessionTokens | undefined {
  const out: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number } = {};
  const input = asCount(row['input_tokens']);
  const output = asCount(row['output_tokens']);
  const cacheRead = asCount(row['cache_read_tokens']);
  const cacheWrite = asCount(row['cache_write_tokens']);
  if (input !== undefined) out.in = input;
  if (output !== undefined) out.out = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return Object.keys(out).length === 0 ? undefined : out;
}

function rowToSession(row: Record<string, unknown>): RawSession | undefined {
  const id = asString(row['id']);
  if (id === undefined) return undefined;
  const draft: { -readonly [K in keyof RawSession]: RawSession[K] } = { id };
  const title = asString(row['title']);
  if (title !== undefined) draft.title = title;
  const model = asString(row['model']);
  if (model !== undefined) draft.model = model;
  const source = asString(row['source']);
  if (source !== undefined) draft.source = source;
  const parentId = asString(row['parent_session_id']);
  if (parentId !== undefined) draft.parentId = parentId;
  const cwd = asString(row['cwd']);
  if (cwd !== undefined) draft.cwd = cwd;
  const branch = asString(row['git_branch']);
  if (branch !== undefined) draft.gitBranch = branch;
  const messages = asCount(row['message_count']);
  if (messages !== undefined) draft.messageCount = messages;
  const tools = asCount(row['tool_call_count']);
  if (tools !== undefined) draft.toolCalls = tools;
  const tokens = tokensOf(row);
  if (tokens !== undefined) draft.tokens = tokens;
  const startedAt = toEpochMs(row['started_at']);
  if (startedAt !== undefined) draft.startedAt = startedAt;
  const endedAt = toEpochMs(row['ended_at']);
  if (endedAt !== undefined) draft.endedAt = endedAt;
  const lastActivityAt = toEpochMs(row['last_activity_at']);
  if (lastActivityAt !== undefined) draft.lastActivityAt = lastActivityAt;
  return draft;
}

/** The columns a table actually declares, for the lease-key question alone. */
function columnsOf(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  const names = new Set<string>();
  for (const row of rows) {
    const name = asString(row['name']);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** What one database yielded, before it is turned into cards. */
export interface HermesRead {
  readonly rows: readonly RawSession[];
  /** Session ids holding a lease that has not expired. */
  readonly leased: ReadonlySet<string>;
  /** Child id to parent id, from `async_delegations`. Edges only. */
  readonly delegated: ReadonlyMap<string, string>;
}

/**
 * Open one `state.db`, run the three statements, close it.
 *
 * Synchronous by nature — `DatabaseSync` is the only SQLite binding Node has —
 * and small enough that it is not worth a worker: three statements over a few
 * hundred rows on a 40 MB database, every two seconds.
 */
function readDatabase(
  open: SqliteOpen,
  file: string,
  now: number,
  busyTimeoutMs: number,
): HermesRead {
  const db = open(readOnlyUri(file));
  try {
    // A read-only connection that waits a quarter of a second and then gives up
    // is a reader a writer never notices. The next poll is two seconds away.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))}`);

    const rows: RawSession[] = [];
    const sessionSql = `SELECT ${HERMES_SESSION_COLUMNS.join(', ')} FROM sessions`;
    for (const raw of db.prepare(sessionSql).all() as Array<Record<string, unknown>>) {
      const parsed = rowToSession(raw);
      if (parsed !== undefined) rows.push(parsed);
    }

    /*
     * Leases. `expires_at > now` is not a nicety: the table is never swept, and
     * the installation this was written against held three leases that had
     * expired three weeks earlier. Without the comparison every one of those
     * sessions would be drawn as working.
     */
    const leased = new Set<string>();
    const leaseColumns = columnsOf(db, 'session_turn_leases');
    const leaseKey = HERMES_LEASE_KEYS.find((name) => leaseColumns.has(name));
    if (leaseKey !== undefined && leaseColumns.has(HERMES_LEASE_EXPIRY)) {
      const leaseSql = `SELECT ${leaseKey}, ${HERMES_LEASE_EXPIRY} FROM session_turn_leases`;
      for (const raw of db.prepare(leaseSql).all() as Array<Record<string, unknown>>) {
        const id = asString(raw[leaseKey]);
        const expires = toEpochMs(raw[HERMES_LEASE_EXPIRY]);
        if (id !== undefined && expires !== undefined && expires > now) leased.add(id);
      }
    }

    const delegated = new Map<string, string>();
    const delegationSql = `SELECT ${HERMES_DELEGATION_COLUMNS.join(', ')} FROM async_delegations`;
    for (const raw of db.prepare(delegationSql).all() as Array<Record<string, unknown>>) {
      const child = asString(raw['origin_session']);
      const parent = asString(raw['parent_session_id']);
      if (child !== undefined && parent !== undefined && child !== parent) {
        delegated.set(child, parent);
      }
    }

    return { rows, leased, delegated };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * The node model
 * ------------------------------------------------------------------ */

/** How a Hermes session id is namespaced. Two profiles can hold the same id. */
export function hermesSessionId(profile: string, id: string): string {
  return `hermes:${profile}:${id}`;
}

/** Deepest tree Nazar will build out of `parent_session_id`. Cycles stop here. */
export const MAX_HERMES_DEPTH = 16;

export interface HermesBuildOptions {
  readonly profile: string;
  readonly now: number;
  readonly taskText: boolean;
  readonly endedWindowMs: number;
  readonly host?: string;
}

/**
 * Turn one database read into cards.
 *
 * A root is a session Hermes did not mark as a subagent; a subagent hangs off
 * its parent, at the depth the parent chain gives it. The relation comes from
 * `parent_session_id` first and from `async_delegations` only where the column
 * was empty, because a delegation is Hermes's *asynchronous* spawn and the two
 * describe the same edge from different ends.
 */
export function buildHermesSessions(read: HermesRead, options: HermesBuildOptions): SessionView[] {
  const { profile, now, taskText, endedWindowMs } = options;
  const byId = new Map<string, RawSession>();
  for (const row of read.rows) byId.set(row.id, row);

  const parentOf = (row: RawSession): string | undefined => {
    const declared = row.parentId ?? read.delegated.get(row.id);
    if (declared === undefined || declared === row.id || !byId.has(declared)) return undefined;
    return declared;
  };

  /** Depth of a row in the parent chain, and `undefined` on a cycle. */
  const depthOf = (row: RawSession): number | undefined => {
    let depth = 0;
    let current = row;
    const seen = new Set<string>([row.id]);
    for (;;) {
      const parent = parentOf(current);
      if (parent === undefined) return depth;
      if (seen.has(parent) || depth >= MAX_HERMES_DEPTH) return undefined;
      seen.add(parent);
      current = byId.get(parent) as RawSession;
      depth += 1;
    }
  };

  const isSubagent = (row: RawSession): boolean =>
    row.source === 'subagent' && parentOf(row) !== undefined;

  const rootOf = (row: RawSession): RawSession | undefined => {
    let current = row;
    const seen = new Set<string>([row.id]);
    for (let step = 0; step <= MAX_HERMES_DEPTH; step += 1) {
      const parent = parentOf(current);
      if (parent === undefined) return current;
      if (seen.has(parent)) return undefined;
      seen.add(parent);
      current = byId.get(parent) as RawSession;
    }
    return undefined;
  };

  /** Recent enough to draw: still open, or ended inside the window. */
  const isCurrent = (row: RawSession): boolean => {
    if (row.endedAt === undefined) return true;
    return now - row.endedAt <= endedWindowMs;
  };

  const agentStateOf = (row: RawSession): Agent['state'] => {
    if (read.leased.has(row.id)) return 'running';
    if (row.endedAt !== undefined) return 'done';
    return 'unknown';
  };

  const agentOf = (row: RawSession, sessionId: string, depth: number): Agent => {
    const agent: { -readonly [K in keyof Agent]: Agent[K] } = {
      id: hermesSessionId(profile, row.id),
      sessionId,
      spawnDepth: depth,
      agentType: row.source ?? 'subagent',
      state: agentStateOf(row),
    };
    const parent = parentOf(row);
    if (parent !== undefined) agent.parentAgentId = hermesSessionId(profile, parent);
    if (row.model !== undefined) agent.model = row.model;
    if (row.startedAt !== undefined) agent.startedAt = row.startedAt;
    if (row.endedAt !== undefined) agent.endedAt = row.endedAt;
    if (row.startedAt !== undefined && row.endedAt !== undefined) {
      agent.durationMs = Math.max(0, row.endedAt - row.startedAt);
    }
    if (row.toolCalls !== undefined) agent.toolCalls = row.toolCalls;
    if (row.tokens !== undefined) agent.tokens = row.tokens;
    if (row.lastActivityAt !== undefined) {
      agent.lastWriteAt = row.lastActivityAt;
      agent.writeAgeMs = Math.max(0, now - row.lastActivityAt);
    }
    // N-WP15a. Hermes's own summary of the conversation is still the
    // conversation, so it crosses only when task text is on.
    if (taskText && row.title !== undefined) agent.task = row.title;
    return agent;
  };

  /* ---- group the subagents under the root they belong to ---------- */

  const children = new Map<string, RawSession[]>();
  const roots: RawSession[] = [];
  for (const row of read.rows) {
    if (isSubagent(row)) {
      const root = rootOf(row);
      if (root === undefined) continue;
      const list = children.get(root.id);
      if (list === undefined) children.set(root.id, [row]);
      else list.push(row);
      continue;
    }
    if (parentOf(row) === undefined) roots.push(row);
  }

  const nodeFor = (row: RawSession, sessionId: string, agents: Map<string, Agent>): AgentNode => {
    const agent = agents.get(hermesSessionId(profile, row.id)) as Agent;
    const kids = read.rows
      .filter((candidate) => parentOf(candidate) === row.id)
      .filter((candidate) => agents.has(hermesSessionId(profile, candidate.id)))
      .map((candidate) => nodeFor(candidate, sessionId, agents));
    return { agent, children: kids };
  };

  const views: SessionView[] = [];
  for (const row of roots) {
    const kids = children.get(row.id) ?? [];
    // A root whose own run is over but whose subagents are not is still worth
    // drawing; a root with nothing current under it is not.
    if (!isCurrent(row) && !kids.some(isCurrent)) continue;

    const sessionId = hermesSessionId(profile, row.id);
    const agents = new Map<string, Agent>();
    for (const kid of kids) {
      const depth = depthOf(kid);
      if (depth === undefined) continue;
      agents.set(hermesSessionId(profile, kid.id), agentOf(kid, sessionId, depth));
    }

    const treeRoots = read.rows
      .filter((candidate) => parentOf(candidate) === row.id)
      .filter((candidate) => agents.has(hermesSessionId(profile, candidate.id)))
      .map((candidate) => nodeFor(candidate, sessionId, agents));

    const running = read.leased.has(row.id);
    const ended = row.endedAt !== undefined;
    const view: { -readonly [K in keyof SessionView]: SessionView[K] } = {
      id: sessionId,
      provider: 'hermes',
      // Hermes runs one gateway per profile, not one process per session, so
      // there is no process behind a card to raise. `0` is the same stand-in a
      // frozen history tree uses, and the canvas refuses to jump to it.
      pid: 0,
      /*
       * Three states and no fourth. A live lease is Hermes saying it is
       * processing this session's turn right now; an `ended_at` is it saying
       * the session is over; neither is it saying nothing is happening.
       * `waiting` is never produced — see the module note.
       */
      status: running ? 'busy' : ended ? 'unknown' : 'idle',
      state: ended ? 'unknown' : 'alive',
      source: 'files',
      lastSeenAt: now,
      agents: [...agents.values()],
      roots: treeRoots,
      orphans: [],
      treeRead: true,
    };
    if (options.host !== undefined) view.host = options.host;
    if (row.cwd !== undefined) view.cwd = row.cwd;
    if (row.model !== undefined) view.model = row.model;
    if (row.startedAt !== undefined) view.startedAt = row.startedAt;
    if (row.toolCalls !== undefined) view.toolCalls = row.toolCalls;
    if (row.tokens !== undefined) view.tokens = row.tokens;
    if (row.lastActivityAt !== undefined) {
      view.lastWriteAt = row.lastActivityAt;
      view.transcriptAt = row.lastActivityAt;
      view.writeAgeMs = Math.max(0, now - row.lastActivityAt);
    }
    const treeTokens = addTokens([row, ...kids]);
    if (treeTokens !== undefined) view.treeTokens = treeTokens;
    if (taskText && row.title !== undefined) view.task = row.title;
    views.push(view);
  }

  views.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
  return views;
}

/** The session's own counters plus its subagents'. Nothing else is summed. */
function addTokens(rows: readonly RawSession[]): SessionTokens | undefined {
  const total: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number } = {};
  let any = false;
  for (const row of rows) {
    const tokens = row.tokens;
    if (tokens === undefined) continue;
    any = true;
    if (tokens.in !== undefined) total.in = (total.in ?? 0) + tokens.in;
    if (tokens.out !== undefined) total.out = (total.out ?? 0) + tokens.out;
    if (tokens.cacheRead !== undefined) total.cacheRead = (total.cacheRead ?? 0) + tokens.cacheRead;
    if (tokens.cacheWrite !== undefined) {
      total.cacheWrite = (total.cacheWrite ?? 0) + tokens.cacheWrite;
    }
  }
  return any ? total : undefined;
}

/* ------------------------------------------------------------------ *
 * The reader
 * ------------------------------------------------------------------ */

export interface HermesReaderOptions {
  /** Root of the Hermes installation. Defaults to `HERMES_HOME` or `~/.hermes`. */
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** How often every source is re-read. Default 2 s, the registry's interval. */
  readonly pollIntervalMs?: number;
  /** How long an ended session stays drawn. Default ten minutes. */
  readonly endedWindowMs?: number;
  /** N-WP15a: may `sessions.title` be read at all. Off unless a caller says so. */
  readonly taskText?: boolean;
  /** How long a read-only connection waits for a writer. Default 250 ms. */
  readonly busyTimeoutMs?: number;
  /** Host label put on every card this reader produces. Set by `--agent`. */
  readonly host?: string;
  readonly now?: () => number;
}

export interface HermesReaderEvents {
  change: [HermesScan];
}

/**
 * Polls every Hermes `state.db` on this machine and publishes cards.
 *
 * The same shape as the two optional readers under `~/.nazar`: it starts, it
 * polls, it emits `change`, and "there is no Hermes here" is a normal answer
 * that produces an empty scan rather than an error.
 */
export class HermesReader extends EventEmitter<HermesReaderEvents> {
  readonly homeDir: string;

  readonly pollIntervalMs: number;

  readonly endedWindowMs: number;

  readonly busyTimeoutMs: number;

  private readonly taskText: boolean;

  private readonly host: string | undefined;

  private readonly now: () => number;

  private timer: NodeJS.Timeout | undefined;

  private started = false;

  private open: SqliteOpen | undefined;

  private current: HermesScan;

  constructor(options: HermesReaderOptions = {}) {
    super();
    this.homeDir = options.homeDir ?? hermesHomeDir(options.env, options.home);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_HERMES_POLL_MS;
    this.endedWindowMs = options.endedWindowMs ?? DEFAULT_ENDED_WINDOW_MS;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.taskText = options.taskText === true;
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.current = { generatedAt: this.now(), available: true, sources: [], sessions: [] };
  }

  snapshot(): HermesScan {
    return this.current;
  }

  /** Read once and start the poll. Resolves with `snapshot()` populated. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.open = await loadSqlite();
    await this.scan();
    if (!this.started) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over every profile. Never throws; a bad source goes `unknown`.
   *
   * The module is loaded here as well as in {@link start}, so a caller that
   * wants one reading and no poll — `nazar doctor`, a test — gets the same
   * answer without having to start something it would then have to stop.
   * `loadSqlite` resolves once per process, so the second call is a cached
   * promise rather than a second import.
   */
  async scan(): Promise<HermesScan> {
    this.open ??= await loadSqlite();
    const now = this.now();
    const open = this.open;
    if (open === undefined) {
      this.current = {
        generatedAt: now,
        available: false,
        reason: `node:sqlite is not available on ${process.version}; Hermes needs Node 22.5 or newer`,
        sources: [],
        sessions: [],
      };
      this.emit('change', this.current);
      return this.current;
    }

    const refs = await discoverHermesSources(this.homeDir);
    const sources: HermesSourceScan[] = [];
    const sessions: SessionView[] = [];

    for (const ref of refs) {
      try {
        const read = readDatabase(open, ref.file, now, this.busyTimeoutMs);
        const built = buildHermesSessions(read, {
          profile: ref.profile,
          now,
          taskText: this.taskText,
          endedWindowMs: this.endedWindowMs,
          ...(this.host === undefined ? {} : { host: this.host }),
        });
        sessions.push(...built);
        sources.push({
          profile: ref.profile,
          file: ref.file,
          state: 'ok',
          sessions: read.rows.length,
          running: read.leased.size,
        });
      } catch (error) {
        // A locked database, a schema this reader does not know, a file that
        // moved. The source says `unknown` and the canvas loses that profile
        // for one pass; nothing crashes and nothing is guessed.
        sources.push({
          profile: ref.profile,
          file: ref.file,
          state: 'unknown',
          error: error instanceof Error ? error.message : String(error),
          sessions: 0,
          running: 0,
        });
      }
    }

    this.current = { generatedAt: now, available: true, sources, sessions };
    this.emit('change', this.current);
    return this.current;
  }
}
