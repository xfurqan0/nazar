/**
 * N-WP17a: the near end of a remote canvas — `nazar --remote <alias>`.
 *
 * One child process per alias:
 *
 * ```
 * ssh -T -o BatchMode=yes -o ConnectTimeout=10 <alias> -- nazar --agent --hermes
 * ```
 *
 * and that command line is the whole security model. There is no port to open,
 * no token to store, no daemon to install and nothing to revoke afterwards:
 * **the connection is your ssh connection**, made with your keys, to a host you
 * already have in your own configuration, and it ends when this process ends.
 * If you can `ssh` to the machine, Nazar can read it; if you cannot, Nazar
 * cannot, and there is no second answer for it to find.
 *
 * Three flags, each of them load-bearing:
 *
 * - `-T` — no pty. The remote side writes newline-delimited JSON, and a pty
 *   would translate its newlines and echo what we write back at us.
 * - `-o BatchMode=yes` — never prompt. A password prompt inside a child process
 *   whose stdout is being parsed as JSON is a hang, not a login. Key-based auth
 *   or nothing, which is also why there is no password flag on this feature and
 *   never will be.
 * - `-o ConnectTimeout=10` — a host that is asleep fails in ten seconds and
 *   goes into the backoff, rather than holding a connection attempt open for
 *   the operating system's default two minutes.
 *
 * There is deliberately **no** `-p`, no `-i` and no `-l`. An alias is a name in
 * `~/.ssh/config`, and everything a connection needs — port, key, user, jump
 * host, agent forwarding — belongs in that file where the rest of the machine's
 * ssh already reads it. Nazar does not open that file either: it hands ssh a
 * name and lets ssh be the thing that knows what names mean.
 *
 * ## What arrives, and what happens when it stops
 *
 * The agent's `hello` names the build, the machine and its sources; every line
 * after it is the same snapshot the local SSE stream carries. Sessions are
 * re-keyed by alias on the way in — two machines can be running the same
 * session id, and a canvas that merged them would draw one card for two runs —
 * and each carries `host`, which is the `@alias` the card shows.
 *
 * When a connection drops, the cards **stay** and go quiet: `state: 'unknown'`,
 * which is the same verdict a local session gets when its process stops
 * answering, and `lastSeenAt` frozen at the last frame that arrived so the card
 * can say how long ago that was. Removing them would be worse — a laptop lid
 * closing would look like every remote agent finishing at once — and inventing
 * a live one would be worse still. Reconnection backs off from one second to a
 * minute, and a `hello` resets it.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { Agent, AgentNode, SessionEnded, SessionView, StateSnapshot } from '@nazar/core';

/** The command run on the far end when `--remote-cmd` does not say otherwise. */
export const DEFAULT_REMOTE_COMMAND = 'nazar --agent --hermes';

/** ssh options every connection gets, and the reasoning is in the module note. */
export const SSH_ARGS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
] as const;

/** First reconnection delay. Doubles up to {@link MAX_BACKOFF_MS}. */
export const MIN_BACKOFF_MS = 1000;

/** Longest a dropped host waits between attempts. */
export const MAX_BACKOFF_MS = 60_000;

/** How long a connected child has to say `hello` before it is called `unknown`. */
export const HELLO_TIMEOUT_MS = 30_000;

/** Longest single line the parser will buffer before it gives up on a stream. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * A name Nazar will hand to `ssh`.
 *
 * Deliberately narrow: no `@`, so `user@host` cannot smuggle a login; no space,
 * so a flag cannot ride along; no `/`, `.` at the head or `-` at the head, so
 * nothing that looks like a path or an option gets through. What is left is an
 * alias — the thing that appears after `Host` in an ssh configuration — which
 * is the only kind of name this feature accepts.
 */
export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isAlias(value: string): boolean {
  return ALIAS_PATTERN.test(value);
}

/**
 * Split a `--remote` value. Commas, because a shell splits on spaces and the
 * flag has to survive being written once in a `.desktop` entry or a config file.
 * Empty entries are dropped rather than reported: `--remote a,,b` is two hosts.
 */
