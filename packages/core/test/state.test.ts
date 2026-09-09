/**
 * The join between the registry (WP1) and the tree watchers (WP2).
 *
 * Nothing here touches `~/.claude`: the registry runs over a temporary
 * directory with `runAgents: null`, and the tree watcher is handed in by the
 * test. What is actually being checked is the wiring — a session that appears
 * gets a watcher, a session that goes loses it, and the snapshot carries what
 * both halves know without inventing anything neither of them does.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectSlugFor } from '../src/project-slug.ts';
import { NazarState } from '../src/state.ts';
import { SessionRegistry } from '../src/session-registry.ts';
import type { SessionTreeSnapshot } from '../src/session-tree.ts';
import { SessionTreeWatcher } from '../src/session-tree.ts';
import type { Agent, Session } from '../src/types.ts';

const NOW = 1_788_756_000_000;

/** A tree watcher that emits what the test tells it to, and reads no files. */
class FakeTree extends SessionTreeWatcher {
  constructor(
    sessionId: string,
    private readonly canned: SessionTreeSnapshot,
  ) {
    super({ sessionId, projectDir: path.join(tmpdir(), 'nazar-never-read'), watch: false });
  }

  stopped = false;

  override async start(): Promise<void> {
    this.emit('change', this.canned);
  }

  override stop(): void {
    this.stopped = true;
  }

  override snapshot(): SessionTreeSnapshot {
    return this.canned;
  }
}

function agent(id: string): Agent {
  return {
    id,
    sessionId: 's',
    spawnDepth: 1,
    agentType: 'general-purpose',
    state: 'running',
    tokens: { in: 10, out: 20, cacheRead: 30, cacheWrite: 40 },
  };
}

function treeSnapshot(sessionId: string): SessionTreeSnapshot {
  const one = agent('agent-a0000000000000001');
  return {
    sessionId,
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    treeTokens: { in: 11, out: 22, cacheRead: 33, cacheWrite: 44 },
    model: 'claude-opus-5[1m]',
    effort: 'high',
    currentTool: 'Grep',
    toolCalls: 7,
    startedAt: NOW - 60_000,
    lastWriteAt: NOW - 3_000,
    writeAgeMs: 3_000,
    agents: [one],
    roots: [{ agent: one, children: [] }],
    orphans: [],
    workflowRuns: [],
    dedupeFallbacks: 0,
    warnings: 0,
    bytesRead: 512,
    filesTailed: 2,
  };
}

async function withSessionsDir(
  run: (dir: string, writeSession: (pid: number, body: unknown) => Promise<void>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-state-'));
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

test('a session gets a tree watcher, and its snapshot carries both halves', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4242, sessionFile(4242, 'sess-a'));

    const created: FakeTree[] = [];
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: (session) => {
        const tree = new FakeTree(session.id, treeSnapshot(session.id));
        created.push(tree);
        return tree;
      },
    });

    try {
      await state.start();
      const snapshot = state.snapshot();

      assert.equal(created.length, 1);
      assert.equal(snapshot.sessions.length, 1);

      const view = snapshot.sessions[0];
      assert.ok(view !== undefined);
      assert.equal(view.id, 'sess-a');
      assert.equal(view.cwd, 'C:/proj/nazar');
      assert.equal(view.state, 'alive');
      assert.equal(view.model, 'claude-opus-5[1m]');
      assert.equal(view.effort, 'high');
      assert.equal(view.currentTool, 'Grep');
      assert.equal(view.toolCalls, 7);
      assert.deepEqual(view.tokens, { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 });
      assert.deepEqual(view.treeTokens, { in: 11, out: 22, cacheRead: 33, cacheWrite: 44 });
      assert.equal(view.agents.length, 1);
      assert.equal(view.roots.length, 1);
      assert.equal(view.treeRead, true);
      assert.equal(view.writeAgeMs, 3_000, 'the age is measured against the snapshot clock');
      assert.equal(view.transcriptAt, NOW - 3_000);
      // The session file carried startedAt, so the transcript does not override it.
      assert.equal(view.startedAt, NOW - 120_000);
    } finally {
      state.stop();
    }
  });
});

test('a session with no tree yet reads as unread rather than as empty', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4243, sessionFile(4243, 'sess-b'));

    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: () => undefined,
    });

    try {
      await state.start();
      const view = state.snapshot().sessions[0];
      assert.ok(view !== undefined);
      assert.equal(view.treeRead, false, 'the canvas must be able to say "unknown", not "none"');
      assert.deepEqual(view.roots, []);
      assert.equal(view.tokens, undefined, 'no counter is invented');
      assert.equal(view.model, undefined);
    } finally {
      state.stop();
    }
  });
});

