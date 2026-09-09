/**
 * WP4: one snapshot of everything the canvas draws.
 *
 * The registry (WP1) knows which sessions exist, where they run and whether
 * they are waiting for the user. The tree watcher (WP2) knows, per session,
 * the subagent forest, the model, the effort, the current tool and the exact
 * deduplicated token totals. Neither of them knows about the other, and the
 * canvas needs both, so this file is the join.
 *
 * N-WP18 added a third source that is not Claude Code's at all: the Codex
 * rollout store. It is joined here rather than inside the registry, because a
 * Codex thread has no pid, no session file and no subagent tree — nothing the
 * registry is built around — and the one thing the canvas needs is for both to
 * arrive in the same snapshot. A machine without Codex produces exactly the
 * state it produced before, for the same reason the two below do: the reader
 * answers "not installed" rather than zero.
 *
 * WP3'/WP5 added two more, both optional and neither ours: the status-line
 * captures under `~/.nazar/statusline` (cost, context window, live effort, and
 * the two rate-limit windows) and `~/.nazar/limits.json` (every quota window
 * nazar-tray knows, Codex included). A machine with neither installed produces
 * exactly the state it produced before them — no strip, no cost, no context —
 * because both readers answer "not configured" rather than zero.
 *
 * The join is deliberately thin: it owns no parsing and no watching of its
 * own. It starts a `SessionTreeWatcher` when a session appears with both a
 * real session id and a working directory, stops it when the session goes,
 * and coalesces the event streams into a single `change` carrying the whole
 * state. Full snapshots rather than deltas: a canvas that reconnects after an
 * SSE drop must be correct without replaying anything.
 *
 * A field no source can fill stays `undefined` and is never invented as `0`
 * (docs/pinned-internal-formats.md, rule 3).
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';

import type { CodexSessionsOptions } from './codex-rollout.js';
import { CodexSessions } from './codex-rollout.js';

import type { LimitsScan, LimitsWatcherOptions } from './limits-file.js';
import { LimitsWatcher } from './limits-file.js';
import { projectsDirPath } from './paths.js';
import { projectSlugFor } from './project-slug.js';
import type { Quota } from './quota.js';
import { selectQuota } from './quota.js';
import type { SessionRegistryOptions } from './session-registry.js';
import { SessionRegistry } from './session-registry.js';
import type { SessionTreeSnapshot } from './session-tree.js';
import { SessionTreeWatcher } from './session-tree.js';
import { CAPTURE_GRACE_MS, ProjectStatusLineProbe } from './project-settings.js';
import type { CaptureScan, StatuslineCapturesOptions } from './statusline-captures.js';
import { StatuslineCaptures } from './statusline-captures.js';
import type { AgentNode, Session, SessionTokens } from './types.js';

/** How long the join waits for more changes before it publishes. */
export const DEFAULT_COALESCE_MS = 60;

/**
 * A session as the canvas sees it: everything the registry knows, plus
 * everything its tree watcher has read off disk.
 */
export interface SessionView extends Session {
  /** The subagent forest hanging off this session. Empty until one spawns. */
  readonly roots: readonly AgentNode[];
  /** Session plus every subagent under it, deduplicated per transcript. */
  readonly treeTokens?: SessionTokens;
  /** Agents whose written parent did not resolve. Empty in healthy data. */
  readonly orphans: readonly string[];
  /** `tool_use` blocks seen in the session's own transcript. */
  readonly toolCalls?: number;
  /** `mtimeMs` of the session transcript: when Claude Code last appended. */
  readonly transcriptAt?: number;
  /** Age of that write at snapshot time. Transcripts are written with lag. */
  readonly writeAgeMs?: number;
  /** True once a tree watcher has completed one pass for this session. */
  readonly treeRead: boolean;
}

/**
 * N-WP20. Why the canvas has nothing to draw, in the terms `nazar doctor`
 * already uses — the same three branches decided from the same two facts, so
 * the page and the command line cannot disagree about a machine.
 *
 * - `noConfigDir` — the sessions directory does not exist, so Claude Code has
 *   never run under this configuration directory.
 * - `noSessions` — the directory is there and holds no session file. Nothing is
 *   running, and that is the whole of what it means.
 * - `staleSessions` — session files exist and no process behind them is alive.
 *   Leftovers from sessions that ended, which Nazar refuses to draw as running.
 */
