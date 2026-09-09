/**
 * WP2: one session's live tree, assembled from the four things on disk.
 *
 *   <projectDir>/<sessionId>.jsonl                     the session's own transcript
 *   <projectDir>/<sessionId>/subagents/agent-*.meta.json   the tree structure
 *   <projectDir>/<sessionId>/subagents/agent-*.jsonl       one transcript per subagent
 *   <projectDir>/<sessionId>/subagents/workflows/<runId>/  workflow-run grouping
 *
 * Every transcript gets its own tailer and its own `TranscriptStats`, so the
 * dedupe is per file and a subagent's tokens are never folded into its parent's
 * count by accident. The parent-to-subagent bridge runs the other way: a
 * `toolUseResult` in *any* transcript of the session names the agent it
 * launched and its resolved model, which is how a depth-2 agent gets its full
 * model id from its depth-1 parent's file.
 *
 * Watching follows WP1: a 2 s poll that always runs, plus `fs.watch` with a
 * 100 ms debounce on every one of those paths when a watch can be had. The
 * poll is the floor and the watch is the accelerator (see `fs-watch.ts`), so
 * the bound holds where `fs.watch` is late or absent. A poll costs one
 * `readdir` per directory, a re-read of the small `meta.json` files, and one
 * `stat` per tailed transcript. Measured on the maintainer's machine at the
 * size WP4c names as the ceiling — one session, 60 agents, 61 files tailed —
 * an idle pass is **12.5 ms median, 17.1 ms p95 and reads 0 bytes**: 0.63 % of
 * a core at a 2 s interval. The transcripts, which are the files that reach
 * megabytes, stay incremental, so no byte is ever read twice, and an idle pass
 * emits nothing because the fingerprint below has not moved.
 */
import { EventEmitter } from 'node:events';

import type { AgentActivity } from './agent-tree.js';
import { buildAgentTree } from './agent-tree.js';
import type { DirectoryWatcher, WatchFactory } from './fs-watch.js';
import { watchPath } from './fs-watch.js';
import { sessionTranscriptPaths } from './paths.js';
import type { SubagentsScan, WorkflowRun } from './subagent-meta.js';
import { readSubagentsDir } from './subagent-meta.js';
import type { ExtractOptions } from './task-text.js';
import { extractTranscriptLine } from './transcript-extract.js';
import type { AgentBridge, TokenTotals } from './transcript-stats.js';
import { TranscriptStats, addTotals } from './transcript-stats.js';
import { TranscriptTailer } from './transcript-tailer.js';
import type { Agent, AgentNode } from './types.js';

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface SessionTreeOptions {
  /** The session's uuid, which is also its transcript's file name. */
  readonly sessionId: string;
  /** `~/.claude/projects/<slug>` for the session's working directory. */
  readonly projectDir: string;
  readonly debounceMs?: number;
  /**
   * How often every watched path is rescanned regardless of `fs.watch`.
   * Default 2 s, and it is what the "a change lands within N" bound is made
   * of — not a fallback that only runs when a watch could not be established.
   */
  readonly pollIntervalMs?: number;
  /** Set false to skip `fs.watch` entirely and rely on the poll alone. */
  readonly watch?: boolean;
  /**
   * Builds each `fs.watch` handle. Defaults to `watchPath`; tests inject a
   * double so the watch pipeline can be asserted without a real filesystem
   * event.
   */
  readonly watchFactory?: WatchFactory;
  /** How long after its last write an agent still counts as running. */
  readonly runningWindowMs?: number;
  /** How long a transcript stays quiet before a closing turn counts as `done`. */
  readonly quietMs?: number;
  /**
   * N-WP15a: read the human turn's text out of every transcript this watcher
   * tails, so the session and its subagents can say what they were asked to do.
   *
   * Off unless the caller says otherwise, and the switch is here — at the
   * *reader* — rather than at the wire on purpose: with it off no task text is
   * ever in this process to be filtered later, which is exactly what
   * `nazar --no-task-text` promises and what a filter could not.
   */
  readonly taskText?: boolean;
  /** Clock, injected by tests. */
  readonly now?: () => number;
}

