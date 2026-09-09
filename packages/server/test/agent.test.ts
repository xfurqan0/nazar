/**
 * N-WP17a: what `nazar --agent` writes, and what it must never write.
 *
 * The framing is the contract. A local Nazar parses this stream line by line,
 * so a single stray line on stdout — a banner, a URL, a "watching 3 sessions" —
 * is a parse error on the other machine, and the failure mode is a canvas that
 * silently shows nothing. Every assertion below is about that: `hello` first,
 * `state` after it, one JSON object per line, and **nothing else on stdout at
 * all**.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { HermesScan, SessionEnded, StateSnapshot } from '@nazar/core';

import { encodeLine, mergeSnapshot, runAgent } from '../src/agent.ts';
import { VERSION } from '../src/version.ts';

const NOW = 1_788_000_000_000;

/** A stream that keeps what was written to it. */
function buffer(): { write(chunk: string): void; text(): string; lines(): string[] } {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0),
  };
}

/**
 * A `NazarState` double: one snapshot, listeners by event, no watcher anywhere.
 *
 * Keyed by event name rather than pooled into one array, because this state
 * emits two of them — `change` and `session-ended` — and a pool would call an
 * ending handler with a snapshot's arguments the first time a card moved.
 */
function fakeState(sessions: StateSnapshot['sessions'] = []): {
  snapshot(): StateSnapshot;
  start(): Promise<void>;
  on(event: 'change' | 'session-ended', listener: (...args: never[]) => void): void;
  off(event: 'change' | 'session-ended', listener: (...args: never[]) => void): void;
  stop(): void;
  fire(): void;
  end(ended: SessionEnded): void;
} {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const of = (event: string): Array<(...args: never[]) => void> => {
    const found = listeners.get(event) ?? [];
    listeners.set(event, found);
    return found;
  };
  return {
    snapshot: () => ({ generatedAt: NOW, sessions, commandAvailable: true, warnings: 0 }),
    start: async () => undefined,
    on: (event, listener) => {
      of(event).push(listener);
    },
    off: () => undefined,
    stop: () => undefined,
    fire: () => {
      for (const listener of [...of('change')]) (listener as () => void)();
    },
    end: (ended) => {
      for (const listener of [...of('session-ended')]) {
        (listener as (one: SessionEnded) => void)(ended);
      }
    },
  };
}

/** A `HermesReader` double with one card on it. */
function fakeReader(scan: HermesScan): {
  snapshot(): HermesScan;
  start(): Promise<void>;
  stop(): void;
  on(event: 'change', listener: () => void): void;
} {
  return {
    snapshot: () => scan,
    start: async () => undefined,
    stop: () => undefined,
    on: () => undefined,
  };
}

const HERMES_CARD = {
  id: 'hermes:default:one',
  provider: 'hermes' as const,
  pid: 0,
  status: 'idle' as const,
  state: 'alive' as const,
  source: 'files' as const,
  lastSeenAt: NOW,
  agents: [],
  roots: [],
  orphans: [],
  treeRead: true,
  task: 'rewrite the importer',
};

const HERMES_SCAN: HermesScan = {
  generatedAt: NOW,
  available: true,
  sources: [{ profile: 'default', file: '/h/state.db', state: 'ok', sessions: 4, running: 1 }],
  sessions: [HERMES_CARD],
};

/** Run one agent over buffers and shut it down. */
async function run(options: {
  hermes?: HermesScan;
  taskText?: boolean;
  sessions?: StateSnapshot['sessions'];
  claude?: boolean;
}): Promise<{ out: ReturnType<typeof buffer>; err: ReturnType<typeof buffer> }> {
  const out = buffer();
  const err = buffer();
  const state = options.claude === false ? null : fakeState(options.sessions ?? []);
  const handle = await runAgent({
    out,
    err,
    hostname: 'box',
    // The suite drives the framing, not the process lifecycle: resuming stdin
    // would keep the event loop alive and the test runner would never exit.
    attach: false,
    ...(options.taskText === undefined ? {} : { taskText: options.taskText }),
    state: state as never,
    reader: (options.hermes === undefined ? null : fakeReader(options.hermes)) as never,
  });
  await handle.stop();
  return { out, err };
}

test('the first line is hello, and it names the build, the machine and the sources', async () => {
  const { out } = await run({ hermes: HERMES_SCAN });
  const hello = JSON.parse(out.lines()[0] as string) as Record<string, unknown>;
  assert.equal(hello['type'], 'hello');
  assert.equal(hello['version'], VERSION);
  assert.equal(hello['host'], 'box');
  assert.deepEqual(hello['capabilities'], {
    claude: true,
    // The injected state is a double with no Codex reader on it, and `hello`
    // reports the reader that exists rather than the flag that asked for one.
    codex: false,
    hermes: true,
    taskText: false,
    // Said out loud rather than left to be inferred: the process a remote card
    // names is on the other machine.
    jump: false,
  });
  const sources = hello['sources'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    sources.map((source) => source['name']),
    ['claude', 'hermes:default'],
  );
});

test('every line after it is a state frame, and stdout carries nothing else', async () => {
  const { out } = await run({ hermes: HERMES_SCAN });
  const lines = out.lines();
  assert.ok(lines.length >= 2);
  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed['type'], index === 0 ? 'hello' : 'state');
  }
  // The strongest form of the claim: the whole of stdout is those objects and
  // the newlines between them.
  assert.equal(out.text(), lines.map((line) => `${line}\n`).join(''));
});

test('the banner goes to stderr, where ssh already shows it to a person', async () => {
  const { out, err } = await run({ hermes: HERMES_SCAN });
  assert.match(err.text(), /--agent on box/);
  assert.ok(!out.text().includes('--agent on box'));
  assert.ok(!out.text().includes('canvas:'), 'no URL: an agent binds nothing');
});

