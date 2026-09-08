/**
 * WP3': the status-line capture reader.
 *
 * A capture is the *whole* status-line payload, and the payload carries paths:
 * `cwd`, `transcript_path`, `scratchpad_dir`, the workspace directories and the
 * repository name. So half of this file is the leak gate — the same shape as
 * the transcript one — and the other half is the tolerance the reader needs to
 * survive a directory another program writes into while it is being read.
 *
 * Nothing here touches the real `~/.nazar`. Every directory test runs over a
 * temporary directory, and no test writes anything the reader would ever see on
 * a real machine.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  captureAgeSource,
  newestCapture,
  parseStatuslineCapture,
  readCapturesDir,
  readResetsAt,
  StatuslineCaptures,
} from '../src/statusline-captures.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', 'fixtures');
const capturesFixtures = path.join(fixturesDir, 'statusline-captures');

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-captures-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The envelope
 * ------------------------------------------------------------------ */

test('the fixture capture parses into exactly the fields Nazar reads', async () => {
  const file = path.join(capturesFixtures, '00000000-0000-4000-8000-000000000001.json');
  const capture = parseStatuslineCapture(await readFile(file, 'utf8'), 1_788_756_000_000);
  assert.ok(capture !== undefined);

  assert.equal(capture.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(capture.wrapper, 'nazar-statusline/0.1.0');
  assert.equal(capture.capturedAt, Date.parse('2026-09-07T07:57:12Z'));
  assert.equal(capture.model, 'Fable 5.1');
  assert.equal(capture.modelId, 'claude-fable-5-1');
  assert.equal(capture.effort, 'high');
  assert.equal(capture.costUsd, 9.60050075);
  assert.deepEqual(capture.contextWindow, { used: 159_283, size: 1_000_000, percent: 16 });
  // Only `seven_day` was present at capture time: Claude Code drops a window
  // once its reset has passed, and the fixture is a real capture.
  assert.deepEqual(capture.rateLimits, {
    seven_day: { percent: 31, resetsAt: 1_789_178_400 * 1000 },
  });

  // The whole key set, so a field added to the parser has to be looked at here.
  assert.deepEqual(Object.keys(capture).sort(), [
    'capturedAt',
    'contextWindow',
    'costUsd',
    'effort',
    'fileAt',
    'model',
    'modelId',
    'rateLimits',
    'sessionId',
    'wrapper',
  ]);
});

test('a capture with almost nothing in it is still a capture', () => {
  const capture = parseStatuslineCapture(
    JSON.stringify({ schemaVersion: 1, sessionId: 'sess-a', payload: {} }),
  );
  assert.ok(capture !== undefined);
  assert.equal(capture.sessionId, 'sess-a');
  assert.equal(capture.costUsd, undefined);
  assert.equal(capture.contextWindow, undefined);
  assert.equal(capture.rateLimits, undefined);
  assert.equal(capture.effort, undefined);
});

test('the third fixture is the missing-fields case, end to end', async () => {
  const file = path.join(capturesFixtures, '00000000-0000-4000-8000-000000000003.json');
  const capture = parseStatuslineCapture(await readFile(file, 'utf8'));
  assert.ok(capture !== undefined);
  assert.equal(capture.model, 'Haiku 5');
  assert.equal(capture.costUsd, undefined, 'no cost block in this payload');
  assert.equal(capture.contextWindow, undefined);
  assert.equal(capture.rateLimits, undefined);
});

test('a wrong schemaVersion is refused rather than read hopefully', () => {
  for (const version of [0, 2, '1', null, undefined]) {
    const raw = JSON.stringify({ version, sessionId: 'sess-a', payload: {}, schemaVersion: version });
    assert.equal(parseStatuslineCapture(raw), undefined, `schemaVersion ${String(version)}`);
  }
});

test('a half-written or malformed file is skipped, never thrown on', () => {
  for (const raw of ['', '{', 'null', '[]', '"text"', '{"schemaVersion":1}']) {
    assert.doesNotThrow(() => parseStatuslineCapture(raw));
    assert.equal(parseStatuslineCapture(raw), undefined, raw);
  }
});

test('a capture with no session id cannot be keyed, so it is not one', () => {
  assert.equal(
    parseStatuslineCapture(JSON.stringify({ schemaVersion: 1, payload: {} })),
    undefined,
  );
  assert.equal(
    parseStatuslineCapture(JSON.stringify({ schemaVersion: 1, sessionId: '', payload: {} })),
    undefined,
  );
});

test('resets_at is read as seconds, and as milliseconds past the switch point', () => {
  assert.equal(readResetsAt(1_789_178_400), 1_789_178_400_000);
  assert.equal(readResetsAt(1_789_178_400_000), 1_789_178_400_000);
  assert.equal(readResetsAt(0), undefined, 'zero is not a reset time');
  assert.equal(readResetsAt(-1), undefined);
  assert.equal(readResetsAt('soon'), undefined);
});

test('a rate-limit window with neither number is not a window', () => {
  const capture = parseStatuslineCapture(
    JSON.stringify({
      schemaVersion: 1,
      sessionId: 'sess-a',
      payload: { rate_limits: { five_hour: {}, seven_day: { used_percentage: 4 } } },
    }),
  );
  assert.deepEqual(capture?.rateLimits, { seven_day: { percent: 4 } });
});

/* ------------------------------------------------------------------ *
 * The leak gate
 * ------------------------------------------------------------------ */

test('nothing but the allow-listed values leaves the parser', () => {
  const SENTINEL = 'NAZAR-CAPTURE-SENTINEL';
  const poisoned = {
    schemaVersion: 1,
    updatedAt: '2026-09-07T07:57:12Z',
    wrapper: 'nazar-statusline/0.1.0',
    sessionId: 'sess-a',
    // Every string in the payload except the four values Nazar actually reads
    // is a sentinel. If any of them reaches the output, this fails.
    payload: {
      session_id: 'sess-a',
      transcript_path: `${SENTINEL}-transcript`,
      cwd: `${SENTINEL}-cwd`,
      scratchpad_dir: `${SENTINEL}-scratchpad`,
      prompt_id: `${SENTINEL}-prompt`,
      session_name: `${SENTINEL}-name`,
      workspace: {
        current_dir: `${SENTINEL}-current`,
        project_dir: `${SENTINEL}-project`,
        added_dirs: [`${SENTINEL}-added`],
        git_worktree: `${SENTINEL}-worktree`,
        repo: { host: `${SENTINEL}-host`, owner: `${SENTINEL}-owner`, name: `${SENTINEL}-repo` },
      },
      output_style: { name: `${SENTINEL}-style` },
      agent: { name: `${SENTINEL}-agent` },
      pr: { title: `${SENTINEL}-pr` },
      vim: { mode: `${SENTINEL}-vim` },
      version: `${SENTINEL}-version`,
      model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
      effort: { level: 'high' },
      cost: { total_cost_usd: 1.5, breakdown: `${SENTINEL}-breakdown` },
      context_window: { total_input_tokens: 10, context_window_size: 100, used_percentage: 10 },
      rate_limits: { five_hour: { used_percentage: 4, resets_at: 1_789_178_400 } },
    },
  };

  const capture = parseStatuslineCapture(JSON.stringify(poisoned), 1);
  assert.ok(capture !== undefined);

  const serialised = JSON.stringify(capture);
  assert.equal(
    serialised.includes(SENTINEL),
    false,
    `a payload field escaped the parser: ${serialised}`,
  );
  // And by name, so a future field called something else is still caught by the
  // sweep above but the two obvious ones are named here as well.
  const keys = new Set(Object.keys(capture as unknown as Record<string, unknown>));
  for (const key of ['cwd', 'transcript_path', 'scratchpad_dir', 'workspace', 'session_name']) {
    assert.equal(keys.has(key), false, `${key} reached the capture`);
  }
});

test('an absurdly long string is cut rather than carried', () => {
  const capture = parseStatuslineCapture(
    JSON.stringify({
      schemaVersion: 1,
      sessionId: 'sess-a',
      payload: { model: { display_name: 'x'.repeat(5000) } },
    }),
  );
  assert.equal(capture?.model?.length, 200);
});

/* ------------------------------------------------------------------ *
 * The directory
 * ------------------------------------------------------------------ */

test('a missing directory is "not configured", not an error', async () => {
  const scan = await readCapturesDir(path.join(tmpdir(), 'nazar-no-such-dir-2f8a'));
  assert.equal(scan.configured, false);
  assert.equal(scan.captures.size, 0);
  assert.equal(scan.warnings, 0);
});

test('the fixture directory reads as three captures, and chain.json is not one', async () => {
  const scan = await readCapturesDir(capturesFixtures);
  assert.equal(scan.configured, true);
  assert.equal(scan.captures.size, 3);
  assert.equal(scan.warnings, 0, 'chain.json is skipped by name, not counted as broken');
  assert.ok(scan.captures.has('00000000-0000-4000-8000-000000000001'));
  assert.ok(scan.captures.has('00000000-0000-4000-8000-000000000002'));
  assert.ok(scan.captures.has('00000000-0000-4000-8000-000000000003'));
});

test('a broken capture is counted and the rest still read', async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, 'good.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'a', payload: {} }));
    await writeFile(path.join(dir, 'broken.json'), '{ half written');
    await writeFile(path.join(dir, 'notes.txt'), 'ignored by extension');

    const scan = await readCapturesDir(dir);
    assert.equal(scan.configured, true);
    assert.equal(scan.captures.size, 1);
    assert.equal(scan.warnings, 1);
  });
});