export interface SessionTreeSnapshot {
  readonly sessionId: string;
  /** Deduplicated totals for the session's own transcript. */
  readonly tokens?: TokenTotals;
  /** The session plus every subagent under it. */
  readonly treeTokens?: TokenTotals;
  readonly model?: string;
  readonly effort?: string;
  readonly currentTool?: string;
  /**
   * N-WP15a: the session's last human turn. Absent unless `taskText` was asked
   * for, and absent on a session whose transcript holds nothing a person typed.
   */
  readonly task?: string;
  readonly toolCalls?: number;
  readonly startedAt?: number;
  /** `mtimeMs` of the session transcript: when Claude Code last appended. */
  readonly lastWriteAt?: number;
  /** Age of that write. Transcripts are written asynchronously and lag. */
  readonly writeAgeMs?: number;
  readonly agents: readonly Agent[];
  readonly roots: readonly AgentNode[];
  /** Agents whose `parentAgentId` did not resolve. Empty in healthy data. */
  readonly orphans: readonly string[];
  readonly workflowRuns: readonly WorkflowRun[];
  /** Lines keyed on `message.id` alone for want of a `requestId`. */
  readonly dedupeFallbacks: number;
  /** Meta files that could not be parsed. */
  readonly warnings: number;
  /** Bytes pulled off disk since this watcher started. */
  readonly bytesRead: number;
  /** Transcripts currently tailed: the session's own plus one per subagent. */
  readonly filesTailed: number;
}

export interface SessionTreeEvents {
  change: [SessionTreeSnapshot];
}

interface Tailed {
  readonly tailer: TranscriptTailer;
  readonly stats: TranscriptStats;
  lastWriteAt?: number;
}

/** Everything except the fields derived from the clock. */
function fingerprint(snapshot: SessionTreeSnapshot): string {
  return JSON.stringify([
    snapshot.tokens ?? null,
    snapshot.treeTokens ?? null,
    snapshot.model ?? null,
    snapshot.effort ?? null,
    snapshot.currentTool ?? null,
    // N-WP15a. In the fingerprint because a new turn on an otherwise idle
    // session changes nothing else: without this the card would keep the
    // previous task until some token count happened to move.
    snapshot.task ?? null,
    snapshot.toolCalls ?? null,
    snapshot.startedAt ?? null,
    snapshot.lastWriteAt ?? null,
    snapshot.dedupeFallbacks,
    snapshot.warnings,
    snapshot.orphans,
    snapshot.workflowRuns.map((run) => [run.runId, run.agentIds]),
    snapshot.agents.map((agent) => [
      agent.id,
      agent.parentAgentId ?? null,
      agent.spawnDepth,
      agent.agentType,
      agent.model ?? null,
      agent.modelId ?? null,
      agent.effort ?? null,
      agent.currentTool ?? null,
      agent.task ?? null,
      agent.toolCalls ?? null,
      agent.tokens ?? null,
      agent.lastWriteAt ?? null,
      agent.state,
      agent.doneSignal ?? null,
      agent.endedAt ?? null,
      agent.durationMs ?? null,
      agent.orphan ?? false,
      agent.workflowRunId ?? null,
    ]),
  ]);
}

export class SessionTreeWatcher extends EventEmitter<SessionTreeEvents> {
  readonly sessionId: string;

  readonly projectDir: string;

  readonly transcriptFile: string;

  readonly subagentsDir: string;

  readonly workflowsDir: string;

  readonly debounceMs: number;

  readonly pollIntervalMs: number;

  private readonly useWatch: boolean;

  private readonly watchFactory: WatchFactory;

  private readonly runningWindowMs: number | undefined;

  private readonly quietMs: number | undefined;

  /**
   * N-WP15a. Frozen at construction and never re-read: the shell restarts the
   * server to change it, so a watcher's answer to "may I read prose" cannot
   * change under a running session.
   */
  private readonly extractOptions: ExtractOptions;

  private readonly now: () => number;

  /**
   * True when the session that owns this tree is no longer running. Set by the
   * join (WP4b, `done` signal (c)); every agent under a gone session is
   * finished, whatever its transcript's last line says.
   */
  private sessionGone = false;

  private readonly sessionTail: Tailed;

  private readonly agentTails = new Map<string, Tailed>();

  private readonly watchers = new Map<string, DirectoryWatcher>();

  private started = false;

  private debounceTimer: NodeJS.Timeout | undefined;

  private pollTimer: NodeJS.Timeout | undefined;

  private queue: Promise<void> = Promise.resolve();

  private current: SessionTreeSnapshot;

  private currentFingerprint = '';

  private scanWarnings = 0;

  /** The last directory scan, kept so `setSessionGone` can republish without one. */
  private lastScan: SubagentsScan = {
    metas: [],
    transcripts: [],
    workflowRuns: [],
    warnings: 0,
    missingDirectory: true,
  };