export type EmptyReason = 'noConfigDir' | 'noSessions' | 'staleSessions';

/**
 * What an empty canvas is allowed to say for itself. Present **only** when
 * there is nothing to draw: a canvas with a session on it has no empty state
 * to explain, and an `emptyReason` sitting next to three running sessions would
 * be a field that lies.
 */
export interface EmptyDiagnosis {
  readonly reason: EmptyReason;
  /** Whether the last liveness gate reached `claude agents --json`. */
  readonly agentsOk: boolean;
  /** Session files on disk right now, alive or not. */
  readonly sessionFiles: number;
  /**
   * Whether the status-line wrapper is installed. Never a reason the canvas is
   * empty — it is why cost and context would be missing once something *is*
   * drawn, which is a different sentence and is shown as one.
   */
  readonly wrapper: boolean;
}

/** Everything one `GET /api/state` or one SSE frame carries. */
export interface StateSnapshot {
  /** Epoch ms this snapshot was built. The canvas ages everything from it. */
  readonly generatedAt: number;
  readonly sessions: readonly SessionView[];
  /** Whether the last liveness gate reached `claude agents --json`. */
  readonly commandAvailable: boolean;
  /** Session files skipped so far because they were malformed. */
  readonly warnings: number;
  /**
   * The quota strip's data (WP5), or **absent** when neither source exists.
   * Absent is the whole of "hide the strip": there is no empty-strip state and
   * no window drawn at `0 %` for want of a reading.
   */
  readonly quota?: Quota;
  /**
   * N-WP20. Why there is nothing on the canvas, or **absent** when there is
   * something on it. The first five minutes of Nazar are an empty rectangle for
   * anybody whose machine is not already running Claude Code, and "no sessions
   * found" is not an answer anyone can act on.
   */
  readonly empty?: EmptyDiagnosis;
}

/**
 * N-WP16: one session that has ended.
 *
 * "Ended" here is the **session-level** answer to the question `agent-done.ts`
 * asks about a subagent, and it is the same signal: `session-gone`. A session is
 * over when the registry no longer holds it — its `~/.claude/sessions/<pid>.json`
 * is gone, `claude agents --json` no longer lists it, and its pid failed the
 * liveness probe for a whole gate interval. The registry already reaches that
 * verdict exactly once per session, in `SessionRegistry.publish`'s `removed`, so
 * this carries the verdict rather than deciding it a second time.
 *
 * Deliberately *not* derived from a subagent finishing. A busy session finishes
 * dozens of subagents a minute and not one of them means the work is done.
 */
export interface SessionEnded {
  /** The session's id — Claude Code's uuid, or Nazar's `pid-<pid>` stand-in. */
  readonly id: string;
  /** What it was called, when it was called anything. */
  readonly name?: string;
  /** Where it ran. Redacted on the wire like every other path. */
  readonly cwd?: string;
  /** Epoch ms at which the registry stopped holding it. */
  readonly at: number;
}

export interface NazarStateEvents {
  change: [StateSnapshot];
  /** N-WP16. One event per session, at the moment the registry drops it. */
  'session-ended': [SessionEnded];
}

/** The subset of `SessionTreeOptions` the join passes through. */
export interface StateTreeOptions {
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly watch?: boolean;
  readonly runningWindowMs?: number;
  readonly quietMs?: number;
  /**
   * N-WP15a: let every tree watcher read the human turn's text.
   *
   * Off unless the CLI turned it on, and the CLI turns it off for good with
   * `--no-task-text`. Nothing downstream can put it back: this is the flag the
   * *reader* takes, so with it off the text is never in the process.
   */
  readonly taskText?: boolean;
}

