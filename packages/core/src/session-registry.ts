/**
 * WP1: the live registry of Claude Code sessions on this machine.
 *
 * Two sources, in this order of authority:
 *
 * 1. `~/.claude/sessions/<pid>.json`, read on a 2 s poll and, on top of that,
 *    watched with `fs.watch`. It is the only source that exists when `claude`
 *    is not on PATH. Its mtime moves on every status transition, so a 100 ms
 *    debounce turns a burst of writes into one pass. The poll is the floor and
 *    the watch is the accelerator, never the other way round: `fs.watch`
 *    delivery latency is a platform's business and not a contract (see
 *    `fs-watch.ts`), so the bound Nazar promises — poll interval plus one pass
 *    — must hold with no watch at all. An idle poll publishes nothing: the
 *    fingerprint below decides that, so the floor is one `readdir` plus a
 *    ~600-byte read per live session — 1.3 ms for nine sessions on the
 *    maintainer's machine — every 2 s, and it emits no events.
 * 2. `claude agents --json`, run at startup, whenever the sessions directory
 *    changes, and every 20-30 s as a liveness gate. It costs ~260 ms per call,
 *    which is why it is a gate and not a loop. When it is missing or fails, the
 *    registry keeps working and every session is marked `source: 'files'`.
 *
 * Liveness is decided by neither of them but by a signal-0 probe of the pid.
 * A session whose process is gone goes to `state: 'unknown'` and is removed at
 * the next gate: one gate interval of "we no longer know", then gone. A session
 * file left behind by a crash never keeps a node on the canvas.
 *
 * N-WP20: and it stays gone. The verdict is remembered against the identity of
 * the file it was made about (`buried` below), because the file that made a
 * session appear is still on disk after the session is dropped — so dropping it
 * without remembering why meant the next `readdir` put it straight back.
 */
import { EventEmitter } from 'node:events';

import type { AgentsEntry, AgentsRunner } from './claude-agents.js';
import { createClaudeAgentsRunner } from './claude-agents.js';
import type { DirectoryWatcher, WatchFactory } from './fs-watch.js';
import { watchPath } from './fs-watch.js';
import type { LivenessProbe } from './liveness.js';
import { isPidAlive } from './liveness.js';
import { sessionsDirPath } from './paths.js';
import type { SessionFileEntry } from './session-file.js';
import { readSessionsDir } from './session-file.js';
import type { Session, SessionChange, SessionSource } from './types.js';

export interface SessionRegistryOptions {
  /**
   * Directory to watch. Defaults to `~/.claude/sessions`; tests always inject a
   * temporary directory and never the real one.
   */
  readonly sessionsDir?: string;
  /** How often the liveness gate runs. Default 25 s, inside the 20-30 s band. */
  readonly gateIntervalMs?: number;
  /** Debounce applied to `fs.watch` events. Default 100 ms. */
  readonly debounceMs?: number;
  /**
   * How often the sessions directory is rescanned regardless of `fs.watch`.
   * Default 2 s, and it is what the "a change lands within N" bound is made
   * of — not a fallback that only runs when the watch fails.
   */
  readonly pollIntervalMs?: number;
  /** Set false to skip `fs.watch` entirely and rely on the poll alone. */
  readonly watch?: boolean;
  /**
   * Builds the `fs.watch` handle. Defaults to `watchPath`; tests inject a
   * double so the watch pipeline can be asserted without a real filesystem
   * event.
   */
  readonly watchFactory?: WatchFactory;
  /** Liveness probe. Defaults to a signal-0 check. */
  readonly isAlive?: LivenessProbe;
  /**
   * Runner for `claude agents --json`. Pass `null` to run from the files alone
   * (every session is then `source: 'files'`).
   */
  readonly runAgents?: AgentsRunner | null;
}

export interface SessionRegistryEvents {
  change: [SessionChange];
}

const DEFAULT_GATE_INTERVAL_MS = 25_000;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 2000;

interface Draft {
  readonly pid: number;
  readonly file?: SessionFileEntry;
  readonly agent?: AgentsEntry;
}

/** Everything except `lastSeenAt`, which moves on every pass by design. */
function fingerprint(session: Session): string {
  return JSON.stringify([
    session.id,
    session.pid,
    session.cwd ?? null,
    session.kind ?? null,
    session.name ?? null,
    session.status,
    session.waitingFor ?? null,
    session.startedAt ?? null,
    session.lastWriteAt ?? null,
    session.statusUpdatedAt ?? null,
    session.version ?? null,
    session.state,
    session.source,
  ]);
}

function sourceOf(draft: Draft): SessionSource {
  if (draft.file !== undefined && draft.agent !== undefined) return 'files+command';
  return draft.file !== undefined ? 'files' : 'command';
}

