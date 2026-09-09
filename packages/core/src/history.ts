/**
 * WP4b: the history scanner.
 *
 * Claude Code keeps every session it has ever run under `~/.claude/projects`
 * until `cleanupPeriodDays` expires it (default 30; the maintainer runs 90).
 * That is 68 project directories, 134 session transcripts and 348 subagents on
 * this machine, and the largest single transcript is 10.8 MB. Reading all of
 * that to draw a *list* would be absurd, so this file is built around one rule:
 *
 * > **List directories. Parse nothing until someone opens a session.**
 *
 * `list()` therefore does `readdir` plus `stat`, never `open`, and the fields
 * that can only come from inside a file (`model`, `tokens`, `durationMs`) are
 * absent from a listing until that session has actually been opened — at which
 * point the parse cache fills them in for as long as it holds the entry. They
 * are never inferred from file metadata and never shown as `0`; an absent
 * measurement stays absent (docs/pinned-internal-formats.md, rule 3).
 *
 * `open()` reuses WP2 whole — `TranscriptTailer`, `extractTranscriptLine`,
 * `TranscriptStats`, `readSubagentsDir`, `buildAgentTree` — so there is exactly
 * one parser in this codebase and the metadata-only guarantee has exactly one
 * place to hold. A history session is built with `sessionGone: true`, which is
 * true by construction: nothing will ever be appended to a finished session,
 * and with `omitDescription: true`, which makes the metadata-only guarantee
 * literal here: `meta.json`'s `description` is the one prose field the node
 * model can carry, a frozen session has no hover card to show it on, so the
 * history object never has the key at all rather than relying on a later
 * filter to strip it. `test/history-leak.test.ts` is the gate.
 *
 * Three limits keep an open bounded: at most {@link DEFAULT_CONCURRENCY} files
 * are read at once, parsed sessions are cached by `(path, size, mtime, the
 * shape of `subagents/`)` so an unchanged *tree* is never read twice, and the
 * cache drops its least recently used entry past {@link DEFAULT_CACHE_LIMIT}
 * sessions.
 *
 * Nothing here writes, moves, copies or deletes anything under `~/.claude`.
 * Retention is Claude Code's, and Nazar does not extend it.
 */
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildAgentTree } from './agent-tree.js';
import type { AgentActivity } from './agent-tree.js';
import { projectsDirPath, sessionTranscriptPaths } from './paths.js';
import { projectDisplayFor } from './project-slug.js';
import { readSubagentsDir } from './subagent-meta.js';
import type { ExtractOptions } from './task-text.js';
import { extractTranscriptLine } from './transcript-extract.js';
import type { AgentBridge } from './transcript-stats.js';
import { addTotals, TranscriptStats } from './transcript-stats.js';
import { TranscriptTailer } from './transcript-tailer.js';
import type { History, HistorySummary } from './types.js';

/** Files opened at once while building one session's frozen tree. */
export const DEFAULT_CONCURRENCY = 4;

/** Parsed sessions kept in memory. The 51st open evicts the coldest. */
export const DEFAULT_CACHE_LIMIT = 50;

/** Sessions per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 50;

/** Largest page a caller may ask for. Keeps one response bounded. */
export const MAX_PAGE_SIZE = 500;

/**
 * How long a directory listing is reused before it is walked again. The walk
 * costs about 20 ms here, so this exists to keep a burst of requests (a list
 * followed by an open) from repeating it, not to hide a slow scan.
 */
export const DEFAULT_INDEX_TTL_MS = 2000;

export interface HistoryListOptions {
  /** Sessions to return. Clamped to {@link MAX_PAGE_SIZE}. */
  readonly limit?: number;
  /** How many of the newest sessions to skip. */
  readonly offset?: number;
  /** Only sessions whose project display equals this. */
  readonly project?: string;
}

export interface HistoryListPage {
  readonly generatedAt: number;
  /** Sessions found, before `limit` and `offset`. */
  readonly total: number;
  readonly offset: number;
  /** Newest write first. */
  readonly sessions: readonly HistorySummary[];
  /** Project display names present in the whole listing, newest first. */
  readonly projects: readonly string[];
  /** Set when more sessions follow this page. */
  readonly nextOffset?: number;
  /** Milliseconds the directory walk took. Zero on a cached index. */
  readonly listMs: number;
  /** Project directories that could not be read. */
  readonly warnings: number;
}