export interface NazarStateOptions {
  /** An already-built registry. Tests inject one over a temporary directory. */
  readonly registry?: SessionRegistry;
  /** Options for the registry this builds when none is handed in. */
  readonly registryOptions?: SessionRegistryOptions;
  /** Root of the per-project transcript store. Defaults to `~/.claude/projects`. */
  readonly projectsDir?: string;
  /** Options handed to every tree watcher. */
  readonly treeOptions?: StateTreeOptions;
  /**
   * The status-line capture reader (WP3'). Pass `null` to run without it, which
   * is what a test that has no `~/.nazar` to point at does; tests that do
   * exercise it inject one over a temporary directory, never the real one.
   */
  readonly captures?: StatuslineCaptures | null;
  /** Options for the capture reader this builds when none is handed in. */
  readonly captureOptions?: StatuslineCapturesOptions;
  /**
   * WP4f: the project-settings probe that explains a missing capture. Pass
   * `null` to run without it, which is what every test that is not about it
   * does; pass one of your own to inject a filesystem.
   */
  readonly statusLines?: ProjectStatusLineProbe | null;
  /** The `limits.json` reader (WP5). Pass `null` to run without it. */
  readonly limits?: LimitsWatcher | null;
  /** Options for the limits reader this builds when none is handed in. */
  readonly limitsOptions?: LimitsWatcherOptions;
  /**
   * N-WP18: the Codex rollout reader. Pass `null` to run without it, which is
   * what `nazar --no-codex` does and what every test that is not about Codex
   * does; tests that are inject one over a temporary store.
   */
  readonly codex?: CodexSessions | null;
  /** Options for the Codex reader this builds when none is handed in. */
  readonly codexOptions?: CodexSessionsOptions;
  /**
   * Builds the watcher for one session. Returning `undefined` means "no tree
   * for this session". Injected by tests so no watcher ever touches `~/.claude`.
   */
  readonly createTree?: (session: Session, projectDir: string) => SessionTreeWatcher | undefined;
  /** How long to wait for more changes before publishing. Default 60 ms. */
  readonly coalesceMs?: number;
  /** Clock, injected by tests. */
  readonly now?: () => number;
}

/** A session id Claude Code wrote, as opposed to Nazar's `pid-<pid>` stand-in. */
function hasRealSessionId(session: Session): boolean {
  return !session.id.startsWith('pid-');
}

interface Tracked {
  readonly watcher: SessionTreeWatcher;
  snapshot?: SessionTreeSnapshot;
}

/**
 * Registry plus one tree watcher per session, joined into a single snapshot
 * and a single `change` event.
 */
export class NazarState extends EventEmitter<NazarStateEvents> {
  readonly registry: SessionRegistry;

  /** The status-line captures, or `undefined` when the join runs without them. */
  readonly captures: StatuslineCaptures | undefined;

  /**
   * WP4f: which project directories replace the user-level status line.
   *
   * Consulted synchronously while a snapshot is built and filled in
   * asynchronously between snapshots — see `project-settings.ts` for why that
   * split exists and what it costs.
   */
  readonly statusLines: ProjectStatusLineProbe | undefined;

  /** The `limits.json` reader, or `undefined` when the join runs without it. */
  readonly limits: LimitsWatcher | undefined;

  /** N-WP18: the Codex reader, or `undefined` when the join runs without it. */
  readonly codex: CodexSessions | undefined;

  readonly projectsDir: string;

  readonly coalesceMs: number;

  private readonly treeOptions: StateTreeOptions;

  private readonly createTree: (
    session: Session,
    projectDir: string,
  ) => SessionTreeWatcher | undefined;

  private readonly now: () => number;

  private readonly trees = new Map<string, Tracked>();

  private started = false;

  private publishTimer: NodeJS.Timeout | undefined;

  private current: StateSnapshot;

  constructor(options: NazarStateOptions = {}) {
    super();
    this.registry = options.registry ?? new SessionRegistry(options.registryOptions ?? {});
    this.captures =
      options.captures === null
        ? undefined
        : (options.captures ?? new StatuslineCaptures(options.captureOptions ?? {}));
    this.limits =
      options.limits === null
        ? undefined
        : (options.limits ?? new LimitsWatcher(options.limitsOptions ?? {}));
    this.codex =
      options.codex === null
        ? undefined
        : (options.codex ?? new CodexSessions(options.codexOptions ?? {}));
    this.statusLines =
      options.statusLines === null
        ? undefined
        : (options.statusLines ?? new ProjectStatusLineProbe());
    this.projectsDir = options.projectsDir ?? projectsDirPath();
    this.treeOptions = options.treeOptions ?? {};
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.now = options.now ?? Date.now;
    this.createTree = options.createTree ?? ((session, projectDir) => this.defaultTree(session, projectDir));
    this.current = {
      generatedAt: this.now(),
      sessions: [],
      commandAvailable: false,
      warnings: 0,
    };
  }

  /** The state as of the last publish. Cheap; never touches the disk. */
  snapshot(): StateSnapshot {
    return this.current;
  }