/**
 * What a "this pid is dead" verdict was made about, so it can be remembered
 * without ever becoming permanent. The session file's own content identity when
 * there is one; the command's view of the session when there is not.
 */
function identityOf(draft: Draft): string {
  if (draft.file !== undefined) return `file:${draft.file.identity}`;
  const agent = draft.agent;
  return `command:${agent?.sessionId ?? ''}:${agent?.status ?? ''}:${agent?.startedAt ?? ''}`;
}

export class SessionRegistry extends EventEmitter<SessionRegistryEvents> {
  readonly sessionsDir: string;

  readonly gateIntervalMs: number;

  readonly debounceMs: number;

  readonly pollIntervalMs: number;

  private readonly useWatch: boolean;

  private readonly watchFactory: WatchFactory;

  private readonly isAlive: LivenessProbe;

  private readonly runAgents: AgentsRunner | null;

  private sessions = new Map<number, Session>();

  /** Gate number at which a pid first failed its liveness probe. */
  private readonly unknownAtGate = new Map<number, number>();

  /**
   * N-WP20. Pids already judged dead and dropped, against the identity of the
   * file that was judged. A session file left behind by a crash is still there
   * on the next `readdir`, and until this map existed the drop was undone by
   * the very next scan: the pid came back as `unknown`, aged out again, came
   * back again — `1 → 0 → 1 → 0` for as long as the file sat on disk. The
   * verdict now outlives the removal. A file whose bytes change gets a fresh
   * hearing; one that does not is not reconsidered.
   */
  private readonly buried = new Map<number, string>();

  private lastAgents: readonly AgentsEntry[] = [];

  private agentsOk = false;

  private warningCount = 0;

  private lastGateDurationMs: number | undefined;

  private sessionFileCount = 0;

  private sessionsDirMissing = false;

  private started = false;

  private watcher: DirectoryWatcher | undefined;

  private debounceTimer: NodeJS.Timeout | undefined;

  private gateTimer: NodeJS.Timeout | undefined;

  private pollTimer: NodeJS.Timeout | undefined;

  private gateCount = 0;

  private queue: Promise<void> = Promise.resolve();

  constructor(options: SessionRegistryOptions = {}) {
    super();
    this.sessionsDir = options.sessionsDir ?? sessionsDirPath();
    this.gateIntervalMs = options.gateIntervalMs ?? DEFAULT_GATE_INTERVAL_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.useWatch = options.watch ?? true;
    this.watchFactory = options.watchFactory ?? watchPath;
    this.isAlive = options.isAlive ?? isPidAlive;
    this.runAgents =
      options.runAgents === undefined ? createClaudeAgentsRunner() : options.runAgents;
  }

  /** Sessions as of the last pass, oldest first. */
  snapshot(): readonly Session[] {
    return [...this.sessions.values()].sort(
      (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid,
    );
  }

  /** Session files skipped so far because they were malformed. */
  get warnings(): number {
    return this.warningCount;
  }

  /** Wall time of the last `claude agents --json` call, in milliseconds. */
  get lastGateMs(): number | undefined {
    return this.lastGateDurationMs;
  }

  /** Whether the last gate reached `claude agents --json` successfully. */
  get commandAvailable(): boolean {
    return this.agentsOk;
  }

  /**
   * Session files the last scan found, alive or not. N-WP20: this is what
   * separates "Claude Code has never written here" from "it wrote, and every
   * process behind those files is gone", which are two different things to say
   * to somebody looking at an empty canvas.
   */
  get sessionFiles(): number {
    return this.sessionFileCount;
  }

  /** True when the sessions directory itself does not exist. */
  get sessionsDirectoryMissing(): boolean {
    return this.sessionsDirMissing;
  }

  /**
   * Whether an `fs.watch` handle is currently held. False is not a failure
   * state: it means the registry is running on the poll alone, at the bound it
   * promises anyway.
   */
  get watching(): boolean {
    return this.watcher !== undefined;
  }

  /**
   * Read both sources once, start watching, and schedule the liveness gate.
   * Resolves after the first pass, so `snapshot()` is populated on return.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.gate();
    if (!this.started) return;
    this.beginWatching();
    this.gateTimer = setInterval(() => {
      void this.gate();
    }, this.gateIntervalMs);
    this.gateTimer.unref();
  }

  /** Stop watching. Timers are unreferenced, so this is only tidiness. */
  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.gateTimer !== undefined) clearInterval(this.gateTimer);
    this.gateTimer = undefined;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** One pass over the session files, without running the command. */
  refresh(): Promise<void> {
    return this.enqueue(() => this.reconcile(false));
  }

