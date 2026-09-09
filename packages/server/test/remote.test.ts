/**
 * N-WP17a: the near end of a remote canvas, driven over a fake child process.
 *
 * No ssh is spawned here and none ever should be: the cases worth testing are
 * the ones a real connection is *bad* at producing on demand — a host that
 * answers with a login banner, one that connects and never says `hello`, one
 * that drops mid-stream, one that comes back. So the spawn is injected, the
 * child is a pair of streams a test writes to, and every timer is turned down
 * to milliseconds.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { SessionEnded, SessionView, StateSnapshot } from '@nazar/core';

import {
  ALIAS_PATTERN,
  CompositeState,
  DEFAULT_REMOTE_COMMAND,
  LineReader,
  RemoteHosts,
  SSH_ARGS,
  faded,
  isAlias,
  mergeRemote,
  parseAliases,
  remoteId,
  withHost,
} from '../src/remote.ts';

const NOW = 1_788_000_000_000;

/** A child process double: two streams, plus `close` and `error`. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Write one agent line, exactly as the far end would. */
  say(line: unknown): void {
    this.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

function card(id: string, extra: Partial<SessionView> = {}): SessionView {
  return {
    id,
    provider: 'claude',
    pid: 4242,
    status: 'busy',
    state: 'alive',
    source: 'files',
    lastSeenAt: NOW,
    agents: [],
    roots: [],
    orphans: [],
    treeRead: true,
    ...extra,
  } as SessionView;
}

function frame(sessions: readonly SessionView[]): unknown {
  return {
    type: 'state',
    state: { generatedAt: NOW, sessions, commandAvailable: true, warnings: 0 },
  };
}

const HELLO = {
  type: 'hello',
  version: '0.1.0',
  host: 'buildbox',
  sources: [{ name: 'hermes:default', state: 'ok', detail: '4 sessions, 1 running' }],
  capabilities: { claude: true, hermes: true, taskText: false, jump: false },
};

/** Wait until `check` holds, or fail. Nothing here sleeps a fixed amount. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------------ *
 * The alias, and the command line built from it
 * ------------------------------------------------------------------ */

test('an alias is a name and nothing that could smuggle a connection option', () => {
  for (const good of ['box', 'build-box', 'hermes.internal', 'a1_2']) {
    assert.ok(isAlias(good), `${good} is an alias`);
  }
  for (const bad of [
    'user@host', // a login
    '-oProxyCommand=touch x', // an option
    '../etc/hosts', // a path
    'box host', // two words
    '', // nothing
    '-box', // begins with a dash
    'x'.repeat(200),
  ]) {
    assert.equal(isAlias(bad), false, `${bad} is not an alias`);
  }
  assert.ok(ALIAS_PATTERN.source.length > 0);
});

test('a comma-separated list is a set of hosts, in the order it was typed', () => {
  assert.deepEqual(parseAliases('a,b , c'), ['a', 'b', 'c']);
  assert.deepEqual(parseAliases('a,,b'), ['a', 'b'], 'an empty entry is not a host');
  assert.deepEqual(parseAliases('a,a'), ['a'], 'the same host twice is one connection');
  assert.deepEqual(parseAliases(''), []);
});

test('the ssh arguments are the four the module explains, and no more', () => {
  assert.deepEqual([...SSH_ARGS], ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
  const joined = SSH_ARGS.join(' ');
  for (const forbidden of ['-p', '-i ', '-l ', 'PasswordAuthentication']) {
    assert.ok(!joined.includes(forbidden), `${forbidden} is ~/.ssh/config's business`);
  }
  assert.equal(DEFAULT_REMOTE_COMMAND, 'nazar --agent --hermes');
});

/* ------------------------------------------------------------------ *
 * Re-keying
 * ------------------------------------------------------------------ */

test('a remote session is re-keyed, tagged and stripped of its pid', () => {
  const session = withHost(
    card('abc', {
      agents: [
        {
          id: 'agent-1',
          sessionId: 'abc',
          spawnDepth: 1,
          agentType: 'Explore',
          state: 'running',
          parentAgentId: 'agent-0',
        },
      ],
      roots: [
        {
          agent: {
            id: 'agent-1',
            sessionId: 'abc',
            spawnDepth: 1,
            agentType: 'Explore',
            state: 'running',
          },
          children: [],
        },
      ],
    }),
    'box',
  );

  assert.equal(session.id, 'box:abc');
  assert.equal(session.host, 'box');
  // The pid is the load-bearing one: 4242 on the far end is somebody else's
  // process here, and a double-click must not raise it.
  assert.equal(session.pid, 0);
  assert.equal(session.agents[0]?.id, 'box:agent-1');
  assert.equal(session.agents[0]?.sessionId, 'box:abc');
  assert.equal(session.agents[0]?.parentAgentId, 'box:agent-0');
  assert.equal(session.roots[0]?.agent.id, 'box:agent-1');
  assert.equal(remoteId('box', 'abc'), 'box:abc');
});

test('a faded card is quiet, not gone', () => {
  const session = faded(withHost(card('abc'), 'box'));
  assert.equal(session.state, 'unknown');
  assert.equal(session.status, 'unknown');
  // Everything else survives, including when it was last heard from — which is
  // the whole of what the hover has to say about it.
  assert.equal(session.lastSeenAt, NOW);
  assert.equal(session.host, 'box');
});

/* ------------------------------------------------------------------ *
 * The line parser
 * ------------------------------------------------------------------ */

test('lines are split on newlines and a partial one is held', () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(reader.push('2}\n'), ['{"b":2}']);
  assert.deepEqual(reader.push('\n \n'), [], 'blank lines are not frames');
});

test('a line that never ends is given up on rather than buffered forever', () => {
  const reader = new LineReader();
  reader.push('x'.repeat(9 * 1024 * 1024));
  assert.equal(reader.overflowed, true);
  assert.deepEqual(reader.push('{"a":1}\n'), [], 'the stream is not an agent; stop reading it');
});

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

test('hello then a frame is a host that is up, with its cards tagged', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({
    aliases: ['box'],
    spawn: () => child as never,
    now: () => NOW,
  });
  hosts.start();

  child.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'hello');
  const status = hosts.status()[0]!;
  assert.equal(status.version, '0.1.0');
  assert.equal(status.hostname, 'buildbox');
  assert.deepEqual(status.sources, [
    { name: 'hermes:default', state: 'ok', detail: '4 sessions, 1 running' },
  ]);

  child.say(frame([card('abc')]));
  await until(() => hosts.sessions().length === 1, 'a frame');
  const session = hosts.sessions()[0]!;
  assert.equal(session.id, 'box:abc');
  assert.equal(session.host, 'box');
  assert.equal(session.state, 'alive', 'a connected host is not faded');
  hosts.stop();
});