/**
 * The whole store reduced to identifiers, with no paging at all.
 *
 * N-WP20. The canvas forgets the layout, the tab membership and the card name
 * of a session the machine no longer has, and "no longer has" can only be
 * decided against the *whole* store. Deciding it against the first page threw
 * away the customisations of every session past it — on a machine with 201
 * transcripts, everything from the 201st down. This is what that decision is
 * allowed to be made from: ids, and nothing else, so it stays as cheap as a
 * listing and carries nothing a listing would not.
 */
export interface HistoryIdsResult {
  readonly generatedAt: number;
  /** Every session id in the store, newest write first. Never a page of them. */
  readonly sessionIds: readonly string[];
  readonly total: number;
  /** Milliseconds the directory walk took. Zero on a cached index. */
  readonly listMs: number;
  readonly warnings: number;
}

/** Counters the laziness tests assert against. Diagnostics only. */
export interface HistoryScannerStats {
  /** Directory walks that actually hit the filesystem. */
  readonly walks: number;
  /** `stat` calls made while listing. */
  readonly stats: number;
  /** Transcript files opened. A listing never moves this. */
  readonly fileReads: number;
  /** Sessions parsed from disk. */
  readonly parses: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly cacheSize: number;
  readonly evictions: number;
}

export interface HistoryScannerOptions {
  /** Root of the per-project transcript store. Defaults to `~/.claude/projects`. */
  readonly projectsDir?: string;
  /** Home directory collapsed to `~` in a project label. */
  readonly home?: string;
  readonly cacheLimit?: number;
  readonly concurrency?: number;
  readonly indexTtlMs?: number;
  /**
   * N-WP15a: read the human turn's text out of a session being opened, so a
   * frozen card can say what that run was asked to do.
   *
   * The **same gate as the live canvas, and for the same reason**: the switch
   * is on the reader. With it off — which is the default and is what a scanner
   * built by any test gets — `open()` produces a history object with no `task`
   * anywhere in it and no `description` on any agent, exactly as before, which
   * is what `test/history-leak.test.ts` walks.
   */
  readonly taskText?: boolean;
  /** Clock, injected by tests. */
  readonly now?: () => number;
}

/** One session transcript found on disk, before anything was opened. */
interface IndexEntry {
  readonly sessionId: string;
  readonly slug: string;
  readonly project: string;
  readonly projectDir: string;
  readonly transcript: string;
  readonly transcriptBytes: number;
  readonly lastWriteAt: number;
  readonly agentCount?: number;
  /**
   * N-WP20. How many subagent files this session has, how many bytes they hold
   * and when the newest of them was written — the half of a session's token
   * total that does not live in its own transcript.
   *
   * The parse cache was keyed on the parent transcript alone, so a session
   * whose *subagents* grew kept answering with the totals from before they
   * did: 11 output tokens on a tree that had 31. Building it here is still a
   * directory listing plus one `stat` per file and never an `open`, and only
   * for the sessions that have a `subagents/` directory at all.
   */
  readonly agentsSignature?: string;
}

interface Index {
  readonly entries: readonly IndexEntry[];
  readonly bySessionId: ReadonlyMap<string, IndexEntry>;
  readonly warnings: number;
  readonly builtAt: number;
  readonly listMs: number;
}

/** Run `task` over `items`, never more than `limit` at a time. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      out[index] = await task(item);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * How much of one transcript is held in memory at a time.
 *
 * The live watcher reads a few kilobytes per pass and needs no such bound.
 * History starts at byte zero of files that reach **76 MB** here, so it drains
 * them in slices: peak memory is this cap, not the file, whatever the store
 * grows to.
 */
export const READ_SLICE_BYTES = 4 << 20;

/**
 * Read one transcript whole, through the WP2 tailer and extractor — the same
 * two, so there is no second parser and the metadata-only guarantee has one
 * place to hold. Bounded: the file is drained in {@link READ_SLICE_BYTES}
 * slices rather than concatenated.
 */