export function parseAliases(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const alias = raw.trim();
    if (alias.length === 0 || seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
  }
  return out;
}

/** What one alias is doing right now. */
export type RemoteState = 'connecting' | 'up' | 'unknown';

/** One source the far end reported in its `hello`. */
export interface RemoteSource {
  readonly name: string;
  readonly state: 'ok' | 'unknown';
  readonly detail?: string;
}

/** Everything the local side knows about one alias. */
export interface RemoteStatus {
  readonly alias: string;
  readonly state: RemoteState;
  /** The command being run on the far end. */
  readonly command: string;
  /** Version the far end reported. Absent until `hello`. */
  readonly version?: string;
  /** What the far end calls itself. Absent until `hello`. */
  readonly hostname?: string;
  readonly sources: readonly RemoteSource[];
  /** Sessions in the last frame that arrived. */
  readonly sessions: number;
  /** When the last frame arrived. Absent when none ever has. */
  readonly lastSeenAt?: number;
  /** Why it is `unknown`: an ssh message, an exit code, a parse failure. */
  readonly error?: string;
  /** Attempts made since the last `hello`. */
  readonly attempts: number;
}

export interface RemoteHostsEvents {
  change: [readonly RemoteStatus[]];
  /**
   * N-WP16 arriving off another machine: one remote session has ended.
   *
   * Re-emitted rather than derived. A session leaving the far end's snapshot is
   * not evidence it ended — a dropped connection empties every host at once and
   * none of those sessions finished — so this fires only when the far end says
   * so on its own stream.
   */
  'session-ended': [SessionEnded];
}

/** Spawns the child. Injected by tests so no ssh is ever run. */
export type RemoteSpawn = (
  alias: string,
  command: string,
) => ChildProcessWithoutNullStreams;

export interface RemoteHostsOptions {
  readonly aliases: readonly string[];
  /** What to run on the far end. Default {@link DEFAULT_REMOTE_COMMAND}. */
  readonly command?: string;
  readonly spawn?: RemoteSpawn;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly helloTimeoutMs?: number;
  readonly now?: () => number;
  /** Where a connection failure is reported. `process.stderr` in production. */
  readonly err?: { write(chunk: string): unknown };
}

