/**
 * N-WP17a: `nazar --agent` — the far end of a remote canvas.
 *
 * A machine you ssh into is a machine whose agents you cannot see. The obvious
 * answers are all wrong for this program: a daemon on the remote host is
 * something to install, secure and forget about; a port is a thing to firewall;
 * a token is a secret to store. So the remote side of Nazar is a **process that
 * writes lines to stdout and dies when the pipe closes**, and the transport is
 * the ssh connection you already have. There is no listener, no port, no token
 * and nothing left running when you disconnect.
 *
 * ## The wire
 *
 * Newline-delimited JSON, one object per line, and the shape is the one the
 * browser already speaks:
 *
 * ```
 * {"type":"hello","version":"0.1.0","host":"<hostname>","sources":[…],"capabilities":{…}}
 * {"type":"state","state":{ … exactly the /api/events payload … }}
 * {"type":"session-ended","id":"…","at":1788000000000}
 * ```
 *
 * The `state` payload is {@link toWireState}'s output, byte for byte — the same
 * function the SSE stream uses, called with the same options — and the ending is
 * {@link toWireSessionEnded}'s, which is what the SSE stream puts behind
 * `event: session-ended`. That is the whole design decision of this file: **the
 * local side learns no second schema.** A field added to a card reaches a remote
 * card on the same commit, and a field dropped from the wire is dropped from
 * both. If this file built its own payload the two would drift, and the drift
 * would show up as a remote card missing a number nobody could explain.
 *
 * `hello` is the one line that is not a snapshot, and it carries only what the
 * local side cannot work out for itself: which build is answering, what the
 * remote machine calls itself, which sources were found there, and which
 * capabilities are on. It is sent once, first, before any state.
 *
 * ## What is on stdout, and what is not
 *
 * stdout is the stream and nothing else — no banner, no URL, no "watching 3
 * sessions". Every one of those goes to stderr, where ssh already puts it in
 * front of the person who typed the command. A single stray line on stdout
 * would be a parse error at the other end, so `--agent` never prints the lines
 * `serve()` prints and the framing test asserts exactly that.
 *
 * ## Task text
 *
 * Opt-in and off by default, which is the *opposite* of the local server's
 * default and deliberately so. `nazar` on your own machine defaults to "the
 * browser decides", because the reader and the browser are on the same machine
 * as the person. An agent is text leaving a machine over a network to a screen
 * that may be shared, so the flag has to be typed: without `--task-text` the
 * remote reader is constructed with task text off and there is no prose in the
 * remote process at all. `NAZAR_TASK_TEXT=0` still overrides in the same hard
 * direction it always does.
 */
import os from 'node:os';

import type { HermesScan, SessionEnded, StateSnapshot } from '@nazar/core';
import { HermesReader, NazarState } from '@nazar/core';

import type { WireOptions } from './snapshot.js';
import { toWireSessionEnded, toWireState } from './snapshot.js';
import { VERSION } from './version.js';

/** Every line the agent writes carries one of these. */
export type AgentLineType = 'hello' | 'state' | 'session-ended';

/** One source the remote machine offered, as the `hello` line describes it. */
export interface AgentSource {
  /** `claude`, or `hermes:<profile>`. */
  readonly name: string;
  /** `ok` when it was read, `unknown` when it could not be. */
  readonly state: 'ok' | 'unknown';
  /** Why it is `unknown`. Short, and never a row of anybody's data. */
  readonly detail?: string;
}

/** What the far end can do, so the near end never has to guess. */
export interface AgentCapabilities {
  /** Whether the Claude Code registry and transcript readers are running. */
  readonly claude: boolean;
  /** Whether the Codex rollout reader is running (N-WP18). */
  readonly codex: boolean;
  /** Whether the Hermes reader is running. */
  readonly hermes: boolean;
  /** Whether this process may read task text at all. Off unless asked. */
  readonly taskText: boolean;
  /**
   * Always `false`. A remote card cannot be jumped to: the process it names is
   * on the other machine. Said out loud rather than left to be inferred.
   */
  readonly jump: false;
}

/** The first line, and the only one that is not a snapshot. */
export interface AgentHello {
  readonly type: 'hello';
  readonly version: string;
  readonly host: string;
  readonly sources: readonly AgentSource[];
  readonly capabilities: AgentCapabilities;
}

/** Every other line: the canvas payload, unchanged. */
export interface AgentState {
  readonly type: 'state';
  readonly state: StateSnapshot;
}

/**
 * N-WP16 over the wire: one session on the far end has ended.
 *
 * The same object the local SSE stream puts behind `event: session-ended`, for
 * the reason a state frame is `toWireState`'s own output — `toWireSessionEnded`
 * builds both, so the near end parses one shape and the sound rules cannot
 * learn to treat a remote ending as a different kind of event.
 *
 * It is a *frame* rather than something derived from two snapshots on the near
 * end, because "gone from the last snapshot" is not the same fact: a dropped
 * connection makes every remote card disappear from the far end's last frame
 * and none of those sessions ended. Only the machine the session was on knows,
 * and this is it saying so.
 */