  constructor(options: SessionTreeOptions) {
    super();
    this.sessionId = options.sessionId;
    this.projectDir = options.projectDir;
    const paths = sessionTranscriptPaths(options.projectDir, options.sessionId);
    this.transcriptFile = paths.transcript;
    this.subagentsDir = paths.subagentsDir;
    this.workflowsDir = paths.workflowsDir;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.useWatch = options.watch ?? true;
    this.watchFactory = options.watchFactory ?? watchPath;
    this.runningWindowMs = options.runningWindowMs;
    this.quietMs = options.quietMs;
    this.extractOptions = { taskText: options.taskText === true };
    this.now = options.now ?? Date.now;
    this.sessionTail = { tailer: new TranscriptTailer(paths.transcript), stats: new TranscriptStats() };
    this.current = {
      sessionId: options.sessionId,
      agents: [],
      roots: [],
      orphans: [],
      workflowRuns: [],
      dedupeFallbacks: 0,
      warnings: 0,
      bytesRead: 0,
      filesTailed: 0,
    };
  }

  /** The tree as of the last pass. Cheap; recomputed only on `refresh()`. */
  snapshot(): SessionTreeSnapshot {
    return this.current;
  }

  /**
   * Tell the watcher its session's process is gone. Republishes immediately
   * when the answer changes, so the canvas fades the tree on the same frame
   * the session goes `unknown` rather than a poll interval later.
   */
  setSessionGone(gone: boolean): void {
    if (this.sessionGone === gone) return;
    this.sessionGone = gone;
    this.publish(this.lastScan);
  }

