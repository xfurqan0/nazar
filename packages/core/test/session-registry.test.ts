/**
 * The session registry.
 *
 * Every test injects a temporary directory in place of `~/.claude/sessions`.
 * The real one is never watched, written to, or listed here, and the only
 * process this file ever ends is a child it spawned itself.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentsEntry, AgentsRunResult } from '../src/claude-agents.ts';
import type { DirectoryWatcher } from '../src/fs-watch.ts';
import { isPidAlive } from '../src/liveness.ts';
import { SessionRegistry } from '../src/session-registry.ts';
import type { SessionChange } from '../src/types.ts';

/**
 * The bound the registry promises: one poll interval (2 s by default) plus one
 * pass, on every platform, with a whole further interval of margin for a
 * loaded CI runner.
 *
 * It is deliberately *not* the 106-121 ms `fs.watch` delivers on the
 * maintainer's machine. That figure is a measurement of one platform's watch,
 * and asserting it turns the suite into a test of whether the filesystem is
 * punctual — which macOS, where a directory watch goes through FSEvents and is
 * coalesced, is entitled not to be. The registry now polls unconditionally, so
 * this budget holds with no watch at all; the tests that have to prove the
 * *watch* works drive it through an injected factory rather than asking a real
 * filesystem to hurry.
 */
const BOUND_MS = 4000;

/** Poll interval for the tests that assert the pipeline rather than the bound. */
const FAST_POLL_MS = 30;

/** An `fs.watch` handle a test drives by hand. */
class FakeWatcher extends EventEmitter implements DirectoryWatcher {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'nazar-registry-'));
}

/** A session file with the shape Claude Code writes, minus the ignored keys. */
function sessionFile(fields: {
  pid: number;
  sessionId?: string;
  status?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
}): string {
  return JSON.stringify({
    pid: fields.pid,
    sessionId: fields.sessionId ?? `00000000-0000-4000-8000-00000000000${fields.pid % 10}`,
    cwd: fields.cwd ?? 'C:/proj/example',
    startedAt: 1788697701170,
    version: '2.1.263',
    kind: 'interactive',
    entrypoint: 'cli',
    name: fields.name ?? 'session-a',
    status: fields.status ?? 'busy',
    updatedAt: fields.updatedAt ?? 1788751348625,
    statusUpdatedAt: fields.updatedAt ?? 1788751348625,
  });
}

/** Resolve on the registry's next `change`, or reject inside the budget. */
function nextChange(registry: SessionRegistry, budgetMs = BOUND_MS): Promise<SessionChange> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onChange = (change: SessionChange): void => {
      clearTimeout(timer);
      resolve(change);
    };
    timer = setTimeout(() => {
      registry.off('change', onChange);
      reject(new Error(`no change event within ${budgetMs} ms`));
    }, budgetMs);
    registry.once('change', onChange);
  });
}

function runnerFor(entries: readonly AgentsEntry[]): () => Promise<AgentsRunResult> {
  return async () => ({ ok: true, entries, durationMs: 1 });
}

/**
 * The whole pipeline — write, rewrite, delete — over the poll path at 30 ms.
 * Nothing here waits on a filesystem event, so it behaves the same on Windows,
 * Linux and macOS; the `fs.watch` half is asserted separately below.
 */