test('a session with no session id of its own gets no tree', async () => {
  await withSessionsDir(async (dir, write) => {
    // No `sessionId`: the registry falls back to `pid-<pid>`, and there is no
    // transcript directory to watch.
    await write(4244, { pid: 4244, cwd: 'C:/proj/nazar', status: 'idle' });

    let calls = 0;
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: () => {
        calls += 1;
        return undefined;
      },
    });

    try {
      await state.start();
      assert.equal(calls, 0);
      assert.equal(state.snapshot().sessions[0]?.id, 'pid-4244');
    } finally {
      state.stop();
    }
  });
});

test('a session that goes away takes its watcher with it', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4245, sessionFile(4245, 'sess-c'));

    const created: FakeTree[] = [];
    const alive = new Set([4245]);
    const registry = new SessionRegistry({
      sessionsDir: dir,
      watch: false,
      runAgents: null,
      isAlive: (pid) => alive.has(pid),
    });
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry,
      coalesceMs: 5,
      now: () => NOW,
      createTree: (session) => {
        const tree = new FakeTree(session.id, treeSnapshot(session.id));
        created.push(tree);
        return tree;
      },
    });

    try {
      await state.start();
      assert.equal(created.length, 1);

      await rm(path.join(dir, '4245.json'));
      alive.delete(4245);
      await registry.gate();
      await registry.gate();
      state.publish();

      assert.equal(state.snapshot().sessions.length, 0);
      assert.equal(created[0]?.stopped, true, 'the tree watcher was left running');
    } finally {
      state.stop();
    }
  });
});

test('a change on either half publishes one coalesced snapshot', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4246, sessionFile(4246, 'sess-d'));

    let tree: FakeTree | undefined;
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: (session) => {
        tree = new FakeTree(session.id, treeSnapshot(session.id));
        return tree;
      },
    });

    try {
      await state.start();
      assert.ok(tree !== undefined);

      const seen: number[] = [];
      state.on('change', (snapshot) => seen.push(snapshot.sessions.length));

      const next = { ...treeSnapshot('sess-d'), toolCalls: 99 };
      tree.emit('change', next);
      tree.emit('change', next);
      tree.emit('change', next);

      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(seen.length, 1, 'three watcher events became one publish');
      assert.equal(state.snapshot().sessions[0]?.toolCalls, 99);
    } finally {
      state.stop();
    }
  });
});

test('projectDirFor puts a session under the slug the resolver produces', () => {
  const projectsDir = path.join('X:', 'projects');
  const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
    registry: new SessionRegistry({ watch: false, runAgents: null }),
    projectsDir,
  });
  const cwd = 'C:/proj/nazar';
  const dir = state.projectDirFor(cwd);

  // Split the join with `path` rather than scanning the joined string for a
  // literal separator: `path.sep` is `\` on Windows and `/` everywhere else, so
  // `dir.includes('/')` reports which host ran the test, not what the resolver
  // produced — it held on windows-latest and failed on ubuntu and macos.
  assert.equal(path.dirname(dir), projectsDir, 'the project dir sits one level under projectsDir');
  const slug = path.basename(dir);
  assert.equal(slug, projectSlugFor(cwd), 'the directory name is the resolver output verbatim');
  // Pinned literally as well as against the resolver: below the 200-character
  // limit both separators are non-alphanumeric and become `-`, so this slug is
  // identical on every platform (packages/core/test/project-slug.test.ts).
  assert.equal(slug, 'C--proj-nazar');
  assert.doesNotMatch(slug, /[\\/]/, 'the slug never keeps a path separator');
  state.stop();
});

test('the snapshot header reports what the registry knows about its sources', async () => {
  await withSessionsDir(async (dir) => {
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: () => undefined,
    });
    try {
      await state.start();
      const snapshot = state.snapshot();
      assert.equal(snapshot.generatedAt, NOW);
      assert.equal(snapshot.sessions.length, 0);
      assert.equal(snapshot.commandAvailable, false, 'runAgents was disabled');
      assert.equal(snapshot.warnings, 0);
    } finally {
      state.stop();
    }
  });
});