  /**
   * Start the registry, attach a tree watcher to every session it found, and
   * publish once. Resolves with `snapshot()` already populated.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.registry.on('change', (change) => {
      if (!this.started) return;
      // N-WP16, and before the trees are synced: `syncTrees` stops the watcher
      // for a session that has gone, so this is the last moment the join can
      // still say anything about it at all.
      this.announceEnded(change.removed);
      void this.syncTrees();
      this.schedulePublish();
    });
    this.captures?.on('change', () => {
      if (this.started) this.schedulePublish();
    });
    this.limits?.on('change', () => {
      if (this.started) this.schedulePublish();
    });
    this.codex?.on('change', () => {
      if (this.started) this.schedulePublish();
    });

    // The two optional readers are started alongside the registry rather than
    // after it: neither can fail in a way that matters — an absent directory is
    // their normal answer — and neither has anything to do with liveness.
    await Promise.all([
      this.registry.start(),
      this.captures?.start() ?? Promise.resolve(),
      this.limits?.start() ?? Promise.resolve(),
      this.codex?.start() ?? Promise.resolve(),
    ]);
    if (!this.started) return;
    await this.syncTrees();
    this.publish();
  }

  /** Stop every watcher. Timers are unreferenced, so this is only tidiness. */
  stop(): void {
    this.started = false;
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    for (const tracked of this.trees.values()) tracked.watcher.stop();
    this.trees.clear();
    this.registry.stop();
    this.captures?.stop();
    this.limits?.stop();
    this.codex?.stop();
  }

  /** `~/.claude/projects/<slug>` for a session's working directory. */
  projectDirFor(cwd: string): string {
    return path.join(this.projectsDir, projectSlugFor(cwd));
  }