test('the state frame carries the Hermes cards beside the local ones', async () => {
  const { out } = await run({ hermes: HERMES_SCAN });
  const frame = JSON.parse(out.lines()[1] as string) as { state: StateSnapshot };
  assert.deepEqual(
    frame.state.sessions.map((session) => session.id),
    ['hermes:default:one'],
  );
  assert.equal(frame.state.sessions[0]?.provider, 'hermes');
});

test('with task text off — the default — no line carries a task', async () => {
  const { out } = await run({ hermes: HERMES_SCAN });
  assert.ok(!out.text().includes('rewrite the importer'));
  const frame = JSON.parse(out.lines()[1] as string) as { state: StateSnapshot };
  assert.ok(!Object.hasOwn(frame.state.sessions[0] as object, 'task'));
  const hello = JSON.parse(out.lines()[0] as string) as { capabilities: { taskText: boolean } };
  assert.equal(hello.capabilities.taskText, false);
});

test('with task text on, it crosses — and hello says so', async () => {
  const { out } = await run({ hermes: HERMES_SCAN, taskText: true });
  const frame = JSON.parse(out.lines()[1] as string) as { state: StateSnapshot };
  assert.equal(frame.state.sessions[0]?.task, 'rewrite the importer');
  const hello = JSON.parse(out.lines()[0] as string) as { capabilities: { taskText: boolean } };
  assert.equal(hello.capabilities.taskText, true);
});

test('--no-claude is a capability of false and a source that is not listed', async () => {
  const { out } = await run({ claude: false, hermes: HERMES_SCAN });
  const hello = JSON.parse(out.lines()[0] as string) as {
    capabilities: { claude: boolean };
    sources: Array<{ name: string }>;
  };
  assert.equal(hello.capabilities.claude, false);
  assert.deepEqual(
    hello.sources.map((source) => source.name),
    ['hermes:default'],
  );
});

test('a Hermes reader that cannot run says so in hello rather than going quiet', async () => {
  const { out } = await run({
    hermes: {
      generatedAt: NOW,
      available: false,
      reason: 'node:sqlite is not available on v20.0.0',
      sources: [],
      sessions: [],
    },
  });
  const hello = JSON.parse(out.lines()[0] as string) as {
    sources: Array<{ name: string; state: string; detail?: string }>;
  };
  const hermes = hello.sources.find((source) => source.name === 'hermes');
  assert.equal(hermes?.state, 'unknown');
  assert.match(hermes?.detail ?? '', /node:sqlite/);
});

test('one JSON object per line, terminated, so a reader can split on newlines', () => {
  const line = encodeLine({ type: 'state', state: { generatedAt: NOW, sessions: [], commandAvailable: false, warnings: 0 } });
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'a frame is exactly one line');
});

test('merging drops the empty diagnosis when there is something to draw', () => {
  const base: StateSnapshot = {
    generatedAt: NOW,
    sessions: [],
    commandAvailable: true,
    warnings: 0,
    empty: { reason: 'noSessions', agentsOk: true, sessionFiles: 0, wrapper: false },
  };
  const merged = mergeSnapshot(base, HERMES_SCAN);
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.empty, undefined, 'a canvas with a card on it is not an empty canvas');

  // And with nothing to add, the snapshot is the one that came in.
  assert.equal(mergeSnapshot(base, undefined), base);
  assert.equal(
    mergeSnapshot(base, { ...HERMES_SCAN, sessions: [] }).empty?.reason,
    'noSessions',
  );
});

/* ------------------------------------------------------------------ *
 * N-WP16 over the wire
 * ------------------------------------------------------------------ */

test('a session ending on the far end is its own frame, in the SSE stream\'s own shape', async () => {
  const out = buffer();
  const err = buffer();
  const state = fakeState([]);
  const handle = await runAgent({
    out,
    err,
    hostname: 'box',
    attach: false,
    state: state as never,
    reader: null as never,
  });

  const before = out.lines().length;
  state.end({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'session-a',
    cwd: 'C:/proj/nazar',
    at: NOW + 1_000,
  });

  const lines = out.lines();
  assert.equal(lines.length, before + 1, 'an ending wrote something other than one line');
  const ended = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  // `toWireSessionEnded`'s own output, which is what the browser already parses
  // off `event: session-ended`. The near end learns no second schema.
  assert.equal(ended['type'], 'session-ended');
  assert.equal(ended['id'], '00000000-0000-4000-8000-000000000001');
  assert.equal(ended['name'], 'session-a');
  assert.equal(ended['at'], NOW + 1_000);

  await handle.stop();
});

test('an ending is not throttled, and nothing is written after the stream stops', async () => {
  const out = buffer();
  const err = buffer();
  const state = fakeState([]);
  const handle = await runAgent({
    out,
    err,
    hostname: 'box',
    attach: false,
    state: state as never,
    reader: null as never,
    // Long enough that a throttled ending would certainly be swallowed.
    throttleMs: 10_000,
  });

  const before = out.lines().length;
  // Two endings inside one throttle window. A state frame is a whole snapshot
  // and dropping one costs nothing; an ending is a single event, and coalescing
  // two of them would silently swallow one sound.
  state.end({ id: 'one', at: NOW });
  state.end({ id: 'two', at: NOW + 1 });
  assert.deepEqual(
    out
      .lines()
      .slice(before)
      .map((line) => (JSON.parse(line) as { id: string }).id),
    ['one', 'two'],
  );

  await handle.stop();
  const after = out.lines().length;
  state.end({ id: 'three', at: NOW + 2 });
  assert.equal(out.lines().length, after, 'a stopped agent wrote to a closed pipe');
});