async function readTranscript(
  file: string,
  extract?: ExtractOptions,
): Promise<{ stats: TranscriptStats; bytesRead: number; lastWriteAt?: number }> {
  const tailer = new TranscriptTailer(file, { maxBytesPerRead: READ_SLICE_BYTES });
  const stats = new TranscriptStats();
  let bytesRead = 0;
  let lastWriteAt: number | undefined;

  for (;;) {
    const result = await tailer.read();
    if (result.mtimeMs !== undefined) lastWriteAt = result.mtimeMs;
    // A file that shrank under us is not the file we started: begin again.
    if (result.restarted) stats.reset();
    for (const line of result.lines) {
      const event = extractTranscriptLine(line, extract);
      if (event !== undefined) stats.add(event);
    }
    bytesRead += result.bytesRead;
    if (result.bytesRead === 0) break;
  }

  return lastWriteAt === undefined
    ? { stats, bytesRead }
    : { stats, bytesRead, lastWriteAt };
}

/**
 * The scanner. One instance per process: it owns the parse cache, so handing
 * two of them the same directory doubles the memory for no gain.
 */
export class HistoryScanner {
  readonly projectsDir: string;

  readonly home: string;

  readonly cacheLimit: number;

  readonly concurrency: number;

  readonly indexTtlMs: number;

  /**
   * N-WP15a. Frozen at construction, like the live watcher's: whether prose may
   * be read out of a transcript is a property of how this process was started,
   * never of the request that arrived.
   */
  private readonly extractOptions: ExtractOptions;

  private readonly now: () => number;

  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly cache = new Map<string, History>();

  private index: Index | undefined;

  private indexInFlight: Promise<Index> | undefined;

  private counters = {
    walks: 0,
    stats: 0,
    fileReads: 0,
    parses: 0,
    cacheHits: 0,
    cacheMisses: 0,
    evictions: 0,
  };

  constructor(options: HistoryScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? projectsDirPath();
    this.home = options.home ?? os.homedir();
    this.cacheLimit = Math.max(1, options.cacheLimit ?? DEFAULT_CACHE_LIMIT);
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.indexTtlMs = options.indexTtlMs ?? DEFAULT_INDEX_TTL_MS;
    this.extractOptions = { taskText: options.taskText === true };
    this.now = options.now ?? Date.now;
  }

  get stats(): HistoryScannerStats {
    return { ...this.counters, cacheSize: this.cache.size };
  }

  /** Throw the parse cache and the directory index away. */
  clear(): void {
    this.cache.clear();
    this.index = undefined;
  }