test('the newest capture is the one the quota strip would use', async () => {
  const scan = await readCapturesDir(capturesFixtures);
  const newest = newestCapture(scan);
  assert.equal(newest?.sessionId, '00000000-0000-4000-8000-000000000002');
  assert.equal(captureAgeSource(newest!), Date.parse('2026-09-07T07:57:44Z'));
});

test('a capture with no updatedAt still has an age, from the file', async () => {
  await withDir(async (dir) => {
    await writeFile(
      path.join(dir, 'a.json'),
      JSON.stringify({ schemaVersion: 1, sessionId: 'a', payload: {} }),
    );
    const scan = await readCapturesDir(dir);
    const capture = scan.captures.get('a');
    assert.ok(capture !== undefined);
    assert.equal(capture.capturedAt, undefined);
    assert.ok((capture.fileAt ?? 0) > 0);
    assert.equal(captureAgeSource(capture), capture.fileAt);
  });
});

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

test('the watcher publishes once for a change and stays quiet otherwise', async () => {
  await withDir(async (dir) => {
    const watcher = new StatuslineCaptures({ dir, watch: false, pollIntervalMs: 10_000 });
    const seen: number[] = [];
    watcher.on('change', (scan) => seen.push(scan.captures.size));

    try {
      await watcher.start();
      assert.equal(watcher.snapshot().configured, true);
      assert.deepEqual(seen, [0], 'the first pass is a change: nothing was known before it');

      await watcher.refresh();
      assert.deepEqual(seen, [0], 'an unchanged directory publishes nothing');

      await writeFile(
        path.join(dir, 'a.json'),
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'a',
          updatedAt: '2026-09-07T07:57:12Z',
          payload: { cost: { total_cost_usd: 1 } },
        }),
      );
      await watcher.refresh();
      assert.deepEqual(seen, [0, 1]);
      assert.equal(watcher.snapshot().captures.get('a')?.costUsd, 1);
    } finally {
      watcher.stop();
    }
  });
});