test('adding, changing and removing a session file each reach the canvas', async (t) => {
  const dir = await tempDir();
  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    watch: false,
    pollIntervalMs: FAST_POLL_MS,
    gateIntervalMs: 60_000,
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.deepEqual(registry.snapshot(), []);

  const file = path.join(dir, '1001.json');

  let pending = nextChange(registry);
  await writeFile(file, sessionFile({ pid: 1001, status: 'busy' }), 'utf8');
  const added = await pending;
  assert.equal(added.added.length, 1);
  assert.equal(added.added[0]?.pid, 1001);
  assert.equal(added.added[0]?.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(added.added[0]?.status, 'busy');
  assert.equal(added.added[0]?.state, 'alive');
  assert.equal(added.added[0]?.source, 'files');
  assert.equal(added.added[0]?.provider, 'claude');
  assert.deepEqual(added.added[0]?.agents, []);

  pending = nextChange(registry);
  await writeFile(file, sessionFile({ pid: 1001, status: 'waiting', updatedAt: 1788751349000 }), 'utf8');
  const updated = await pending;
  assert.equal(updated.updated.length, 1);
  assert.equal(updated.updated[0]?.status, 'waiting');
  // The session file says a session is waiting but never says what for.
  assert.equal(updated.updated[0]?.waitingFor, undefined);
  assert.equal(updated.updated[0]?.lastWriteAt, 1788751349000);

  pending = nextChange(registry);
  await rm(file);
  const removed = await pending;
  assert.equal(removed.removed.length, 1);
  assert.equal(removed.removed[0]?.pid, 1001);
  assert.deepEqual(registry.snapshot(), []);
});

/**
 * The one test that touches a real filesystem watch, and it asserts the bound
 * rather than the watch: shipped defaults, no injected timings, and a budget
 * that a machine with no working `fs.watch` at all would still meet.
 */
test('a real session file write lands inside the cross-platform bound', async (t) => {
  const dir = await tempDir();
  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    gateIntervalMs: 60_000,
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(registry.pollIntervalMs, 2000, 'the bound below is made of the shipped default');
  assert.equal(registry.debounceMs, 100);
  assert.equal(registry.watching, true, 'a watch on a temporary directory can be established');

  const pending = nextChange(registry);
  await writeFile(path.join(dir, '1002.json'), sessionFile({ pid: 1002 }), 'utf8');
  const change = await pending;
  assert.equal(change.added[0]?.pid, 1002);
});

/**
 * The macOS failure mode, made deterministic: a watch that is established,
 * never errors, and simply never delivers. This is what a coalesced FSEvents
 * stream looks like from inside the process, and the poll has to carry it.
 * The interval is shortened so the suite does not sit through the shipped 2 s;
 * the arithmetic is the same one the bound is made of, and the test above
 * pins the shipped value itself.
 */
test('a watch that never delivers still lands the change on the poll', async (t) => {
  const dir = await tempDir();
  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    pollIntervalMs: 200,
    gateIntervalMs: 60_000,
    watchFactory: () => new FakeWatcher(),
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(registry.watching, true, 'the watch is held; it is just mute');

  const pending = nextChange(registry);
  await writeFile(path.join(dir, '1003.json'), sessionFile({ pid: 1003 }), 'utf8');
  assert.equal((await pending).added[0]?.pid, 1003);
});

test('fs.watch is taken on the sessions directory and its event drives a pass', async (t) => {
  const dir = await tempDir();
  const watched: string[] = [];
  const watcher = new FakeWatcher();
  let fire: (() => void) | undefined;

  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    debounceMs: 20,
    // Long enough that only the watch can deliver the change below.
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
    watchFactory: (target, onChange) => {
      watched.push(target);
      fire = onChange;
      return watcher;
    },
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.deepEqual(watched, [dir], 'the sessions directory, once');
  assert.equal(registry.watching, true);

  const pending = nextChange(registry);
  await writeFile(path.join(dir, '1004.json'), sessionFile({ pid: 1004 }), 'utf8');
  assert.ok(fire !== undefined);
  fire();
  const change = await pending;
  assert.equal(change.added[0]?.pid, 1004);
});

test('a watch that errors is closed and dropped, and the poll carries on alone', async (t) => {
  const dir = await tempDir();
  const watcher = new FakeWatcher();

  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    pollIntervalMs: FAST_POLL_MS,
    gateIntervalMs: 60_000,
    watchFactory: () => watcher,
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(registry.watching, true);

  // What a filesystem that stops supporting the watch looks like from here.
  watcher.emit('error', new Error('EPERM'));
  assert.equal(watcher.closed, true, 'the dead handle is released, not leaked');
  assert.equal(registry.watching, false);

  const pending = nextChange(registry);
  await writeFile(path.join(dir, '1005.json'), sessionFile({ pid: 1005 }), 'utf8');
  const change = await pending;
  assert.equal(change.added[0]?.pid, 1005, 'the poll was already running; nothing had to take over');
});

test('a registry told not to watch never calls the factory', async (t) => {
  const dir = await tempDir();
  let calls = 0;
  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    watch: false,
    pollIntervalMs: FAST_POLL_MS,
    gateIntervalMs: 60_000,
    watchFactory: () => {
      calls += 1;
      return new FakeWatcher();
    },
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(calls, 0);
  assert.equal(registry.watching, false);

  const pending = nextChange(registry);
  await writeFile(path.join(dir, '1006.json'), sessionFile({ pid: 1006 }), 'utf8');
  assert.equal((await pending).added[0]?.pid, 1006);
});

test('the command adds what the files cannot, and marks where a session came from', async (t) => {
  const dir = await tempDir();
  await writeFile(path.join(dir, '1001.json'), sessionFile({ pid: 1001, status: 'waiting' }), 'utf8');
  await writeFile(path.join(dir, '1003.json'), sessionFile({ pid: 1003, status: 'idle' }), 'utf8');

  const registry = new SessionRegistry({
    sessionsDir: dir,
    isAlive: () => true,
    watch: false,
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
    runAgents: runnerFor([
      {
        pid: 1001,
        cwd: 'C:/proj/example',
        kind: 'interactive',
        name: 'session-a',
        status: 'waiting',
        waitingFor: 'permission prompt',
        sessionId: '00000000-0000-4000-8000-000000000001',
        startedAt: 1788697701170,
      },
      {
        pid: 2002,
        cwd: 'C:/proj/other',
        kind: 'interactive',
        name: 'session-z',
        status: 'busy',
        sessionId: '00000000-0000-4000-8000-000000000009',
        startedAt: 1788697701171,
      },
    ]),
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  const byPid = new Map(registry.snapshot().map((session) => [session.pid, session]));

  assert.equal(registry.commandAvailable, true);
  assert.equal(byPid.size, 3);
  assert.equal(byPid.get(1001)?.source, 'files+command');
  assert.equal(byPid.get(1001)?.waitingFor, 'permission prompt');
  assert.equal(byPid.get(1003)?.source, 'files');
  assert.equal(byPid.get(1003)?.waitingFor, undefined);
  assert.equal(byPid.get(2002)?.source, 'command');
  assert.equal(byPid.get(2002)?.cwd, 'C:/proj/other');
});

test('a failing command leaves the registry running from the files alone', async (t) => {
  const dir = await tempDir();
  await writeFile(path.join(dir, '1001.json'), sessionFile({ pid: 1001 }), 'utf8');

  const registry = new SessionRegistry({
    sessionsDir: dir,
    isAlive: () => true,
    watch: false,
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
    runAgents: async () => ({ ok: false, entries: [], durationMs: 3, error: 'ENOENT' }),
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(registry.commandAvailable, false);
  assert.equal(registry.lastGateMs, 3);
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.snapshot()[0]?.source, 'files');
});

test('a killed process goes to unknown, survives one gate, then disappears', async (t) => {
  const dir = await tempDir();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const pid = child.pid;
  assert.ok(pid !== undefined);

  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    watch: false,
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
  });
  t.after(async () => {
    registry.stop();
    if (isPidAlive(pid)) child.kill();
    await rm(dir, { recursive: true, force: true });
  });

  // The session file stays on disk, which is exactly what a crash leaves
  // behind. Only the pid probe can tell the session is gone.
  await writeFile(path.join(dir, `${pid}.json`), sessionFile({ pid }), 'utf8');
  await registry.start();
  assert.equal(registry.snapshot()[0]?.state, 'alive');

  child.kill();
  await once(child, 'exit');
  for (let attempt = 0; attempt < 50 && isPidAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const toUnknown = nextChange(registry);
  await registry.gate();
  const unknown = await toUnknown;
  assert.equal(unknown.updated[0]?.state, 'unknown');
  assert.equal(registry.snapshot().length, 1, 'one gate interval of unknown, not an instant delete');

  const toGone = nextChange(registry);
  await registry.gate();
  const gone = await toGone;
  assert.equal(gone.removed[0]?.pid, pid);
  assert.deepEqual(registry.snapshot(), []);
});

test('malformed and credential files in the watched directory are counted and skipped', async (t) => {
  const dir = await tempDir();
  await writeFile(path.join(dir, '1001.json'), sessionFile({ pid: 1001 }), 'utf8');
  await writeFile(path.join(dir, '1002.json'), '{ not json', 'utf8');
  await writeFile(path.join(dir, `1001.${'0'.repeat(64)}.key`), 'credential material', 'utf8');

  const registry = new SessionRegistry({
    sessionsDir: dir,
    runAgents: null,
    isAlive: () => true,
    watch: false,
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
  });
  t.after(async () => {
    registry.stop();
    await rm(dir, { recursive: true, force: true });
  });

  await registry.start();
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.snapshot()[0]?.pid, 1001);
  assert.equal(registry.warnings, 1, 'the malformed file counts once; the key file not at all');
});

test('a missing sessions directory is not an error', async (t) => {
  const registry = new SessionRegistry({
    sessionsDir: path.join(os.tmpdir(), 'nazar-registry-absent-4676'),
    runAgents: null,
    watch: true,
    pollIntervalMs: 60_000,
    gateIntervalMs: 60_000,
  });
  t.after(() => {
    registry.stop();
  });

  await registry.start();
  assert.deepEqual(registry.snapshot(), []);
  assert.equal(registry.warnings, 0);
});