/** The default spawn: ssh, with the five arguments the module note explains. */
export function sshSpawn(alias: string, command: string): ChildProcessWithoutNullStreams {
  return spawn('ssh', [...SSH_ARGS, alias, '--', command], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

/* ------------------------------------------------------------------ *
 * Re-keying a remote snapshot
 * ------------------------------------------------------------------ */

/** `<alias>:<id>`, so two machines running the same id are two cards. */
export function remoteId(alias: string, id: string): string {
  return `${alias}:${id}`;
}

function remoteAgent(agent: Agent, alias: string): Agent {
  const out: { -readonly [K in keyof Agent]: Agent[K] } = {
    ...agent,
    id: remoteId(alias, agent.id),
    sessionId: remoteId(alias, agent.sessionId),
  };
  if (agent.parentAgentId !== undefined) {
    out.parentAgentId = remoteId(alias, agent.parentAgentId);
  }
  return out;
}

function remoteNode(node: AgentNode, alias: string): AgentNode {
  return {
    agent: remoteAgent(node.agent, alias),
    children: node.children.map((child) => remoteNode(child, alias)),
  };
}

/**
 * One remote session, as this machine will draw it.
 *
 * Three changes and no others: the ids are namespaced, `host` is set, and `pid`
 * is cleared. That last one matters — a remote session's pid is a number on
 * *another* machine, and leaving it on the card would let a double-click raise
 * whatever local process happens to be wearing it today.
 */
export function withHost(session: SessionView, alias: string): SessionView {
  return {
    ...session,
    id: remoteId(alias, session.id),
    host: alias,
    pid: 0,
    agents: session.agents.map((agent) => remoteAgent(agent, alias)),
    roots: session.roots.map((node) => remoteNode(node, alias)),
  };
}

/** The same session, gone quiet: the connection behind it dropped. */
export function faded(session: SessionView): SessionView {
  return { ...session, state: 'unknown', status: 'unknown' };
}

/* ------------------------------------------------------------------ *
 * The line parser
 * ------------------------------------------------------------------ */

/**
 * Newline-delimited JSON, with a cap.
 *
 * A stream is somebody else's output, so a line that never ends is a real
 * possibility and an unbounded buffer is how a monitoring tool becomes the
 * thing that fell over. Past {@link MAX_LINE_BYTES} the parser gives up on the
 * stream and says so; the connection is then torn down and retried like any
 * other failure.
 */
export class LineReader {
  private buffer = '';

  overflowed = false;

  /** Feed a chunk, get the complete lines it finished. */
  push(chunk: string): string[] {
    if (this.overflowed) return [];
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.overflowed = true;
      this.buffer = '';
      return [];
    }
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

interface Tracked {
  readonly alias: string;
  child?: ChildProcessWithoutNullStreams;
  reader: LineReader;
  state: RemoteState;
  version?: string;
  hostname?: string;
  sources: RemoteSource[];
  sessions: SessionView[];
  lastSeenAt?: number;
  error?: string;
  attempts: number;
  backoffMs: number;
  retry?: NodeJS.Timeout;
  hello?: NodeJS.Timeout;
}

/**
 * Every remote alias, and the sessions they are reporting.
 *
 * It owns the child processes and nothing else: what to do with the sessions is
 * the composite state's business, and what to say about a failure is doctor's.
 */
export class RemoteHosts extends EventEmitter<RemoteHostsEvents> {
  readonly command: string;

  private readonly hosts = new Map<string, Tracked>();

  private readonly spawnChild: RemoteSpawn;

  private readonly minBackoffMs: number;

  private readonly maxBackoffMs: number;

  private readonly helloTimeoutMs: number;

  private readonly now: () => number;

  private readonly err: { write(chunk: string): unknown } | undefined;

  private started = false;

  constructor(options: RemoteHostsOptions) {
    super();
    this.command = options.command ?? DEFAULT_REMOTE_COMMAND;
    this.spawnChild = options.spawn ?? sshSpawn;
    this.minBackoffMs = options.minBackoffMs ?? MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.err = options.err;
    for (const alias of options.aliases) {
      this.hosts.set(alias, {
        alias,
        reader: new LineReader(),
        state: 'connecting',
        sources: [],
        sessions: [],
        attempts: 0,
        backoffMs: this.minBackoffMs,
      });
    }
  }

  /** Every alias, in the order they were given. */
  status(): readonly RemoteStatus[] {
    return [...this.hosts.values()].map((host) => {
      const out: { -readonly [K in keyof RemoteStatus]: RemoteStatus[K] } = {
        alias: host.alias,
        state: host.state,
        command: this.command,
        sources: host.sources,
        sessions: host.sessions.length,
        attempts: host.attempts,
      };
      if (host.version !== undefined) out.version = host.version;
      if (host.hostname !== undefined) out.hostname = host.hostname;
      if (host.lastSeenAt !== undefined) out.lastSeenAt = host.lastSeenAt;
      if (host.error !== undefined) out.error = host.error;
      return out;
    });
  }

  /** Every remote session, faded when the connection behind it is down. */
  sessions(): readonly SessionView[] {
    const out: SessionView[] = [];
    for (const host of this.hosts.values()) {
      const live = host.state === 'up';
      for (const session of host.sessions) out.push(live ? session : faded(session));
    }
    return out;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const host of this.hosts.values()) this.connect(host);
  }

  stop(): void {
    this.started = false;
    for (const host of this.hosts.values()) {
      if (host.retry !== undefined) clearTimeout(host.retry);
      if (host.hello !== undefined) clearTimeout(host.hello);
      host.retry = undefined;
      host.hello = undefined;
      host.child?.kill();
      host.child = undefined;
    }
  }

  private connect(host: Tracked): void {
    if (!this.started) return;
    host.attempts += 1;
    host.reader = new LineReader();
    host.state = host.lastSeenAt === undefined ? 'connecting' : host.state;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild(host.alias, this.command);
    } catch (error) {
      this.fail(host, error instanceof Error ? error.message : String(error));
      return;
    }
    host.child = child;

    // A `hello` that never comes is the interesting failure: ssh connected, the
    // remote shell ran something, and whatever it was is not a Nazar agent.
    host.hello = setTimeout(() => {
      host.hello = undefined;
      if (host.state === 'up') return;
      host.state = 'unknown';
      host.error = `no hello in ${Math.round(this.helloTimeoutMs / 1000)}s (is "${this.command}" on the remote PATH?)`;
      this.emit('change', this.status());
    }, this.helloTimeoutMs);
    host.hello.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of host.reader.push(chunk)) this.line(host, line);
      if (host.reader.overflowed) {
        this.fail(host, 'a line longer than 8 MB arrived; the stream is not an agent');
        child.kill();
      }
    });

    /*
     * The far end's stderr is its own diagnostics *and* ssh's — "Permission
     * denied", "Could not resolve hostname", "Host key verification failed".
     * The last line of it is what doctor reports, because it is the sentence
     * that actually says why nothing is arriving.
     */
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = String(chunk).trim().split('\n').pop();
      if (line !== undefined && line.length > 0) {
        host.error = line.slice(0, 200);
        this.err?.write(`nazar: ${host.alias}: ${host.error}\n`);
      }
    });

    child.on('error', (error: Error) => this.fail(host, error.message));
    child.on('close', (code, signal) => {
      if (host.child !== child) return;
      host.child = undefined;
      this.fail(
        host,
        host.error ??
          (signal !== null ? `ssh ended on ${signal}` : `ssh exited with code ${code ?? 0}`),
      );
    });
  }

  /** A line off the far end's stdout. Anything unparseable is dropped. */
  private line(host: Tracked, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // Not fatal on its own: a login banner that slipped past `-T` is one bad
      // line followed by good ones, and the `hello` timeout is what catches a
      // stream that is not an agent at all.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as Record<string, unknown>;

    if (message['type'] === 'hello') {
      if (host.hello !== undefined) clearTimeout(host.hello);
      host.hello = undefined;
      host.state = 'up';
      host.attempts = 0;
      host.backoffMs = this.minBackoffMs;
      delete host.error;
      const version = message['version'];
      if (typeof version === 'string') host.version = version.slice(0, 40);
      const hostname = message['host'];
      if (typeof hostname === 'string') host.hostname = hostname.slice(0, 80);
      host.sources = Array.isArray(message['sources'])
        ? (message['sources'] as unknown[]).flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];
            const source = entry as Record<string, unknown>;
            const name = source['name'];
            if (typeof name !== 'string') return [];
            const detail = source['detail'];
            return [
              {
                name: name.slice(0, 60),
                state: source['state'] === 'unknown' ? ('unknown' as const) : ('ok' as const),
                ...(typeof detail === 'string' ? { detail: detail.slice(0, 120) } : {}),
              },
            ];
          })
        : [];
      this.emit('change', this.status());
      return;
    }

    /*
     * N-WP16 over the wire.
     *
     * Re-keyed by alias exactly as a session is, because the id it names is the
     * id on a card this canvas already drew: the sound rules match an ending to
     * a card by id, so an un-namespaced one would either match nothing or —
     * worse — match a local session that happens to share the far end's uuid.
     * `host` rides along so anything downstream can tell where it happened
     * without re-deriving it from the id.
     */
    if (message['type'] === 'session-ended') {
      const id = message['id'];
      if (typeof id !== 'string' || id.length === 0) return;
      const at = message['at'];
      const ended: { -readonly [K in keyof SessionEnded]: SessionEnded[K] } = {
        id: remoteId(host.alias, id),
        at: typeof at === 'number' && Number.isFinite(at) ? at : this.now(),
        host: host.alias,
      };
      const name = message['name'];
      if (typeof name === 'string') ended.name = name.slice(0, 200);
      const cwd = message['cwd'];
      if (typeof cwd === 'string') ended.cwd = cwd.slice(0, 200);
      this.emit('session-ended', ended);
      return;
    }

    if (message['type'] !== 'state') return;
    const state = message['state'];
    if (typeof state !== 'object' || state === null) return;
    const sessions = (state as StateSnapshot).sessions;
    if (!Array.isArray(sessions)) return;

    host.sessions = sessions.map((session) => withHost(session, host.alias));
    host.lastSeenAt = this.now();
    // A frame arriving is the strongest possible evidence the far end is up,
    // whatever the last stderr line said.
    host.state = 'up';
    delete host.error;
    this.emit('change', this.status());
  }

  /** The connection is down. Fade the cards, back off, try again. */
  private fail(host: Tracked, reason: string): void {
    if (host.hello !== undefined) clearTimeout(host.hello);
    host.hello = undefined;
    host.state = 'unknown';
    host.error = reason.slice(0, 200);
    this.emit('change', this.status());
    if (!this.started || host.retry !== undefined) return;
    const delay = host.backoffMs;
    host.backoffMs = Math.min(this.maxBackoffMs, host.backoffMs * 2);
    host.retry = setTimeout(() => {
      host.retry = undefined;
      this.connect(host);
    }, delay);
    host.retry.unref?.();
  }
}