test('the poll is the floor: a watch that cannot be established is not an error', async () => {
  await withDir(async (dir) => {
    const watcher = new StatuslineCaptures({
      dir,
      pollIntervalMs: 10_000,
      watchFactory: () => {
        throw new Error('no watches on this filesystem');
      },
    });
    try {
      await watcher.start();
      assert.equal(watcher.watching, false);
      assert.equal(watcher.snapshot().configured, true, 'the poll read the directory anyway');
    } finally {
      watcher.stop();
    }
  });
});

test('a watch event drives a refresh through the debounce', async () => {
  await withDir(async (dir) => {
    let fire: (() => void) | undefined;
    const watcher = new StatuslineCaptures({
      dir,
      debounceMs: 5,
      pollIntervalMs: 10_000,
      watchFactory: (_target, onChange) => {
        fire = onChange;
        return { close: () => undefined, on: () => undefined };
      },
    });

    try {
      await watcher.start();
      assert.equal(watcher.watching, true);
      await writeFile(
        path.join(dir, 'a.json'),
        JSON.stringify({ schemaVersion: 1, sessionId: 'a', payload: {} }),
      );
      fire?.();
      fire?.();
      fire?.();
      // Wait for the debounce to land rather than for a fixed number of
      // milliseconds: a timer test that races the machine it runs on is a
      // test that fails on someone else's laptop for no reason.
      for (let attempt = 0; attempt < 100 && watcher.snapshot().captures.size === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(watcher.snapshot().captures.size, 1);
    } finally {
      watcher.stop();
    }
  });
});