export type AgentSessionEnded = SessionEnded & { readonly type: 'session-ended' };

export type AgentLine = AgentHello | AgentState | AgentSessionEnded;

export interface AgentOptions {
  /** Read Claude Code's registry and transcripts. On unless `--no-claude`. */
  readonly claude?: boolean;
  /**
   * Read Codex rollouts (N-WP18). On unless `--no-codex`.
   *
   * `--no-claude` takes this with it whatever it says: the Codex reader lives
   * inside `NazarState`, and with no local join constructed there is nothing
   * for it to hang off. `hello` reports what actually ran rather than what was
   * asked for, so the near end is never told about a reader that is not there.
   */
  readonly codex?: boolean;
  /** Read Hermes's `state.db` files. Off unless `--hermes`. */
  readonly hermes?: boolean;
  /** N-WP15a: may this process read task text at all. Off unless `--task-text`. */
  readonly taskText?: boolean;
  /** Where the stream goes. `process.stdout` in production, a buffer in tests. */
  readonly out: { write(chunk: string): unknown };
  /** Where everything else goes. Never the stream. */
  readonly err: { write(chunk: string): unknown };
  /** Name reported in `hello`. Defaults to this machine's hostname. */
  readonly hostname?: string;
  /** Injected by tests so no watcher touches the real machine. */
  readonly state?: NazarState | null;
  /** Injected by tests so no reader touches a real Hermes installation. */
  readonly reader?: HermesReader | null;
  /** Shortest gap between two published lines. Default 250 ms. */
  readonly throttleMs?: number;
  /**
   * Wire this process's own lifecycle to the stream: stdin closing and the two
   * termination signals both shut it down. On by default, because that is the
   * whole of how a remote agent knows the other end went away.
   *
   * A test passes `false`, and has to: resuming stdin keeps the event loop
   * alive, so a suite that ran the real thing would never exit. The framing —
   * which is what these tests are about — is identical either way.
   */
  readonly attach?: boolean;
}

export interface AgentHandle {
  /** Resolves when the stream has been shut down. */
  readonly done: Promise<void>;
  /** Stop the readers and end the stream. Idempotent. */
  stop(): Promise<void>;
}

/**
 * How long the agent waits after publishing before it publishes again.
 *
 * The readers underneath already coalesce, but they coalesce independently:
 * a Claude change and a Hermes poll landing 40 ms apart are two snapshots that
 * differ in nothing a person could see, and over ssh each of them is a packet.
 * A quarter of a second is well inside the two-second poll everything here is
 * built on, and it means a busy machine costs one line per quarter second
 * rather than one per event.
 */
export const DEFAULT_AGENT_THROTTLE_MS = 250;

/** One line of the wire, serialised. Exported so the framing test can use it. */
export function encodeLine(line: AgentLine): string {
  return `${JSON.stringify(line)}\n`;
}

/**
 * Merge the local snapshot with whatever Hermes had.
 *
 * The Claude snapshot is authoritative for everything that is not a session —
 * `commandAvailable`, `warnings`, the quota strip — because Hermes has nothing
 * to say about any of them. `empty` is recomputed rather than passed through:
 * a machine with no Claude session and three Hermes ones is not an empty
 * canvas, and shipping the local `empty` would make it claim to be one.
 */
export function mergeSnapshot(base: StateSnapshot, hermes: HermesScan | undefined): StateSnapshot {
  if (hermes === undefined || hermes.sessions.length === 0) return base;
  const merged: { -readonly [K in keyof StateSnapshot]: StateSnapshot[K] } = {
    ...base,
    sessions: [...base.sessions, ...hermes.sessions],
  };
  delete merged.empty;
  return merged;
}

/** The empty state a `--no-claude` agent publishes between Hermes passes. */
function emptyState(now: number): StateSnapshot {
  return { generatedAt: now, sessions: [], commandAvailable: false, warnings: 0 };
}