/** Type-level guard: `SessionView` really is a `Session` plus the tree. */
test('a SessionView is usable anywhere a Session is', async () => {
  await withSessionsDir(async (dir, write) => {
    await write(4247, sessionFile(4247, 'sess-e'));
    const state = new NazarState({
      // Neither optional source is read here: a test must never depend on
      // what is or is not installed under the home directory it runs in.
      captures: null,
      limits: null,
      registry: new SessionRegistry({
        sessionsDir: dir,
        watch: false,
        runAgents: null,
        isAlive: () => true,
      }),
      coalesceMs: 5,
      now: () => NOW,
      createTree: () => undefined,
    });
    try {
      await state.start();
      const view = state.snapshot().sessions[0];
      assert.ok(view !== undefined);
      const asSession: Session = view;
      assert.equal(asSession.pid, 4247);
    } finally {
      state.stop();
    }
  });
});

/* ------------------------------------------------------------------ *
 * N-WP20: why the canvas is empty
 * ------------------------------------------------------------------ */

/** A join over one sessions directory, with neither optional source read. */
function emptyState(dir: string, alive: boolean, agents: boolean): NazarState {
  return new NazarState({
    captures: null,
    limits: null,
    registry: new SessionRegistry({
      sessionsDir: dir,
      watch: false,
      isAlive: () => alive,
      runAgents: agents
        ? async () => ({ ok: true, entries: [], durationMs: 1 })
        : null,
    }),
    coalesceMs: 5,
    now: () => NOW,
    createTree: () => undefined,
  });
}

test('N-WP20: an empty canvas says which of the three empties it is', async () => {
  /*
   * `nazar doctor` has always separated these three; the page could not, so it
   * told everybody the same thing — *start `claude` in a terminal* — including
   * the person whose `CLAUDE_CONFIG_DIR` had moved, for whom opening another
   * terminal does nothing at all. Same two facts, same three branches, decided
   * here against a real directory.
   */

  // (1) No sessions directory: Claude Code has never run under this config dir.
  const absent = emptyState(path.join(tmpdir(), 'nazar-state-absent-4676'), false, true);
  try {
    await absent.start();
    const snapshot = absent.snapshot();
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.empty?.reason, 'noConfigDir');
    assert.equal(snapshot.empty?.sessionFiles, 0);
  } finally {
    absent.stop();
  }

  // (2) The directory exists and holds nothing. Nothing is running; that is all.
  await withSessionsDir(async (dir) => {
    const state = emptyState(dir, false, true);
    try {
      await state.start();
      assert.equal(state.snapshot().empty?.reason, 'noSessions');
      assert.equal(state.snapshot().empty?.agentsOk, true);
    } finally {
      state.stop();
    }
  });

  // (3) Session files, none of them alive: leftovers Nazar refuses to draw.
  await withSessionsDir(async (dir, write) => {
    await write(4242, sessionFile(4242, 'sess-dead'));
    const state = emptyState(dir, false, true);
    try {
      await state.start();
      // One gate of "we no longer know" comes first: an `unknown` session is
      // still a session and still drawn, so the canvas is not empty yet and
      // there is nothing to explain.
      assert.equal(state.snapshot().sessions.length, 1);
      assert.equal(state.snapshot().empty, undefined);

      await state.registry.gate();
      state.publish();
      const snapshot = state.snapshot();
      assert.equal(snapshot.sessions.length, 0, 'the second gate drops it');
      assert.equal(snapshot.empty?.reason, 'staleSessions');
      assert.equal(snapshot.empty?.sessionFiles, 1, 'and the leftover file is why');
    } finally {
      state.stop();
    }
  });
});

test('N-WP20: the two asides are reported, and neither is ever the reason', async () => {
  await withSessionsDir(async (dir) => {
    // `claude agents --json` unavailable, and no status-line wrapper: both
    // true, both worth saying, neither of them why the canvas is empty.
    const state = emptyState(dir, false, false);
    try {
      await state.start();
      const diagnosis = state.snapshot().empty;
      assert.equal(diagnosis?.reason, 'noSessions', 'the reason comes from the files alone');
      assert.equal(diagnosis?.agentsOk, false);
      assert.equal(diagnosis?.wrapper, false);
    } finally {
      state.stop();
    }
  });
});

test('N-WP20: a canvas with something on it carries no diagnosis at all', async () => {
  // Absent rather than a fourth reason code. An `empty` object sitting next to
  // a running session would be a field that lies, and every consumer would
  // have to learn to ignore it.
  await withSessionsDir(async (dir, write) => {
    await write(4242, sessionFile(4242, 'sess-a'));
    const state = emptyState(dir, true, true);
    try {
      await state.start();
      assert.equal(state.snapshot().sessions.length, 1);
      assert.equal(state.snapshot().empty, undefined);
    } finally {
      state.stop();
    }
  });
});