/* ------------------------------------------------------------------ *
 * The composite the server is handed
 * ------------------------------------------------------------------ */

/** The part of `NazarState` the composite needs. Structural, like `StateSource`. */
export interface LocalState {
  snapshot(): StateSnapshot;
  on(event: 'change', listener: (snapshot: StateSnapshot) => void): unknown;
  on(event: 'session-ended', listener: (ended: SessionEnded) => void): unknown;
  off(event: 'change', listener: (snapshot: StateSnapshot) => void): unknown;
}

/**
 * The local machine's snapshot with every remote session appended.
 *
 * `empty` is dropped whenever a remote session is present, for the same reason
 * the agent drops it: "nothing is running on this machine" is not a thing to
 * say on a canvas with four cards on it. Everything else on the snapshot —
 * `commandAvailable`, `warnings`, the quota strip — stays the local machine's,
 * because those are facts about the machine the browser is on.
 */
export function mergeRemote(
  base: StateSnapshot,
  remote: readonly SessionView[],
): StateSnapshot {
  if (remote.length === 0) return base;
  const merged: { -readonly [K in keyof StateSnapshot]: StateSnapshot[K] } = {
    ...base,
    sessions: [...base.sessions, ...remote],
  };
  delete merged.empty;
  return merged;
}

/**
 * A `StateSource` that is the local one plus the remote ones — and, since
 * N-WP16 reached this package, an `EndingsSource` that is both as well.
 *
 * It re-emits on either half changing, and it holds no state of its own beyond
 * the last merged snapshot — so a browser reconnecting mid-drop gets the same
 * answer as one that never disconnected, which is the property the whole
 * whole-snapshot design rests on.
 *
 * The endings pass straight through, local and remote alike. That is the point:
 * `http.ts` takes one `EndingsSource`, so a session ending on a build server
 * reaches the browser as the same `event: session-ended` a local one does, and
 * the sound rules never learn there were two kinds.
 */
export class CompositeState extends EventEmitter<{
  change: [StateSnapshot];
  'session-ended': [SessionEnded];
}> {
  private readonly local: LocalState;

  private readonly remotes: RemoteHosts;

  private current: StateSnapshot;

  constructor(local: LocalState, remotes: RemoteHosts) {
    super();
    this.local = local;
    this.remotes = remotes;
    this.current = mergeRemote(local.snapshot(), remotes.sessions());
    const republish = (): void => {
      this.current = mergeRemote(this.local.snapshot(), this.remotes.sessions());
      this.emit('change', this.current);
    };
    local.on('change', republish);
    remotes.on('change', republish);
    const ended = (one: SessionEnded): void => {
      this.emit('session-ended', one);
    };
    local.on('session-ended', ended);
    remotes.on('session-ended', ended);
  }

  snapshot(): StateSnapshot {
    return this.current;
  }
}