  private defaultTree(session: Session, projectDir: string): SessionTreeWatcher | undefined {
    const options: ConstructorParameters<typeof SessionTreeWatcher>[0] = {
      sessionId: session.id,
      projectDir,
      ...(this.treeOptions.debounceMs === undefined
        ? {}
        : { debounceMs: this.treeOptions.debounceMs }),
      ...(this.treeOptions.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.treeOptions.pollIntervalMs }),
      ...(this.treeOptions.watch === undefined ? {} : { watch: this.treeOptions.watch }),
      ...(this.treeOptions.runningWindowMs === undefined
        ? {}
        : { runningWindowMs: this.treeOptions.runningWindowMs }),
      ...(this.treeOptions.quietMs === undefined ? {} : { quietMs: this.treeOptions.quietMs }),
      ...(this.treeOptions.taskText === undefined ? {} : { taskText: this.treeOptions.taskText }),
    };
    return new SessionTreeWatcher(options);
  }

  /** Add a watcher for every new session, drop the ones whose session is gone. */
  private async syncTrees(): Promise<void> {
    const sessions = this.registry.snapshot();
    const wanted = new Set<string>();
    const starting: Array<Promise<void>> = [];

    for (const session of sessions) {
      const cwd = session.cwd;
      if (cwd === undefined || !hasRealSessionId(session)) continue;
      wanted.add(session.id);
      const existing = this.trees.get(session.id);
      if (existing !== undefined) {
        // WP4b signal (c): a session whose process stopped answering will never
        // append another line, so every agent beneath it is finished.
        existing.watcher.setSessionGone(session.state === 'unknown');
        continue;
      }

      const watcher = this.createTree(session, this.projectDirFor(cwd));
      if (watcher === undefined) continue;

      const tracked: Tracked = { watcher };
      this.trees.set(session.id, tracked);
      watcher.setSessionGone(session.state === 'unknown');
      watcher.on('change', (snapshot) => {
        tracked.snapshot = snapshot;
        this.schedulePublish();
      });
      starting.push(
        watcher.start().then(
          () => {
            // The watcher only emits when its fingerprint moves, so a session
            // whose first pass found nothing would otherwise stay unread.
            tracked.snapshot ??= watcher.snapshot();
          },
          () => {
            // A session directory that vanished mid-start is not an error:
            // the registry will drop the session on the next gate.
          },
        ),
      );
    }

    for (const [id, tracked] of this.trees) {
      if (wanted.has(id)) continue;
      tracked.watcher.stop();
      this.trees.delete(id);
    }

    await Promise.all(starting);
  }

  /**
   * N-WP16: say, once, that each of these sessions has ended.
   *
   * No bookkeeping of its own and no set of ids already announced, because there
   * is nothing to deduplicate: a session appears in `removed` on the pass that
   * takes it out of the registry's map, and the map cannot lose it twice. The
   * *session* it names could come back — a new `claude` on the same pid — but
   * that is a new session with its own end, not this one happening again.
   *
   * The listeners are the SSE stream and nothing else, so a machine with no
   * canvas open does this work for an empty room. That is the price of one
   * `emit` per ended session, which is not a price.
   */
  private announceEnded(removed: readonly Session[]): void {
    if (removed.length === 0) return;
    const at = this.now();
    for (const session of removed) {
      const ended: { -readonly [K in keyof SessionEnded]: SessionEnded[K] } = { id: session.id, at };
      if (session.name !== undefined) ended.name = session.name;
      if (session.cwd !== undefined) ended.cwd = session.cwd;
      this.emit('session-ended', ended);
    }
  }

  private schedulePublish(): void {
    if (!this.started || this.publishTimer !== undefined) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, this.coalesceMs);
    this.publishTimer.unref?.();
  }

  /** The two optional sources as of the last pass. Neither ever throws. */
  quotaSources(): { readonly limits: LimitsScan; readonly captures: CaptureScan } {
    return {
      limits: this.limits?.snapshot() ?? { configured: false },
      captures: this.captures?.snapshot() ?? {
        configured: false,
        captures: new Map(),
        warnings: 0,
      },
    };
  }

  /** Build the snapshot and hand it to every listener. */
  publish(): StateSnapshot {
    const now = this.now();
    const captures = this.captures?.snapshot();
    const raw = this.registry.snapshot();
    // WP4f. Fired before the views are built, so the *next* publish has the
    // answer; the probe caches for minutes, so a machine at rest reads nothing.
    this.probeStatusLines(raw, now, captures);
    const sessions = [
      ...raw.map((session) => this.viewOf(session, now, captures)),
      // N-WP18. A Codex thread arrives already complete: it has no tree watcher
      // to join, no status-line capture (the wrapper is Claude Code's), and no
      // subagent forest of its own — a thread it spawns is a *sibling* rollout
      // with a card of its own, not a node under this one. So the view is the
      // session plus the three empty tree fields, and `treeRead` is `true`
      // because the rollout genuinely was read: the card says "no subagents"
      // rather than "not read yet", which is the difference between an answer
      // and a shrug.
      ...(this.codex?.snapshot() ?? []).map(
        (session): SessionView => ({
          ...session,
          roots: [],
          orphans: [],
          treeRead: true,
          // The rollout is both the registry entry and the transcript for a
          // Codex thread, so the one mtime fills both fields the canvas ages a
          // card from. Absent when the file has not been stat'd yet.
          ...(session.lastWriteAt === undefined ? {} : { transcriptAt: session.lastWriteAt }),
        }),
      ),
    ];

    const next: {
      -readonly [K in keyof StateSnapshot]: StateSnapshot[K];
    } = {
      generatedAt: now,
      sessions,
      commandAvailable: this.registry.commandAvailable,
      warnings: this.registry.warnings,
    };
    const sources = this.quotaSources();
    const quota = selectQuota(sources.limits, sources.captures);
    // Absent, not empty: no source means no strip, and an empty `quota` object
    // would be a third state the canvas would have to learn to hide.
    if (quota !== undefined) next.quota = quota;

    // N-WP20. Only when there is nothing to draw, and built from what the
    // registry already read on this pass: no extra syscall on the hot path.
    if (sessions.length === 0) {
      next.empty = {
        reason: this.registry.sessionsDirectoryMissing
          ? 'noConfigDir'
          : this.registry.sessionFiles > 0
            ? 'staleSessions'
            : 'noSessions',
        agentsOk: this.registry.commandAvailable,
        sessionFiles: this.registry.sessionFiles,
        wrapper: sources.captures.configured,
      };
    }

    this.current = next;
    this.emit('change', this.current);
    return this.current;
  }

  private viewOf(session: Session, now: number, captures?: CaptureScan): SessionView {
    const tree = this.trees.get(session.id)?.snapshot;
    const view: {
      -readonly [K in keyof SessionView]: SessionView[K];
    } = {
      ...session,
      agents: tree?.agents ?? session.agents,
      roots: tree?.roots ?? [],
      orphans: tree?.orphans ?? [],
      treeRead: tree !== undefined,
    };

    if (tree !== undefined) {
      if (tree.model !== undefined) view.model = tree.model;
      if (tree.effort !== undefined) view.effort = tree.effort;
      if (tree.currentTool !== undefined) view.currentTool = tree.currentTool;
      // N-WP15a. Absent on every session unless the reader was asked for it.
      if (tree.task !== undefined) view.task = tree.task;
      if (tree.tokens !== undefined) view.tokens = tree.tokens;
      if (tree.treeTokens !== undefined) view.treeTokens = tree.treeTokens;
      if (tree.toolCalls !== undefined) view.toolCalls = tree.toolCalls;
      // The transcript's first timestamp beats the session file's `startedAt`
      // only when the file never carried one.
      if (view.startedAt === undefined && tree.startedAt !== undefined) {
        view.startedAt = tree.startedAt;
      }
      if (tree.lastWriteAt !== undefined) {
        view.transcriptAt = tree.lastWriteAt;
        view.writeAgeMs = Math.max(0, now - tree.lastWriteAt);
      }
    }

    /* ---- WP3': the capture for this session, if there is one ------- */

    const capture = captures?.captures.get(session.id);
    if (capture === undefined) {
      // WP4f: a blank with a reason. Set only when the wrapper *is* installed —
      // on a machine without it nothing has a capture, and that is a fact about
      // the machine rather than about this session or its project.
      if (this.captureBlocked(session, now, captures)) {
        view.captureBlockedBy = 'project statusLine';
      }
      return view;
    }

    if (capture.costUsd !== undefined) view.costUsd = capture.costUsd;
    if (capture.contextWindow !== undefined) view.contextWindow = capture.contextWindow;
    const capturedAt = capture.capturedAt ?? capture.fileAt;
    if (capturedAt !== undefined) view.capturedAt = capturedAt;

    /*
     * Effort has two sources that disagree by design.
     *
     * The transcript's `effort` is on the last *written* assistant line, so it
     * is the effort of the turn that has already happened — and transcripts are
     * flushed with lag. The status line carries the effort the session is set
     * to right now, and it is rewritten every few seconds. So the newer of the
     * two wins, and "newer" is measured against the transcript's own mtime
     * rather than against the wall clock: a capture from a session that stopped
     * writing an hour ago must not overrule a transcript line written since.
     *
     * With no transcript read yet there is nothing to compare against and the
     * capture is simply the only answer.
     */
    if (capture.effort !== undefined) {
      const writtenAt = tree?.lastWriteAt;
      if (view.effort === undefined || writtenAt === undefined || (capturedAt ?? -Infinity) >= writtenAt) {
        view.effort = capture.effort;
      }
    }

    // The model is left to the transcript: it is the model that actually
    // answered, where the status line reports the one selected. They agree
    // except in the seconds after a `/model`, and the transcript is the one
    // that describes work already done.

    return view;
  }

  /**
   * Whether a session is old enough, and quiet enough, to be worth asking about.
   *
   * Four conditions, and all four have to hold before Nazar says anything: the
   * wrapper is installed (or the answer is about the machine, not the project),
   * this session has no capture, it is actually alive, and it has been alive
   * long past the first status-line redraw it should have had.
   */
  private capturePending(session: Session, now: number, captures?: CaptureScan): boolean {
    if (captures?.configured !== true) return false;
    if (captures.captures.has(session.id)) return false;
    if (session.state !== 'alive') return false;
    const startedAt = session.startedAt;
    return startedAt !== undefined && now - startedAt > CAPTURE_GRACE_MS;
  }

  /** The verdict itself: pending *and* the project displaces the status line. */
  private captureBlocked(session: Session, now: number, captures?: CaptureScan): boolean {
    if (this.statusLines === undefined) return false;
    if (!this.capturePending(session, now, captures)) return false;
    return this.statusLines.overrides(session.cwd);
  }

  /** Read the settings of every project that owes this canvas an explanation. */
  private probeStatusLines(
    sessions: readonly Session[],
    now: number,
    captures?: CaptureScan,
  ): void {
    const probe = this.statusLines;
    if (probe === undefined) return;
    for (const session of sessions) {
      const cwd = session.cwd;
      if (cwd === undefined) continue;
      if (!this.capturePending(session, now, captures)) continue;
      // Fire and forget: the probe caches, de-duplicates concurrent reads and
      // never rejects, so there is nothing here for a failure to do.
      void probe.probe(cwd);
    }
  }
}