test('a login banner is one bad line, not a broken connection', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({ aliases: ['box'], spawn: () => child as never, now: () => NOW });
  hosts.start();

  child.stdout.write('Welcome to Ubuntu 24.04 LTS\n');
  child.stdout.write('Last login: Tue Sep  9 02:00:00 2026\n');
  child.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'hello after a banner');
  hosts.stop();
});

test('a host that connects and never says hello goes unknown, and says why', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({
    aliases: ['box'],
    spawn: () => child as never,
    helloTimeoutMs: 15,
    minBackoffMs: 100_000,
    now: () => NOW,
  });
  hosts.start();

  await until(() => hosts.status()[0]?.state === 'unknown', 'the hello timeout');
  assert.match(hosts.status()[0]?.error ?? '', /no hello/);
  assert.match(hosts.status()[0]?.error ?? '', /remote PATH/);
  hosts.stop();
});

test('a dropped connection fades its cards and keeps them', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({
    aliases: ['box'],
    spawn: () => child as never,
    // Long enough that the reconnection does not race the assertions.
    minBackoffMs: 100_000,
    now: () => NOW,
  });
  hosts.start();
  child.say(HELLO);
  child.say(frame([card('abc')]));
  await until(() => hosts.sessions().length === 1, 'a frame');

  child.emit('close', 255, null);
  await until(() => hosts.status()[0]?.state === 'unknown', 'the drop');

  const sessions = hosts.sessions();
  assert.equal(sessions.length, 1, 'a lid closing is not every remote agent finishing at once');
  assert.equal(sessions[0]?.state, 'unknown');
  assert.equal(sessions[0]?.lastSeenAt, NOW, 'frozen at the last frame that arrived');
  hosts.stop();
});

test('reconnection backs off, and a hello resets it', async () => {
  const children: FakeChild[] = [];
  const hosts = new RemoteHosts({
    aliases: ['box'],
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    },
    minBackoffMs: 5,
    maxBackoffMs: 20,
    helloTimeoutMs: 100_000,
    now: () => NOW,
  });
  hosts.start();

  // Three failures in a row: the attempts accumulate rather than the process
  // giving up on a host that is merely asleep.
  for (let round = 0; round < 3; round += 1) {
    const child = children[children.length - 1]!;
    child.emit('close', 255, null);
    await until(() => children.length === round + 2, `reconnection ${round + 1}`);
  }
  assert.ok((hosts.status()[0]?.attempts ?? 0) >= 4);

  children[children.length - 1]!.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'the reconnection succeeding');
  assert.equal(hosts.status()[0]?.attempts, 0, 'a hello resets the backoff');
  assert.equal(hosts.status()[0]?.error, undefined);
  hosts.stop();
});

test("ssh's own complaint is what the report gets", async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({
    aliases: ['box'],
    spawn: () => child as never,
    minBackoffMs: 100_000,
    now: () => NOW,
  });
  hosts.start();
  child.stderr.write('box: Permission denied (publickey).\n');
  child.emit('close', 255, null);
  await until(() => hosts.status()[0]?.state === 'unknown', 'the failure');
  assert.match(hosts.status()[0]?.error ?? '', /Permission denied/);
  hosts.stop();
});