  /**
   * One page of past sessions, newest write first. Opens no transcript: every
   * field here comes from a directory entry or from the parse cache.
   */
  async list(options: HistoryListOptions = {}): Promise<HistoryListPage> {
    const index = await this.ensureIndex();
    const wanted =
      options.project === undefined
        ? index.entries
        : index.entries.filter((entry) => entry.project === options.project);

    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)));
    const page = wanted.slice(offset, offset + limit);

    const projects: string[] = [];
    const seen = new Set<string>();
    for (const entry of wanted) {
      if (seen.has(entry.project)) continue;
      seen.add(entry.project);
      projects.push(entry.project);
    }

    const result: {
      -readonly [K in keyof HistoryListPage]: HistoryListPage[K];
    } = {
      generatedAt: this.now(),
      total: wanted.length,
      offset,
      sessions: page.map((entry) => this.summaryOf(entry)),
      projects,
      listMs: index.listMs,
      warnings: index.warnings,
    };
    if (offset + page.length < wanted.length) result.nextOffset = offset + page.length;
    return result;
  }

  /**
   * Every session id in the store, in one answer and in listing order.
   *
   * N-WP20. Deliberately not a page: the one caller is the canvas deciding what
   * to forget, and a partial answer to that question is worse than no answer at
   * all — it deletes the customisations of the sessions it did not mention. An
   * id is a uuid, so 10 000 of them is under half a megabyte, and this walks
   * the same cached index `list()` does.
   */
  async ids(): Promise<HistoryIdsResult> {
    const index = await this.ensureIndex();
    return {
      generatedAt: this.now(),
      sessionIds: index.entries.map((entry) => entry.sessionId),
      total: index.entries.length,
      listMs: index.listMs,
      warnings: index.warnings,
    };
  }

  /**
   * One past session as a frozen tree. Parses on the first call and on any call
   * where the transcript **or any of its subagent files** has changed size or
   * mtime since; otherwise the cache answers and nothing is opened.
   */
  async open(sessionId: string): Promise<History | undefined> {
    const index = await this.ensureIndex();
    let entry = index.bySessionId.get(sessionId);
    if (entry === undefined) {
      // The session may have been written since the index was built.
      const fresh = await this.ensureIndex(true);
      entry = fresh.bySessionId.get(sessionId);
      if (entry === undefined) return undefined;
    }

    const key = this.cacheKey(entry);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.counters.cacheHits += 1;
      // Re-insert to make this the most recently used entry.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    this.counters.cacheMisses += 1;
    const history = await this.parse(entry);
    this.remember(key, history);
    return history;
  }

  /**
   * Path, size and mtime of the transcript, plus the shape of the `subagents/`
   * directory beside it: a session that changed any of them is re-parsed.
   *
   * The subagent half is N-WP20. A session's headline number is `treeTokens`,
   * which is the parent transcript **plus every subagent under it**, so a key
   * that only watched the parent answered a question it had not checked. The
   * reproduction was one appended subagent line: 11 tokens cached against a
   * tree that had 31.
   */
  private cacheKey(entry: IndexEntry): string {
    return `${entry.transcript}|${entry.transcriptBytes}|${entry.lastWriteAt}|${entry.agentsSignature ?? '-'}`;
  }

  private remember(key: string, history: History): void {
    this.cache.set(key, history);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
      this.counters.evictions += 1;
    }
  }

  /** A listing row: directory facts, plus the parse cache when it has this one. */
  private summaryOf(entry: IndexEntry): HistorySummary {
    const cached = this.cache.get(this.cacheKey(entry));
    const summary: {
      -readonly [K in keyof HistorySummary]: HistorySummary[K];
    } = {
      sessionId: entry.sessionId,
      project: entry.project,
      transcriptBytes: entry.transcriptBytes,
      lastWriteAt: entry.lastWriteAt,
      hydrated: cached !== undefined,
    };
    if (entry.agentCount !== undefined) summary.agentCount = entry.agentCount;
    if (cached === undefined) return summary;

    // A parsed session knows its own agent count better than the directory did.
    summary.agentCount = cached.agentCount;
    if (cached.firstWriteAt !== undefined) summary.firstWriteAt = cached.firstWriteAt;
    if (cached.durationMs !== undefined) summary.durationMs = cached.durationMs;
    if (cached.model !== undefined) summary.model = cached.model;
    if (cached.tokens !== undefined) summary.tokens = cached.tokens;
    if (cached.treeTokens !== undefined) summary.treeTokens = cached.treeTokens;
    return summary;
  }

  /* ---------------------------------------------------------------- *
   * The directory walk
   * ---------------------------------------------------------------- */

  private async ensureIndex(force = false): Promise<Index> {
    const current = this.index;
    if (!force && current !== undefined && this.now() - current.builtAt < this.indexTtlMs) {
      return current;
    }
    // A second caller arriving mid-walk waits for the same walk rather than
    // starting another one.
    const inFlight = this.indexInFlight;
    if (!force && inFlight !== undefined) return inFlight;

    const promise = this.buildIndex();
    this.indexInFlight = promise;
    try {
      const built = await promise;
      this.index = built;
      return built;
    } finally {
      if (this.indexInFlight === promise) this.indexInFlight = undefined;
    }
  }

  private async buildIndex(): Promise<Index> {
    const started = this.now();
    this.counters.walks += 1;

    let projects: string[];
    let warnings = 0;
    try {
      projects = (await readdir(this.projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No project store at all is the normal state of a fresh machine.
      return {
        entries: [],
        bySessionId: new Map(),
        warnings: 0,
        builtAt: started,
        listMs: Math.max(0, this.now() - started),
      };
    }

    const perProject = await mapLimit(projects, this.concurrency, async (slug) =>
      this.scanProject(slug),
    );

    const entries: IndexEntry[] = [];
    for (const result of perProject) {
      warnings += result.warnings;
      entries.push(...result.entries);
    }
    entries.sort((a, b) => b.lastWriteAt - a.lastWriteAt || (a.sessionId < b.sessionId ? -1 : 1));

    // A session id is a uuid, so a collision means the same session was copied
    // between projects. The most recently written copy wins; it is the one the
    // user means.
    const bySessionId = new Map<string, IndexEntry>();
    for (const entry of entries) {
      if (!bySessionId.has(entry.sessionId)) bySessionId.set(entry.sessionId, entry);
    }

    return {
      entries,
      bySessionId,
      warnings,
      builtAt: started,
      listMs: Math.max(0, this.now() - started),
    };
  }

  /** One `~/.claude/projects/<slug>`: its transcripts and their subagent counts. */
  private async scanProject(slug: string): Promise<{ entries: IndexEntry[]; warnings: number }> {
    const projectDir = path.join(this.projectsDir, slug);
    let names;
    try {
      names = await readdir(projectDir, { withFileTypes: true });
    } catch {
      return { entries: [], warnings: 1 };
    }

    const project = projectDisplayFor(slug, this.home);
    const transcripts: string[] = [];
    const sessionDirs = new Set<string>();
    for (const entry of names) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        transcripts.push(entry.name.slice(0, -'.jsonl'.length));
      } else if (entry.isDirectory()) {
        sessionDirs.add(entry.name);
      }
    }

    const rows = await mapLimit(transcripts, this.concurrency, async (sessionId) => {
      const paths = sessionTranscriptPaths(projectDir, sessionId);
      let size: number;
      let mtimeMs: number;
      try {
        this.counters.stats += 1;
        const info = await stat(paths.transcript);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        // Removed between readdir and stat: Claude Code's own cleanup.
        return undefined;
      }

      const row: {
        -readonly [K in keyof IndexEntry]: IndexEntry[K];
      } = {
        sessionId,
        slug,
        project,
        projectDir,
        transcript: paths.transcript,
        transcriptBytes: size,
        lastWriteAt: mtimeMs,
      };

      // Only a directory listing and a `stat` each, never a file read:
      // `agent-*.meta.json` names are enough to count the subagents, and their
      // sizes and mtimes are enough to know whether any of them moved.
      if (sessionDirs.has(sessionId)) {
        try {
          const files = await readdir(paths.subagentsDir);
          row.agentCount = files.filter(
            (name) => name.startsWith('agent-') && name.endsWith('.meta.json'),
          ).length;
          const signature = await this.agentsSignature(paths.subagentsDir, files);
          if (signature !== undefined) row.agentsSignature = signature;
        } catch {
          // A session directory with no `subagents/` is the normal case.
        }
      }
      return row;
    });

    return {
      entries: rows.filter((row): row is IndexEntry => row !== undefined),
      warnings: 0,
    };
  }

  /**
   * N-WP20. What the `subagents/` directory looks like right now: how many
   * files the tree is built from, how many bytes they hold together, and the
   * newest write among them. Any of the three moving means the tree changed,
   * which is exactly when the cached parse of it stops being true.
   *
   * Count and bytes together rather than either alone: a file replaced by
   * another of the same size keeps the total, and the mtime catches that.
   */
  private async agentsSignature(
    subagentsDir: string,
    names: readonly string[],
  ): Promise<string | undefined> {
    const tracked = names
      .filter(
        (name) =>
          name.startsWith('agent-') && (name.endsWith('.jsonl') || name.endsWith('.meta.json')),
      )
      .sort();
    if (tracked.length === 0) return undefined;

    let bytes = 0;
    let newest = 0;
    for (const name of tracked) {
      try {
        this.counters.stats += 1;
        const info = await stat(path.join(subagentsDir, name));
        bytes += info.size;
        if (info.mtimeMs > newest) newest = info.mtimeMs;
      } catch {
        // Removed between the listing and the stat: Claude Code's own cleanup.
      }
    }
    return `${tracked.length}:${bytes}:${newest}`;
  }

  /* ---------------------------------------------------------------- *
   * The frozen tree
   * ---------------------------------------------------------------- */

  private async parse(entry: IndexEntry): Promise<History> {
    this.counters.parses += 1;

    this.counters.fileReads += 1;
    const session = await readTranscript(entry.transcript, this.extractOptions);
    let bytesRead = session.bytesRead;

    const paths = sessionTranscriptPaths(entry.projectDir, entry.sessionId);
    const scan = await readSubagentsDir(paths.subagentsDir);

    const agentStats = await mapLimit(scan.transcripts, this.concurrency, async (file) => {
      this.counters.fileReads += 1;
      const read = await readTranscript(file.file, this.extractOptions);
      return { agentId: file.agentId, ...read };
    });

    const activity = new Map<string, AgentActivity>();
    const bridges = new Map<string, AgentBridge>();
    for (const [agentId, bridge] of session.stats.agentBridges) bridges.set(agentId, bridge);

    for (const read of agentStats) {
      bytesRead += read.bytesRead;
      for (const [agentId, bridge] of read.stats.agentBridges) bridges.set(agentId, bridge);

      const one: {
        -readonly [K in keyof AgentActivity]: AgentActivity[K];
      } = { toolCalls: read.stats.toolCalls };
      const tokens = read.stats.tokens;
      if (tokens !== undefined) one.tokens = tokens;
      if (read.stats.effort !== undefined) one.effort = read.stats.effort;
      if (read.stats.model !== undefined) one.model = read.stats.model;
      if (read.stats.startedAt !== undefined) one.startedAt = read.stats.startedAt;
      if (read.stats.lastEventAt !== undefined) one.lastEventAt = read.stats.lastEventAt;
      if (read.lastWriteAt !== undefined) one.lastWriteAt = read.lastWriteAt;
      if (read.stats.lastLineType !== undefined) one.lastLineType = read.stats.lastLineType;
      // N-WP15a: the brief, under the same gate. Absent unless this scanner was
      // built with `taskText`, which is not the default anywhere.
      if (read.stats.firstTask !== undefined) one.task = read.stats.firstTask;
      one.pendingToolUse = read.stats.pendingToolUse;
      activity.set(read.agentId, one);
    }

    // A finished session cannot gain another line, so every agent under it is
    // `done` by construction. The clock is the session's last write, not now:
    // a tree opened tomorrow must read the same as one opened today.
    const frozenNow = session.lastWriteAt ?? session.stats.lastEventAt ?? this.now();
    const tree = buildAgentTree({
      sessionId: entry.sessionId,
      metas: scan.metas,
      activity,
      bridges,
      now: frozenNow,
      sessionGone: true,
      // `meta.json`'s `description` stays out of history unless task text was
      // asked for, and the construction is still the guarantee rather than a
      // filter: with the switch off the key is never built, so there is nothing
      // for a later filter to forget. N-WP15a is what made the flag a variable
      // — before it, this was the constant `true`, and the reasoning is the
      // same in both states: prose is built only where somebody has said it may
      // be read, never merely stripped on the way out.
      omitDescription: this.extractOptions.taskText !== true,
    });

    const history: {
      -readonly [K in keyof History]: History[K];
    } = {
      sessionId: entry.sessionId,
      project: entry.project,
      agentCount: tree.agents.length,
      agents: tree.agents,
      roots: tree.roots,
      orphans: tree.orphans,
      dedupeFallbacks:
        session.stats.dedupeFallbacks +
        agentStats.reduce((sum, read) => sum + read.stats.dedupeFallbacks, 0),
      bytesRead,
      toolCalls: session.stats.toolCalls,
    };

    if (session.stats.startedAt !== undefined) history.firstWriteAt = session.stats.startedAt;
    history.lastWriteAt = entry.lastWriteAt;
    if (session.stats.startedAt !== undefined && session.stats.lastEventAt !== undefined) {
      history.durationMs = Math.max(0, session.stats.lastEventAt - session.stats.startedAt);
    }
    if (session.stats.model !== undefined) history.model = session.stats.model;
    if (session.stats.effort !== undefined) history.effort = session.stats.effort;
    // N-WP15a: the last human turn of a run that is over. Absent unless asked.
    if (session.stats.lastTask !== undefined) history.task = session.stats.lastTask;

    const tokens = session.stats.tokens;
    if (tokens !== undefined) history.tokens = tokens;
    const treeTokens = addTotals(tokens, ...agentStats.map((read) => read.stats.tokens));
    if (treeTokens !== undefined) history.treeTokens = treeTokens;

    return history;
  }
}
