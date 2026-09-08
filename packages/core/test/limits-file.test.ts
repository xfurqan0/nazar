/**
 * WP5: the `~/.nazar/limits.json` reader.
 *
 * The document belongs to nazar-tray, so the fixture is **its** sample, copied
 * in verbatim (`fixtures/limits.sample.json`); the contract says consumers
 * should vendor that file rather than hand-write one, and this is what makes
 * that copy load-bearing instead of decorative.
 *
 * The four properties worth failing a build over are all in here: an unknown
 * percentage never becomes zero, an unrecognised window key still reads, a
 * version bump is refused by name, and the `binding` window is recomputed
 * rather than believed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bindingWindow,
  LimitsWatcher,
  parseLimitsDocument,
  readLimitsFile,
} from '../src/limits-file.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleFile = path.join(here, '..', '..', '..', 'fixtures', 'limits.sample.json');

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nazar-limits-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("nazar-tray's own sample parses into both providers and every window", async () => {
  const parsed = parseLimitsDocument(await readFile(sampleFile, 'utf8'));
  assert.ok('document' in parsed, 'the vendored sample must parse');
  const { document } = parsed;

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.updatedAt, Date.parse('2026-09-06T21:12:34Z'));
  assert.deepEqual(
    document.providers.map((provider) => provider.name),
    ['claude', 'codex'],
  );

  const claude = document.providers[0];
  assert.ok(claude !== undefined);
  assert.equal(claude.configured, true);
  assert.equal(claude.plan, 'max_20x');
  assert.equal(claude.source, 'endpoint');
  assert.equal(claude.sourceAt, Date.parse('2026-09-06T21:12:30Z'));
  assert.deepEqual(
    claude.windows.map((window) => window.key),
    ['five_hour', 'seven_day', 'seven_day_fable'],
  );

  const scoped = claude.windows.find((window) => window.key === 'seven_day_fable');
  assert.equal(scoped?.percent, 23);
  assert.equal(scoped?.model, 'Fable');
  assert.equal(scoped?.detailed, true);
  assert.equal(scoped?.windowMinutes, 10_080);
  assert.equal(scoped?.resetsAt, Date.parse('2026-09-12T02:00:00Z'));

  // 23 is the highest of 12, 18 and 23 — the constraint a Fable-heavy Max user
  // actually hits, and the one the passive path cannot see.
  assert.equal(claude.binding, 'seven_day_fable');

  const codex = document.providers[1];
  assert.equal(codex?.plan, 'plus');
  assert.equal(codex?.binding, 'secondary');
  assert.equal(codex?.windows.length, 2);
});

test('a window with no percentage stays unknown and never becomes zero', () => {
  const parsed = parseLimitsDocument(
    JSON.stringify({
      schemaVersion: 1,
      providers: {
        claude: {
          configured: true,
          windows: {
            seven_day: {
              windowMinutes: 10_080,
              state: 'error',
              error: 'the usage endpoint did not answer',
            },
          },
        },
      },
    }),
  );
  assert.ok('document' in parsed);
  const window = parsed.document.providers[0]?.windows[0];
  assert.equal(window?.percent, undefined, 'unknown must not be rendered as a number');
  assert.equal(window?.state, 'error');
  assert.equal(window?.error, 'the usage endpoint did not answer');
  // And a window with no percentage never binds.
  assert.equal(parsed.document.providers[0]?.binding, undefined);
});

test('an unrecognised window key and an unrecognised state both survive', () => {
  const parsed = parseLimitsDocument(
    JSON.stringify({
      schemaVersion: 1,
      providers: {
        claude: {
          configured: true,
          source: 'something-new',
          windows: {
            thirty_day: { percent: 5, windowMinutes: 43_200, state: 'degraded' },
          },
        },
      },
    }),
  );
  assert.ok('document' in parsed);
  const provider = parsed.document.providers[0];
  assert.equal(provider?.source, 'something-new');
  assert.equal(provider?.windows[0]?.key, 'thirty_day');
  assert.equal(provider?.windows[0]?.state, 'degraded');
});

test('a window with no state is not a window: there is no safe default', () => {
  const parsed = parseLimitsDocument(
    JSON.stringify({
      schemaVersion: 1,
      providers: { claude: { configured: true, windows: { five_hour: { percent: 10 } } } },
    }),
  );
  assert.ok('document' in parsed);
  assert.equal(parsed.document.providers[0]?.windows.length, 0);
});

test('a provider with no `configured` flag is not a provider', () => {
  const parsed = parseLimitsDocument(
    JSON.stringify({ schemaVersion: 1, providers: { claude: { windows: {} } } }),
  );
  assert.ok('document' in parsed);
  assert.equal(parsed.document.providers.length, 0);
});

test('a version bump is refused by name rather than parsed hopefully', () => {
  const parsed = parseLimitsDocument(JSON.stringify({ schemaVersion: 2, providers: {} }));
  assert.ok('error' in parsed);
  assert.match(parsed.error, /schemaVersion 2/);
});

test('a malformed document says why, and never throws', () => {
  for (const [raw, pattern] of [
    ['', /JSON/],
    ['{ half', /JSON/],
    ['[]', /top level/],
    ['{"providers":{}}', /schemaVersion/],
    ['{"schemaVersion":1}', /providers/],
  ] as const) {
    const parsed = parseLimitsDocument(raw);
    assert.ok('error' in parsed, raw);
    assert.match(parsed.error, pattern);
  }
});

test('binding: highest percent, ties to the shorter window, then the smaller key', () => {
  assert.equal(
    bindingWindow([
      { key: 'a', state: 'ok', percent: 10, windowMinutes: 300 },
      { key: 'b', state: 'ok', percent: 40, windowMinutes: 10_080 },
    ]),
    'b',
  );
  assert.equal(
    bindingWindow([
      { key: 'weekly', state: 'ok', percent: 40, windowMinutes: 10_080 },
      { key: 'five', state: 'ok', percent: 40, windowMinutes: 300 },
    ]),
    'five',
    'a tie goes to the window that resets sooner',
  );
  assert.equal(
    bindingWindow([
      { key: 'b', state: 'ok', percent: 40, windowMinutes: 300 },
      { key: 'a', state: 'ok', percent: 40, windowMinutes: 300 },
    ]),
    'a',
  );
  assert.equal(
    bindingWindow([{ key: 'a', state: 'error' }]),
    undefined,
    'a window nobody could read is not a constraint',
  );
});

test('the reader recomputes binding rather than believing the file', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'limits.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          claude: {
            configured: true,
            // Written by an older build, and wrong: 44 is the higher number.
            binding: 'five_hour',
            windows: {
              five_hour: { percent: 3, windowMinutes: 300, state: 'ok' },
              seven_day: { percent: 44, windowMinutes: 10_080, state: 'ok' },
            },
          },
        },
      }),
    );
    const scan = await readLimitsFile(file);
    assert.equal(scan.document?.providers[0]?.binding, 'seven_day');
  });
});

test('a missing file is "not configured", not an error', async () => {
  const scan = await readLimitsFile(path.join(tmpdir(), 'nazar-no-such-limits-9c1.json'));
  assert.equal(scan.configured, false);
  assert.equal(scan.document, undefined);
  assert.equal(scan.error, undefined);
});

test('a file that is there and unusable says so, which is a different state', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'limits.json');
    await writeFile(file, '{ not json');
    const scan = await readLimitsFile(file);
    assert.equal(scan.configured, true);
    assert.equal(scan.document, undefined);
    assert.match(scan.error ?? '', /JSON/);
  });
});

test('the watcher publishes on a real change and stays quiet otherwise', async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, 'limits.json');
    const watcher = new LimitsWatcher({ file, watch: false, pollIntervalMs: 10_000 });
    const seen: string[] = [];
    watcher.on('change', (scan) => seen.push(scan.document === undefined ? 'none' : 'document'));

    try {
      await watcher.start();
      assert.deepEqual(seen, ['none']);

      await watcher.refresh();
      assert.deepEqual(seen, ['none'], 'a file that is still absent is not a change');

      await writeFile(file, await readFile(sampleFile, 'utf8'));
      await watcher.refresh();
      assert.deepEqual(seen, ['none', 'document']);
      assert.equal(watcher.snapshot().document?.providers.length, 2);

      await watcher.refresh();
      assert.equal(seen.length, 2, 'unchanged content publishes nothing');
    } finally {
      watcher.stop();
    }
  });
});
