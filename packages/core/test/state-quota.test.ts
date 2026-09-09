/**
 * WP3'/WP5: the join, where the two optional sources meet the two mandatory
 * ones.
 *
 * Three questions, and the middle one is the interesting one:
 *
 * - does a session pick up the cost and context window of *its own* capture,
 *   and stay empty when no capture names it?
 * - **which effort wins?** The transcript's is on the last line that was
 *   *written*, and transcripts are flushed with lag; the status line's is what
 *   the session is set to right now, and it is rewritten every few seconds. So
 *   the newer of the two wins, measured against the transcript's own mtime and
 *   not against the wall clock — a capture from a session that stopped writing
 *   an hour ago must not overrule a transcript line written since.
 * - does the snapshot carry a quota only when something can fill it?
 *
 * Both readers are handed in over paths that do not exist, so nothing here
 * depends on whether nazar-tray happens to be installed on the machine the
 * tests run on.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LimitsScan } from '../src/limits-file.ts';
import { LimitsWatcher } from '../src/limits-file.ts';
import { CAPTURE_GRACE_MS, ProjectStatusLineProbe } from '../src/project-settings.ts';
import { SessionRegistry } from '../src/session-registry.ts';
import type { SessionTreeSnapshot } from '../src/session-tree.ts';
import { SessionTreeWatcher } from '../src/session-tree.ts';
import { NazarState } from '../src/state.ts';
import type { CaptureScan, StatuslineCapture } from '../src/statusline-captures.ts';
import { StatuslineCaptures } from '../src/statusline-captures.ts';

const NOW = 1_788_756_000_000;

/** A tree watcher that reads nothing and answers what the test says. */
class FakeTree extends SessionTreeWatcher {
  constructor(
    sessionId: string,
    private readonly canned: SessionTreeSnapshot,
  ) {
    super({ sessionId, projectDir: path.join(tmpdir(), 'nazar-never-read'), watch: false });
  }

  override async start(): Promise<void> {
    this.emit('change', this.canned);
  }

  override stop(): void {
    // Nothing was started.
  }

  override snapshot(): SessionTreeSnapshot {
    return this.canned;
  }
}

/** A capture reader that reads no directory. */
class FakeCaptures extends StatuslineCaptures {
  constructor(private readonly canned: CaptureScan) {
    super({ dir: path.join(tmpdir(), 'nazar-never-read'), watch: false });
  }

  override async start(): Promise<void> {
    // `snapshot()` already answers.
  }

  override stop(): void {
    // Nothing was started.
  }

  override snapshot(): CaptureScan {
    return this.canned;
  }
}

/** Likewise for `limits.json`. */
class FakeLimits extends LimitsWatcher {
  constructor(private readonly canned: LimitsScan) {
    super({ file: path.join(tmpdir(), 'nazar-never-read.json'), watch: false });
  }

  override async start(): Promise<void> {
    // `snapshot()` already answers.
  }

  override stop(): void {
    // Nothing was started.
  }

  override snapshot(): LimitsScan {
    return this.canned;
  }
}

/** The transcript half: effort `high`, last written three seconds ago. */
function treeSnapshot(sessionId: string): SessionTreeSnapshot {
  return {
    sessionId,
    tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    treeTokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 },
    model: 'claude-opus-5[1m]',
    effort: 'high',
    toolCalls: 7,
    startedAt: NOW - 60_000,
    lastWriteAt: NOW - 3_000,
    writeAgeMs: 3_000,
    agents: [],
    roots: [],
    orphans: [],
    workflowRuns: [],
    dedupeFallbacks: 0,
    warnings: 0,
    bytesRead: 512,
    filesTailed: 1,
  };
}

function captureScan(...list: StatuslineCapture[]): CaptureScan {
  return {
    configured: true,
    captures: new Map(list.map((capture) => [capture.sessionId, capture])),
    warnings: 0,
  };
}