test('stop kills every child, so nothing is left running', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({ aliases: ['box'], spawn: () => child as never, now: () => NOW });
  hosts.start();
  child.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'hello');
  hosts.stop();
  assert.equal(child.killed, true);
});

/* ------------------------------------------------------------------ *
 * The composite
 * ------------------------------------------------------------------ */

test('the composite is this machine plus every remote card, on one snapshot', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({ aliases: ['box'], spawn: () => child as never, now: () => NOW });
  const local = new EventEmitter() as EventEmitter & { snapshot(): StateSnapshot };
  const localSnapshot: StateSnapshot = {
    generatedAt: NOW,
    sessions: [card('local')],
    commandAvailable: true,
    warnings: 0,
  };
  local.snapshot = () => localSnapshot;

  const composite = new CompositeState(local as never, hosts);
  assert.deepEqual(
    composite.snapshot().sessions.map((session) => session.id),
    ['local'],
  );

  hosts.start();
  child.say(HELLO);
  child.say(frame([card('abc')]));
  await until(() => composite.snapshot().sessions.length === 2, 'the remote frame');
  assert.deepEqual(
    composite.snapshot().sessions.map((session) => session.id),
    ['local', 'box:abc'],
  );
  hosts.stop();
});

test('an empty local canvas with a remote card on it is not an empty canvas', () => {
  const base: StateSnapshot = {
    generatedAt: NOW,
    sessions: [],
    commandAvailable: true,
    warnings: 0,
    empty: { reason: 'noSessions', agentsOk: true, sessionFiles: 0, wrapper: false },
  };
  assert.equal(mergeRemote(base, []).empty?.reason, 'noSessions');
  const merged = mergeRemote(base, [withHost(card('abc'), 'box')]);
  assert.equal(merged.empty, undefined);
  assert.equal(merged.sessions.length, 1);
  // Everything that is a fact about *this* machine stays this machine's.
  assert.equal(merged.commandAvailable, true);
});

/* ------------------------------------------------------------------ *
 * N-WP16 arriving off another machine
 * ------------------------------------------------------------------ */

test('an ending off the far end is re-keyed by alias and tagged with the host', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({ aliases: ['box'], spawn: () => child as never, now: () => NOW });
  const seen: SessionEnded[] = [];
  hosts.on('session-ended', (ended) => seen.push(ended));
  hosts.start();
  child.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'hello');

  child.say({ type: 'session-ended', id: 'abc', name: 'importer', cwd: '~/proj', at: NOW + 5 });
  await until(() => seen.length === 1, 'the ending');

  // The id has to be the one the card carries, or the sound rules match either
  // nothing or — worse — a local session wearing the same uuid.
  assert.equal(seen[0]?.id, remoteId('box', 'abc'));
  assert.equal(seen[0]?.host, 'box');
  assert.equal(seen[0]?.name, 'importer');
  assert.equal(seen[0]?.at, NOW + 5);

  // A frame with no usable id is dropped rather than turned into an ending of
  // something: this is somebody else's stdout.
  child.say({ type: 'session-ended', at: NOW + 6 });
  child.say({ type: 'session-ended', id: '', at: NOW + 7 });
  child.say(frame([card('abc')]));
  await until(() => hosts.sessions().length === 1, 'a state frame after the bad endings');
  assert.equal(seen.length, 1, 'an ending was invented from a frame that named nothing');

  hosts.stop();
});

test('the composite carries endings from both halves, local and remote alike', async () => {
  const child = new FakeChild();
  const hosts = new RemoteHosts({ aliases: ['box'], spawn: () => child as never, now: () => NOW });
  const local = new EventEmitter() as EventEmitter & { snapshot(): StateSnapshot };
  local.snapshot = () => ({
    generatedAt: NOW,
    sessions: [card('local')],
    commandAvailable: true,
    warnings: 0,
  });

  const composite = new CompositeState(local as never, hosts);
  const seen: SessionEnded[] = [];
  composite.on('session-ended', (ended) => seen.push(ended));

  hosts.start();
  child.say(HELLO);
  await until(() => hosts.status()[0]?.state === 'up', 'hello');

  local.emit('session-ended', { id: 'local', at: NOW });
  child.say({ type: 'session-ended', id: 'abc', at: NOW + 1 });
  await until(() => seen.length === 2, 'both endings');

  assert.deepEqual(
    seen.map((ended) => ended.id),
    ['local', 'box:abc'],
  );
  // The local one is untouched — a machine does not tag its own sessions with a
  // host — and the remote one names the alias it came through.
  assert.equal(seen[0]?.host, undefined);
  assert.equal(seen[1]?.host, 'box');

  hosts.stop();
});