  /** Read both sources once, then watch. Resolves after the first pass. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    if (!this.started) return;
    this.beginWatching();
  }

  stop(): void {
    this.started = false;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** One pass: scan the directory, read what was appended, rebuild the tree. */
  refresh(): Promise<void> {
    const task = async (): Promise<void> => {
      await this.pass();
    };
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async pass(): Promise<void> {
    const scan = await readSubagentsDir(this.subagentsDir);
    this.scanWarnings = scan.warnings;
    this.lastScan = scan;

    await this.drain(this.sessionTail);

    for (const entry of scan.transcripts) {
      let tail = this.agentTails.get(entry.agentId);
      if (tail === undefined) {
        tail = { tailer: new TranscriptTailer(entry.file), stats: new TranscriptStats() };
        this.agentTails.set(entry.agentId, tail);
      }
      await this.drain(tail);
    }

    this.publish(scan);
    if (this.started) this.ensureWatchers();
  }

  /** Read one file's appended bytes into its stats. Never throws. */
  private async drain(tail: Tailed): Promise<void> {
    const result = await tail.tailer.read();
    if (result.restarted) tail.stats.reset();
    if (result.mtimeMs !== undefined) tail.lastWriteAt = result.mtimeMs;
    for (const line of result.lines) {
      const event = extractTranscriptLine(line, this.extractOptions);
      if (event !== undefined) tail.stats.add(event);
    }
  }

  private publish(scan: SubagentsScan): void {
    const now = this.now();

    // Bridges are session-wide: a depth-2 agent is named in its depth-1
    // parent's transcript, not in the session's own.
    const bridges = new Map<string, AgentBridge>();
    for (const [agentId, bridge] of this.sessionTail.stats.agentBridges) {
      bridges.set(agentId, bridge);
    }
    for (const tail of this.agentTails.values()) {
      for (const [agentId, bridge] of tail.stats.agentBridges) bridges.set(agentId, bridge);
    }

    const activity = new Map<string, AgentActivity>();
    for (const [agentId, tail] of this.agentTails) {
      const entry: {
        -readonly [K in keyof AgentActivity]: AgentActivity[K];
      } = {};
      const tokens = tail.stats.tokens;
      if (tokens !== undefined) entry.tokens = tokens;
      if (tail.stats.effort !== undefined) entry.effort = tail.stats.effort;
      if (tail.stats.model !== undefined) entry.model = tail.stats.model;
      if (tail.stats.currentTool !== undefined) entry.currentTool = tail.stats.currentTool;
      // N-WP15a: the *first* human turn of a subagent's own transcript is the
      // brief the `Agent` tool launched it with. A `SendMessage` follow-up is a
      // correction to a job, not the job.
      if (tail.stats.firstTask !== undefined) entry.task = tail.stats.firstTask;
      entry.toolCalls = tail.stats.toolCalls;
      if (tail.stats.startedAt !== undefined) entry.startedAt = tail.stats.startedAt;
      if (tail.stats.lastEventAt !== undefined) entry.lastEventAt = tail.stats.lastEventAt;
      if (tail.lastWriteAt !== undefined) entry.lastWriteAt = tail.lastWriteAt;
      if (tail.stats.lastLineType !== undefined) entry.lastLineType = tail.stats.lastLineType;
      entry.pendingToolUse = tail.stats.pendingToolUse;
      activity.set(agentId, entry);
    }

    const treeOptions: Parameters<typeof buildAgentTree>[0] = {
      sessionId: this.sessionId,
      metas: scan.metas,
      activity,
      bridges,
      now,
      sessionGone: this.sessionGone,
      ...(this.runningWindowMs === undefined ? {} : { runningWindowMs: this.runningWindowMs }),
      ...(this.quietMs === undefined ? {} : { quietMs: this.quietMs }),
    };
    const tree = buildAgentTree(treeOptions);

    const sessionStats = this.sessionTail.stats;
    const lastWriteAt = this.sessionTail.lastWriteAt;

    let bytesRead = this.sessionTail.tailer.bytesRead;
    for (const tail of this.agentTails.values()) bytesRead += tail.tailer.bytesRead;

    const snapshot: {
      -readonly [K in keyof SessionTreeSnapshot]: SessionTreeSnapshot[K];
    } = {
      sessionId: this.sessionId,
      agents: tree.agents,
      roots: tree.roots,
      orphans: tree.orphans,
      workflowRuns: scan.workflowRuns,
      dedupeFallbacks:
        sessionStats.dedupeFallbacks +
        [...this.agentTails.values()].reduce((sum, tail) => sum + tail.stats.dedupeFallbacks, 0),
      warnings: this.scanWarnings,
      bytesRead,
      filesTailed: 1 + this.agentTails.size,
      toolCalls: sessionStats.toolCalls,
    };

    const tokens = sessionStats.tokens;
    if (tokens !== undefined) snapshot.tokens = tokens;
    const treeTokens = addTotals(
      tokens,
      ...[...this.agentTails.values()].map((tail) => tail.stats.tokens),
    );
    if (treeTokens !== undefined) snapshot.treeTokens = treeTokens;
    if (sessionStats.model !== undefined) snapshot.model = sessionStats.model;
    if (sessionStats.effort !== undefined) snapshot.effort = sessionStats.effort;
    if (sessionStats.currentTool !== undefined) snapshot.currentTool = sessionStats.currentTool;
    // N-WP15a: the *last* human turn of the session's own transcript — what it
    // was asked to do most recently, which is the question a live card raises.
    if (sessionStats.lastTask !== undefined) snapshot.task = sessionStats.lastTask;
    if (sessionStats.startedAt !== undefined) snapshot.startedAt = sessionStats.startedAt;
    if (lastWriteAt !== undefined) {
      snapshot.lastWriteAt = lastWriteAt;
      snapshot.writeAgeMs = Math.max(0, now - lastWriteAt);
    }

    this.current = snapshot;
    const next = fingerprint(snapshot);
    if (next === this.currentFingerprint) return;
    this.currentFingerprint = next;
    this.emit('change', snapshot);
  }

  /**
   * Every path currently held by an `fs.watch` handle. A path missing from
   * this list is not a failure: the poll covers it either way, and a session
   * that has not spawned a subagent has no `subagents/` to watch at all.
   */
  get watchedPaths(): readonly string[] {
    return [...this.watchers.keys()];
  }

  private ensureWatchers(): void {
    if (!this.useWatch) return;
    const targets = [this.transcriptFile, this.subagentsDir, this.workflowsDir];
    for (const run of this.current.workflowRuns) targets.push(run.dir);
    for (const tail of this.agentTails.values()) targets.push(tail.tailer.file);

    for (const target of targets) {
      if (this.watchers.has(target)) continue;
      try {
        const watcher = this.watchFactory(target, () => {
          this.scheduleRefresh();
        });
        watcher.on('error', () => {
          watcher.close();
          if (this.watchers.get(target) === watcher) this.watchers.delete(target);
        });
        this.watchers.set(target, watcher);
      } catch {
        // The file or directory does not exist yet: a session with no subagent
        // has no `subagents/`, and a brand-new session has no transcript. The
        // next pass tries again, and until then the poll is the whole story.
      }
    }
  }

  private beginWatching(): void {
    // The poll starts first and unconditionally; the watches are the fast path
    // on top of it, and losing them changes latency, not correctness.
    this.beginPolling();
    this.ensureWatchers();
  }

  private beginPolling(): void {
    if (this.pollTimer !== undefined || !this.started) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }
}