async function withSession(
  pid: number,
  sessionId: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-state-quota-'));
  try {
    await writeFile(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
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
      }),
      'utf8',
    );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Sources {
  readonly captures?: CaptureScan;
  readonly limits?: LimitsScan;
  readonly tree?: boolean;
}

function stateOver(dir: string, sources: Sources): NazarState {
  return new NazarState({
    registry: new SessionRegistry({
      sessionsDir: dir,
      watch: false,
      runAgents: null,
      isAlive: () => true,
    }),
    captures: sources.captures === undefined ? null : new FakeCaptures(sources.captures),
    limits: sources.limits === undefined ? null : new FakeLimits(sources.limits),
    // N-WP18: and no Codex reader either, so no test reaches ~/.codex.
    codex: null,
    coalesceMs: 5,
    now: () => NOW,
    createTree:
      sources.tree === false
        ? () => undefined
        : (session) => new FakeTree(session.id, treeSnapshot(session.id)),
  });
}

test("a session gains its own capture's cost and context window", async () => {
  await withSession(4300, 'sess-cap', async (dir) => {
    const state = stateOver(dir, {
      captures: captureScan({
        sessionId: 'sess-cap',
        capturedAt: NOW - 1_000,
        costUsd: 9.6,
        contextWindow: { used: 159_283, size: 1_000_000, percent: 16 },
      }),
    });
    try {
      await state.start();
      const view = state.snapshot().sessions[0];
      assert.equal(view?.costUsd, 9.6);
      assert.deepEqual(view?.contextWindow, { used: 159_283, size: 1_000_000, percent: 16 });
      assert.equal(view?.capturedAt, NOW - 1_000);
    } finally {
      state.stop();
    }
  });
});

test('a session no capture names keeps both fields absent, never zero', async () => {
  await withSession(4301, 'sess-none', async (dir) => {
    const state = stateOver(dir, {
      captures: captureScan({ sessionId: 'someone-else', capturedAt: NOW, costUsd: 1 }),
    });
    try {
      await state.start();
      const view = state.snapshot().sessions[0];
      assert.equal(view?.costUsd, undefined);
      assert.equal(view?.contextWindow, undefined);
      assert.equal(view?.capturedAt, undefined);
    } finally {
      state.stop();
    }
  });
});

test('effort: the newer of the capture and the transcript wins', async () => {
  const cases = [
    { capturedAt: NOW - 1_000, expected: 'medium', why: 'the capture is newer than the transcript' },
    { capturedAt: NOW - 10_000, expected: 'high', why: 'the transcript is newer than the capture' },
  ] as const;

  for (const one of cases) {
    await withSession(4302, 'sess-effort', async (dir) => {
      const state = stateOver(dir, {
        captures: captureScan({
          sessionId: 'sess-effort',
          capturedAt: one.capturedAt,
          effort: 'medium',
        }),
      });
      try {
        await state.start();
        assert.equal(state.snapshot().sessions[0]?.effort, one.expected, one.why);
      } finally {
        state.stop();
      }
    });
  }
});

test('with no transcript read yet, the capture is the only answer on effort', async () => {
  await withSession(4303, 'sess-fresh', async (dir) => {
    const state = stateOver(dir, {
      tree: false,
      captures: captureScan({ sessionId: 'sess-fresh', capturedAt: NOW - 90_000, effort: 'low' }),
    });
    try {
      await state.start();
      assert.equal(state.snapshot().sessions[0]?.effort, 'low');
    } finally {
      state.stop();
    }
  });
});

test('the model stays the transcript\'s: it is the one that answered', async () => {
  await withSession(4305, 'sess-model', async (dir) => {
    const state = stateOver(dir, {
      captures: captureScan({
        sessionId: 'sess-model',
        capturedAt: NOW,
        model: 'Sonnet 5',
        modelId: 'claude-sonnet-5',
      }),
    });
    try {
      await state.start();
      assert.equal(state.snapshot().sessions[0]?.model, 'claude-opus-5[1m]');
    } finally {
      state.stop();
    }
  });
});