  /** One pass that also runs `claude agents --json` and ages out `unknown`. */
  gate(): Promise<void> {
    return this.enqueue(() => this.reconcile(true));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private beginWatching(): void {
    // The poll starts first and unconditionally. Everything below is an
    // accelerator: it can fail to start, it can die later, and on macOS it can
    // simply be late, and none of that may change what the registry promises.
    this.beginPolling();
    if (!this.useWatch) return;
    try {
      const watcher = this.watchFactory(this.sessionsDir, () => {
        this.scheduleRefresh();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      // The directory may not exist yet on a machine that has never run
      // Claude Code, and some filesystems have no watch support at all.
    }
  }

  private beginPolling(): void {
    if (this.pollTimer !== undefined) return;
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

  private async reconcile(isGate: boolean): Promise<void> {
    const scan = await readSessionsDir(this.sessionsDir);
    this.warningCount += scan.warnings;
    this.sessionFileCount = scan.entries.length;
    this.sessionsDirMissing = scan.missingDirectory;

    if (isGate) {
      this.gateCount += 1;
      if (this.runAgents === null) {
        this.lastAgents = [];
        this.agentsOk = false;
      } else {
        const result = await this.runAgents();
        this.lastGateDurationMs = result.durationMs;
        this.agentsOk = result.ok;
        // A failed call is never patched over with a stale list: "no news" must
        // not keep a session on the canvas.
        this.lastAgents = result.ok ? result.entries : [];
      }
    }

    const drafts = new Map<number, Draft>();
    for (const file of scan.entries) drafts.set(file.pid, { pid: file.pid, file });
    for (const agent of this.lastAgents) {
      const existing = drafts.get(agent.pid);
      drafts.set(agent.pid, { pid: agent.pid, file: existing?.file, agent });
    }

    const now = Date.now();
    const next = new Map<number, Session>();

    for (const draft of drafts.values()) {
      const identity = identityOf(draft);
      const grave = this.buried.get(draft.pid);
      if (grave !== undefined) {
        // Already judged dead, and nothing about the evidence has moved since.
        // Reading the same leftover file again is not new information.
        if (grave === identity) continue;
        this.buried.delete(draft.pid);
      }

      const alive = this.isAlive(draft.pid);
      if (alive) {
        this.unknownAtGate.delete(draft.pid);
      } else {
        const since = this.unknownAtGate.get(draft.pid);
        if (since === undefined) {
          this.unknownAtGate.set(draft.pid, this.gateCount);
        } else if (this.gateCount > since) {
          // It has survived a full gate interval as `unknown`. Drop it, and
          // remember which file the verdict was about so the next scan does not
          // hand it straight back.
          this.unknownAtGate.delete(draft.pid);
          this.buried.set(draft.pid, identity);
          continue;
        }
      }
      next.set(draft.pid, this.toSession(draft, alive, now));
    }

    for (const pid of [...this.unknownAtGate.keys()]) {
      if (!next.has(pid)) this.unknownAtGate.delete(pid);
    }
    // A grave with no file left behind it is nothing to remember: the leftover
    // was cleaned up, and a pid that comes back after that is a new session.
    for (const pid of [...this.buried.keys()]) {
      if (!drafts.has(pid)) this.buried.delete(pid);
    }

    this.publish(next);
  }

  private toSession(draft: Draft, alive: boolean, now: number): Session {
    const { file, agent } = draft;
    const previous = this.sessions.get(draft.pid);
    const sessionId = file?.sessionId ?? agent?.sessionId;
    const status = file?.status ?? 'unknown';
    return {
      id: sessionId ?? `pid-${draft.pid}`,
      provider: 'claude',
      pid: draft.pid,
      cwd: file?.cwd ?? agent?.cwd,
      kind: file?.kind ?? agent?.kind,
      name: file?.name ?? agent?.name,
      // The session file is written on every status transition, so it leads;
      // the command fills in only what the file never carries.
      status: status === 'unknown' ? (agent?.status ?? 'unknown') : status,
      waitingFor: agent?.waitingFor,
      startedAt: file?.startedAt ?? agent?.startedAt,
      lastWriteAt: file?.updatedAt,
      statusUpdatedAt: file?.statusUpdatedAt,
      version: file?.version,
      agents: [],
      state: alive ? 'alive' : 'unknown',
      source: sourceOf(draft),
      lastSeenAt: file !== undefined || agent !== undefined ? now : (previous?.lastSeenAt ?? now),
    };
  }

  private publish(next: Map<number, Session>): void {
    const added: Session[] = [];
    const updated: Session[] = [];
    const removed: Session[] = [];

    for (const [pid, session] of next) {
      const previous = this.sessions.get(pid);
      if (previous === undefined) added.push(session);
      else if (fingerprint(previous) !== fingerprint(session)) updated.push(session);
    }
    for (const [pid, session] of this.sessions) {
      if (!next.has(pid)) removed.push(session);
    }

    this.sessions = next;
    if (added.length === 0 && updated.length === 0 && removed.length === 0) return;
    this.emit('change', { added, updated, removed });
  }
}