function sourcesOf(claude: NazarState | undefined, hermes: HermesScan | undefined): AgentSource[] {
  const sources: AgentSource[] = [];
  if (claude !== undefined) {
    const ok = claude.snapshot().commandAvailable;
    sources.push({
      name: 'claude',
      state: 'ok',
      // Not a failure: the registry works off the session files alone when
      // `claude agents --json` is not on the remote PATH, and the local side is
      // better told which of the two it is looking at.
      detail: ok ? 'registry and transcripts' : 'session files only (no claude on PATH)',
    });
    // N-WP18. Reported off the reader that exists rather than off the flag that
    // asked for it: a machine with no `~/.codex/sessions` builds a reader that
    // finds nothing, and saying so is more use than saying nothing.
    const codex = claude.codex;
    if (codex !== undefined) {
      const threads = codex.snapshot().length;
      sources.push({
        name: 'codex',
        state: 'ok',
        detail: `${threads} thread${threads === 1 ? '' : 's'}`,
      });
    }
  }
  if (hermes !== undefined) {
    if (!hermes.available) {
      sources.push({
        name: 'hermes',
        state: 'unknown',
        ...(hermes.reason === undefined ? {} : { detail: hermes.reason }),
      });
    } else if (hermes.sources.length === 0) {
      sources.push({ name: 'hermes', state: 'ok', detail: 'no state.db found' });
    } else {
      for (const source of hermes.sources) {
        sources.push({
          name: `hermes:${source.profile}`,
          state: source.state,
          detail:
            source.state === 'ok'
              ? `${source.sessions} sessions, ${source.running} running`
              : (source.error ?? 'unreadable'),
        });
      }
    }
  }
  return sources;
}

/**
 * Run the agent. Resolves once the first line is on the stream; the returned
 * handle's `done` resolves when the stream ends.
 *
 * The process is ended by the two things a remote command can be ended by: the
 * pipe closing — which is what `ssh` does the moment the local side goes away —
 * and `SIGTERM`. Both go through the same shutdown, so a half-written line is
 * never followed by a second half after the readers have stopped.
 */
export async function runAgent(options: AgentOptions): Promise<AgentHandle> {
  const wantClaude = options.claude !== false;
  const wantCodex = options.codex !== false;
  const wantHermes = options.hermes === true;
  const taskText = options.taskText === true;
  const throttleMs = options.throttleMs ?? DEFAULT_AGENT_THROTTLE_MS;
  const wire: WireOptions | undefined = taskText ? { task: true } : undefined;

  const state =
    options.state === null
      ? undefined
      : (options.state ??
        (wantClaude
          ? new NazarState({
              treeOptions: { taskText },
              // The serve path's shape, and `--no-codex` means the same thing
              // here: with no reader constructed there is no poll, no watch and
              // no rollout opened on this run.
              ...(wantCodex ? { codexOptions: { taskText } } : { codex: null }),
            })
          : undefined));
  const reader =
    options.reader === null
      ? undefined
      : (options.reader ?? (wantHermes ? new HermesReader({ taskText }) : undefined));

  await Promise.all([state?.start() ?? Promise.resolve(), reader?.start() ?? Promise.resolve()]);

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const publish = (): void => {
    if (stopped) return;
    const base = state?.snapshot() ?? emptyState(Date.now());
    const snapshot = mergeSnapshot(base, reader?.snapshot());
    options.out.write(encodeLine({ type: 'state', state: toWireState(snapshot, wire) }));
  };

  /** Publish now, then hold the floor for `throttleMs`. */
  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) {
      pending = true;
      return;
    }
    publish();
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) {
        pending = false;
        schedule();
      }
    }, throttleMs);
    timer.unref?.();
  };

  // `hello` first, always, and before any listener can fire.
  options.out.write(
    encodeLine({
      type: 'hello',
      version: VERSION,
      host: options.hostname ?? os.hostname(),
      sources: sourcesOf(state, reader?.snapshot()),
      capabilities: {
        claude: state !== undefined,
        codex: state?.codex !== undefined,
        hermes: reader !== undefined,
        taskText,
        jump: false,
      },
    }),
  );
  publish();

  state?.on('change', schedule);
  reader?.on('change', schedule);

  /*
   * N-WP16 over the wire, and it is deliberately not throttled.
   *
   * A state frame is a whole snapshot, so dropping one costs nothing — the next
   * one carries everything. An ending is a *single event*, emitted once by the
   * registry at the moment it stops holding a session, and a throttle that
   * coalesced two of them would silently swallow one sound. There is one line
   * per ended session and a machine cannot end many at once.
   */
  state?.on('session-ended', (ended) => {
    if (stopped) return;
    options.out.write(encodeLine(toWireSessionEnded(ended, wire)));
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    state?.stop();
    reader?.stop();
    resolveDone();
  };

  // stdin closing is the signal that the other end went away: ssh closes the
  // pipe, and a process that kept polling a database after that is a process
  // nobody asked for and nobody can see.
  if (options.attach !== false) {
    if (process.stdin.readable) {
      process.stdin.resume();
      process.stdin.on('end', () => void stop());
      process.stdin.on('close', () => void stop());
      process.stdin.on('error', () => void stop());
    }
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
  }

  options.err.write(
    `nazar ${VERSION} --agent on ${options.hostname ?? os.hostname()}: ` +
      `${state === undefined ? 'no claude' : 'claude'}, ` +
      `${state?.codex === undefined ? 'no codex' : 'codex'}, ` +
      `${reader === undefined ? 'no hermes' : 'hermes'}, ` +
      `task text ${taskText ? 'on' : 'off'}\n`,
  );

  return { done, stop };
}