test('no source means no quota on the snapshot at all', async () => {
  await withSession(4304, 'sess-quota', async (dir) => {
    const state = stateOver(dir, { tree: false });
    try {
      await state.start();
      assert.equal(state.snapshot().quota, undefined);
    } finally {
      state.stop();
    }
  });
});

test('limits.json fills the snapshot quota, Codex included', async () => {
  await withSession(4306, 'sess-tray', async (dir) => {
    const state = stateOver(dir, {
      tree: false,
      captures: { configured: false, captures: new Map(), warnings: 0 },
      limits: {
        configured: true,
        document: {
          schemaVersion: 1,
          updatedAt: NOW - 2_000,
          providers: [
            { name: 'claude', configured: false, windows: [] },
            {
              name: 'codex',
              configured: true,
              plan: 'plus',
              source: 'rollout',
              sourceAt: NOW - 3_000,
              binding: 'secondary',
              windows: [
                { key: 'primary', state: 'ok', percent: 54, windowMinutes: 300 },
                { key: 'secondary', state: 'ok', percent: 70, windowMinutes: 10_080 },
              ],
            },
          ],
        },
      },
    });
    try {
      await state.start();
      const quota = state.snapshot().quota;
      assert.equal(quota?.source, 'limits.json');
      assert.equal(quota?.providers.length, 2);
      assert.equal(quota?.providers[1]?.windows.length, 2);
    } finally {
      state.stop();
    }
  });
});

test('quotaSources answers for both readers even when neither exists', async () => {
  await withSession(4307, 'sess-sources', async (dir) => {
    const state = stateOver(dir, { tree: false });
    try {
      await state.start();
      const sources = state.quotaSources();
      assert.equal(sources.limits.configured, false);
      assert.equal(sources.captures.configured, false);
      assert.equal(sources.captures.captures.size, 0);
    } finally {
      state.stop();
    }
  });
});

/* ------------------------------------------------------------------ *
 * WP4f: a blank with a reason
 *
 * Cost and context are absent on a machine without the wrapper, and that is a
 * fact about the machine. On a machine *with* the wrapper they are absent for
 * exactly one other reason: the project the session was started in replaced the
 * status line the wrapper installed itself as. The join says so, and these are
 * the four conditions it must hold out for before it does.
 * ------------------------------------------------------------------ */

/** A session file with a working directory and a start time of the test's choosing. */
async function withSessionAt(
  pid: number,
  sessionId: string,
  fields: { readonly cwd: string; readonly startedAt: number },
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-state-blocked-'));
  try {
    await writeFile(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd: fields.cwd,
        kind: 'interactive',
        name: `session-${pid}`,
        status: 'busy',
        startedAt: fields.startedAt,
        updatedAt: NOW - 5_000,
        statusUpdatedAt: NOW - 5_000,
        version: '2.1.263',
      }),
      'utf8',
    );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A probe that has already read, and answers whatever the test says. */
async function probeSaying(cwd: string, overrides: boolean): Promise<ProjectStatusLineProbe> {
  const probe = new ProjectStatusLineProbe({
    read: async () => [{ file: `${cwd}/.claude/settings.json`, overrides }],
  });
  await probe.probe(cwd);
  return probe;
}

/** An empty capture directory that the wrapper *has* written into before. */
const WRAPPER_INSTALLED: CaptureScan = { configured: true, captures: new Map(), warnings: 0 };

interface BlockedCase {
  readonly captures?: CaptureScan;
  readonly startedAt?: number;
  readonly overrides?: boolean;
  readonly cwd?: string;
}

