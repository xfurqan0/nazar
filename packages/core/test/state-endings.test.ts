/**
 * N-WP16: when the join says a session has ended.
 *
 * The event is the session-level `session-gone` — the same signal
 * `agent-done.ts` uses for a subagent, asked of the process that owns the
 * transcript rather than of the transcript. It is worth its own file because
 * three separate things have to be true of it and each is a different failure:
 *
 * - it fires **once** per session, because a canvas turns it into a sound;
 * - it does **not** fire for a session that is merely quiet, or for one that has
 *   failed a single liveness probe — those are `unknown`, which is the registry
 *   saying it does not know, and a monitor that rang for *I am not sure* would
 *   ring all day;
 * - it does **not** fire on start-up, however many sessions were already gone
 *   when the process came up.
 *
 * Nothing here touches `~/.claude` or `~/.codex`: the registry runs over a
 * temporary directory with `runAgents: null`, the Codex reader is off, and no
 * tree watcher is ever built.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionRegistry } from '../src/session-registry.ts';
import type { SessionEnded } from '../src/state.ts';
import { NazarState } from '../src/state.ts';

const NOW = 1_788_756_000_000;

async function withSessionsDir(
  run: (dir: string, writeSession: (pid: number, body: unknown) => Promise<void>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-ended-'));
  try {
    await run(dir, async (pid, body) => {
      await writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body), 'utf8');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionFile(pid: number, sessionId: string): unknown {
  return {
    pid,
    sessionId,
    cwd: 'C:/proj/nazar',
    kind: 'interactive',
    name: `session-${pid}`,
    status: 'busy',
    startedAt: NOW - 120_000,
    updatedAt: NOW - 5_000,
    statusUpdatedAt: NOW - 5_000,
    version: '2.1.263',
  };
}

/** A join with no optional reader, no tree watcher and a frozen clock. */
function makeState(dir: string, isAlive: () => boolean): NazarState {
  return new NazarState({
    captures: null,
    limits: null,
    statusLines: null,
    // N-WP18: and no Codex reader either, so no test reaches ~/.codex.
    codex: null,
    registry: new SessionRegistry({
      sessionsDir: dir,
      watch: false,
      runAgents: null,
      isAlive,
    }),
    coalesceMs: 5,
    now: () => NOW,
    createTree: () => undefined,
  });
}

test('a session whose file goes ends exactly once, and says who it was', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4242, sessionFile(4242, 'sess-a'));
    const state = makeState(dir, () => true);
    const ended: SessionEnded[] = [];
    state.on('session-ended', (one) => ended.push(one));

    try {
      await state.start();
      assert.equal(ended.length, 0, 'a session that is *there* has not ended');

      await rm(path.join(dir, '4242.json'));
      await state.registry.refresh();

      assert.equal(ended.length, 1);
      const one = ended[0];
      assert.ok(one !== undefined);
      assert.equal(one.id, 'sess-a');
      assert.equal(one.name, 'session-4242');
      assert.equal(one.cwd, 'C:/proj/nazar');
      assert.equal(one.at, NOW, 'the timestamp is the join\'s clock, not the file\'s');

      // Every later pass finds the same nothing. The registry cannot lose a
      // session twice, and a canvas that rang on every poll would be unusable.
      await state.registry.refresh();
      await state.registry.gate();
      assert.equal(ended.length, 1, 'the ending was announced more than once');
    } finally {
      state.stop();
    }
  });
});

test('a dead pid is unknown for one gate before it has ended', async () => {
  await withSessionsDir(async (dir, write) => {
    // The file stays on disk: this is the crash case, where a session file is
    // left behind by a process that is no longer there.
    await write(4243, sessionFile(4243, 'sess-b'));
    const state = makeState(dir, () => false);
    const ended: SessionEnded[] = [];
    state.on('session-ended', (one) => ended.push(one));

    try {
      await state.start();
      const view = state.snapshot().sessions[0];
      assert.ok(view !== undefined);
      assert.equal(view.state, 'unknown', 'the first failed probe is a doubt, not a verdict');
      assert.equal(ended.length, 0, 'a doubt must not make a sound');

      await state.registry.gate();
      assert.equal(ended.length, 1, 'a full gate as unknown is the end');
      assert.equal(ended[0]?.id, 'sess-b');
    } finally {
      state.stop();
    }
  });
});

test('nothing is announced for sessions that were already gone at start-up', async () => {
  await withSessionsDir(async (dir) => {
    // An empty directory: every session this machine ever ran has ended, and not
    // one of them is news. The listener is attached *before* `start()` so a
    // start-up burst would be seen.
    const state = makeState(dir, () => true);
    const ended: SessionEnded[] = [];
    state.on('session-ended', (one) => ended.push(one));

    try {
      await state.start();
      await state.registry.gate();
      assert.equal(ended.length, 0);
      assert.equal(state.snapshot().sessions.length, 0);
    } finally {
      state.stop();
    }
  });
});

test('a session with no name and no cwd ends with neither invented', async () => {
  await withSessionsDir(async (dir, write) => {
    // The thinnest session file the reader accepts. `cwd` and `name` are absent
    // rather than empty strings, which is the rule the whole wire follows.
    await write(4244, { pid: 4244, sessionId: 'sess-c', status: 'busy' });
    const state = makeState(dir, () => true);
    const ended: SessionEnded[] = [];
    state.on('session-ended', (one) => ended.push(one));

    try {
      await state.start();
      await rm(path.join(dir, '4244.json'));
      await state.registry.refresh();

      assert.equal(ended.length, 1);
      const one = ended[0];
      assert.ok(one !== undefined);
      assert.equal(one.id, 'sess-c');
      assert.equal('name' in one, false);
      assert.equal('cwd' in one, false);
    } finally {
      state.stop();
    }
  });
});