async function blockedVerdict(pid: number, options: BlockedCase): Promise<string | undefined> {
  const cwd = options.cwd ?? 'C:/proj/overridden';
  const probe = await probeSaying(cwd, options.overrides ?? true);
  let verdict: string | undefined;
  await withSessionAt(
    pid,
    `sess-${pid}`,
    { cwd, startedAt: options.startedAt ?? NOW - 120_000 },
    async (dir) => {
      const state = new NazarState({
        registry: new SessionRegistry({
          sessionsDir: dir,
          watch: false,
          runAgents: null,
          isAlive: () => true,
        }),
        captures: options.captures === undefined ? null : new FakeCaptures(options.captures),
        limits: null,
        // N-WP18: and no Codex reader either, so no test reaches ~/.codex.
        codex: null,
        statusLines: probe,
        coalesceMs: 5,
        now: () => NOW,
        createTree: () => undefined,
      });
      try {
        await state.start();
        verdict = state.snapshot().sessions[0]?.captureBlockedBy;
      } finally {
        state.stop();
      }
    },
  );
  return verdict;
}

test('a session in an overriding project, with no capture, says why', async () => {
  assert.equal(await blockedVerdict(4400, { captures: WRAPPER_INSTALLED }), 'project statusLine');
});

test('a session that has a capture says nothing, whatever its project does', async () => {
  const verdict = await blockedVerdict(4401, {
    captures: captureScan({ sessionId: 'sess-4401', costUsd: 1.5 }),
  });
  assert.equal(verdict, undefined, 'the numbers are there; there is nothing to explain');
});

test('a machine with no wrapper is not a project problem', async () => {
  // `configured: false` is "the wrapper is not installed", which is already the
  // answer and is about the machine rather than about this project.
  assert.equal(
    await blockedVerdict(4402, {
      captures: { configured: false, captures: new Map(), warnings: 0 },
    }),
    undefined,
  );
  assert.equal(await blockedVerdict(4403, {}), undefined, 'nor is a canvas with no reader');
});

test('a young session is given time to have a first redraw', async () => {
  assert.equal(
    await blockedVerdict(4404, {
      captures: WRAPPER_INSTALLED,
      startedAt: NOW - (CAPTURE_GRACE_MS - 1_000),
    }),
    undefined,
    'a wrong explanation is worse than none',
  );
  assert.equal(
    await blockedVerdict(4405, {
      captures: WRAPPER_INSTALLED,
      startedAt: NOW - (CAPTURE_GRACE_MS + 1_000),
    }),
    'project statusLine',
  );
});

test('a project that points its own status line at the wrapper is not blamed', async () => {
  assert.equal(
    await blockedVerdict(4406, { captures: WRAPPER_INSTALLED, overrides: false }),
    undefined,
  );
});

test('an unread project directory draws nothing rather than guessing', async () => {
  await withSessionAt(
    4407,
    'sess-4407',
    { cwd: 'C:/proj/never-read', startedAt: NOW - 120_000 },
    async (dir) => {
      // A probe that has read nothing at all: the first publish after the grace
      // period fires the read, and the *next* one carries the verdict.
      const probe = new ProjectStatusLineProbe({
        read: async () => [{ file: 'x', overrides: true }],
      });
      const state = new NazarState({
        registry: new SessionRegistry({
          sessionsDir: dir,
          watch: false,
          runAgents: null,
          isAlive: () => true,
        }),
        captures: new FakeCaptures(WRAPPER_INSTALLED),
        limits: null,
        // N-WP18: and no Codex reader either, so no test reaches ~/.codex.
        codex: null,
        statusLines: probe,
        coalesceMs: 5,
        now: () => NOW,
        createTree: () => undefined,
      });
      try {
        await state.start();
        assert.equal(state.snapshot().sessions[0]?.captureBlockedBy, undefined);
        // The first publish fired the probe; give it the turn it needs.
        await probe.probe('C:/proj/never-read');
        assert.equal(state.publish().sessions[0]?.captureBlockedBy, 'project statusLine');
      } finally {
        state.stop();
      }
    },
  );
});
